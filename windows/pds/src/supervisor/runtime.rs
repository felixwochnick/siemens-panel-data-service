//! Laufzeit des Supervisors: startet Caddy und Node, beobachtet sie, startet nach Fehlern neu und
//! beendet sie geordnet.
//!
//! Threads (std, ohne Async-Runtime): Der Thread von [`Supervisor::run`] besitzt den ganzen Zustand
//! und wartet auf einem `mpsc`-Kanal. Dorthin melden sich die Lesethreads der Kinder (Pipe zu),
//! der Health-Thread (eine Abfrage kann Sekunden dauern und darf das Beenden nicht aufhalten) und
//! ein Thread, der das Haltesignal weiterreicht. Das Ende eines Kindes erkennt `try_wait`, sofort
//! nach dem Schließen seiner Pipes und sonst spätestens nach [`POLL_INTERVAL`].

use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::io::Write;
use std::process::ExitStatus;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pds_common::names::product_version;
use pds_common::platform::JobObject;
use pds_common::status::{
    ChildStatus, ErrorInfo, HEARTBEAT_INTERVAL, HealthStatus, ServiceState, Status,
};
use time::OffsetDateTime;

use super::planner::{LaunchPlan, LaunchPlanner};
use super::process::{self, ChildSpec, OutputClosed, RunningChild, SharedLog, code_text, name};
use super::{Backoff, ChildKind, ExitClass, Redactor, classify_exit, shorten_message};
use crate::daemon::{Runner, StopSignal};

/// Spätestens so oft prüft der Supervisor, ob ein Kind beendet ist (falls ein Enkel dessen Pipes
/// offen hält und deshalb keine Nachricht kommt).
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Nach dem Schließen der Pipes so lange auf das Ende des Kindes warten.
const EXIT_GRACE: Duration = Duration::from_millis(100);
/// Bis zum ersten erfolgreichen Health-Check wird öfter gefragt, damit `running` früh erscheint.
const STARTUP_PROBE_INTERVAL: Duration = Duration::from_secs(1);

/// Zeiten des Supervisors; die Standardwerte gelten im Betrieb, Tests verkürzen sie.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorOptions {
    /// Abstand der Health-Abfragen.
    pub health_interval: Duration,
    /// So lange darf Node nach dem Schließen von stdin für laufende Anfragen brauchen.
    pub stop_timeout: Duration,
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Läuft ein Kind so lange, beginnt sein Backoff beim nächsten Ende wieder bei `backoff_base`.
    pub stable_run: Duration,
    /// Abstand der Lebenszeichen in `status.json`.
    pub heartbeat: Duration,
}

impl Default for SupervisorOptions {
    fn default() -> Self {
        Self {
            health_interval: Duration::from_secs(10),
            stop_timeout: Duration::from_secs(15),
            backoff_base: Duration::from_secs(2),
            backoff_max: Duration::from_secs(300),
            stable_run: Duration::from_secs(600),
            heartbeat: HEARTBEAT_INTERVAL,
        }
    }
}

/// Fragt die Bereitschaft der App ab. Das Ergebnis geht nur in den Status, nie in einen Neustart.
pub trait HealthProbe: Send {
    /// `Err` mit einer kurzen deutschen Meldung.
    fn check(&mut self, url: &str) -> Result<(), String>;
}

/// Nimmt jeden Status entgegen: bei jeder Änderung und als Heartbeat.
pub trait StatusSink: Send {
    fn publish(&mut self, status: &Status);
}

/// Wohin die Ausgabe der Kinder geht (zeilenweise, geschwärzt, mit Zeitstempel).
pub struct LogSinks {
    pub app: Box<dyn Write + Send>,
    pub proxy: Box<dyn Write + Send>,
}

/// Startet und überwacht Caddy (Proxy) und Node (App).
pub struct Supervisor {
    planner: Box<dyn LaunchPlanner>,
    probe: Box<dyn HealthProbe>,
    sink: Box<dyn StatusSink>,
    logs: LogSinks,
    /// Versionen von Node und Caddy für den Status.
    versions: (String, String),
    options: SupervisorOptions,
}

impl Supervisor {
    pub fn new(
        planner: impl LaunchPlanner + 'static,
        probe: impl HealthProbe + 'static,
        sink: impl StatusSink + 'static,
        logs: LogSinks,
        versions: (String, String),
        options: SupervisorOptions,
    ) -> Self {
        Self {
            planner: Box::new(planner),
            probe: Box::new(probe),
            sink: Box::new(sink),
            logs,
            versions,
            options,
        }
    }

    /// Läuft, bis `stop` ausgelöst ist und beide Kinder beendet sind. Der letzte Status ist
    /// `stopped`.
    pub fn run(self, stop: &StopSignal) {
        let Self {
            mut planner,
            probe,
            sink,
            logs,
            versions,
            options,
        } = self;
        let mut reporter = Reporter::new(sink, versions);

        match planner.plan() {
            Err(findings) => {
                // Ohne gültige Konfiguration kein neuer Versuch: Erst ein Neustart des Dienstes
                // (Speichern in UI oder CLI) liest sie erneut
                reporter.status.findings = findings;
                reporter.set_state(ServiceState::Unconfigured);
                reporter.publish();
                while !stop.wait(options.heartbeat) {
                    reporter.publish();
                }
            }
            Ok(plan) => {
                reporter.status.findings = plan.findings.clone();
                reporter.status.certificate_not_after = plan.certificate_not_after;
                if !stop.is_stopped() {
                    Runtime::new(plan, reporter, logs, options).run(probe, stop);
                    return;
                }
            }
        }
        reporter.set_state(ServiceState::Stopped);
        reporter.publish();
        tracing::info!("Dienst beendet");
    }
}

impl Runner for Supervisor {
    fn run(self, stop: &StopSignal) {
        Supervisor::run(self, stop);
    }
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/// Hält den Status und gibt ihn an die Senke weiter.
struct Reporter {
    sink: Box<dyn StatusSink>,
    status: Status,
    last_publish: Instant,
}

impl Reporter {
    fn new(sink: Box<dyn StatusSink>, (node_version, caddy_version): (String, String)) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            sink,
            status: Status {
                state: ServiceState::Starting,
                since: now,
                heartbeat: now,
                product_version: product_version().to_owned(),
                node_version,
                caddy_version,
                health: None,
                last_error: None,
                next_attempt: None,
                findings: Vec::new(),
                certificate_not_after: None,
                app: ChildStatus::default(),
                proxy: ChildStatus::default(),
            },
            last_publish: Instant::now(),
        }
    }

    /// `since` ändert sich nur bei einem anderen Zustand.
    fn set_state(&mut self, state: ServiceState) {
        if self.status.state != state {
            self.status.state = state;
            self.status.since = OffsetDateTime::now_utc();
        }
    }

    fn publish(&mut self) {
        self.status.heartbeat = OffsetDateTime::now_utc();
        self.sink.publish(&self.status);
        self.last_publish = Instant::now();
    }
}

// ---------------------------------------------------------------------------------------------
// Laufzeit
// ---------------------------------------------------------------------------------------------

/// Nachrichten an den Supervisor-Thread.
enum Event {
    Output(OutputClosed),
    Health {
        generation: u64,
        result: Result<(), String>,
        checked_at: OffsetDateTime,
    },
    Stop,
}

impl From<OutputClosed> for Event {
    fn from(closed: OutputClosed) -> Self {
        Self::Output(closed)
    }
}

struct HealthRequest {
    /// Start der App, für den gefragt wird; spätere Antworten zu alten Starts zählen nicht.
    generation: u64,
    url: String,
}

/// Ein Kind mit allem, was über seine Starts hinweg bleibt.
struct Slot {
    spec: ChildSpec,
    log: SharedLog,
    backoff: Backoff,
    running: Option<RunningChild>,
    /// Geplanter Neustart (monoton für den Ablauf, Uhrzeit für den Status).
    restart_at: Option<(Instant, OffsetDateTime)>,
    restarts: u32,
}

impl Slot {
    fn new(spec: ChildSpec, log: Box<dyn Write + Send>, options: &SupervisorOptions) -> Self {
        Self {
            spec,
            log: Arc::new(Mutex::new(log)),
            backoff: Backoff::new(options.backoff_base, options.backoff_max),
            running: None,
            restart_at: None,
            restarts: 0,
        }
    }

    fn child_status(&self) -> ChildStatus {
        ChildStatus {
            pid: self.running.as_ref().map(RunningChild::pid),
            running: self.running.is_some(),
            restarts: self.restarts,
        }
    }

    fn schedule_restart(&mut self, ran_for: Duration, stable_run: Duration) -> Duration {
        let delay = retry_delay(&mut self.backoff, ran_for, stable_run, jitter());
        self.restart_at = Some((Instant::now() + delay, OffsetDateTime::now_utc() + delay));
        delay
    }
}

struct Runtime {
    app: Slot,
    proxy: Slot,
    health_url: String,
    redactor: Redactor,
    reporter: Reporter,
    options: SupervisorOptions,
    /// Unter Windows beendet es beim Schließen alle Kinder, auch wenn der Dienst abstürzt.
    job: Option<JobObject>,
    events_tx: Sender<Event>,
    events: Receiver<Event>,
    /// Zählt jeden Start, damit Nachrichten zu einem früheren Start erkennbar sind.
    generation: u64,
    next_health: Instant,
    health_in_flight: bool,
    /// Die laufende App hat mindestens einmal den Health-Check bestanden.
    app_healthy: bool,
    config_error: bool,
    stopping: bool,
    /// Der Status hat sich geändert und muss geschrieben werden.
    dirty: bool,
}

impl Runtime {
    fn new(
        plan: LaunchPlan,
        reporter: Reporter,
        logs: LogSinks,
        options: SupervisorOptions,
    ) -> Self {
        let job = match JobObject::new_kill_on_close() {
            Ok(job) => Some(job),
            Err(error) => {
                tracing::warn!("Job Object nicht verfügbar, Kinder laufen ohne: {error}");
                None
            }
        };
        let (events_tx, events) = mpsc::channel();
        Self {
            app: Slot::new(plan.app, logs.app, &options),
            proxy: Slot::new(plan.proxy, logs.proxy, &options),
            health_url: plan.health_url,
            redactor: plan.redactor,
            reporter,
            options,
            job,
            events_tx,
            events,
            generation: 0,
            next_health: Instant::now(),
            health_in_flight: false,
            app_healthy: false,
            config_error: false,
            stopping: false,
            dirty: true,
        }
    }

    fn run(mut self, probe: Box<dyn HealthProbe>, stop: &StopSignal) {
        forward_stop(stop, self.events_tx.clone());
        let health = spawn_health(probe, self.events_tx.clone());

        // Caddy zuerst: Er belegt die Ports früh, und ein belegter Port zeigt sich gleich
        self.start(ChildKind::Proxy, false);
        self.start(ChildKind::App, false);

        loop {
            self.start_due_restarts();
            self.request_health(&health);
            self.refresh();
            if self.dirty || Instant::now() >= self.reporter.last_publish + self.options.heartbeat {
                self.reporter.publish();
                self.dirty = false;
            }

            let timeout = self.next_wake().saturating_duration_since(Instant::now());
            match self.events.recv_timeout(timeout) {
                Ok(Event::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(Event::Output(closed)) => self.on_output_closed(closed),
                Ok(Event::Health {
                    generation,
                    result,
                    checked_at,
                }) => self.on_health(generation, result, checked_at),
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.poll_exits();
        }
        self.shutdown();
    }

    fn slot_mut(&mut self, kind: ChildKind) -> &mut Slot {
        match kind {
            ChildKind::App => &mut self.app,
            ChildKind::Proxy => &mut self.proxy,
        }
    }

    // --- Starten ---------------------------------------------------------------------------

    fn start(&mut self, kind: ChildKind, restart: bool) {
        self.generation += 1;
        let generation = self.generation;
        let job = self.job.as_ref();
        let redactor = &self.redactor;
        let events = &self.events_tx;
        let slot = match kind {
            ChildKind::App => &mut self.app,
            ChildKind::Proxy => &mut self.proxy,
        };
        slot.restart_at = None;
        if restart {
            slot.restarts += 1;
        }
        let spawned = process::spawn(&slot.spec, generation, job, &slot.log, redactor, events);
        match spawned {
            Ok(child) => {
                tracing::info!("{} gestartet (PID {})", name(kind), child.pid());
                slot.running = Some(child);
                if kind == ChildKind::App {
                    self.app_healthy = false;
                    self.next_health = Instant::now() + self.probe_interval();
                }
            }
            Err(error) => {
                // Wie ein Absturz: Ein fehlendes Programm kann ein Update gerade ersetzen
                let delay = slot.schedule_restart(Duration::ZERO, self.options.stable_run);
                let message = report_message(&self.redactor, &error.0);
                tracing::warn!("{message}; neuer Versuch in {:.1} s", delay.as_secs_f64());
                self.set_error(kind, message);
            }
        }
        self.dirty = true;
    }

    fn start_due_restarts(&mut self) {
        let now = Instant::now();
        for kind in [ChildKind::Proxy, ChildKind::App] {
            let due = self
                .slot_mut(kind)
                .restart_at
                .is_some_and(|(at, _)| at <= now);
            if due {
                self.start(kind, true);
            }
        }
    }

    // --- Health ----------------------------------------------------------------------------

    fn probe_interval(&self) -> Duration {
        if self.app_healthy {
            self.options.health_interval
        } else {
            self.options.health_interval.min(STARTUP_PROBE_INTERVAL)
        }
    }

    fn request_health(&mut self, health: &Sender<HealthRequest>) {
        let Some(app) = &self.app.running else {
            return;
        };
        if self.health_in_flight || Instant::now() < self.next_health {
            return;
        }
        let request = HealthRequest {
            generation: app.generation,
            url: self.health_url.clone(),
        };
        if health.send(request).is_ok() {
            self.health_in_flight = true;
        }
        self.next_health = Instant::now() + self.probe_interval();
    }

    fn on_health(
        &mut self,
        generation: u64,
        result: Result<(), String>,
        checked_at: OffsetDateTime,
    ) {
        self.health_in_flight = false;
        let current = self.app.running.as_ref().map(|app| app.generation);
        if current != Some(generation) {
            return;
        }
        let ok = result.is_ok();
        let message = result
            .err()
            .map(|message| report_message(&self.redactor, &message));
        if ok && !self.app_healthy {
            tracing::info!("Anwendung bereit");
            self.app_healthy = true;
        }
        self.reporter.status.health = Some(HealthStatus {
            ok,
            checked_at,
            message,
        });
        self.dirty = true;
    }

    // --- Ende eines Kindes -----------------------------------------------------------------

    fn on_output_closed(&mut self, closed: OutputClosed) {
        let slot = self.slot_mut(closed.kind);
        let Some(child) = slot.running.as_mut() else {
            return;
        };
        if child.generation != closed.generation {
            return;
        }
        // Die Pipe schließt kurz vor dem Prozessende; kurz warten statt bis zur nächsten Runde
        if let Some(status) = child.wait_timeout(EXIT_GRACE) {
            let child = slot.running.take().expect("gerade geprüft");
            self.on_exit(closed.kind, child, Some(status));
        }
    }

    fn poll_exits(&mut self) {
        // Die App zuerst: Ihr Konfigurationsfehler stoppt auch den Proxy
        for kind in [ChildKind::App, ChildKind::Proxy] {
            let slot = self.slot_mut(kind);
            let Some(status) = slot.running.as_mut().and_then(RunningChild::try_wait) else {
                continue;
            };
            let child = slot.running.take().expect("gerade geprüft");
            self.on_exit(kind, child, Some(status));
        }
    }

    fn on_exit(&mut self, kind: ChildKind, child: RunningChild, status: Option<ExitStatus>) {
        let pid = child.pid();
        let ended = child.finish(status);
        if kind == ChildKind::App {
            self.app_healthy = false;
            self.reporter.status.health = None;
        }
        // Eingeordnet wird auf den ungeschwärzten Zeilen; die Meldung wird geschwärzt, dann gekürzt
        match classify_exit(kind, ended.code, &ended.stderr_tail) {
            ExitClass::ConfigError(message) => {
                let message = report_message(&self.redactor, &message);
                tracing::error!(
                    "{} (PID {pid}) lehnt ihre Konfiguration ab: {message}",
                    name(kind)
                );
                self.set_error(kind, message);
                // Kein Neustart, bis der Dienst neu gestartet wird (Speichern in UI oder CLI)
                self.config_error = true;
                self.app.restart_at = None;
                self.proxy.restart_at = None;
                self.stop_children();
            }
            ExitClass::Retry(message) => {
                let message = report_message(&self.redactor, &message);
                let stable_run = self.options.stable_run;
                let delay = self
                    .slot_mut(kind)
                    .schedule_restart(ended.ran_for, stable_run);
                tracing::warn!(
                    "{} (PID {pid}, Exit-Code {}) beendet: {message}; neuer Versuch in {:.1} s",
                    name(kind),
                    code_text(ended.code),
                    delay.as_secs_f64()
                );
                self.set_error(kind, message);
            }
        }
        self.dirty = true;
    }

    fn set_error(&mut self, kind: ChildKind, message: String) {
        let source = match kind {
            ChildKind::App => "app",
            ChildKind::Proxy => "proxy",
        };
        self.reporter.status.last_error = Some(ErrorInfo {
            at: OffsetDateTime::now_utc(),
            source: source.to_owned(),
            message,
        });
    }

    // --- Zustand ---------------------------------------------------------------------------

    fn derive_state(&self) -> ServiceState {
        if self.stopping {
            ServiceState::Stopping
        } else if self.config_error {
            ServiceState::ConfigError
        } else if self.app.restart_at.is_some() || self.proxy.restart_at.is_some() {
            ServiceState::Backoff
        } else if self.app_healthy && self.app.running.is_some() && self.proxy.running.is_some() {
            ServiceState::Running
        } else {
            ServiceState::Starting
        }
    }

    /// Übernimmt Zustand, Kinder und nächsten Versuch in den Status; markiert ihn bei Änderung.
    fn refresh(&mut self) {
        let state = self.derive_state();
        let app = self.app.child_status();
        let proxy = self.proxy.child_status();
        let next_attempt = [self.app.restart_at, self.proxy.restart_at]
            .into_iter()
            .flatten()
            .map(|(_, at)| at)
            .min();
        let status = &self.reporter.status;
        if status.state != state
            || status.app != app
            || status.proxy != proxy
            || status.next_attempt != next_attempt
        {
            self.reporter.set_state(state);
            let status = &mut self.reporter.status;
            status.app = app;
            status.proxy = proxy;
            status.next_attempt = next_attempt;
            self.dirty = true;
        }
    }

    fn next_wake(&self) -> Instant {
        let mut wake = (self.reporter.last_publish + self.options.heartbeat)
            .min(Instant::now() + POLL_INTERVAL);
        if self.app.running.is_some() && !self.health_in_flight {
            wake = wake.min(self.next_health);
        }
        for (at, _) in [self.app.restart_at, self.proxy.restart_at]
            .into_iter()
            .flatten()
        {
            wake = wake.min(at);
        }
        wake
    }

    // --- Beenden ---------------------------------------------------------------------------

    /// App: stdin schließen, bis `stop_timeout` warten, sonst hart beenden. Danach den Proxy.
    fn stop_children(&mut self) {
        if let Some(mut app) = self.app.running.take() {
            app.close_stdin();
            let status = match app.wait_timeout(self.options.stop_timeout) {
                Some(status) => Some(status),
                None => {
                    tracing::warn!(
                        "Anwendung (PID {}) hat sich nicht innerhalb von {:.1} s beendet und wird \
                         hart beendet",
                        app.pid(),
                        self.options.stop_timeout.as_secs_f64()
                    );
                    app.kill()
                }
            };
            let ended = app.finish(status);
            tracing::info!("Anwendung beendet (Exit-Code {})", code_text(ended.code));
        }
        // Caddy hat kein geordnetes Ende über stdin; offene Verbindungen sind dann ohnehin weg
        if let Some(mut proxy) = self.proxy.running.take() {
            let status = proxy.kill();
            proxy.finish(status);
            tracing::info!("Proxy beendet");
        }
        self.app_healthy = false;
        self.reporter.status.health = None;
    }

    fn shutdown(mut self) {
        tracing::info!("Dienst wird beendet");
        self.stopping = true;
        self.app.restart_at = None;
        self.proxy.restart_at = None;
        self.refresh();
        self.reporter.publish();

        self.stop_children();
        // Schließen beendet, was noch im Job Object ist (etwa Enkel der Kinder)
        self.job = None;

        self.refresh();
        self.reporter.set_state(ServiceState::Stopped);
        self.reporter.publish();
        tracing::info!("Dienst beendet");
    }
}

/// Reicht das Haltesignal in den Kanal weiter, damit der Supervisor nicht darauf pollen muss.
fn forward_stop(stop: &StopSignal, events: Sender<Event>) {
    let stop = stop.clone();
    let spawned = thread::Builder::new()
        .name("stop".to_owned())
        .spawn(move || {
            while !stop.wait(Duration::from_secs(3600)) {}
            let _ = events.send(Event::Stop);
        });
    if let Err(error) = spawned {
        // Ohne Weiterleitung käme das Haltesignal nie an
        panic!("Thread für das Haltesignal nicht startbar: {error}");
    }
}

/// Health-Abfragen in einem eigenen Thread. Endet, sobald der Supervisor den Sender fallen lässt.
fn spawn_health(mut probe: Box<dyn HealthProbe>, events: Sender<Event>) -> Sender<HealthRequest> {
    let (requests, incoming) = mpsc::channel::<HealthRequest>();
    let spawned = thread::Builder::new()
        .name("health".to_owned())
        .spawn(move || {
            for request in incoming {
                let result = probe.check(&request.url);
                let answer = Event::Health {
                    generation: request.generation,
                    result,
                    checked_at: OffsetDateTime::now_utc(),
                };
                if events.send(answer).is_err() {
                    break;
                }
            }
        });
    if let Err(error) = spawned {
        // Ohne Health bleibt der Zustand `starting`; die Kinder laufen trotzdem
        tracing::error!("Thread für die Health-Abfrage nicht startbar: {error}");
    }
    requests
}

/// Meldung für Status, Log und Ereignisprotokoll: erst schwärzen, dann kürzen. Andersherum bliebe
/// von einem Secret an der Schnittstelle ein Anfang im Klartext stehen.
fn report_message(redactor: &Redactor, raw: &str) -> String {
    shorten_message(&redactor.redact(raw))
}

/// Wartezeit bis zum nächsten Versuch. Lief das Kind stabil, war der Fehler neu: Dann beginnt die
/// Wartezeit wieder bei der kürzesten.
fn retry_delay(
    backoff: &mut Backoff,
    ran_for: Duration,
    stable_run: Duration,
    jitter: f64,
) -> Duration {
    if ran_for >= stable_run {
        backoff.reset();
    }
    backoff.next_delay(jitter)
}

/// Zufall von 0,0 bis 1,0 für den Backoff-Jitter. Kryptografisch muss er nicht sein; `RandomState`
/// ist je Aufruf neu gesät und braucht keine weitere Abhängigkeit.
fn jitter() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let random = RandomState::new().hash_one(nanos);
    // Die oberen 53 Bit passen genau in die Mantisse eines f64
    (random >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_service() {
        let options = SupervisorOptions::default();
        assert_eq!(options.health_interval, Duration::from_secs(10));
        assert_eq!(options.stop_timeout, Duration::from_secs(15));
        assert_eq!(options.backoff_base, Duration::from_secs(2));
        assert_eq!(options.backoff_max, Duration::from_secs(300));
        assert_eq!(options.stable_run, Duration::from_secs(600));
        assert_eq!(options.heartbeat, Duration::from_secs(10));
    }

    #[test]
    fn retry_delay_grows_until_a_stable_run() {
        let base = Duration::from_secs(2);
        let stable = Duration::from_secs(600);
        let mut backoff = Backoff::new(base, Duration::from_secs(300));
        let short = Duration::from_secs(5);

        assert_eq!(retry_delay(&mut backoff, short, stable, 0.5), base);
        assert_eq!(retry_delay(&mut backoff, short, stable, 0.5), base * 2);
        assert_eq!(retry_delay(&mut backoff, short, stable, 0.5), base * 4);
        // Zehn Minuten stabil: wieder von vorn
        assert_eq!(retry_delay(&mut backoff, stable, stable, 0.5), base);
        assert_eq!(retry_delay(&mut backoff, short, stable, 0.5), base * 2);
    }

    #[test]
    fn report_message_redacts_before_shortening() {
        let secret = "Geheim-Grenze-1234567";
        let redactor = Redactor::new([secret.to_owned()]);
        // Das Secret beginnt bei Zeichen 290 und reicht über die Grenze von 300
        let raw = format!("{}{secret}{}", "x".repeat(290), "y".repeat(50));

        let message = report_message(&redactor, &raw);

        assert!(!message.contains("Geheim"), "{message}");
        assert!(message.contains("***"), "{message}");
        assert_eq!(message.chars().count(), 300);
        // Auch `[config]`-Meldungen sind begrenzt (das Ereignisprotokoll nimmt höchstens ~31 K)
        let long = "ö".repeat(40_000);
        assert_eq!(report_message(&redactor, &long).chars().count(), 300);
        assert_eq!(report_message(&redactor, "kurz"), "kurz");
    }

    #[test]
    fn jitter_stays_in_range() {
        for _ in 0..1000 {
            let value = jitter();
            assert!((0.0..=1.0).contains(&value), "{value}");
        }
        // Nicht immer derselbe Wert
        let values: Vec<f64> = (0..10).map(|_| jitter()).collect();
        assert!(values.iter().any(|value| *value != values[0]));
    }
}
