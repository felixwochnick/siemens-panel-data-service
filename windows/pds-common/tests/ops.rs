//! Gemeinsame Abläufe für CLI, Dienst und UI: Laden mit Befunden, App-Secret, Statusbericht.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use pds_common::config::{self, Config, ConfigError, SecretField, TlsMode};
use pds_common::ops::{
    self, ApplyOutcome, OpsError, TlsSource, ensure_app_secret, generate_app_secret,
    regenerate_app_secret, status_report, unreadable_finding,
};
use pds_common::platform::{PlatformError, SqliteDirOutcome};
use pds_common::status::{self, ChildStatus, ErrorInfo, HealthStatus, ServiceState, Status};
use pds_common::validate::{Finding, Severity};
use pds_common::{Paths, Secret, system_protector, tls};
use tempfile::TempDir;
use time::OffsetDateTime;

const HOST: &str = "trainee.example.com";

fn paths(dir: &TempDir) -> Paths {
    Paths::new(dir.path().join("install"), dir.path().join("data"))
}

/// Datenordner wie nach `setup install` (ohne Windows-ACL).
fn prepared() -> (TempDir, Paths) {
    let dir = TempDir::new().unwrap();
    let paths = paths(&dir);
    fs::create_dir_all(&paths.data_dir).unwrap();
    (dir, paths)
}

fn codes(findings: &[pds_common::validate::Finding]) -> Vec<String> {
    findings
        .iter()
        .map(|finding| format!("{}:{}", finding.field, finding.code))
        .collect()
}

fn status_at(state: ServiceState, heartbeat: OffsetDateTime) -> Status {
    Status {
        state,
        since: heartbeat,
        heartbeat,
        product_version: "0.1.0".into(),
        node_version: String::new(),
        caddy_version: String::new(),
        health: None,
        last_error: None,
        next_attempt: None,
        findings: Vec::new(),
        certificate_not_after: None,
        app: ChildStatus::default(),
        proxy: ChildStatus::default(),
    }
}

/// Zertifikat aus der OpenSSL-Testdatei (Leaf `windows-legacy.example.com`, 100 Jahre gültig).
/// Ohne `rcgen`, damit die Datei auch für Windows übersetzbar bleibt.
fn store_certificate(paths: &Paths) {
    let pfx = fs::read(format!(
        "{}/tests/fixtures/openssl-aes256.pfx",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let material = tls::from_pfx(&pfx, &Secret::new("Pässwört 1!")).unwrap();
    tls::save(paths, &material, &*system_protector()).unwrap();
}

// ---------------------------------------------------------------------------------------------
// App-Secret
// ---------------------------------------------------------------------------------------------

#[test]
fn generated_app_secret_has_64_url_safe_chars() {
    let first = generate_app_secret();
    let second = generate_app_secret();

    assert_eq!(first.expose().chars().count(), 64);
    assert!(
        first
            .expose()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "nur base64url ohne Padding"
    );
    assert_ne!(first.expose(), second.expose());
}

#[test]
fn ensure_app_secret_creates_it_once() {
    let (_dir, paths) = prepared();

    assert!(ensure_app_secret(&paths, &*system_protector()).unwrap());
    let first = config::load(&paths.config_file()).unwrap();
    assert!(!ensure_app_secret(&paths, &*system_protector()).unwrap());
    let second = config::load(&paths.config_file()).unwrap();

    assert_eq!(
        first.sealed(SecretField::AppSecret),
        second.sealed(SecretField::AppSecret)
    );
    let secrets = second.open_secrets(&*system_protector()).unwrap();
    assert_eq!(secrets.app_secret.unwrap().expose().len(), 64);
}

#[test]
fn ensure_app_secret_keeps_other_settings() {
    let (_dir, paths) = prepared();
    fs::write(
        paths.config_file(),
        "[public]\nhost = \"trainee.example.com\"\n",
    )
    .unwrap();

    assert!(ensure_app_secret(&paths, &*system_protector()).unwrap());

    let config = config::load(&paths.config_file()).unwrap();
    assert_eq!(config.public.host, HOST);
}

#[test]
fn ensure_app_secret_never_overwrites_unreadable_config() {
    let (_dir, paths) = prepared();
    fs::write(paths.config_file(), "[public\nhost = 1").unwrap();

    let error = ensure_app_secret(&paths, &*system_protector()).unwrap_err();

    assert_eq!(error.code(), "config_unreadable");
    assert_eq!(
        fs::read_to_string(paths.config_file()).unwrap(),
        "[public\nhost = 1"
    );
}

#[test]
fn regenerate_app_secret_replaces_it() {
    let (_dir, paths) = prepared();
    ensure_app_secret(&paths, &*system_protector()).unwrap();
    let before = config::load(&paths.config_file())
        .unwrap()
        .open_secrets(&*system_protector())
        .unwrap()
        .app_secret
        .unwrap();

    regenerate_app_secret(&paths, &*system_protector()).unwrap();

    let after = config::load(&paths.config_file())
        .unwrap()
        .open_secrets(&*system_protector())
        .unwrap()
        .app_secret
        .unwrap();
    assert_ne!(before.expose(), after.expose());
    assert_eq!(after.expose().len(), 64);
}

#[cfg(not(windows))]
#[test]
fn data_dir_is_created_without_windows() {
    let dir = TempDir::new().unwrap();
    let paths = paths(&dir);

    ops::require_data_dir(&paths).unwrap();

    assert!(paths.data_dir.is_dir());
}

#[test]
fn data_dir_missing_has_stable_code() {
    assert_eq!(OpsError::DataDirMissing.code(), "data_dir_missing");
    assert!(
        OpsError::DataDirMissing
            .to_string()
            .starts_with("Datenordner fehlt")
    );
}

// ---------------------------------------------------------------------------------------------
// Laden und Befunde
// ---------------------------------------------------------------------------------------------

#[test]
fn unreadable_finding_points_to_config() {
    let finding = unreadable_finding(&ConfigError::Unreadable("Zeile 1, Spalte 2: x".into()));

    assert_eq!(finding.field, "config");
    assert_eq!(finding.code, "config_unreadable");
    assert_eq!(finding.severity, Severity::Error);
    assert!(finding.message.contains("Zeile 1"), "{}", finding.message);
}

#[test]
fn fresh_config_lists_missing_fields() {
    let (_dir, paths) = prepared();

    let checked = ops::check(&paths, &*system_protector(), OffsetDateTime::now_utc());

    assert!(checked.loaded.is_some());
    let codes = codes(&checked.findings);
    assert!(
        codes.contains(&"public.host:required".to_owned()),
        "{codes:?}"
    );
    // SQL Server ist der Standard: Server und Passwort fehlen noch
    assert!(
        codes.contains(&"db.server:required".to_owned()),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"db.password:required".to_owned()),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"app.secret:app_secret_missing".to_owned()),
        "{codes:?}"
    );
}

#[test]
fn broken_config_files_become_config_unreadable() {
    let (_dir, paths) = prepared();
    let cases = [
        "[public\nhost = 1",
        "unbekannt = 1\n",
        "schema = 99\n",
        "[db]\npassword = \"Klartext-Geheim\"\n",
    ];
    for text in cases {
        fs::write(paths.config_file(), text).unwrap();

        let checked = ops::check(&paths, &*system_protector(), OffsetDateTime::now_utc());

        assert!(checked.loaded.is_none(), "{text:?}");
        assert_eq!(
            codes(&checked.findings),
            ["config:config_unreadable"],
            "{text:?}"
        );
        assert!(!checked.findings[0].message.contains("Klartext-Geheim"));
    }
}

#[test]
fn loads_certificate_and_key_check() {
    let (_dir, paths) = prepared();
    store_certificate(&paths);

    let loaded = ops::load(&paths, &*system_protector()).unwrap();

    assert_eq!(loaded.config.tls.mode, TlsMode::Certificate);
    let certificate = loaded.certificate.unwrap();
    assert!(
        certificate
            .dns_names
            .contains(&"windows-legacy.example.com".to_owned()),
        "{certificate:?}"
    );
    assert_eq!(loaded.key_matches, Some(true));
}

#[test]
fn certificate_without_key_is_a_tls_finding() {
    let (_dir, paths) = prepared();
    store_certificate(&paths);
    fs::remove_file(paths.tls_key_file()).unwrap();

    let checked = ops::check(&paths, &*system_protector(), OffsetDateTime::now_utc());

    assert_eq!(codes(&checked.findings), ["tls:tls_no_private_key"]);
}

#[test]
fn missing_certificate_is_a_finding() {
    let (_dir, paths) = prepared();

    let loaded = ops::load(&paths, &*system_protector()).unwrap();
    let findings = ops::findings(&paths, &loaded, OffsetDateTime::now_utc());

    assert_eq!(loaded.certificate, None);
    assert_eq!(loaded.key_matches, None);
    assert!(codes(&findings).contains(&"tls:certificate_missing".to_owned()));
}

#[test]
fn broken_certificate_matters_only_in_certificate_mode() {
    let (_dir, paths) = prepared();
    fs::create_dir_all(paths.tls_dir()).unwrap();
    fs::write(paths.tls_cert_file(), "kein PEM").unwrap();

    let checked = ops::check(&paths, &*system_protector(), OffsetDateTime::now_utc());
    assert_eq!(codes(&checked.findings), ["tls:tls_no_certificate"]);

    // Bei ACME braucht der Dienst die Dateien nicht: dann kein Hindernis
    fs::write(paths.config_file(), "[tls]\nmode = \"acme\"\n").unwrap();
    let checked = ops::check(&paths, &*system_protector(), OffsetDateTime::now_utc());
    let loaded = checked.loaded.expect("geladen");
    assert_eq!(loaded.certificate, None);
    assert!(
        !codes(&checked.findings)
            .iter()
            .any(|code| code.starts_with("tls:"))
    );
}

// ---------------------------------------------------------------------------------------------
// Statusbericht
// ---------------------------------------------------------------------------------------------

#[test]
fn status_report_without_service_or_status() {
    let (_dir, paths) = prepared();

    let report = status_report(&paths);

    assert_eq!(report.status, None);
    assert!(!report.stale);
    assert_eq!(report.internal, None);
    assert_eq!(report.public, None);
    assert_eq!(report.app_url, "");
    // Fehlt eine Datei, ist das kein Lesefehler
    assert_eq!(report.status_error, None);
    assert_eq!(report.config_error, None);
    #[cfg(not(windows))]
    assert_eq!(report.service, None);
}

#[test]
fn status_report_reports_corrupt_files() {
    let (_dir, paths) = prepared();
    fs::create_dir_all(paths.state_dir()).unwrap();
    fs::write(paths.status_file(), "{kein json").unwrap();
    fs::write(paths.config_file(), "[public\nhost = 1").unwrap();

    let report = status_report(&paths);

    assert_eq!(report.status, None);
    let status_error = report.status_error.expect("Status nicht lesbar");
    assert!(!status_error.access_denied, "{status_error:?}");
    assert!(
        status_error.message.contains("beschädigt"),
        "{status_error:?}"
    );
    assert_eq!(report.app_url, "");
    let config_error = report.config_error.expect("Konfiguration nicht lesbar");
    assert!(!config_error.access_denied, "{config_error:?}");
}

/// Ohne Administratorrechte sind `status.json` und `config.toml` unter Windows nicht lesbar; das
/// darf nicht wie „lief noch nie“ bzw. „kein Hostname“ aussehen.
#[cfg(unix)]
#[test]
fn status_report_tells_access_denied_apart_from_missing() {
    use std::os::unix::fs::PermissionsExt;

    let (_dir, paths) = prepared();
    status::write(
        &paths.status_file(),
        &status_at(ServiceState::Running, OffsetDateTime::now_utc()),
    )
    .unwrap();
    fs::write(paths.config_file(), "[public]\nhost = \"h.example.com\"\n").unwrap();
    for file in [paths.status_file(), paths.config_file()] {
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
    }
    if fs::read(paths.status_file()).is_ok() {
        eprintln!("übersprungen: läuft als root, chmod 000 sperrt nichts");
        return;
    }

    let report = status_report(&paths);

    assert_eq!(report.status, None);
    let status_error = report.status_error.expect("Status nicht lesbar");
    assert!(status_error.access_denied, "{status_error:?}");
    assert!(
        status_error.message.contains("status.json"),
        "{status_error:?}"
    );
    assert_eq!(report.app_url, "");
    let config_error = report.config_error.expect("Konfiguration nicht lesbar");
    assert!(config_error.access_denied, "{config_error:?}");
    assert!(
        config_error.message.contains("config.toml"),
        "{config_error:?}"
    );
    assert_eq!(report.internal, None);
}

#[test]
fn status_report_detects_stale_heartbeat() {
    let (_dir, paths) = prepared();
    let old = OffsetDateTime::now_utc() - time::Duration::minutes(5);
    status::write(&paths.status_file(), &status_at(ServiceState::Running, old)).unwrap();

    let report = status_report(&paths);

    assert!(report.stale);
    assert_eq!(report.status.unwrap().state, ServiceState::Running);
    // Ein veralteter Status ist kein Grund für eine Abfrage
    assert_eq!(report.internal, None);
}

#[test]
fn status_report_builds_app_url() {
    let (_dir, paths) = prepared();
    let cases = [
        (
            "[public]\nhost = \"h.example.com\"\n",
            "https://h.example.com",
        ),
        (
            "[public]\nhost = \"h.example.com\"\nport = 8443\n",
            "https://h.example.com:8443",
        ),
        (
            "[public]\nhost = \"h.example.com\"\nport = 80\nscheme = \"http\"\n[tls]\nmode = \"off\"\n",
            "http://h.example.com",
        ),
        (
            "[public]\nhost = \"h.example.com\"\nport = 8080\nscheme = \"http\"\n[tls]\nmode = \"off\"\n",
            "http://h.example.com:8080",
        ),
        // Wie `render::app_url`: Host klein, IPv6 in Klammern
        (
            "[public]\nhost = \"Trainee.Example.COM\"\n",
            "https://trainee.example.com",
        ),
        ("[public]\nhost = \"fd00::1\"\n", "https://[fd00::1]"),
        ("[public]\nhost = \"  \"\n", ""),
    ];
    for (text, url) in cases {
        fs::write(paths.config_file(), text).unwrap();
        assert_eq!(status_report(&paths).app_url, url, "{text}");
    }
}

#[test]
fn status_report_probes_internal_health_while_running() {
    let (_dir, paths) = prepared();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 2048];
        let _ = stream.read(&mut buffer).unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .unwrap();
    });
    fs::write(paths.config_file(), format!("[internal]\nport = {port}\n")).unwrap();
    status::write(
        &paths.status_file(),
        &status_at(ServiceState::Running, OffsetDateTime::now_utc()),
    )
    .unwrap();

    let report = status_report(&paths);

    let internal = report.internal.expect("intern geprüft");
    assert!(internal.ok, "{internal:?}");
    assert!(!report.stale);
    server.join().unwrap();
}

#[test]
fn status_report_json_shape() {
    let (_dir, paths) = prepared();
    status::write(
        &paths.status_file(),
        &status_at(ServiceState::Unconfigured, OffsetDateTime::now_utc()),
    )
    .unwrap();

    let json = serde_json::to_value(status_report(&paths)).unwrap();

    assert_eq!(json["status"]["state"], "unconfigured");
    assert_eq!(json["stale"], false);
    assert_eq!(json["appUrl"], "");
    assert_eq!(json["statusError"], serde_json::Value::Null);
    assert_eq!(json["configError"], serde_json::Value::Null);
    assert!(json.get("internal").is_some());
    assert!(json.get("public").is_some());
    assert!(json.get("service").is_some());
}

// ---------------------------------------------------------------------------------------------
// TLS-Import
// ---------------------------------------------------------------------------------------------

const FIXTURE_PASSWORD: &str = "Pässwört 1!";
const FIXTURE_HOST: &str = "windows-legacy.example.com";

fn fixture_pfx() -> Vec<u8> {
    fs::read(format!(
        "{}/tests/fixtures/openssl-aes256.pfx",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn pfx_source() -> TlsSource {
    TlsSource::Pfx {
        bytes: fixture_pfx(),
        password: Secret::new(FIXTURE_PASSWORD),
    }
}

fn config_with_host(host: &str) -> Config {
    let mut config = Config::default();
    config.public.host = host.into();
    config
}

fn rejected_codes(error: OpsError) -> Vec<String> {
    match error {
        OpsError::Rejected(findings) => codes(&findings),
        other => panic!("nicht abgelehnt: {other}"),
    }
}

#[test]
fn import_tls_pfx_stores_certificate_and_sealed_key() {
    let (_dir, paths) = prepared();

    let info = ops::import_tls(
        &paths,
        &config_with_host(FIXTURE_HOST),
        pfx_source(),
        &*system_protector(),
        OffsetDateTime::now_utc(),
    )
    .unwrap();

    assert!(
        info.dns_names.contains(&FIXTURE_HOST.to_owned()),
        "{info:?}"
    );
    let loaded = ops::load(&paths, &*system_protector()).unwrap();
    assert_eq!(loaded.certificate, Some(info));
    assert_eq!(loaded.key_matches, Some(true));
    let key_file = fs::read_to_string(paths.tls_key_file()).unwrap();
    assert!(!key_file.contains("PRIVATE KEY"), "Schlüssel im Klartext");
}

#[test]
fn import_tls_without_public_host_accepts_any_name() {
    let (_dir, paths) = prepared();

    ops::import_tls(
        &paths,
        &Config::default(),
        pfx_source(),
        &*system_protector(),
        OffsetDateTime::now_utc(),
    )
    .unwrap();

    assert!(paths.tls_cert_file().is_file());
}

#[test]
fn import_tls_rejects_a_foreign_hostname_and_stores_nothing() {
    let (_dir, paths) = prepared();

    let error = ops::import_tls(
        &paths,
        &config_with_host("anders.example.com"),
        pfx_source(),
        &*system_protector(),
        OffsetDateTime::now_utc(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "rejected");
    assert_eq!(
        rejected_codes(error),
        ["public.host:certificate_hostname_mismatch"]
    );
    assert!(!paths.tls_cert_file().exists());
    assert!(!paths.tls_key_file().exists());
}

#[test]
fn import_tls_rejects_an_expired_certificate() {
    let (_dir, paths) = prepared();
    // Die Testdatei gilt 100 Jahre: in 200 Jahren ist sie abgelaufen
    let later = OffsetDateTime::now_utc() + time::Duration::days(365 * 200);

    let error = ops::import_tls(
        &paths,
        &config_with_host(FIXTURE_HOST),
        pfx_source(),
        &*system_protector(),
        later,
    )
    .unwrap_err();

    assert_eq!(rejected_codes(error), ["tls:certificate_expired"]);
    assert!(!paths.tls_cert_file().exists());
}

#[test]
fn import_tls_reports_every_problem_at_once() {
    let (_dir, paths) = prepared();
    let later = OffsetDateTime::now_utc() + time::Duration::days(365 * 200);

    let error = ops::import_tls(
        &paths,
        &config_with_host("anders.example.com"),
        pfx_source(),
        &*system_protector(),
        later,
    )
    .unwrap_err();

    let codes = rejected_codes(error);
    assert!(
        codes.contains(&"tls:certificate_expired".to_owned()),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"public.host:certificate_hostname_mismatch".to_owned()),
        "{codes:?}"
    );
}

#[test]
fn import_tls_expiring_soon_is_accepted() {
    let (_dir, paths) = prepared();
    // Zwei Wochen vor Ablauf: nur eine Warnung, kein Grund zur Ablehnung
    let info = tls::from_pfx(&fixture_pfx(), &Secret::new(FIXTURE_PASSWORD))
        .and_then(|material| tls::inspect(&material.chain_pem))
        .unwrap();
    let soon = info.not_after - time::Duration::days(14);

    ops::import_tls(
        &paths,
        &Config::default(),
        pfx_source(),
        &*system_protector(),
        soon,
    )
    .unwrap();

    let findings = ops::certificate_findings(&Config::default(), &paths, &info, Some(true), soon);
    assert_eq!(codes(&findings), ["tls:certificate_expires_soon"]);
}

#[test]
fn import_tls_rejects_a_key_that_does_not_fit() {
    let (_dir, paths) = prepared();
    let make = |name: &str| {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(vec![name.to_owned()]).unwrap();
        params.not_before = rcgen::date_time_ymd(2020, 1, 1);
        params.not_after = rcgen::date_time_ymd(2090, 1, 1);
        (params.self_signed(&key).unwrap().pem(), key)
    };
    let (cert, _) = make(HOST);
    let (_, other_key) = make(HOST);

    let error = ops::import_tls(
        &paths,
        &Config::default(),
        TlsSource::Pem {
            cert,
            key: Secret::new(other_key.serialize_pem()),
        },
        &*system_protector(),
        OffsetDateTime::now_utc(),
    )
    .unwrap_err();

    assert_eq!(rejected_codes(error), ["tls:certificate_key_mismatch"]);
    assert!(!paths.tls_cert_file().exists());
}

#[test]
fn import_tls_wrong_pfx_password_is_a_tls_error() {
    let (_dir, paths) = prepared();

    let error = ops::import_tls(
        &paths,
        &Config::default(),
        TlsSource::Pfx {
            bytes: fixture_pfx(),
            password: Secret::new("falsch"),
        },
        &*system_protector(),
        OffsetDateTime::now_utc(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "tls_wrong_password");
}

#[test]
fn import_tls_needs_the_data_dir() {
    let dir = TempDir::new().unwrap();
    let paths = paths(&dir);

    // Ohne Windows entsteht der Ordner, mit Windows ist er Sache von `setup install`
    let result = ops::import_tls(
        &paths,
        &Config::default(),
        pfx_source(),
        &*system_protector(),
        OffsetDateTime::now_utc(),
    );

    if cfg!(windows) {
        assert_eq!(result.unwrap_err().code(), "data_dir_missing");
    } else {
        result.unwrap();
    }
}

#[cfg(not(windows))]
#[test]
fn import_tls_from_the_store_is_unsupported_without_windows() {
    let (_dir, paths) = prepared();

    let error = ops::import_tls(
        &paths,
        &Config::default(),
        TlsSource::Store {
            thumbprint: "AB".repeat(20),
        },
        &*system_protector(),
        OffsetDateTime::now_utc(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "platform_unsupported");
}

// ---------------------------------------------------------------------------------------------
// Konfiguration speichern
// ---------------------------------------------------------------------------------------------

#[test]
fn save_config_writes_the_file() {
    let (_dir, paths) = prepared();
    let mut config = config_with_host(HOST);
    config.listen.http_port = 8080;

    let outcome = ops::save_config(&paths, &config).unwrap();

    assert_eq!(config::load(&paths.config_file()).unwrap(), config);
    // Ohne Windows gibt es keine Firewall-Regel; unter Windows bleibt sie ohne `caddy.exe` im
    // Installationsordner (hier: leer) unberührt. Warnungen gibt es in beiden Fällen keine.
    assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);
}

#[test]
fn save_config_refuses_unsealed_secrets() {
    let (_dir, paths) = prepared();
    let mut config = Config::default();
    config.db.password.0 = "Klartext".into();

    let error = ops::save_config(&paths, &config).unwrap_err();

    assert_eq!(error.code(), "config_secret_unsealed");
    assert!(!paths.config_file().exists());
}

#[test]
fn firewall_ports_follow_tls_mode() {
    let mut config = Config::default();
    assert_eq!(ops::firewall_ports(&config), [80, 443]);

    config.listen.http_port = 8080;
    config.public.port = 8443;
    assert_eq!(ops::firewall_ports(&config), [8080, 8443]);

    config.tls.mode = TlsMode::Off;
    assert_eq!(ops::firewall_ports(&config), [8080]);

    config.tls.mode = TlsMode::Internal;
    config.public.port = 8080;
    assert_eq!(ops::firewall_ports(&config), [8080], "ohne Doppelte");
}

#[test]
fn firewall_step_passes_caddy_and_ports() {
    let mut seen = None;

    let result = ops::firewall_step(
        &Config::default(),
        std::path::Path::new("C:/inst/caddy.exe"),
        |exe, ports| {
            seen = Some((exe.to_path_buf(), ports.to_vec()));
            Ok(())
        },
    );

    assert_eq!(result, Ok(vec![80, 443]));
    assert_eq!(
        seen,
        Some((std::path::PathBuf::from("C:/inst/caddy.exe"), vec![80, 443]))
    );
}

#[test]
fn firewall_failure_is_only_a_warning_with_ports() {
    use pds_common::platform::PlatformError;

    let mut config = Config::default();
    config.listen.http_port = 8080;
    config.public.port = 8443;

    let result = ops::firewall_step(&config, std::path::Path::new("caddy.exe"), |_, _| {
        Err(PlatformError::Os {
            context: "INetFwPolicy2",
            code: 0x8007_06D9,
            message: "Der Endpunktzuordnung sind keine weiteren Endpunkte verfügbar.".into(),
        })
    });

    let warning = result.unwrap_err();
    assert!(
        warning.starts_with(
            "Firewall-Regel „EPLAN Panel Data Service (HTTP/HTTPS)“ konnte nicht angelegt werden: "
        ),
        "{warning}"
    );
    assert!(warning.contains("0x800706D9"), "{warning}");
    assert!(
        warning.ends_with(" – bitte Ports 8080, 8443 von Hand freigeben"),
        "{warning}"
    );
}

// ---------------------------------------------------------------------------------------------
// Datenbankpasswort
// ---------------------------------------------------------------------------------------------

#[test]
fn generated_db_password_meets_the_sql_server_rules() {
    for _ in 0..200 {
        let password = ops::generate_db_password();
        let text = password.expose();

        assert_eq!(text.chars().count(), 32, "{text}");
        assert!(
            text.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "{text}"
        );
        assert!(text.chars().any(|c| c.is_ascii_uppercase()), "{text}");
        assert!(text.chars().any(|c| c.is_ascii_lowercase()), "{text}");
        assert!(text.chars().any(|c| c.is_ascii_digit()), "{text}");
        assert_eq!(text.matches('-').count(), 1, "{text}");
        // Am Rand liefe ein Bindestrich Gefahr, als Option gelesen zu werden
        assert!(!text.starts_with('-') && !text.ends_with('-'), "{text}");
    }
}

#[test]
fn generated_db_passwords_differ() {
    assert_ne!(
        ops::generate_db_password().expose(),
        ops::generate_db_password().expose()
    );
}

#[test]
fn ensure_db_password_creates_it_once() {
    let (_dir, paths) = prepared();
    fs::write(
        paths.config_file(),
        "[public]\nhost = \"trainee.example.com\"\n",
    )
    .unwrap();

    assert!(ops::ensure_db_password(&paths, &*system_protector()).unwrap());
    let first = config::load(&paths.config_file()).unwrap();
    assert!(!ops::ensure_db_password(&paths, &*system_protector()).unwrap());
    let second = config::load(&paths.config_file()).unwrap();

    assert_eq!(
        first.sealed(SecretField::DbPassword),
        second.sealed(SecretField::DbPassword)
    );
    assert_eq!(first.public.host, HOST, "übrige Einstellungen bleiben");
    let password = second
        .open_secrets(&*system_protector())
        .unwrap()
        .db_password
        .unwrap();
    assert_eq!(password.expose().chars().count(), 32);
}

#[test]
fn ensure_db_password_never_overwrites_unreadable_config() {
    let (_dir, paths) = prepared();
    fs::write(paths.config_file(), "[db\n").unwrap();

    let error = ops::ensure_db_password(&paths, &*system_protector()).unwrap_err();

    assert_eq!(error.code(), "config_unreadable");
    assert_eq!(fs::read_to_string(paths.config_file()).unwrap(), "[db\n");
}

// ---------------------------------------------------------------------------------------------
// Neustart abwarten
// ---------------------------------------------------------------------------------------------

const WAIT: Duration = Duration::from_millis(400);
const POLL: Duration = Duration::from_millis(10);

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

/// Status, der vor `since` beginnt und dessen Heartbeat `heartbeat` ist.
fn status_since(state: ServiceState, since: OffsetDateTime) -> Status {
    Status {
        since,
        ..status_at(state, now())
    }
}

fn healthy(mut status: Status) -> Status {
    status.health = Some(HealthStatus {
        ok: true,
        checked_at: now(),
        message: None,
    });
    status
}

fn write_status(paths: &Paths, status: &Status) {
    status::write(&paths.status_file(), status).unwrap();
}

fn wait(paths: &Paths, requested: OffsetDateTime) -> ApplyOutcome {
    ops::wait_for_running_every(paths, requested, WAIT, POLL)
}

#[test]
fn wait_succeeds_for_a_fresh_running_status_with_health() {
    let (_dir, paths) = prepared();
    let requested = now() - time::Duration::seconds(2);
    write_status(&paths, &healthy(status_since(ServiceState::Running, now())));

    let outcome = wait(&paths, requested);

    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(outcome.state, Some(ServiceState::Running));
    assert!(!outcome.message.is_empty());
    assert_eq!(outcome.waited_seconds, 0);
}

#[test]
fn wait_does_not_accept_the_status_from_before_the_restart() {
    let (_dir, paths) = prepared();
    // Der Dienst lief gesund, bis der Neustart angefordert wurde: der alte Status zählt nicht
    let requested = now();
    let old = requested - time::Duration::seconds(30);
    write_status(&paths, &healthy(status_since(ServiceState::Running, old)));

    let outcome = wait(&paths, requested);

    assert!(!outcome.ok, "{outcome:?}");
    assert_eq!(outcome.state, None, "kein neuer Status gesehen");
    assert!(
        outcome.message.contains("Zeitüberschreitung"),
        "{}",
        outcome.message
    );
    assert!(
        outcome.message.contains("seit dem Neustart"),
        "{}",
        outcome.message
    );
}

#[test]
fn wait_does_not_accept_a_stale_old_config_error_either() {
    let (_dir, paths) = prepared();
    let requested = now();
    let old = requested - time::Duration::seconds(30);
    write_status(&paths, &status_since(ServiceState::ConfigError, old));

    let outcome = wait(&paths, requested);

    assert_eq!(outcome.state, None);
    assert!(outcome.message.contains("Zeitüberschreitung"));
}

#[test]
fn wait_without_status_file_times_out_with_a_hint() {
    let (_dir, paths) = prepared();

    let outcome = wait(&paths, now());

    assert!(!outcome.ok);
    assert_eq!(outcome.state, None);
    assert!(
        outcome.message.contains("Zeitüberschreitung"),
        "{}",
        outcome.message
    );
}

#[test]
fn wait_for_running_without_health_times_out_with_the_last_state() {
    let (_dir, paths) = prepared();
    let requested = now() - time::Duration::seconds(2);
    let mut status = status_since(ServiceState::Running, now());
    status.health = Some(HealthStatus {
        ok: false,
        checked_at: now(),
        message: Some("Nicht erreichbar: Verbindung abgelehnt".into()),
    });
    write_status(&paths, &status);

    let outcome = wait(&paths, requested);

    assert!(!outcome.ok);
    assert_eq!(outcome.state, Some(ServiceState::Running));
    assert!(
        outcome.message.contains("Zeitüberschreitung"),
        "{}",
        outcome.message
    );
    assert!(
        outcome.message.contains("Verbindung abgelehnt"),
        "{}",
        outcome.message
    );
}

#[test]
fn wait_for_starting_times_out_with_the_state() {
    let (_dir, paths) = prepared();
    let requested = now() - time::Duration::seconds(2);
    write_status(&paths, &status_since(ServiceState::Starting, now()));

    let outcome = wait(&paths, requested);

    assert!(!outcome.ok);
    assert_eq!(outcome.state, Some(ServiceState::Starting));
}

#[test]
fn wait_names_the_backoff_reason_on_timeout() {
    let (_dir, paths) = prepared();
    let requested = now() - time::Duration::seconds(2);
    let mut status = status_since(ServiceState::Backoff, now());
    status.last_error = Some(ErrorInfo {
        at: now(),
        source: "proxy".into(),
        message: "Port 443 ist bereits belegt".into(),
    });
    write_status(&paths, &status);

    let outcome = wait(&paths, requested);

    assert!(!outcome.ok);
    assert_eq!(outcome.state, Some(ServiceState::Backoff));
    assert!(
        outcome.message.contains("Port 443 ist bereits belegt"),
        "{}",
        outcome.message
    );
}

#[test]
fn wait_stops_early_at_config_error() {
    let (_dir, paths) = prepared();
    let requested = now() - time::Duration::seconds(2);
    let mut status = status_since(ServiceState::ConfigError, now());
    status.last_error = Some(ErrorInfo {
        at: now(),
        source: "app".into(),
        message: "[config] NUXT_APP_SECRET fehlt".into(),
    });
    write_status(&paths, &status);

    let started = std::time::Instant::now();
    let outcome = ops::wait_for_running_every(&paths, requested, Duration::from_secs(30), POLL);

    assert!(
        started.elapsed() < Duration::from_secs(5),
        "wartete bis zum Timeout"
    );
    assert!(!outcome.ok);
    assert_eq!(outcome.state, Some(ServiceState::ConfigError));
    assert!(
        outcome.message.contains("NUXT_APP_SECRET fehlt"),
        "{}",
        outcome.message
    );
}

#[test]
fn wait_stops_early_at_unconfigured_and_lists_the_errors() {
    let (_dir, paths) = prepared();
    let requested = now() - time::Duration::seconds(2);
    let mut status = status_since(ServiceState::Unconfigured, now());
    status.findings = vec![
        Finding {
            field: "public.host".into(),
            code: "required".into(),
            message: "Hostname fehlt".into(),
            severity: Severity::Error,
        },
        Finding {
            field: "tls".into(),
            code: "certificate_expires_soon".into(),
            message: "Das Zertifikat läuft bald ab".into(),
            severity: Severity::Warning,
        },
    ];
    write_status(&paths, &status);

    let started = std::time::Instant::now();
    let outcome = ops::wait_for_running_every(&paths, requested, Duration::from_secs(30), POLL);

    assert!(
        started.elapsed() < Duration::from_secs(5),
        "wartete bis zum Timeout"
    );
    assert!(!outcome.ok);
    assert_eq!(outcome.state, Some(ServiceState::Unconfigured));
    assert!(
        outcome.message.contains("public.host: Hostname fehlt"),
        "{}",
        outcome.message
    );
    assert!(
        !outcome.message.contains("läuft bald ab"),
        "Warnungen zählen nicht"
    );
}

#[test]
fn wait_rejects_a_running_status_with_a_stale_heartbeat() {
    let (_dir, paths) = prepared();
    // Neu genug seit der Anforderung, aber der Heartbeat ist älter als 30 s: der Dienst ist weg
    let requested = now() - time::Duration::minutes(5);
    let mut status = healthy(status_since(
        ServiceState::Running,
        now() - time::Duration::minutes(4),
    ));
    status.heartbeat = now() - time::Duration::minutes(2);
    write_status(&paths, &status);

    let outcome = wait(&paths, requested);

    assert!(!outcome.ok, "{outcome:?}");
}

#[test]
fn wait_picks_up_a_status_written_while_waiting() {
    let (_dir, paths) = prepared();
    let requested = now();
    let writer_paths = paths.clone();
    let writer = thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        write_status(&writer_paths, &status_since(ServiceState::Starting, now()));
        thread::sleep(Duration::from_millis(150));
        write_status(
            &writer_paths,
            &healthy(status_since(ServiceState::Running, now())),
        );
    });

    let outcome = ops::wait_for_running_every(&paths, requested, Duration::from_secs(10), POLL);
    writer.join().unwrap();

    assert!(outcome.ok, "{outcome:?}");
}

#[test]
fn apply_outcome_json_shape() {
    let outcome = ApplyOutcome {
        ok: false,
        state: Some(ServiceState::ConfigError),
        message: "x".into(),
        waited_seconds: 3,
    };

    let json = serde_json::to_value(&outcome).unwrap();

    assert_eq!(
        json,
        serde_json::json!({
            "ok": false,
            "state": "config_error",
            "message": "x",
            "waitedSeconds": 3,
        })
    );
}

#[cfg(not(windows))]
#[test]
fn apply_is_unsupported_without_windows() {
    let (_dir, paths) = prepared();

    let error = ops::apply(&paths, Duration::from_secs(1)).unwrap_err();

    assert_eq!(error.code(), "platform_unsupported");
}

// ---------------------------------------------------------------------------------------------
// Datenbank-Einrichtung über das Werkzeug (Ersatz für node, nur Unix)
// ---------------------------------------------------------------------------------------------

/// `db_setup` mit einem Admin-Passwort; die Parameter, auf die es hier nicht ankommt, sind fest.
fn run_db_setup(
    paths: &Paths,
    config: &Config,
    secrets: &config::Secrets,
) -> Result<ops::DbSetupOutcome, OpsError> {
    // Die Einrichtung gibt es nur für SQL Server
    let mut config = config.clone();
    config.db.kind = config::DbKind::Sqlserver;
    ops::db_setup(
        paths,
        &config,
        secrets,
        "sa",
        &Secret::new("Admin-Passwort"),
        &*system_protector(),
    )
}

/// Das Passwort, das auf der Platte steht (geöffnet).
fn stored_db_password(paths: &Paths) -> Option<String> {
    config::load(&paths.config_file())
        .unwrap()
        .open_secrets(&*system_protector())
        .unwrap()
        .db_password
        .map(|password| password.expose().to_owned())
}

/// Ersatz für das Werkzeug: Ein Node-Skript, das das Passwort, das es bekommt, in `password.txt` im
/// Testordner schreibt und Erfolg meldet. Nur Unix (Symlink auf das System-`node`).
#[cfg(unix)]
fn install_fake_setup_tool(dir: &TempDir, paths: &Paths) -> std::path::PathBuf {
    use std::os::unix::fs::symlink;

    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|candidate| candidate.join("node"))
        .find(|candidate| candidate.is_file())
        .expect("node nicht im PATH gefunden");
    fs::create_dir_all(paths.install_dir.join("node")).unwrap();
    fs::create_dir_all(paths.install_dir.join("tools")).unwrap();
    symlink(node, paths.node_exe()).unwrap();
    let dump = dir.path().join("password.txt");
    fs::write(
        paths.tools_script(),
        format!(
            "import {{ writeFileSync }} from 'node:fs'\n\
             writeFileSync({:?}, process.env.PDS_DB_PASSWORD ?? '(fehlt)')\n\
             process.stdout.write(JSON.stringify({{ type: 'result', ok: true, code: 'ok', message: 'bereit' }}) + '\\n')\n",
            dump.display().to_string()
        ),
    )
    .unwrap();
    dump
}

#[cfg(unix)]
#[test]
fn db_setup_without_a_password_generates_it_and_writes_only_that_to_disk() {
    let (dir, paths) = prepared();
    let dump = install_fake_setup_tool(&dir, &paths);
    // Auf der Platte steht eine Konfiguration; der Aufrufer hat ungespeicherte Änderungen
    fs::write(
        paths.config_file(),
        "[public]\nhost = \"gespeichert.example.com\"\n",
    )
    .unwrap();
    let mut config = config_with_host("ungespeichert.example.com");
    config.db.server = "sql.example.com".into();
    let secrets = config.open_secrets(&*system_protector()).unwrap();
    assert!(secrets.db_password.is_none());

    let outcome = run_db_setup(&paths, &config, &secrets).unwrap();

    assert!(outcome.result.ok, "{outcome:?}");
    assert!(outcome.password_generated);
    let saved = stored_db_password(&paths).expect("gespeichert");
    assert_eq!(saved.chars().count(), 32);
    // Genau dieses Passwort ging ans Werkzeug, vor dessen Aufruf gespeichert
    assert_eq!(fs::read_to_string(&dump).unwrap(), saved);
    // Auf der Platte nur das Passwort neu; nichts aus der Konfiguration des Aufrufers
    let disk = config::load(&paths.config_file()).unwrap();
    assert_eq!(disk.public.host, "gespeichert.example.com");
    assert_eq!(disk.db.server, "", "ungespeicherte Änderung geschrieben");
    let expected = Config {
        db: config::DbConfig {
            password: disk.db.password.clone(),
            ..config::DbConfig::default()
        },
        public: config::PublicConfig {
            host: "gespeichert.example.com".into(),
            ..config::PublicConfig::default()
        },
        ..Config::default()
    };
    assert_eq!(disk, expected);
}

#[cfg(unix)]
#[test]
fn db_setup_uses_the_password_the_caller_passes_and_leaves_the_disk_alone() {
    let (dir, paths) = prepared();
    let dump = install_fake_setup_tool(&dir, &paths);
    let config = config_with_host(HOST);
    let mut secrets = config.open_secrets(&*system_protector()).unwrap();
    secrets.db_password = Some(Secret::new("Frisch-Eingegeben-1"));

    let outcome = run_db_setup(&paths, &config, &secrets).unwrap();

    assert!(outcome.result.ok, "{outcome:?}");
    assert!(!outcome.password_generated);
    assert_eq!(fs::read_to_string(&dump).unwrap(), "Frisch-Eingegeben-1");
    assert!(!paths.config_file().exists(), "nichts gespeichert");
}

#[cfg(unix)]
#[test]
fn db_setup_uses_the_stored_password_when_the_caller_has_none() {
    let (dir, paths) = prepared();
    let dump = install_fake_setup_tool(&dir, &paths);
    let mut stored = Config::default();
    stored
        .seal(
            SecretField::DbPassword,
            Some(&Secret::new("Gespeichert-2")),
            &*system_protector(),
        )
        .unwrap();
    config::save(&paths.config_file(), &stored).unwrap();
    let before = fs::read_to_string(paths.config_file()).unwrap();
    let config = config_with_host(HOST);
    let secrets = config.open_secrets(&*system_protector()).unwrap();

    let outcome = run_db_setup(&paths, &config, &secrets).unwrap();

    assert!(outcome.result.ok, "{outcome:?}");
    assert!(!outcome.password_generated);
    assert_eq!(fs::read_to_string(&dump).unwrap(), "Gespeichert-2");
    assert_eq!(fs::read_to_string(paths.config_file()).unwrap(), before);
}

#[test]
fn db_setup_reports_the_generated_password_even_when_the_tool_cannot_run() {
    let (_dir, paths) = prepared();
    // Kein Werkzeug installiert: Das Passwort ist trotzdem schon gespeichert, der Aufrufer muss es erfahren
    let config = config_with_host(HOST);
    let secrets = config.open_secrets(&*system_protector()).unwrap();

    let outcome = run_db_setup(&paths, &config, &secrets).unwrap();

    assert!(!outcome.result.ok);
    assert_eq!(outcome.result.code, "tool_missing");
    assert!(outcome.password_generated);
    assert!(stored_db_password(&paths).is_some());
}

#[test]
fn db_setup_propagates_tool_errors_when_nothing_was_generated() {
    let (_dir, paths) = prepared();
    let config = config_with_host(HOST);
    let mut secrets = config.open_secrets(&*system_protector()).unwrap();
    secrets.db_password = Some(Secret::new("Frisch-Eingegeben-1"));

    let error = run_db_setup(&paths, &config, &secrets).unwrap_err();

    assert_eq!(error.code(), "tool_missing");
    assert!(!paths.config_file().exists());
}

#[test]
fn db_setup_outcome_json_shape() {
    let outcome = ops::DbSetupOutcome {
        result: pds_common::tools::ToolResult {
            ok: true,
            code: "ok".into(),
            message: "bereit".into(),
            steps: Vec::new(),
            details: serde_json::Value::Null,
        },
        password_generated: true,
    };

    let json = serde_json::to_value(&outcome).unwrap();

    assert_eq!(json["passwordGenerated"], true);
    assert_eq!(json["result"]["code"], "ok");
}

// ---------------------------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------------------------

fn sqlite_config(path: &str) -> Config {
    let mut config = Config::default();
    config.db.kind = config::DbKind::Sqlite;
    config.db.path = path.into();
    config
}

#[test]
fn db_setup_and_script_refuse_sqlite() {
    let (_dir, paths) = prepared();
    let config = sqlite_config("");
    let secrets = config.open_secrets(&*system_protector()).unwrap();

    let error = ops::db_setup(
        &paths,
        &config,
        &secrets,
        "sa",
        &Secret::new("x"),
        &*system_protector(),
    )
    .unwrap_err();
    assert_eq!(error.code(), "sqlserver_only");
    assert!(error.to_string().contains("nur für SQL Server"), "{error}");
    // Nichts erzeugt und nichts gespeichert
    assert!(!paths.config_file().exists());

    let error = ops::db_script(&paths, &config).unwrap_err();
    assert_eq!(error.code(), "sqlserver_only");
}

#[test]
fn db_backup_refuses_sql_server() {
    let (dir, paths) = prepared();
    let mut config = Config::default();
    config.db.kind = config::DbKind::Sqlserver;

    let error = ops::db_backup(&paths, &config, &dir.path().join("x.db")).unwrap_err();

    assert_eq!(error.code(), "sqlite_only");
}

#[test]
fn db_backup_without_tool_is_tool_missing() {
    let (dir, paths) = prepared();

    let error = ops::db_backup(&paths, &sqlite_config(""), &dir.path().join("x.db")).unwrap_err();

    assert_eq!(error.code(), "tool_missing");
}

#[test]
fn sqlite_dir_step_prepares_only_a_valid_sqlite_path() {
    let paths = Paths::new(
        r"C:\Program Files\EPLAN Panel Data Service",
        r"C:\ProgramData\EPLAN Panel Data Service",
    );
    let never = |_: &Paths, _: &Path| -> Result<SqliteDirOutcome, PlatformError> {
        panic!("darf nicht aufgerufen werden")
    };

    // SQL Server, Netzlaufwerk und Laufwerksstamm: nichts anfassen
    let mut sql_server = sqlite_config(r"D:\PDS\pds.db");
    sql_server.db.kind = config::DbKind::Sqlserver;
    assert_eq!(
        ops::sqlite_dir_step(&sql_server, &paths, never),
        Ok(SqliteDirOutcome::default())
    );
    for path in [
        r"\\server\freigabe\pds.db",
        r"D:\pds.db",
        r"C:\Windows\pds.db",
    ] {
        assert_eq!(
            ops::sqlite_dir_step(&sqlite_config(path), &paths, never),
            Ok(SqliteDirOutcome::default()),
            "{path}"
        );
    }

    // Standard und eigener Pfad: die Datei, die die App öffnet
    for (path, expected) in [
        ("", paths.default_sqlite_file()),
        (r" D:\PDS\pds.db ", PathBuf::from(r"D:\PDS\pds.db")),
    ] {
        let mut seen = None;
        let outcome = ops::sqlite_dir_step(&sqlite_config(path), &paths, |_, file| {
            seen = Some(file.to_owned());
            Ok(SqliteDirOutcome {
                created: Some(PathBuf::from("neu")),
                granted: Vec::new(),
            })
        })
        .unwrap();
        assert_eq!(seen, Some(expected));
        assert_eq!(outcome.created, Some(PathBuf::from("neu")));
    }

    // Ein Fehler ist eine Warnung mit Ordner und Konto
    let warning = ops::sqlite_dir_step(&sqlite_config(r"D:\PDS\pds.db"), &paths, |_, _| {
        Err(PlatformError::AccessDenied)
    })
    .unwrap_err();
    assert!(warning.contains("PDS"), "{warning}");
    assert!(warning.contains(r"NT SERVICE\pds"), "{warning}");
    assert!(warning.contains("Ändern"), "{warning}");
}

#[test]
fn database_summary_names_kind_and_place() {
    let paths = Paths::new("/inst", "/daten");
    assert_eq!(
        ops::database_summary(&sqlite_config(""), &paths),
        format!("SQLite: {}", paths.default_sqlite_file().display())
    );
    assert_eq!(
        ops::database_summary(&sqlite_config(r"D:\PDS\pds.db"), &paths),
        r"SQLite: D:\PDS\pds.db"
    );
    let mut config = Config::default();
    config.db.kind = config::DbKind::Sqlserver;
    assert_eq!(
        ops::database_summary(&config, &paths),
        "SQL Server: (kein Server eingetragen)"
    );
    config.db.server = "sql01".into();
    assert_eq!(
        ops::database_summary(&config, &paths),
        "SQL Server: sql01:1433, Datenbank pds"
    );
}

#[test]
fn status_report_names_the_database() {
    let (_dir, paths) = prepared();
    config::save(&paths.config_file(), &sqlite_config(r"D:\PDS\pds.db")).unwrap();

    let report = ops::status_report(&paths);

    assert_eq!(report.database, r"SQLite: D:\PDS\pds.db");
}
