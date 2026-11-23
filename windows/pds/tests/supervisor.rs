//! Supervisor mit Dummy-Kindern: Die Testbinary startet sich selbst erneut, der Test
//! `dummy_child_entry` spielt dann Node oder Caddy (gesteuert über `DUMMY_*`-Variablen).
//!
//! Das funktioniert unter Linux und Windows gleich, ohne Shell-Skripte.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use pds::daemon::StopSignal;
use pds::supervisor::{
    ChildKind, ChildSpec, ConfigPlanner, HealthProbe, LaunchPlan, LaunchPlanner, LogSinks,
    Redactor, StatusSink, Supervisor, SupervisorOptions, build_production,
};
use pds_common::config::{self, Config, SecretField, TlsMode};
use pds_common::status::{self, ServiceState, Status};
use pds_common::validate::{Finding, Severity};
use pds_common::{Paths, Secret, ops, system_protector};
use tempfile::TempDir;

// ---------------------------------------------------------------------------------------------
// Dummy-Kind
// ---------------------------------------------------------------------------------------------

/// Tut nur etwas, wenn die Testbinary als Dummy-Kind gestartet wurde. Schreibt direkt auf die
/// Standardkanäle (ohne `print!`), damit die Ausgabeumleitung von libtest nichts verschluckt.
#[test]
fn dummy_child_entry() {
    if std::env::var_os("PDS_DUMMY_CHILD").is_none() {
        return;
    }
    let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());

    // Zählt die Starts in einer Datei; ab dem (N+1)-ten läuft das Kind gesund bis stdin-EOF
    if let Some(path) = var("DUMMY_COUNTER") {
        let starts = fs::read_to_string(&path)
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok())
            .unwrap_or(0)
            + 1;
        fs::write(&path, starts.to_string()).unwrap();
        let fail_times: u32 = var("DUMMY_FAIL_TIMES").map_or(0, |n| n.parse().unwrap());
        if starts > fail_times {
            io::copy(&mut io::stdin(), &mut io::sink()).unwrap();
            std::process::exit(0);
        }
    }
    if let Some(path) = var("DUMMY_STDIN_TO") {
        let mut data = Vec::new();
        io::stdin().read_to_end(&mut data).unwrap();
        fs::write(path, data).unwrap();
    }
    if let Some(text) = var("DUMMY_STDOUT") {
        let mut out = io::stdout();
        writeln!(out, "{text}").unwrap();
        out.flush().unwrap();
    }
    if let Some(text) = var("DUMMY_STDERR") {
        let mut err = io::stderr();
        writeln!(err, "{text}").unwrap();
        err.flush().unwrap();
    }
    if var("DUMMY_UNTIL_STDIN_EOF").is_some() {
        io::copy(&mut io::stdin(), &mut io::sink()).unwrap();
    }
    if var("DUMMY_IGNORE_STDIN").is_some() {
        // Sicherheitsnetz: Ein vergessenes Kind endet von selbst
        thread::sleep(Duration::from_secs(60));
    }
    let code = var("DUMMY_EXIT").map_or(0, |code| code.parse().unwrap());
    std::process::exit(code);
}

/// Startet diese Testbinary als Dummy-Kind mit den angegebenen Variablen.
fn dummy(kind: ChildKind, vars: &[(&str, &str)]) -> ChildSpec {
    // Die Basis braucht Windows (`SystemRoot`), sonst startet nicht einmal die Testbinary
    let mut env = ops::base_env();
    env.push(("PDS_DUMMY_CHILD".to_owned(), Secret::new("1")));
    for (name, value) in vars {
        env.push(((*name).to_owned(), Secret::new(*value)));
    }
    ChildSpec {
        kind,
        program: std::env::current_exe().unwrap(),
        args: [
            "dummy_child_entry",
            "--exact",
            "--nocapture",
            "--test-threads=1",
            "-q",
        ]
        .map(OsString::from)
        .to_vec(),
        env,
        cwd: std::env::current_dir().unwrap(),
        // Wie im Betrieb: Caddy bekommt seine Konfiguration und dann EOF, Node behält stdin
        stdin_payload: (kind == ChildKind::Proxy).then(|| Secret::new("{}")),
        keep_stdin_open: kind == ChildKind::App,
    }
}

/// Läuft bis stdin-EOF und endet dann mit 0, wie `pds-entry.mjs`.
fn steady_app() -> ChildSpec {
    dummy(ChildKind::App, &[("DUMMY_UNTIL_STDIN_EOF", "1")])
}

/// Caddy liest seine Konfiguration und läuft dann, bis es beendet wird.
fn steady_proxy() -> ChildSpec {
    dummy(ChildKind::Proxy, &[("DUMMY_IGNORE_STDIN", "1")])
}

fn plan(app: ChildSpec, proxy: ChildSpec) -> LaunchPlan {
    LaunchPlan {
        app,
        proxy,
        health_url: "http://127.0.0.1:3000/api/health".to_owned(),
        redactor: Redactor::new(Vec::new()),
        certificate_not_after: None,
        findings: Vec::new(),
    }
}

// ---------------------------------------------------------------------------------------------
// Testumgebung
// ---------------------------------------------------------------------------------------------

fn ms(millis: u64) -> Duration {
    Duration::from_millis(millis)
}

/// Kurze Zeiten, damit die Tests schnell sind.
fn options() -> SupervisorOptions {
    SupervisorOptions {
        health_interval: ms(50),
        stop_timeout: ms(500),
        backoff_base: ms(50),
        backoff_max: ms(200),
        stable_run: Duration::from_secs(600),
        heartbeat: ms(50),
    }
}

/// Gibt bei jedem Aufruf denselben Plan zurück und zählt mit.
struct FixedPlanner {
    result: Result<LaunchPlan, Vec<Finding>>,
    calls: Arc<AtomicUsize>,
}

impl LaunchPlanner for FixedPlanner {
    fn plan(&mut self) -> Result<LaunchPlan, Vec<Finding>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.result.clone()
    }
}

/// Health-Abfrage ohne Netz: Ergebnis von außen umschaltbar.
struct FakeProbe {
    healthy: Arc<AtomicBool>,
    urls: Arc<Mutex<Vec<String>>>,
}

impl HealthProbe for FakeProbe {
    fn check(&mut self, url: &str) -> Result<(), String> {
        self.urls.lock().unwrap().push(url.to_owned());
        if self.healthy.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err("HTTP 503".to_owned())
        }
    }
}

/// Merkt sich jeden veröffentlichten Status.
#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<Status>>>);

impl StatusSink for Recorder {
    fn publish(&mut self, status: &Status) {
        self.0.lock().unwrap().push(status.clone());
    }
}

impl Recorder {
    fn all(&self) -> Vec<Status> {
        self.0.lock().unwrap().clone()
    }

    fn last(&self) -> Status {
        self.all().last().cloned().expect("noch kein Status")
    }

    /// Wartet höchstens 10 s auf einen Status, der `condition` erfüllt.
    fn wait_for(&self, what: &str, condition: impl Fn(&Status) -> bool) -> Status {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self
                .all()
                .into_iter()
                .rev()
                .find(|status| condition(status))
            {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "{what} nicht erreicht, zuletzt: {:#?}",
                self.all().last()
            );
            thread::sleep(ms(10));
        }
    }
}

/// Logziel im Speicher.
#[derive(Clone, Default)]
struct SharedLog(Arc<Mutex<Vec<u8>>>);

impl Write for SharedLog {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl SharedLog {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }

    fn wait_for(&self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let text = self.text();
            if text.contains(needle) {
                return text;
            }
            assert!(
                Instant::now() < deadline,
                "{needle:?} fehlt im Log:\n{text}"
            );
            thread::sleep(ms(10));
        }
    }
}

/// Supervisor in einem eigenen Thread. Beim Drop (auch nach einem fehlgeschlagenen Assert) wird
/// er gestoppt, damit keine Dummy-Kinder übrig bleiben.
struct Harness {
    stop: StopSignal,
    worker: Option<JoinHandle<()>>,
    statuses: Recorder,
    app_log: SharedLog,
    proxy_log: SharedLog,
    plans: Arc<AtomicUsize>,
    healthy: Arc<AtomicBool>,
    urls: Arc<Mutex<Vec<String>>>,
}

impl Harness {
    fn start(result: Result<LaunchPlan, Vec<Finding>>, options: SupervisorOptions) -> Self {
        Self::start_with_health(result, options, true)
    }

    fn start_with_health(
        result: Result<LaunchPlan, Vec<Finding>>,
        options: SupervisorOptions,
        healthy: bool,
    ) -> Self {
        let statuses = Recorder::default();
        let app_log = SharedLog::default();
        let proxy_log = SharedLog::default();
        let plans = Arc::new(AtomicUsize::new(0));
        let healthy = Arc::new(AtomicBool::new(healthy));
        let urls = Arc::new(Mutex::new(Vec::new()));
        let supervisor = Supervisor::new(
            FixedPlanner {
                result,
                calls: Arc::clone(&plans),
            },
            FakeProbe {
                healthy: Arc::clone(&healthy),
                urls: Arc::clone(&urls),
            },
            statuses.clone(),
            LogSinks {
                app: Box::new(app_log.clone()),
                proxy: Box::new(proxy_log.clone()),
            },
            ("24.0.0".to_owned(), "2.11.0".to_owned()),
            options,
        );
        let stop = StopSignal::new();
        let remote = stop.clone();
        let worker = thread::spawn(move || supervisor.run(&remote));
        Self {
            stop,
            worker: Some(worker),
            statuses,
            app_log,
            proxy_log,
            plans,
            healthy,
            urls,
        }
    }

    fn running(app: ChildSpec, proxy: ChildSpec) -> Self {
        Self::start(Ok(plan(app, proxy)), options())
    }

    /// Stoppt und gibt zurück, wie lange es bis zum Ende von `run` gedauert hat.
    fn stop(&mut self) -> Duration {
        let started = Instant::now();
        self.stop.stop();
        if let Some(worker) = self.worker.take() {
            worker.join().expect("Supervisor abgestürzt");
        }
        started.elapsed()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.stop.stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn finding(code: &str) -> Finding {
    Finding {
        field: "public.host".to_owned(),
        code: code.to_owned(),
        message: "Pflichtfeld".to_owned(),
        severity: Severity::Error,
    }
}

#[cfg(target_os = "linux")]
fn process_exists(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

// ---------------------------------------------------------------------------------------------
// Verhalten
// ---------------------------------------------------------------------------------------------

#[test]
fn unconfigured_when_plan_fails() {
    let mut harness = Harness::start(Err(vec![finding("required")]), options());

    let first = harness.statuses.wait_for("unconfigured", |status| {
        status.state == ServiceState::Unconfigured
    });
    assert_eq!(first.findings.len(), 1);
    assert_eq!(first.findings[0].code, "required");
    assert!(!first.product_version.is_empty());
    assert_eq!(first.node_version, "24.0.0");
    assert_eq!(first.caddy_version, "2.11.0");
    // Nur Heartbeats, kein neuer Versuch
    let later = harness.statuses.wait_for("Heartbeat", |status| {
        status.heartbeat > first.heartbeat + time::Duration::milliseconds(100)
    });
    assert_eq!(later.state, ServiceState::Unconfigured);
    assert_eq!(
        later.since, first.since,
        "Heartbeat ändert den Zustand nicht"
    );
    assert_eq!(harness.plans.load(Ordering::SeqCst), 1);

    harness.stop();
    let all = harness.statuses.all();
    assert!(
        all.iter()
            .all(|status| status.app.pid.is_none() && status.proxy.pid.is_none()),
        "keine Kinder gestartet"
    );
    assert!(
        harness.urls.lock().unwrap().is_empty(),
        "keine Health-Abfrage"
    );
    assert_eq!(harness.statuses.last().state, ServiceState::Stopped);
}

#[test]
fn runs_and_reports_health() {
    let mut harness = Harness::running(steady_app(), steady_proxy());

    harness
        .statuses
        .wait_for("starting", |status| status.state == ServiceState::Starting);
    let running = harness
        .statuses
        .wait_for("running", |status| status.state == ServiceState::Running);
    let health = running.health.clone().expect("Health im Status");
    assert!(health.ok);
    assert_eq!(health.message, None);
    assert!(running.app.running && running.proxy.running);
    assert!(running.app.pid.is_some() && running.proxy.pid.is_some());
    assert_ne!(running.app.pid, running.proxy.pid);
    assert_eq!((running.app.restarts, running.proxy.restarts), (0, 0));
    assert_eq!(running.next_attempt, None);
    assert_eq!(
        harness.urls.lock().unwrap()[0],
        "http://127.0.0.1:3000/api/health"
    );

    harness.stop();
    let all = harness.statuses.all();
    let last = all.last().unwrap();
    assert_eq!(last.state, ServiceState::Stopped);
    assert!(!last.app.running && !last.proxy.running);
    assert!(
        all.iter()
            .any(|status| status.state == ServiceState::Stopping),
        "stopping vor stopped"
    );
}

#[test]
fn failing_health_never_restarts() {
    // Von Anfang an ungesund, sonst könnte die erste Abfrage noch gelingen
    let harness =
        Harness::start_with_health(Ok(plan(steady_app(), steady_proxy())), options(), false);

    let failing = harness.statuses.wait_for("Health failing", |status| {
        status.health.as_ref().is_some_and(|health| !health.ok)
    });
    assert_eq!(failing.health.unwrap().message.as_deref(), Some("HTTP 503"));
    let pid = failing.app.pid;
    thread::sleep(ms(300));

    let last = harness.statuses.last();
    assert_eq!(
        last.state,
        ServiceState::Starting,
        "nie running ohne Health"
    );
    assert_eq!(last.app.restarts, 0);
    assert_eq!(last.app.pid, pid);

    // Wird die App gesund, folgt running ohne Neustart
    harness.healthy.store(true, Ordering::SeqCst);
    let running = harness
        .statuses
        .wait_for("running", |status| status.state == ServiceState::Running);
    assert_eq!(running.app.pid, pid);
}

#[test]
fn config_error_stops_without_restart() {
    let app = dummy(
        ChildKind::App,
        &[
            ("DUMMY_STDERR", "[config] NUXT_DATABASE_URL fehlt"),
            ("DUMMY_EXIT", "1"),
        ],
    );
    let harness = Harness::running(app, steady_proxy());

    let failed = harness.statuses.wait_for("config_error", |status| {
        status.state == ServiceState::ConfigError
    });
    let error = failed.last_error.clone().expect("last_error gesetzt");
    assert_eq!(error.message, "NUXT_DATABASE_URL fehlt");
    assert_eq!(error.source, "app");
    assert!(
        !failed.app.running && !failed.proxy.running,
        "beide gestoppt"
    );
    assert_eq!(failed.next_attempt, None);

    thread::sleep(ms(500));
    let last = harness.statuses.last();
    assert_eq!(last.state, ServiceState::ConfigError);
    assert_eq!(last.app.restarts, 0);
    assert_eq!(last.proxy.restarts, 0);
    assert!(!last.proxy.running);
    assert!(last.heartbeat > failed.heartbeat, "Heartbeat läuft weiter");
}

#[test]
fn db_failure_backs_off_and_restarts() {
    let app = dummy(
        ChildKind::App,
        &[
            (
                "DUMMY_STDERR",
                "[db] Datenbankmigration fehlgeschlagen ConnectionError: Failed to connect to sql:1433",
            ),
            ("DUMMY_EXIT", "1"),
        ],
    );
    let harness = Harness::running(app, steady_proxy());

    let backoff = harness
        .statuses
        .wait_for("backoff", |status| status.state == ServiceState::Backoff);
    assert!(backoff.next_attempt.is_some());
    let error = backoff.last_error.expect("last_error gesetzt");
    assert_eq!(error.source, "app");
    assert!(
        error.message.starts_with("Datenbank nicht bereit"),
        "{}",
        error.message
    );

    let restarted = harness
        .statuses
        .wait_for("zwei Neustarts", |status| status.app.restarts >= 2);
    assert_eq!(restarted.proxy.restarts, 0, "nur die App neu gestartet");
    assert!(
        harness
            .statuses
            .all()
            .iter()
            .all(|status| status.state != ServiceState::ConfigError),
        "nie config_error"
    );
}

#[test]
fn recovers_when_the_database_comes_back() {
    // Boot ohne SQL Server: zweimal `[db] …`, danach läuft die App von selbst
    let dir = TempDir::new().unwrap();
    let counter = dir.path().join("starts.txt");
    let app = dummy(
        ChildKind::App,
        &[
            ("DUMMY_COUNTER", counter.to_str().unwrap()),
            ("DUMMY_FAIL_TIMES", "2"),
            (
                "DUMMY_STDERR",
                "[db] Datenbankmigration fehlgeschlagen ConnectionError: Failed to connect to sql:1433",
            ),
            ("DUMMY_EXIT", "1"),
        ],
    );
    let harness = Harness::running(app, steady_proxy());

    let running = harness
        .statuses
        .wait_for("running nach zwei Fehlversuchen", |status| {
            status.state == ServiceState::Running
        });

    assert_eq!(running.app.restarts, 2);
    assert_eq!(running.next_attempt, None);
    let all = harness.statuses.all();
    let backoffs = all
        .iter()
        .filter(|status| status.state == ServiceState::Backoff)
        .count();
    assert!(backoffs >= 2, "{backoffs} Backoff-Status");
    assert!(
        all.iter()
            .all(|status| status.state != ServiceState::ConfigError)
    );
    assert_eq!(fs::read_to_string(&counter).unwrap(), "3");
}

#[test]
fn stop_during_long_backoff_is_quick() {
    let app = dummy(
        ChildKind::App,
        &[
            ("DUMMY_STDERR", "[db] Datenbankmigration fehlgeschlagen"),
            ("DUMMY_EXIT", "1"),
        ],
    );
    let options = SupervisorOptions {
        backoff_base: Duration::from_secs(60),
        backoff_max: Duration::from_secs(60),
        ..options()
    };
    let mut harness = Harness::start(Ok(plan(app, steady_proxy())), options);
    harness
        .statuses
        .wait_for("backoff", |status| status.state == ServiceState::Backoff);

    let took = harness.stop();

    assert!(took < Duration::from_secs(1), "Stopp dauerte {took:?}");
    let last = harness.statuses.last();
    assert_eq!(last.state, ServiceState::Stopped);
    assert_eq!(last.next_attempt, None);
    assert_eq!(last.app.restarts, 0);
}

#[test]
fn proxy_crash_restarts_only_proxy() {
    let proxy = dummy(
        ChildKind::Proxy,
        &[
            (
                "DUMMY_STDERR",
                "Error: loading new config: http app module: start: listening on :443: listen tcp :443: bind: address already in use",
            ),
            ("DUMMY_EXIT", "1"),
        ],
    );
    let harness = Harness::running(steady_app(), proxy);

    let restarted = harness
        .statuses
        .wait_for("zwei Proxy-Neustarts", |status| status.proxy.restarts >= 2);
    let error = restarted.last_error.clone().expect("last_error gesetzt");
    assert_eq!(error.source, "proxy");
    assert!(error.message.contains("Port 443"), "{}", error.message);

    let all = harness.statuses.all();
    let app_pids: Vec<_> = all.iter().filter_map(|status| status.app.pid).collect();
    assert!(!app_pids.is_empty());
    assert!(
        app_pids.iter().all(|pid| *pid == app_pids[0]),
        "App läuft ungestört weiter"
    );
    assert!(all.iter().all(|status| status.app.restarts == 0));
    assert!(
        all.iter()
            .any(|status| status.state == ServiceState::Backoff)
    );
}

#[test]
fn graceful_stop_via_stdin_eof() {
    let mut options = options();
    // Lang genug, dass ein schnelles Ende nur vom geordneten Beenden kommen kann
    options.stop_timeout = Duration::from_secs(10);
    let mut harness = Harness::start(Ok(plan(steady_app(), steady_proxy())), options);
    harness
        .statuses
        .wait_for("running", |status| status.state == ServiceState::Running);

    let took = harness.stop();

    assert!(took < ms(500), "Stopp dauerte {took:?}");
    let log = harness.app_log.text();
    assert!(log.contains("Exit-Code 0"), "{log}");
    assert_eq!(harness.statuses.last().state, ServiceState::Stopped);
}

#[test]
fn kill_after_timeout() {
    let app = dummy(ChildKind::App, &[("DUMMY_IGNORE_STDIN", "1")]);
    let mut harness = Harness::running(app, steady_proxy());
    let running = harness
        .statuses
        .wait_for("running", |status| status.state == ServiceState::Running);
    let pid = running.app.pid.unwrap();

    let took = harness.stop();

    assert!(took >= ms(450), "zu früh beendet: {took:?}");
    assert!(took < Duration::from_secs(5), "Stopp dauerte {took:?}");
    let log = harness.app_log.text();
    assert!(log.contains("Prozess beendet"), "{log}");
    #[cfg(target_os = "linux")]
    assert!(!process_exists(pid), "PID {pid} läuft noch");
    let _ = pid;
    assert_eq!(harness.statuses.last().state, ServiceState::Stopped);
}

#[test]
fn proxy_receives_payload_on_stdin() {
    let dir = TempDir::new().unwrap();
    let target = dir.path().join("stdin.txt");
    // Größer als jeder Pipe-Puffer, damit ein blockierendes Schreiben auffiele
    let payload = format!("{{\"apps\":\"{}\"}}", "x".repeat(300_000));
    let mut proxy = dummy(
        ChildKind::Proxy,
        &[
            ("DUMMY_STDIN_TO", target.to_str().unwrap()),
            ("DUMMY_IGNORE_STDIN", "1"),
        ],
    );
    proxy.stdin_payload = Some(Secret::new(payload.clone()));
    let _harness = Harness::running(steady_app(), proxy);

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if fs::read_to_string(&target).is_ok_and(|text| text == payload) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Payload nicht vollständig angekommen"
        );
        thread::sleep(ms(20));
    }
}

#[test]
fn output_is_redacted() {
    let secret = "Geheim-Pa55wort";
    let app = dummy(
        ChildKind::App,
        &[
            ("DUMMY_STDOUT", "Verbinde mit Passwort Geheim-Pa55wort"),
            (
                "DUMMY_STDERR",
                "Fehler: Login mit Geheim-Pa55wort abgelehnt",
            ),
            ("DUMMY_EXIT", "1"),
        ],
    );
    let proxy = dummy(
        ChildKind::Proxy,
        &[
            ("DUMMY_STDERR", "Schlüssel Geheim-Pa55wort geladen"),
            ("DUMMY_IGNORE_STDIN", "1"),
        ],
    );
    let mut launch = plan(app, proxy);
    launch.redactor = Redactor::new([secret.to_owned()]);
    let harness = Harness::start(Ok(launch), options());

    let backoff = harness
        .statuses
        .wait_for("backoff", |status| status.state == ServiceState::Backoff);
    let message = backoff.last_error.unwrap().message;
    assert!(!message.contains(secret), "{message}");
    assert!(message.contains("***"), "{message}");

    let app_log = harness.app_log.wait_for("abgelehnt");
    harness.app_log.wait_for("Passwort ***");
    assert!(app_log.contains("Login mit *** abgelehnt"), "{app_log}");
    let proxy_log = harness.proxy_log.wait_for("geladen");
    assert!(proxy_log.contains("Schlüssel *** geladen"), "{proxy_log}");
    assert!(!harness.app_log.text().contains(secret));
    assert!(!harness.proxy_log.text().contains(secret));
}

#[test]
fn long_error_is_redacted_before_shortening() {
    // Das Secret liegt genau über der Grenze von 300 Zeichen der Meldung
    let secret = "Geheim-Grenze-1234567";
    let prefix = "Anwendung beendet (Exit-Code 1): ";
    let filler = "x".repeat(290 - prefix.chars().count());
    let line = format!("{filler}{secret} und noch mehr Text dahinter");
    let app = dummy(
        ChildKind::App,
        &[("DUMMY_STDERR", line.as_str()), ("DUMMY_EXIT", "1")],
    );
    let mut launch = plan(app, steady_proxy());
    launch.redactor = Redactor::new([secret.to_owned()]);
    let harness = Harness::start(Ok(launch), options());

    let backoff = harness
        .statuses
        .wait_for("backoff", |status| status.state == ServiceState::Backoff);
    let message = backoff.last_error.unwrap().message;

    assert!(message.starts_with(prefix), "{message}");
    assert!(
        message.chars().count() <= 300,
        "{}",
        message.chars().count()
    );
    assert!(
        !message.contains("Geheim"),
        "Anfang des Secrets sichtbar: {message}"
    );
    assert!(message.contains("***"), "{message}");
}

#[test]
fn spawn_failure_backs_off() {
    let mut app = steady_app();
    app.program = std::env::temp_dir().join("pds-gibt-es-nicht").join("node");
    let harness = Harness::running(app, steady_proxy());

    let backoff = harness
        .statuses
        .wait_for("backoff", |status| status.state == ServiceState::Backoff);
    let error = backoff.last_error.unwrap();
    assert_eq!(error.source, "app");
    assert!(
        error.message.contains("konnte nicht gestartet werden"),
        "{}",
        error.message
    );
    harness
        .statuses
        .wait_for("Neustartversuch", |status| status.app.restarts >= 1);
}

#[test]
fn warnings_of_the_plan_reach_the_status() {
    let mut launch = plan(steady_app(), steady_proxy());
    launch.findings = vec![Finding {
        severity: Severity::Warning,
        ..finding("certificate_expires_soon")
    }];
    let not_after = time::OffsetDateTime::now_utc() + time::Duration::days(10);
    launch.certificate_not_after = Some(not_after);
    let harness = Harness::start(Ok(launch), options());

    let status = harness
        .statuses
        .wait_for("starting", |status| status.state == ServiceState::Starting);
    assert_eq!(status.findings[0].code, "certificate_expires_soon");
    assert_eq!(status.certificate_not_after, Some(not_after));
}

// ---------------------------------------------------------------------------------------------
// Produktive Bausteine
// ---------------------------------------------------------------------------------------------

fn temp_paths(dir: &TempDir) -> Paths {
    let paths = Paths::new(dir.path().join("install"), dir.path().join("data"));
    fs::create_dir_all(&paths.data_dir).unwrap();
    paths
}

/// Gültig ohne Zertifikat: Modus `internal`, alle Pflichtfelder und Secrets gesetzt.
fn write_valid_config(paths: &Paths, db_password: &str) {
    let protector = system_protector();
    let mut config = Config::default();
    config.public.host = "trainee.example.com".into();
    config.tls.mode = TlsMode::Internal;
    config.db.server = "sql.example.com".into();
    config.oidc.tenant_id = "11111111-2222-3333-4444-555555555555".into();
    config.oidc.client_id = "11111111-2222-3333-4444-666666666666".into();
    config.internal.port = 3123;
    for (field, value) in [
        (SecretField::DbPassword, db_password),
        (SecretField::OidcClientSecret, "client-secret"),
        (SecretField::AppSecret, &"x".repeat(64)),
    ] {
        config
            .seal(field, Some(&Secret::new(value)), &*protector)
            .unwrap();
    }
    config::save(&paths.config_file(), &config).unwrap();
}

fn env_value<'a>(spec: &'a ChildSpec, name: &str) -> Option<&'a str> {
    spec.env
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.expose())
}

#[test]
fn unreadable_config_is_unconfigured() {
    let dir = TempDir::new().unwrap();
    let paths = temp_paths(&dir);
    fs::write(paths.config_file(), "[public\nhost = ").unwrap();

    let findings = ConfigPlanner::new(paths, system_protector())
        .plan()
        .expect_err("kaputte Konfiguration");

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, "config_unreadable");
    assert_eq!(findings[0].severity, Severity::Error);
}

#[test]
fn config_planner_renders_valid_config() {
    let dir = TempDir::new().unwrap();
    let paths = temp_paths(&dir);
    let password = "Pa'ss@w%rd #1";
    write_valid_config(&paths, password);

    let plan = ConfigPlanner::new(paths.clone(), system_protector())
        .plan()
        .expect("gültige Konfiguration");

    let app = &plan.app;
    assert_eq!(app.kind, ChildKind::App);
    assert_eq!(app.program, paths.node_exe());
    assert_eq!(
        app.args,
        vec![
            OsString::from("--use-system-ca"),
            paths.app_entry().into_os_string()
        ]
    );
    assert_eq!(app.cwd, paths.install_dir.join("app"));
    assert!(app.keep_stdin_open);
    assert!(app.stdin_payload.is_none());
    assert_eq!(env_value(app, "PORT"), Some("3123"));
    assert!(env_value(app, "NUXT_DATABASE_URL").is_some());
    assert!(env_value(app, "PATH").is_some(), "Basis-Umgebung");
    // Die Web-Konsole zeigt die Logs des Dienstes
    assert_eq!(
        env_value(app, "NUXT_LOG_DIR"),
        Some(paths.logs_dir().to_string_lossy().as_ref())
    );
    // PowerShell und net.exe für das Netzlaufwerk brauchen mehr als die Basis von Caddy
    #[cfg(windows)]
    {
        for name in ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP"] {
            assert!(env_value(app, name).is_some(), "{name}");
        }
        let path = env_value(app, "PATH").unwrap().to_ascii_lowercase();
        assert!(path.contains(r"\system32\windowspowershell\v1.0"), "{path}");
        assert!(
            env_value(&plan.proxy, "ComSpec").is_none(),
            "Caddy bleibt minimal"
        );
    }

    let proxy = &plan.proxy;
    assert_eq!(proxy.kind, ChildKind::Proxy);
    assert_eq!(proxy.program, paths.caddy_exe());
    assert_eq!(
        proxy.args,
        // Ohne `--adapter`: JSON ist Caddys eigenes Format
        ["run", "--config", "-"].map(OsString::from).to_vec()
    );
    assert!(!proxy.keep_stdin_open);
    let payload = proxy.stdin_payload.as_ref().expect("Caddy-JSON");
    let json: serde_json::Value = serde_json::from_str(payload.expose()).unwrap();
    assert_eq!(json["admin"]["disabled"], true);
    assert!(env_value(proxy, "XDG_DATA_HOME").is_some());
    assert!(
        env_value(proxy, "NUXT_DATABASE_URL").is_none(),
        "Caddy bekommt keine App-Secrets"
    );
    // Ohne `caddy\` im Datenordner der Installationsordner
    assert_eq!(proxy.cwd, paths.install_dir);

    assert_eq!(plan.health_url, "http://127.0.0.1:3123/api/health");
    assert_eq!(plan.certificate_not_after, None);
    assert!(plan.findings.iter().all(|f| f.severity != Severity::Error));
    let line = format!(
        "Login {password} und {}",
        env_value(app, "NUXT_DATABASE_URL").unwrap()
    );
    let redacted = plan.redactor.redact(&line);
    assert!(!redacted.contains(password), "{redacted}");
    assert!(!redacted.contains("mssql://"), "{redacted}");
}

#[test]
fn config_planner_runs_caddy_in_its_data_folder() {
    let dir = TempDir::new().unwrap();
    let paths = temp_paths(&dir);
    write_valid_config(&paths, "Pa55wort!");
    fs::create_dir_all(paths.caddy_dir()).unwrap();

    let plan = ConfigPlanner::new(paths.clone(), system_protector())
        .plan()
        .unwrap();

    assert_eq!(plan.proxy.cwd, paths.caddy_dir());
}

/// Wie im Dienst: Konfiguration, Statusdatei und Logs aus dem Datenordner.
fn run_production(paths: &Paths) -> (StopSignal, JoinHandle<()>) {
    fs::create_dir_all(paths.logs_dir()).unwrap();
    let options = SupervisorOptions {
        heartbeat: ms(50),
        backoff_base: ms(50),
        backoff_max: ms(200),
        ..SupervisorOptions::default()
    };
    let supervisor = build_production(paths, options);
    let stop = StopSignal::new();
    let remote = stop.clone();
    (stop, thread::spawn(move || supervisor.run(&remote)))
}

fn wait_for_file(paths: &Paths, condition: impl Fn(&Status) -> bool) -> Status {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(Some(status)) = status::read(&paths.status_file())
            && condition(&status)
        {
            return status;
        }
        assert!(Instant::now() < deadline, "Status nicht erreicht");
        thread::sleep(ms(10));
    }
}

#[test]
fn production_reports_unconfigured_heartbeat_and_stopped() {
    let dir = TempDir::new().unwrap();
    let paths = temp_paths(&dir);
    fs::write(paths.config_file(), "[db]\npassword = \"Zx9-Geheimwert\"\n").unwrap();

    let (stop, worker) = run_production(&paths);
    let first = wait_for_file(&paths, |status| status.state == ServiceState::Unconfigured);
    assert_eq!(first.findings[0].code, "config_unreadable");
    let later = wait_for_file(&paths, |status| status.heartbeat > first.heartbeat);
    assert_eq!(later.since, first.since);

    stop.stop();
    worker.join().unwrap();
    let last = status::read(&paths.status_file()).unwrap().unwrap();
    assert_eq!(last.state, ServiceState::Stopped);
    let raw = fs::read_to_string(paths.status_file()).unwrap();
    assert!(!raw.contains("Zx9-Geheimwert"));
}

#[test]
fn production_backs_off_without_binaries() {
    let dir = TempDir::new().unwrap();
    let paths = temp_paths(&dir);
    write_valid_config(&paths, "Pa55wort!");

    let (stop, worker) = run_production(&paths);
    let backoff = wait_for_file(&paths, |status| status.state == ServiceState::Backoff);
    assert!(
        backoff
            .findings
            .iter()
            .all(|f| f.severity != Severity::Error)
    );
    let message = backoff.last_error.unwrap().message;
    assert!(
        message.contains("konnte nicht gestartet werden"),
        "{message}"
    );

    stop.stop();
    worker.join().unwrap();
    let last = status::read(&paths.status_file()).unwrap().unwrap();
    assert_eq!(last.state, ServiceState::Stopped);
    assert!(paths.logs_dir().join("app.log").is_file());
    assert!(paths.logs_dir().join("caddy.log").is_file());
}
