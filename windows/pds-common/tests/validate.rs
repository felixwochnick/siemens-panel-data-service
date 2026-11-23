//! Validierung: ein Test je Befundcode, dazu Grenzfälle (Ablauf, Ports, Aussteller-Modus).
//!
//! Die Tests prüfen Feldpfad, Code und Schwere, nicht die Meldungstexte (Ausnahme: das Datumsformat).
//! Jede Prüfung vergleicht die vollständige Befundliste, damit keine Folgefehler unbemerkt bleiben.

use pds_common::config::{Config, DbKind, Secrets, TlsMode};
use pds_common::tls::CertInfo;
use pds_common::validate::{
    Finding, Severity, ValidationInput, has_errors, sqlite_findings, validate,
};
use pds_common::{Paths, Secret};
use tempfile::TempDir;
use time::{Date, Duration, Month, OffsetDateTime};

const HOST: &str = "pds.example.com";
const TENANT: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CLIENT: &str = "11111111-2222-3333-4444-555555555555";
const INSTALL_DIR: &str = r"C:\Program Files\EPLAN Panel Data Service";
const DATA_DIR: &str = r"C:\ProgramData\EPLAN Panel Data Service";

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

/// Alles, was `validate` braucht, in veränderbarer Form.
struct Setup {
    config: Config,
    secrets: Secrets,
    certificate: Option<CertInfo>,
    key_matches: Option<bool>,
    now: OffsetDateTime,
    paths: Paths,
}

impl Setup {
    fn findings(&self) -> Vec<Finding> {
        validate(&ValidationInput {
            config: &self.config,
            secrets: &self.secrets,
            certificate: self.certificate.as_ref(),
            certificate_key_matches: self.key_matches,
            now: self.now,
            paths: &self.paths,
        })
    }

    /// Feldpfad, Code und Schwere aller Befunde.
    fn summary(&self) -> Vec<(String, String, Severity)> {
        summary(&self.findings())
    }

    /// Leaf-Zertifikat, das `days` Tage nach `now` abläuft.
    fn expire_in(&mut self, days: i64) {
        self.certificate.as_mut().unwrap().not_after = self.now + Duration::days(days);
    }
}

fn summary(findings: &[Finding]) -> Vec<(String, String, Severity)> {
    findings
        .iter()
        .map(|f| (f.field.clone(), f.code.clone(), f.severity))
        .collect()
}

fn error(field: &str, code: &str) -> Vec<(String, String, Severity)> {
    vec![(field.into(), code.into(), Severity::Error)]
}

fn warning(field: &str, code: &str) -> Vec<(String, String, Severity)> {
    vec![(field.into(), code.into(), Severity::Warning)]
}

fn none() -> Vec<(String, String, Severity)> {
    Vec::new()
}

fn date(year: i32, month: Month, day: u8) -> OffsetDateTime {
    Date::from_calendar_date(year, month, day)
        .unwrap()
        .with_hms(12, 0, 0)
        .unwrap()
        .assume_utc()
}

/// Wie installiert: Programm- und Datenordner von Windows (als Text, auch unter Linux geprüft).
fn windows_paths() -> Paths {
    Paths::new(INSTALL_DIR, DATA_DIR)
}

/// Vollständig gültig: Modus `certificate`, passendes Zertifikat samt Schlüssel, alle Pflichtfelder,
/// SQL Server als Datenbank.
fn valid_config() -> Setup {
    let now = date(2026, Month::November, 19);
    let mut config = Config::default();
    config.public.host = HOST.into();
    config.db.kind = DbKind::Sqlserver;
    config.db.server = "sql.example.com".into();
    config.oidc.tenant_id = TENANT.into();
    config.oidc.client_id = CLIENT.into();
    Setup {
        config,
        secrets: Secrets {
            db_password: Some(Secret::new("Pässwört 1!")),
            oidc_client_secret: Some(Secret::new("client-secret")),
            app_secret: Some(Secret::new("a".repeat(64))),
            acme_eab_hmac: None,
        },
        certificate: Some(CertInfo {
            subject: format!("CN={HOST}"),
            issuer: "CN=LPD Test CA".into(),
            dns_names: vec![HOST.into()],
            not_before: now - Duration::days(30),
            not_after: now + Duration::days(365),
            thumbprint_sha1: "00".repeat(20),
        }),
        key_matches: Some(true),
        now,
        paths: windows_paths(),
    }
}

/// Gültig mit SQLite: ohne Server und ohne Datenbankpasswort.
fn valid_sqlite() -> Setup {
    let mut setup = valid_config();
    setup.config.db = Default::default();
    setup.config.db.kind = DbKind::Sqlite;
    setup.secrets.db_password = None;
    setup
}

/// Mit SQLite und eigenem Pfad.
fn sqlite_at(path: &str) -> Setup {
    let mut setup = valid_sqlite();
    setup.config.db.path = path.into();
    setup
}

/// Gültig im Modus `acme`: ohne Zertifikat, dafür mit E-Mail-Adresse.
fn valid_acme() -> Setup {
    let mut setup = valid_config();
    setup.config.tls.mode = TlsMode::Acme;
    setup.config.tls.acme_email = "admin@example.com".into();
    setup.certificate = None;
    setup.key_matches = None;
    setup
}

/// Gültig im Modus `off`: der Zertifikats-Teil entfällt.
fn valid_off() -> Setup {
    let mut setup = valid_config();
    setup.config.tls.mode = TlsMode::Off;
    setup.config.public.scheme = "http".into();
    setup.config.public.port = 80;
    setup.config.listen.http_port = 8080;
    setup.certificate = None;
    setup.key_matches = None;
    setup
}

// ---------------------------------------------------------------------------------------------
// Grundfälle
// ---------------------------------------------------------------------------------------------

#[test]
fn valid_config_has_no_findings() {
    let setup = valid_config();
    assert_eq!(setup.summary(), none());
    assert!(!has_errors(&setup.findings()));
}

#[test]
fn valid_acme_and_off_have_no_findings() {
    assert_eq!(valid_acme().summary(), none());
    assert_eq!(valid_off().summary(), none());
}

#[test]
fn default_config_reports_what_is_missing() {
    // Teilweise Konfiguration ist erlaubt, sie meldet aber jede Lücke
    // Mit SQL Server (Standard) fehlen Server und Datenbankpasswort
    let config = Config::default();
    let secrets = Secrets::default();
    let paths = windows_paths();
    let findings = validate(&ValidationInput {
        config: &config,
        secrets: &secrets,
        certificate: None,
        certificate_key_matches: None,
        now: date(2026, Month::November, 19),
        paths: &paths,
    });
    let fields: Vec<(&str, &str)> = findings
        .iter()
        .map(|f| (f.field.as_str(), f.code.as_str()))
        .collect();
    assert_eq!(
        fields,
        vec![
            ("public.host", "required"),
            ("tls", "certificate_missing"),
            ("db.server", "required"),
            ("db.password", "required"),
            ("oidc.tenant_id", "required"),
            ("oidc.client_id", "required"),
            ("oidc.client_secret", "oidc_client_secret_missing"),
            ("app.secret", "app_secret_missing"),
        ]
    );
    assert!(has_errors(&findings));
}

#[test]
fn has_errors_ignores_warnings() {
    let finding = |severity| Finding {
        field: "x".into(),
        code: "y".into(),
        message: "z".into(),
        severity,
    };
    assert!(!has_errors(&[]));
    assert!(!has_errors(&[finding(Severity::Warning)]));
    assert!(has_errors(&[
        finding(Severity::Warning),
        finding(Severity::Error)
    ]));
}

#[test]
fn finding_serializes_camel_case_with_lowercase_severity() {
    let finding = Finding {
        field: "public.host".into(),
        code: "required".into(),
        message: "Hostname fehlt".into(),
        severity: Severity::Warning,
    };
    let json = serde_json::to_value(&finding).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "field": "public.host",
            "code": "required",
            "message": "Hostname fehlt",
            "severity": "warning",
        })
    );
    let error: Severity = serde_json::from_str("\"error\"").unwrap();
    assert_eq!(error, Severity::Error);
}

// ---------------------------------------------------------------------------------------------
// Adresse und Ports
// ---------------------------------------------------------------------------------------------

#[test]
fn host_required() {
    let mut setup = valid_config();
    setup.config.public.host = String::new();
    assert_eq!(setup.summary(), error("public.host", "required"));

    setup.config.public.host = "   ".into();
    assert_eq!(setup.summary(), error("public.host", "required"));
}

#[test]
fn host_invalid_hostname() {
    let long_label = format!("{}.example.com", "a".repeat(64));
    let long_name = vec!["a".repeat(60); 5].join(".");
    for host in [
        "exa mple.com",
        "-a.example.com",
        "a-.example.com",
        "a..example.com",
        ".example.com",
        "example.com.",
        "a_b.example.com",
        "https://example.com",
        "example.com:443",
        "example.com/pfad",
        "bücher.example.com",
        "999.1.1.1",
        "1234",
        "[::1]",
        long_label.as_str(),
        long_name.as_str(),
    ] {
        let mut setup = valid_config();
        setup.config.tls.mode = TlsMode::Internal;
        setup.config.public.host = host.into();
        assert_eq!(
            setup.summary(),
            error("public.host", "invalid_hostname"),
            "Host {host:?}"
        );
    }
}

#[test]
fn host_valid_names_and_addresses() {
    for host in [
        "localhost",
        "Pds.Example.COM",
        "server1",
        "a.b.c.d.example.com",
        "10.0.0.5",
        "::1",
        "fe80::1",
        "2001:db8::8a2e:370:7334",
    ] {
        let mut setup = valid_config();
        setup.config.tls.mode = TlsMode::Internal;
        setup.config.public.host = host.into();
        assert_eq!(setup.summary(), none(), "Host {host:?}");
    }
}

#[test]
fn scheme_checked_only_in_off_mode() {
    let mut setup = valid_off();
    setup.config.public.scheme = "ftp".into();
    assert_eq!(setup.summary(), error("public.scheme", "invalid_scheme"));

    setup.config.public.scheme = "https".into();
    assert_eq!(setup.summary(), none());

    // In allen anderen Modi ist das Schema ohne Wirkung
    let mut setup = valid_config();
    setup.config.public.scheme = "ftp".into();
    assert_eq!(setup.summary(), none());
}

#[test]
fn port_zero_is_invalid() {
    let mut setup = valid_config();
    setup.config.public.port = 0;
    assert_eq!(setup.summary(), error("public.port", "invalid_port"));

    let mut setup = valid_config();
    setup.config.listen.http_port = 0;
    assert_eq!(setup.summary(), error("listen.http_port", "invalid_port"));

    let mut setup = valid_config();
    setup.config.internal.port = 0;
    assert_eq!(setup.summary(), error("internal.port", "invalid_port"));

    let mut setup = valid_config();
    setup.config.db.port = 0;
    assert_eq!(setup.summary(), error("db.port", "invalid_port"));
}

#[test]
fn port_one_and_max_are_valid() {
    let mut setup = valid_config();
    setup.config.public.port = 1;
    setup.config.listen.http_port = 65535;
    setup.config.internal.port = 8080;
    setup.config.db.port = 65535;
    assert_eq!(setup.summary(), none());
}

#[test]
fn port_conflict_sits_on_the_later_field() {
    // public.port == listen.http_port
    let mut setup = valid_config();
    setup.config.listen.http_port = 443;
    assert_eq!(setup.summary(), error("listen.http_port", "port_conflict"));

    // public.port == internal.port
    let mut setup = valid_config();
    setup.config.internal.port = 443;
    assert_eq!(setup.summary(), error("internal.port", "port_conflict"));

    // listen.http_port == internal.port
    let mut setup = valid_config();
    setup.config.internal.port = 80;
    assert_eq!(setup.summary(), error("internal.port", "port_conflict"));
}

#[test]
fn port_conflict_all_equal_reports_each_later_field_once() {
    let mut setup = valid_config();
    setup.config.public.port = 8443;
    setup.config.listen.http_port = 8443;
    setup.config.internal.port = 8443;
    assert_eq!(
        setup.summary(),
        vec![
            (
                "listen.http_port".into(),
                "port_conflict".into(),
                Severity::Error
            ),
            (
                "internal.port".into(),
                "port_conflict".into(),
                Severity::Error
            ),
        ]
    );
}

#[test]
fn off_mode_uses_http_port_for_conflict() {
    // public.port ist bei `off` nur der Port in der URL und lauscht nicht
    let mut setup = valid_off();
    setup.config.public.port = 3000;
    setup.config.listen.http_port = 8080;
    setup.config.internal.port = 3000;
    assert_eq!(setup.summary(), none());

    setup.config.public.port = 8080;
    assert_eq!(setup.summary(), none());

    // dafür zählen listen.http_port und internal.port
    setup.config.listen.http_port = 3000;
    assert_eq!(setup.summary(), error("internal.port", "port_conflict"));
}

#[test]
fn port_conflict_ignores_zero_ports() {
    let mut setup = valid_config();
    setup.config.listen.http_port = 0;
    setup.config.internal.port = 0;
    assert_eq!(
        setup.summary(),
        vec![
            (
                "listen.http_port".into(),
                "invalid_port".into(),
                Severity::Error
            ),
            (
                "internal.port".into(),
                "invalid_port".into(),
                Severity::Error
            ),
        ]
    );
}

// ---------------------------------------------------------------------------------------------
// TLS: Zertifikat
// ---------------------------------------------------------------------------------------------

#[test]
fn certificate_missing() {
    let mut setup = valid_config();
    setup.certificate = None;
    setup.key_matches = None;
    assert_eq!(setup.summary(), error("tls", "certificate_missing"));
}

#[test]
fn certificate_key_mismatch() {
    let mut setup = valid_config();
    setup.key_matches = Some(false);
    assert_eq!(setup.summary(), error("tls", "certificate_key_mismatch"));

    // nicht geprüft ist kein Befund
    setup.key_matches = None;
    assert_eq!(setup.summary(), none());
}

#[test]
fn certificate_expired() {
    let mut setup = valid_config();
    setup.expire_in(-1);
    assert_eq!(setup.summary(), error("tls", "certificate_expired"));
}

#[test]
fn expiry_boundary() {
    let mut setup = valid_config();

    setup.expire_in(30);
    assert_eq!(setup.summary(), warning("tls", "certificate_expires_soon"));
    assert!(!has_errors(&setup.findings()));

    setup.expire_in(31);
    assert_eq!(setup.summary(), none());

    // höchstens 30 Tage: schon eine Sekunde mehr bleibt ohne Befund
    setup.certificate.as_mut().unwrap().not_after =
        setup.now + Duration::days(30) + Duration::SECOND;
    assert_eq!(setup.summary(), none());

    setup.expire_in(1);
    assert_eq!(setup.summary(), warning("tls", "certificate_expires_soon"));

    // am letzten Gültigkeitszeitpunkt ist es noch gültig, danach abgelaufen
    setup.expire_in(0);
    assert_eq!(setup.summary(), warning("tls", "certificate_expires_soon"));
    setup.certificate.as_mut().unwrap().not_after = setup.now - Duration::SECOND;
    assert_eq!(setup.summary(), error("tls", "certificate_expired"));
}

#[test]
fn expiry_messages_use_german_date() {
    let mut setup = valid_config();
    setup.certificate.as_mut().unwrap().not_after = date(2026, Month::December, 5);
    let findings = setup.findings();
    assert_eq!(findings.len(), 1);
    assert!(
        findings[0].message.contains("05.12.2026"),
        "{}",
        findings[0].message
    );

    setup.certificate.as_mut().unwrap().not_after = date(2026, Month::October, 12);
    let findings = setup.findings();
    assert_eq!(findings[0].code, "certificate_expired");
    assert!(
        findings[0].message.contains("12.10.2026"),
        "{}",
        findings[0].message
    );
}

#[test]
fn certificate_hostname_mismatch() {
    let mut setup = valid_config();
    setup.config.public.host = "other.example.com".into();
    assert_eq!(
        setup.summary(),
        error("public.host", "certificate_hostname_mismatch")
    );
}

#[test]
fn certificate_wildcard_covers_one_label() {
    let mut setup = valid_config();
    setup.certificate.as_mut().unwrap().dns_names = vec!["*.example.com".into()];
    assert_eq!(setup.summary(), none());

    setup.config.public.host = "a.b.example.com".into();
    assert_eq!(
        setup.summary(),
        error("public.host", "certificate_hostname_mismatch")
    );
}

#[test]
fn certificate_findings_accumulate() {
    let mut setup = valid_config();
    setup.config.public.host = "other.example.com".into();
    setup.key_matches = Some(false);
    setup.expire_in(-5);
    assert_eq!(
        setup.summary(),
        vec![
            (
                "tls".into(),
                "certificate_key_mismatch".into(),
                Severity::Error
            ),
            ("tls".into(), "certificate_expired".into(), Severity::Error),
            (
                "public.host".into(),
                "certificate_hostname_mismatch".into(),
                Severity::Error
            ),
        ]
    );
}

#[test]
fn certificate_not_checked_without_host_or_in_other_modes() {
    // fehlender Host: nur `required`, kein Folgebefund
    let mut setup = valid_config();
    setup.config.public.host = String::new();
    assert_eq!(setup.summary(), error("public.host", "required"));

    // ungültiger Host: nur `invalid_hostname`
    setup.config.public.host = "a b".into();
    assert_eq!(setup.summary(), error("public.host", "invalid_hostname"));

    for mode in [TlsMode::Internal, TlsMode::Off, TlsMode::Acme] {
        let mut setup = valid_config();
        setup.config.tls.mode = mode;
        setup.config.tls.acme_email = "admin@example.com".into();
        setup.config.public.scheme = "https".into();
        setup.certificate = None;
        setup.key_matches = Some(false);
        setup.config.public.host = "other.example.com".into();
        assert_eq!(setup.summary(), none(), "Modus {mode:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// TLS: ACME
// ---------------------------------------------------------------------------------------------

#[test]
fn acme_email_required_and_valid() {
    let mut setup = valid_acme();
    setup.config.tls.acme_email = String::new();
    assert_eq!(setup.summary(), error("tls.acme_email", "required"));

    for email in [
        "admin",
        "admin@",
        "@example.com",
        "admin@example",
        "admin@@example.com",
        "admin@example..com",
        "admin@.example.com",
        "admin@example.com.",
        "ad min@example.com",
        "admin@exa mple.com",
        " admin@example.com",
    ] {
        setup.config.tls.acme_email = email.into();
        assert_eq!(
            setup.summary(),
            error("tls.acme_email", "invalid_email"),
            "E-Mail {email:?}"
        );
    }

    for email in ["a@b.de", "vorname.nachname+tag@mail.example.com"] {
        setup.config.tls.acme_email = email.into();
        assert_eq!(setup.summary(), none(), "E-Mail {email:?}");
    }
}

#[test]
fn acme_ca_url() {
    let mut setup = valid_acme();
    for url in [
        "http://ca.example.com/directory",
        "ca.example.com",
        "https://",
        "https:///directory",
        "https://ca example.com",
        "ftp://ca.example.com",
        "https://ca.example.com:0/dir",
        "https://ca.example.com:abc/dir",
    ] {
        setup.config.tls.acme_ca_url = url.into();
        assert_eq!(
            setup.summary(),
            error("tls.acme_ca_url", "invalid_url"),
            "URL {url:?}"
        );
    }

    for url in [
        "",
        "https://acme-v02.api.letsencrypt.org/directory",
        "https://ca.internal.example.com:8443/acme/acme/directory",
        "https://localhost:9000/dir",
    ] {
        setup.config.tls.acme_ca_url = url.into();
        assert_eq!(setup.summary(), none(), "URL {url:?}");
    }
}

#[test]
fn acme_ca_root_file_must_exist() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("root.pem");

    let mut setup = valid_acme();
    setup.config.tls.acme_ca_root = root.to_string_lossy().into_owned();
    assert_eq!(setup.summary(), error("tls.acme_ca_root", "file_not_found"));

    std::fs::write(&root, "pem").unwrap();
    assert_eq!(setup.summary(), none());

    // leer ist erlaubt
    setup.config.tls.acme_ca_root = String::new();
    assert_eq!(setup.summary(), none());
}

#[test]
fn acme_eab_needs_both_or_neither() {
    let mut setup = valid_acme();
    setup.config.tls.acme_eab_key_id = "kid-1".into();
    assert_eq!(
        setup.summary(),
        error("tls.acme_eab_key_id", "acme_eab_incomplete")
    );

    setup.config.tls.acme_eab_key_id = String::new();
    setup.secrets.acme_eab_hmac = Some(Secret::new("hmac"));
    assert_eq!(
        setup.summary(),
        error("tls.acme_eab_key_id", "acme_eab_incomplete")
    );

    setup.config.tls.acme_eab_key_id = "kid-1".into();
    assert_eq!(setup.summary(), none());

    // ein leeres Secret zählt als nicht gesetzt
    setup.secrets.acme_eab_hmac = Some(Secret::new(""));
    assert_eq!(
        setup.summary(),
        error("tls.acme_eab_key_id", "acme_eab_incomplete")
    );
}

#[test]
fn acme_fields_ignored_in_other_modes() {
    let mut setup = valid_config();
    setup.config.tls.acme_email = "kaputt".into();
    setup.config.tls.acme_ca_url = "http://x".into();
    setup.config.tls.acme_ca_root = "/gibt/es/nicht.pem".into();
    setup.config.tls.acme_eab_key_id = "kid".into();
    assert_eq!(setup.summary(), none());
}

// ---------------------------------------------------------------------------------------------
// Datenbank
// ---------------------------------------------------------------------------------------------

#[test]
fn db_server_named_instance() {
    // `new URL` lehnt den Backslash ab, die App käme gar nicht hoch
    let mut setup = valid_config();
    for server in [
        r"sql01\SQLEXPRESS",
        r"sql01.example.com\inst",
        r"sql01\",
        r"\\sql01",
    ] {
        setup.config.db.server = server.into();
        assert_eq!(
            setup.summary(),
            error("db.server", "named_instance_not_supported"),
            "Server {server:?}"
        );
    }
}

#[test]
fn db_server_ipv6_not_supported() {
    // Die App reicht `url.hostname` samt Klammern an den Treiber, der es nicht auflösen kann
    let mut setup = valid_config();
    for server in [
        "::1",
        "2001:db8::5",
        "[::1]",
        "[2001:db8::5]",
        "::ffff:10.0.0.5",
    ] {
        setup.config.db.server = server.into();
        assert_eq!(
            setup.summary(),
            error("db.server", "ipv6_not_supported"),
            "Server {server:?}"
        );
    }
}

#[test]
fn db_server_hostname() {
    let mut setup = valid_config();
    for server in [
        "sql 01",
        " sql01",
        "a@b",
        "sql01:1433",
        "sql01,1433",
        "tcp:sql01",
        "sql01/db",
        "[sql01]",
        "-sql01",
        "sql01-",
        "sql_01-",
        "sql..example.com",
        "999.1.1.1",
        "sql01.exämple.com",
    ] {
        setup.config.db.server = server.into();
        assert_eq!(
            setup.summary(),
            error("db.server", "invalid_hostname"),
            "Server {server:?}"
        );
    }

    // NetBIOS-artige Namen mit Unterstrich sind bei Firmenservern üblich
    for server in [
        "sql01",
        "SQL01",
        "sql01.example.com",
        "10.0.0.5",
        "SQL_PROD",
        "sql_prod.corp.example.com",
        "_sql",
    ] {
        setup.config.db.server = server.into();
        assert_eq!(setup.summary(), none(), "Server {server:?}");
    }
}

#[test]
fn public_host_stays_strict_about_underscores() {
    // Der Unterstrich ist nur beim Datenbankserver erlaubt: Browser und Zertifikate kennen ihn nicht
    let mut setup = valid_config();
    setup.config.public.host = "sql_prod.example.com".into();
    assert_eq!(setup.summary(), error("public.host", "invalid_hostname"));
}

#[test]
fn db_required_fields() {
    let mut setup = valid_config();
    setup.config.db.server = String::new();
    assert_eq!(setup.summary(), error("db.server", "required"));

    let mut setup = valid_config();
    setup.config.db.database = String::new();
    assert_eq!(setup.summary(), error("db.database", "required"));

    let mut setup = valid_config();
    setup.config.db.user = String::new();
    assert_eq!(setup.summary(), error("db.user", "required"));

    let mut setup = valid_config();
    setup.secrets.db_password = None;
    assert_eq!(setup.summary(), error("db.password", "required"));

    setup.secrets.db_password = Some(Secret::new(""));
    assert_eq!(setup.summary(), error("db.password", "required"));
}

#[test]
fn identifier_with_bracket_rejected() {
    let mut setup = valid_config();
    setup.config.db.database = "a]b".into();
    assert_eq!(setup.summary(), error("db.database", "invalid_identifier"));

    let mut setup = valid_config();
    setup.config.db.user = "o'neil".into();
    assert_eq!(setup.summary(), error("db.user", "invalid_identifier"));

    let mut setup = valid_config();
    setup.config.db.database = "a]b".into();
    setup.config.db.user = "o'neil".into();
    assert_eq!(
        setup.summary(),
        vec![
            (
                "db.database".into(),
                "invalid_identifier".into(),
                Severity::Error
            ),
            (
                "db.user".into(),
                "invalid_identifier".into(),
                Severity::Error
            ),
        ]
    );
}

#[test]
fn system_databases_are_rejected() {
    // model etwa würde Snapshot-Einstellung und db_owner in jede künftige Datenbank vererben
    for name in [
        "master", "model", "msdb", "tempdb", "MODEL", "Master", " tempdb ",
    ] {
        let mut setup = valid_config();
        setup.config.db.database = name.into();
        assert_eq!(
            setup.summary(),
            error("db.database", "system_database_not_allowed"),
            "{name}"
        );
    }
}

#[test]
fn names_that_only_contain_a_system_database_name_are_fine() {
    for name in ["model_x", "my_master", "tempdb2", "Modell"] {
        let mut setup = valid_config();
        setup.config.db.database = name.into();
        assert_eq!(setup.summary(), none(), "{name}");
    }
    // Der Benutzer darf so heißen: Nur der Datenbankname ist geschützt
    let mut setup = valid_config();
    setup.config.db.user = "model".into();
    assert_eq!(setup.summary(), none());
}

#[test]
fn system_database_and_invalid_identifier_report_only_the_identifier() {
    let mut setup = valid_config();
    setup.config.db.database = "".into();
    assert_eq!(setup.summary(), error("db.database", "required"));

    let mut setup = valid_config();
    setup.config.db.database = "ma]ster".into();
    assert_eq!(setup.summary(), error("db.database", "invalid_identifier"));
}

#[test]
fn identifier_other_special_characters_are_fine() {
    // Alles andere wird beim Rendern kodiert bzw. im T-SQL gequotet
    let mut setup = valid_config();
    setup.config.db.database = "Panel Data-Ä_1".into();
    setup.config.db.user = "DOMAIN\\svc app".into();
    assert_eq!(setup.summary(), none());
}

// ---------------------------------------------------------------------------------------------
// Anmeldung (OIDC)
// ---------------------------------------------------------------------------------------------

#[test]
fn tenant_id_required_without_issuer() {
    let mut setup = valid_config();
    setup.config.oidc.tenant_id = String::new();
    assert_eq!(setup.summary(), error("oidc.tenant_id", "required"));
}

#[test]
fn tenant_id_must_be_guid() {
    let mut setup = valid_config();
    for value in [
        "nicht-eine-guid",
        "0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d",
        "{0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d}",
        "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4",
        "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4dd",
        "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4g",
        " 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    ] {
        setup.config.oidc.tenant_id = value.into();
        assert_eq!(
            setup.summary(),
            error("oidc.tenant_id", "invalid_guid"),
            "Tenant {value:?}"
        );
    }

    // Groß-/Kleinschreibung egal
    setup.config.oidc.tenant_id = TENANT.to_uppercase();
    assert_eq!(setup.summary(), none());
}

#[test]
fn tenant_id_ignored_with_custom_issuer() {
    let mut setup = valid_config();
    setup.config.oidc.issuer = "https://sso.example.com/realms/pds".into();
    setup.config.oidc.client_id = "app-client".into();
    setup.config.oidc.tenant_id = "irgendwas".into();
    assert_eq!(setup.summary(), none());

    setup.config.oidc.tenant_id = String::new();
    assert_eq!(setup.summary(), none());
}

#[test]
fn issuer_must_be_https_except_localhost() {
    let mut setup = valid_config();
    setup.config.oidc.client_id = "app-client".into();
    for issuer in [
        "http://sso.example.com/realms/pds",
        "sso.example.com",
        "https://",
        "https:///realms/pds",
        "ftp://sso.example.com",
        "https://sso example.com",
        "http://localhost.example.com",
        "   ",
    ] {
        setup.config.oidc.issuer = issuer.into();
        assert_eq!(
            setup.summary(),
            error("oidc.issuer", "invalid_url"),
            "Issuer {issuer:?}"
        );
    }

    for issuer in [
        "https://sso.example.com/realms/pds",
        "https://sso.example.com:8443/realms/pds/",
        "https://localhost:8443/realms/pds",
        "http://localhost/realms/pds",
        "http://localhost:8080/realms/pds",
        "http://LOCALHOST:8080",
    ] {
        setup.config.oidc.issuer = issuer.into();
        assert_eq!(setup.summary(), none(), "Issuer {issuer:?}");
    }
}

#[test]
fn client_id_required() {
    let mut setup = valid_config();
    setup.config.oidc.client_id = String::new();
    assert_eq!(setup.summary(), error("oidc.client_id", "required"));

    // auch mit eigenem Issuer
    setup.config.oidc.issuer = "https://sso.example.com".into();
    assert_eq!(setup.summary(), error("oidc.client_id", "required"));
}

#[test]
fn client_id_must_be_guid_in_tenant_mode() {
    let mut setup = valid_config();
    setup.config.oidc.client_id = "app-client".into();
    assert_eq!(setup.summary(), error("oidc.client_id", "invalid_guid"));
}

#[test]
fn custom_issuer_allows_non_guid_client_id() {
    let mut setup = valid_config();
    setup.config.oidc.issuer = "https://sso.example.com/realms/pds".into();
    setup.config.oidc.client_id = "pds".into();
    assert_eq!(setup.summary(), none());
}

#[test]
fn client_secret_missing_is_only_a_warning() {
    let mut setup = valid_config();
    setup.secrets.oidc_client_secret = None;
    assert_eq!(
        setup.summary(),
        warning("oidc.client_secret", "oidc_client_secret_missing")
    );
    assert!(!has_errors(&setup.findings()));

    setup.secrets.oidc_client_secret = Some(Secret::new(""));
    assert_eq!(
        setup.summary(),
        warning("oidc.client_secret", "oidc_client_secret_missing")
    );
}

// ---------------------------------------------------------------------------------------------
// Proxy und App
// ---------------------------------------------------------------------------------------------

#[test]
fn proxy_url() {
    let mut setup = valid_config();
    for url in [
        "proxy.example.com:8080",
        "socks5://proxy.example.com:1080",
        "http://",
        "http://proxy example.com",
        "http://proxy.example.com:99999",
    ] {
        setup.config.proxy.url = url.into();
        assert_eq!(
            setup.summary(),
            error("proxy.url", "invalid_url"),
            "Proxy {url:?}"
        );
    }

    for url in [
        "",
        "http://proxy.example.com:8080",
        "https://proxy.example.com",
        "http://[::1]:3128",
        // Ein `@` hinter dem Pfad oder ohne Benutzer gehört nicht zu den Zugangsdaten
        "http://proxy.example.com:8080/a@b",
        "http://proxy.example.com:8080?user=a@b",
        "http://@proxy.example.com:3128",
    ] {
        setup.config.proxy.url = url.into();
        assert_eq!(setup.summary(), none(), "Proxy {url:?}");
    }
}

#[test]
fn proxy_url_with_credentials() {
    // Die Adresse landet im Klartext in `config.toml` und in der Umgebung der Kindprozesse
    let mut setup = valid_config();
    for url in [
        "http://user:pass@proxy.example.com:3128",
        "http://user:pa%40ss@proxy.example.com:3128",
        "https://user@proxy.example.com",
        "http://user:pass@[::1]:3128/path",
    ] {
        setup.config.proxy.url = url.into();
        assert_eq!(
            setup.summary(),
            error("proxy.url", "proxy_credentials_not_supported"),
            "Proxy {url:?}"
        );
    }

    // Eine ungültige Adresse meldet nur `invalid_url`, kein zweiter Befund für dasselbe Feld
    setup.config.proxy.url = "socks5://user:pass@proxy.example.com:1080".into();
    assert_eq!(setup.summary(), error("proxy.url", "invalid_url"));
}

#[test]
fn app_secret_missing() {
    let mut setup = valid_config();
    setup.secrets.app_secret = None;
    assert_eq!(setup.summary(), error("app.secret", "app_secret_missing"));

    setup.secrets.app_secret = Some(Secret::new(""));
    assert_eq!(setup.summary(), error("app.secret", "app_secret_missing"));
}

#[test]
fn app_secret_too_short() {
    let mut setup = valid_config();
    setup.secrets.app_secret = Some(Secret::new("a".repeat(31)));
    assert_eq!(setup.summary(), error("app.secret", "app_secret_too_short"));

    setup.secrets.app_secret = Some(Secret::new("a".repeat(32)));
    assert_eq!(setup.summary(), none());
}

#[test]
fn app_secret_length_counts_characters_not_bytes() {
    // 16 Umlaute sind 32 Bytes, aber nur 16 Zeichen
    let mut setup = valid_config();
    setup.secrets.app_secret = Some(Secret::new("ä".repeat(16)));
    assert_eq!(setup.summary(), error("app.secret", "app_secret_too_short"));

    setup.secrets.app_secret = Some(Secret::new("ä".repeat(32)));
    assert_eq!(setup.summary(), none());
}

#[test]
fn messages_never_contain_secrets() {
    // Meldungen gehen an Admins und ins Protokoll
    let mut setup = valid_config();
    setup.secrets.app_secret = Some(Secret::new("kurz-und-geheim"));
    setup.secrets.db_password = Some(Secret::new("db-geheim"));
    setup.config.db.user = "o'neil".into();
    setup.config.db.database = "a]b".into();
    let text: String = setup.findings().iter().map(|f| f.message.clone()).collect();
    assert!(!text.is_empty());
    assert!(!text.contains("kurz-und-geheim"));
    assert!(!text.contains("db-geheim"));
}

// ---------------------------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------------------------

#[test]
fn sqlite_default_needs_nothing_from_sql_server() {
    let mut setup = valid_sqlite();
    assert_eq!(setup.summary(), none());

    // Die Felder des SQL Servers bleiben gespeichert, zählen aber nicht
    setup.config.db.server = "sql mit leerzeichen".into();
    setup.config.db.port = 0;
    setup.config.db.database = "master".into();
    setup.config.db.user = String::new();
    assert_eq!(setup.summary(), none());
}

#[test]
fn sql_server_still_checks_its_fields() {
    let mut setup = valid_config();
    setup.config.db.path = "kein absoluter Pfad".into();
    setup.config.db.server = String::new();
    // Der SQLite-Pfad zählt bei SQL Server nicht
    assert_eq!(setup.summary(), error("db.server", "required"));
}

#[test]
fn sqlite_custom_paths_that_are_fine() {
    for path in [
        r"D:\PDS\pds.db",
        "D:/PDS/pds.db",
        r"d:\Daten mit Leerzeichen\Controller\pds.sqlite",
        r"C:\ProgramData\PDS\pds.db",
        r"D:\Users-Daten\pds.db",
        r"C:\ProgramData\PDS\Microsoft\pds.db",
        r"D:\ES~WC\pds.db",
        r"D:\PDS\\pds.db",
        // Der Standardordner, ausdrücklich angegeben, und darunter
        r"C:\ProgramData\EPLAN Panel Data Service\data\pds.db",
        r"c:\programdata\eplan panel data service\DATA\alt\pds.db",
        // Leerzeichen am Rand zählen nicht
        r"  D:\PDS\pds.db  ",
    ] {
        assert_eq!(sqlite_at(path).summary(), none(), "{path}");
    }
}

#[test]
fn sqlite_path_must_be_absolute_with_drive_letter() {
    for path in [
        "pds.db",
        r"data\pds.db",
        "C:pds.db",
        r"\PDS\pds.db",
        "/var/lib/pds.db",
        r"1:\PDS\pds.db",
    ] {
        assert_eq!(
            sqlite_at(path).summary(),
            error("db.path", "sqlite_path_not_absolute"),
            "{path}"
        );
    }
}

#[test]
fn sqlite_on_network_shares_is_rejected() {
    for path in [
        r"\\fileserver\freigabe\pds.db",
        "//fileserver/freigabe/pds.db",
        r"\\?\UNC\fileserver\freigabe\pds.db",
        r"\\.\unc\fileserver\freigabe\pds.db",
    ] {
        assert_eq!(
            sqlite_at(path).summary(),
            error("db.path", "sqlite_network_path"),
            "{path}"
        );
    }
}

#[test]
fn sqlite_path_with_invalid_form() {
    for path in [
        r"\\?\C:\PDS\pds.db",
        r"\\.\C:\PDS\pds.db",
        r"D:\PDS\",
        "D:/PDS/",
        r"D:\",
        r"D:\PDS\pds.db:versteckt",
        r"D:\ES*WC\pds.db",
        r"D:\PDS\pds?.db",
        "D:\\PDS\\pds\u{7}.db",
        r"D:\PDS\..\Windows\pds.db",
        r"D:\PDS\.\pds.db",
        r"D:\PDS\pds.db.",
        r"D:\PDS \pds.db",
        r"D:\PDS\con.db",
        r"D:\NUL\pds.db",
        r"D:\PDS\Lpt1",
        // Kurznamen (8.3) verbergen den eigentlichen Ordner
        r"C:\PROGRA~1\pds.db",
        r"C:\PROGRA~3\EPLANS~1\tls\pds.db",
        r"D:\PDS~2\pds.db",
        r"D:\PDS\PDS~1.DB",
    ] {
        assert_eq!(
            sqlite_at(path).summary(),
            error("db.path", "invalid_path"),
            "{path}"
        );
    }
}

#[test]
fn sqlite_path_in_places_that_must_not_be_loosened() {
    for path in [
        // Stamm eines Laufwerks: Ändern auf dem ganzen Laufwerk
        r"D:\pds.db",
        // Systemordner, auch tiefer und in anderer Schreibweise
        r"C:\Windows\pds.db",
        r"c:\WINDOWS\System32\config\pds.db",
        r"C:\Program Files\PDS\pds.db",
        r"D:\Program Files (x86)\PDS\pds.db",
        r"D:\$Recycle.Bin\pds.db",
        r"D:\System Volume Information\pds.db",
        // Gemeinsame Ordner selbst (ein eigener Unterordner ist in Ordnung)
        r"C:\ProgramData\pds.db",
        // Benutzerprofile, auch tiefer und auf anderen Laufwerken
        r"C:\Users\pds.db",
        r"C:\Users\Public\PDS\pds.db",
        r"C:\Users\admin\Documents\pds.db",
        r"D:\users\x\pds.db",
        // ProgramData\Microsoft gehört Windows (der Autostart aller Benutzer liegt darin)
        r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp\pds.db",
        r"C:\ProgramData\microsoft\pds.db",
        // Programmordner: wird bei Update und Deinstallation ersetzt
        r"C:\Program Files\EPLAN Panel Data Service\app\pds.db",
        // Datenordner außerhalb von data\: dort liegen Konfiguration und Schlüssel
        r"C:\ProgramData\EPLAN Panel Data Service\pds.db",
        r"C:\ProgramData\EPLAN Panel Data Service\tls\pds.db",
        r"C:\ProgramData\EPLAN Panel Data Service\logs\pds.db",
        r"C:\ProgramData\EPLAN Panel Data Service\database\pds.db",
    ] {
        assert_eq!(
            sqlite_at(path).summary(),
            error("db.path", "sqlite_path_forbidden"),
            "{path}"
        );
    }
}

#[test]
fn sqlite_path_inside_a_custom_install_dir() {
    let mut setup = sqlite_at(r"D:\Apps\PDS\daten\pds.db");
    setup.paths = Paths::new(r"D:\Apps\PDS", DATA_DIR);
    assert_eq!(setup.summary(), error("db.path", "sqlite_path_forbidden"));
    // Ein Ordner, dessen Name nur so anfängt, liegt nicht darin
    setup.config.db.path = r"D:\Apps\PDS-Daten\pds.db".into();
    assert_eq!(setup.summary(), none());
}

#[test]
fn sqlite_findings_only_cover_the_path() {
    let mut setup = sqlite_at(r"\\server\freigabe\pds.db");
    setup.config.public.host = String::new();
    let findings = sqlite_findings(&setup.config, &setup.paths);
    assert_eq!(summary(&findings), error("db.path", "sqlite_network_path"));

    setup.config.db.kind = DbKind::Sqlserver;
    assert!(sqlite_findings(&setup.config, &setup.paths).is_empty());
}

#[test]
fn sqlite_messages_name_the_problem() {
    let message = |path: &str| sqlite_at(path).findings().remove(0).message;
    assert!(message(r"\\server\x\pds.db").contains("Netzlaufwerk"));
    assert!(message(r"D:\pds.db").contains("Stammverzeichnis"));
    assert!(message(r"C:\ProgramData\EPLAN Panel Data Service\pds.db").contains("data\\"));
    assert!(message("pds.db").contains(r"D:\PDS\pds.db"));
}

#[cfg(windows)]
#[test]
fn sqlite_path_that_is_a_directory() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().display().to_string();
    assert_eq!(
        sqlite_at(&path).summary(),
        error("db.path", "sqlite_path_is_directory")
    );
}

/// Legt eine Junction an (darf jeder Benutzer).
#[cfg(windows)]
fn junction(link: &std::path::Path, target: &std::path::Path) {
    let quote = |path: &std::path::Path| path.display().to_string().replace('\'', "''");
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(format!(
            "New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null",
            quote(link),
            quote(target)
        ))
        .status()
        .unwrap();
    assert!(status.success());
}

// Text allein reicht nicht: Ein Verweis mitten im Pfad lenkt ihn nach C:\Windows
#[cfg(windows)]
#[test]
fn sqlite_path_through_a_junction_is_checked_where_it_leads() {
    let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_owned());
    let dir = tempfile::Builder::new()
        .prefix("pds-validate-")
        .tempdir_in(format!(r"{system}\"))
        .unwrap();
    let windows = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
    let link = dir.path().join("link");
    junction(&link, std::path::Path::new(&windows));

    let path = link.join("System32").join("pds.db");
    let findings = sqlite_at(&path.display().to_string()).findings();
    assert_eq!(
        summary(&findings),
        error("db.path", "sqlite_path_forbidden"),
        "{findings:?}"
    );
    assert!(findings[0].message.contains("tatsächlich"), "{findings:?}");

    // Ohne Verweis ist derselbe Ort in Ordnung
    let plain = dir.path().join("echt").join("pds.db");
    assert_eq!(sqlite_at(&plain.display().to_string()).summary(), none());
}
