//! Plattform-API, soweit sie überall läuft: Portprüfung, Datentypen, Fehlercodes und die Ersatz-
//! Implementierungen ohne Windows. Die Windows-Teile prüft `platform_windows.rs` in CI.

use std::net::TcpListener;

use pds_common::names::SERVICE_ACCOUNT;
use pds_common::platform::{
    PlatformError, PortStatus, ScmInfo, ScmState, StoreCert, cert_store, ports,
};
use time::OffsetDateTime;

/// Hört auf allen Adressen, wie später Caddy; der Port kommt vom System.
fn listener() -> (TcpListener, u16) {
    let listener = TcpListener::bind(("0.0.0.0", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

#[test]
fn ports_detects_bound_listener() {
    let (_listener, port) = listener();

    let result = ports::check(&[port]);

    assert_eq!(result.len(), 1);
    let status = &result[0];
    assert_eq!(status.port, port);
    assert!(!status.free, "{status:?}");
    assert!(!status.http_sys, "{status:?}");
    // Unter Windows ist der Besitzer bekannt: dieser Testprozess
    if cfg!(windows) {
        assert_eq!(status.owner_pid, Some(std::process::id()), "{status:?}");
        let name = status.owner_name.as_deref().unwrap_or_default();
        assert!(name.to_ascii_lowercase().ends_with(".exe"), "{status:?}");
        assert!(!name.contains('\\'), "nur der Dateiname: {status:?}");
    }
}

#[test]
fn ports_reports_free_port() {
    let (listener, port) = listener();
    drop(listener);

    let result = ports::check(&[port]);

    assert_eq!(
        result,
        [PortStatus {
            port,
            free: true,
            owner_pid: None,
            owner_name: None,
            http_sys: false,
        }]
    );
}

#[test]
fn ports_keeps_requested_order() {
    let (_first, busy) = listener();
    let (free_listener, free) = listener();
    drop(free_listener);

    let result = ports::check(&[free, busy, free]);

    let summary: Vec<_> = result.iter().map(|s| (s.port, s.free)).collect();
    assert_eq!(summary, [(free, true), (busy, false), (free, true)]);
    assert!(ports::check(&[]).is_empty());
}

#[test]
fn port_status_serializes_camel_case() {
    let status = PortStatus {
        port: 443,
        free: false,
        owner_pid: Some(4),
        owner_name: Some("System (http.sys)".into()),
        http_sys: true,
    };
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "port": 443,
            "free": false,
            "ownerPid": 4,
            "ownerName": "System (http.sys)",
            "httpSys": true,
        })
    );
}

// ---------------------------------------------------------------------------------------------
// Dienststeuerung (Datentypen)
// ---------------------------------------------------------------------------------------------

#[test]
fn scm_state_serializes_snake_case() {
    let cases = [
        (ScmState::NotInstalled, "not_installed"),
        (ScmState::Stopped, "stopped"),
        (ScmState::StartPending, "start_pending"),
        (ScmState::Running, "running"),
        (ScmState::StopPending, "stop_pending"),
        (ScmState::Other, "other"),
    ];
    for (state, text) in cases {
        assert_eq!(serde_json::to_value(state).unwrap(), text);
        assert_eq!(
            serde_json::from_value::<ScmState>(text.into()).unwrap(),
            state
        );
    }
}

#[test]
fn scm_info_serializes_camel_case() {
    let info = ScmInfo {
        state: ScmState::Running,
        start_type: "auto".into(),
        delayed: true,
        account: SERVICE_ACCOUNT.into(),
    };
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "state": "running",
            "startType": "auto",
            "delayed": true,
            "account": SERVICE_ACCOUNT,
        })
    );
    assert_eq!(ScmInfo::not_installed().state, ScmState::NotInstalled);
    assert!(ScmInfo::not_installed().account.is_empty());
}

// ---------------------------------------------------------------------------------------------
// Zertifikatspeicher (Datentypen und Fingerabdruck)
// ---------------------------------------------------------------------------------------------

#[test]
fn store_cert_serializes_camel_case() {
    let cert = StoreCert {
        thumbprint: "AB".repeat(20),
        subject: "trainee.example.com".into(),
        // 2027-03-01T12:00:00Z
        not_after: OffsetDateTime::from_unix_timestamp(1_803_902_400).unwrap(),
        has_private_key: true,
    };
    let json = serde_json::to_value(&cert).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "thumbprint": "AB".repeat(20),
            "subject": "trainee.example.com",
            "notAfter": "2027-03-01T12:00:00Z",
            "hasPrivateKey": true,
        })
    );
}

#[test]
fn thumbprint_is_normalized() {
    let upper = "0123456789ABCDEF0123456789ABCDEF01234567";
    assert_eq!(
        cert_store::normalize_thumbprint(upper).as_deref(),
        Some(upper)
    );
    // Kleinbuchstaben, Leerzeichen und Doppelpunkte wie in certlm.msc bzw. OpenSSL
    let spaced = "01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67";
    assert_eq!(
        cert_store::normalize_thumbprint(spaced).as_deref(),
        Some(upper)
    );
    let colons = "01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67";
    assert_eq!(
        cert_store::normalize_thumbprint(colons).as_deref(),
        Some(upper)
    );
    // Beim Kopieren aus der Zertifikatsanzeige kommt ein unsichtbares U+200E mit
    let copied = format!("\u{200e}{}", upper.to_lowercase());
    assert_eq!(
        cert_store::normalize_thumbprint(&copied).as_deref(),
        Some(upper)
    );
}

#[test]
fn thumbprint_rejects_garbage() {
    for value in [
        "",
        "0123",
        "0123456789ABCDEF0123456789ABCDEF0123456",
        "0123456789ABCDEF0123456789ABCDEF012345678",
        "0123456789ABCDEF0123456789ABCDEF0123456G",
        "Zertifikat",
    ] {
        assert_eq!(cert_store::normalize_thumbprint(value), None, "{value:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------------------------

#[test]
fn error_codes_are_stable_snake_case() {
    use pds_common::tls::TlsError;

    let cases = [
        (PlatformError::Unsupported, "platform_unsupported"),
        (PlatformError::AccessDenied, "access_denied"),
        (
            PlatformError::AccessDeniedAt("C:\\daten".into()),
            "access_denied",
        ),
        (PlatformError::NotExportable, "certificate_not_exportable"),
        (PlatformError::CertificateNotFound, "certificate_not_found"),
        (
            PlatformError::InvalidThumbprint,
            "certificate_thumbprint_invalid",
        ),
        (PlatformError::AccountNotFound, "service_account_not_found"),
        (PlatformError::ServiceNotInstalled, "service_not_installed"),
        (PlatformError::ServiceTimeout, "service_timeout"),
        (PlatformError::Io("x".into()), "platform_io_error"),
        (
            PlatformError::Os {
                context: "Test",
                code: 5,
                message: "x".into(),
            },
            "platform_os_error",
        ),
        (
            PlatformError::Tls(TlsError::NoPrivateKey),
            "tls_no_private_key",
        ),
    ];
    for (error, code) in cases {
        assert_eq!(error.code(), code);
        assert!(
            code.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
            "{code}"
        );
        assert!(!error.to_string().is_empty());
    }
    assert!(
        PlatformError::AccessDenied
            .to_string()
            .contains("Administrator")
    );
    let at = PlatformError::AccessDeniedAt("C:\\daten. Beiseite gelegt: C:\\alt".into());
    assert!(at.to_string().contains("C:\\daten"), "{at}");
    assert!(at.to_string().contains("Beiseite gelegt: C:\\alt"), "{at}");
    assert!(at.to_string().contains("Administrator"), "{at}");
}

// ---------------------------------------------------------------------------------------------
// Ersatz ohne Windows
// ---------------------------------------------------------------------------------------------

#[cfg(not(windows))]
mod without_windows {
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use pds_common::Paths;
    use pds_common::platform::{
        EventLevel, JobObject, PlatformError, cert_store, eventlog, firewall, scm, secure_data_dir,
    };
    use tempfile::TempDir;

    #[test]
    fn job_noop_portable() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        {
            let job = JobObject::new_kill_on_close().unwrap();
            job.assign(&child).unwrap();
            job.terminate().unwrap();
        }

        // Ohne Windows tut das Job Object nichts, auch nicht am Ende: Das Kind läuft weiter
        std::thread::sleep(Duration::from_millis(200));
        assert!(child.try_wait().unwrap().is_none(), "Kind wurde beendet");
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn eventlog_write_is_noop() {
        eventlog::write(EventLevel::Info, "Dienst gestartet").unwrap();
        eventlog::write(EventLevel::Warning, "Zertifikat läuft bald ab").unwrap();
        eventlog::write(EventLevel::Error, "").unwrap();
    }

    #[test]
    fn windows_only_functions_are_unsupported() {
        let unsupported = |result: Result<(), PlatformError>| {
            assert_eq!(result, Err(PlatformError::Unsupported));
        };
        unsupported(scm::query().map(|_| ()));
        unsupported(scm::start());
        unsupported(scm::stop(Duration::from_secs(1)));
        unsupported(scm::restart(Duration::from_secs(1)));
        unsupported(eventlog::register_source(Path::new("/x")));
        unsupported(eventlog::deregister_source());
        unsupported(firewall::ensure_rule(Path::new("/x/caddy"), &[80, 443]));
        unsupported(firewall::remove_rule());
        unsupported(cert_store::list().map(|_| ()));
        let export = cert_store::export(&"AB".repeat(20));
        assert!(matches!(export, Err(PlatformError::Unsupported)));
    }

    #[test]
    fn secure_data_dir_creates_folders() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path().join("inst"), dir.path().join("daten"));

        let outcome = secure_data_dir(&paths).unwrap();
        // Ein zweiter Aufruf ändert nichts und scheitert nicht
        let again = secure_data_dir(&paths).unwrap();

        assert!(outcome.moved_aside.is_empty() && again.moved_aside.is_empty());

        for folder in [
            paths.data_dir.clone(),
            paths.tls_dir(),
            paths.state_dir(),
            paths.logs_dir(),
            paths.caddy_dir(),
        ] {
            assert!(folder.is_dir(), "{}", folder.display());
        }
    }
}
