//! Befehle der Konfigurations-UI (`logic`), ohne Tauri: Laden, Prüfen und Speichern des Entwurfs,
//! Zertifikatsimport, Werkzeuge, Ports. Läuft unter Linux und Windows; was den Rechner ändern würde
//! (Dienst neu starten), wird hineingereicht.

use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;

use pds_common::config::{self, Config, DbKind, Sealed, SecretField, TlsMode};
use pds_common::ops::{self, ApplyOutcome, OpsError};
use pds_common::platform::PlatformError;
use pds_common::status::ServiceState;
use pds_common::validate::{Finding, has_errors};
use pds_common::{Paths, Secret, system_protector, tls};
use pds_config::logic::{self, Backend, ServiceAction, UiError};
use tempfile::TempDir;
use time::OffsetDateTime;

const HOST: &str = "trainee.example.com";
const DB_PASSWORD: &str = "Db-Pässwort 'x'@1";
const CLIENT_SECRET: &str = "Kl@rtext-Geheimnis #42";
const TENANT_ID: &str = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID: &str = "66666666-7777-8888-9999-000000000000";
/// Testzertifikat aus `pds-common` (Leaf `windows-legacy.example.com`, 100 Jahre).
const FIXTURE_HOST: &str = "windows-legacy.example.com";
const FIXTURE_PASSWORD: &str = "Pässwört 1!";
/// Selbst signiert für `trainee.example.com` (EC P-256, 100 Jahre), erzeugt mit OpenSSL 3:
/// `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out trainee-key.pem`, dann
/// `openssl req -new … -subj /CN=trainee.example.com` und `openssl x509 -req -key trainee-key.pem
/// -days 36500` mit `subjectAltName=DNS:trainee.example.com`, `basicConstraints=CA:FALSE`.
const HOST_CERT: &str = "tests/fixtures/trainee-cert.pem";
const HOST_KEY: &str = "tests/fixtures/trainee-key.pem";

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

fn fixture(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)
}

fn fixture_pfx() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../pds-common/tests/fixtures/openssl-aes256.pfx")
}

/// Vollständige Konfiguration ohne Fehler (TLS intern, damit kein Zertifikat nötig ist).
fn valid_config(backend: &Backend) -> Config {
    let protector = &*backend.protector;
    let mut config = Config::default();
    config.public.host = HOST.into();
    config.tls.mode = TlsMode::Internal;
    config.db.kind = DbKind::Sqlserver;
    config.db.server = "sql01.example.com".into();
    config.oidc.tenant_id = TENANT_ID.into();
    config.oidc.client_id = CLIENT_ID.into();
    config
        .seal(
            SecretField::DbPassword,
            Some(&Secret::new(DB_PASSWORD)),
            protector,
        )
        .unwrap();
    config
        .seal(
            SecretField::AppSecret,
            Some(&ops::generate_app_secret()),
            protector,
        )
        .unwrap();
    config
}

/// Datenordner wie nach `setup install`, ohne Konfigurationsdatei.
fn empty() -> (TempDir, Backend) {
    let dir = TempDir::new().unwrap();
    let paths = Paths::new(dir.path().join("install"), dir.path().join("data"));
    fs::create_dir_all(&paths.data_dir).unwrap();
    (dir, Backend::new(paths, system_protector()))
}

/// Datenordner mit gespeicherter, gültiger Konfiguration.
fn prepared() -> (TempDir, Backend) {
    let (dir, backend) = empty();
    let config = valid_config(&backend);
    config::save(&backend.paths.config_file(), &config).unwrap();
    (dir, backend)
}

fn config_text(backend: &Backend) -> String {
    fs::read_to_string(backend.paths.config_file()).unwrap()
}

fn stored(backend: &Backend) -> Config {
    config::load(&backend.paths.config_file()).unwrap()
}

fn has(findings: &[Finding], field: &str, code: &str) -> bool {
    findings
        .iter()
        .any(|finding| finding.field == field && finding.code == code)
}

fn unsupported(_: &Paths) -> Result<ApplyOutcome, OpsError> {
    Err(PlatformError::Unsupported.into())
}

// ---------------------------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------------------------

#[test]
fn load_state_masks_secrets() {
    let (_dir, backend) = prepared();

    let state = backend.load_state(now());

    assert_eq!(state.config.db.password.0, "***");
    assert_eq!(state.config.app.secret.0, "***");
    assert_eq!(state.config.oidc.client_secret.0, "", "nicht gesetzt");
    assert_eq!(state.config.tls.acme_eab_hmac.0, "");
    assert!(!has_errors(&state.findings), "{:?}", state.findings);
    // Weder Klartext noch versiegelte Werte erreichen die Oberfläche
    let json = serde_json::to_string(&state).unwrap();
    assert!(!json.contains(DB_PASSWORD));
    assert!(!json.contains("insecure:") && !json.contains("dpapi:"));
    assert!(json.contains("\"redirectUri\":\"https://trainee.example.com/auth/callback\""));
}

#[test]
fn load_state_with_unreadable_config_shows_one_finding_and_defaults() {
    let (_dir, backend) = empty();
    fs::write(
        backend.paths.config_file(),
        "schema = 1\n[db]\npasswort = \"geheim\"\n",
    )
    .unwrap();

    let state = backend.load_state(now());

    assert_eq!(state.findings.len(), 1, "{:?}", state.findings);
    assert!(has(&state.findings, "config", "config_unreadable"));
    assert_eq!(state.config, Config::default());
    assert_eq!(state.app_url, "");
    assert!(!serde_json::to_string(&state).unwrap().contains("geheim"));
}

#[test]
fn redirect_uri_from_draft() {
    let mut draft = Config::default();
    draft.public.host = "Trainee.Example.com".into();
    draft.public.port = 8443;
    draft.oidc.tenant_id = TENANT_ID.into();

    let addresses = logic::addresses(&draft);

    assert_eq!(addresses.app_url, "https://trainee.example.com:8443");
    assert_eq!(
        addresses.redirect_uri,
        "https://trainee.example.com:8443/auth/callback"
    );
    assert_eq!(
        addresses.issuer,
        format!("https://login.microsoftonline.com/{TENANT_ID}/v2.0")
    );
    // Ohne Hostname bzw. Tenant gibt es keine Adresse statt einer halben
    let empty = logic::addresses(&Config::default());
    assert_eq!(
        (
            empty.app_url.as_str(),
            empty.redirect_uri.as_str(),
            empty.issuer.as_str()
        ),
        ("", "", "")
    );
}

// ---------------------------------------------------------------------------------------------
// Prüfen und Speichern
// ---------------------------------------------------------------------------------------------

#[test]
fn validate_draft_uses_existing_secret_for_masked() {
    let (_dir, backend) = prepared();
    let before = config_text(&backend);
    let draft = backend.load_state(now()).config;
    assert_eq!(draft.db.password.0, "***");

    let findings = backend.validate_draft(draft.clone(), now());
    assert!(!has(&findings, "db.password", "required"), "{findings:?}");

    // Gegenprobe: entfernt ⇒ Befund
    let mut removed = draft;
    removed.db.password = Sealed::default();
    let findings = backend.validate_draft(removed, now());
    assert!(has(&findings, "db.password", "required"));
    // Prüfen schreibt nichts
    assert_eq!(config_text(&backend), before);
}

#[test]
fn validate_draft_with_unreadable_config_reports_it() {
    let (_dir, backend) = empty();
    fs::write(backend.paths.config_file(), "kaputt = [").unwrap();

    let findings = backend.validate_draft(Config::default(), now());

    assert_eq!(findings.len(), 1);
    assert!(has(&findings, "config", "config_unreadable"));
}

#[test]
fn save_draft_rejects_errors_without_writing() {
    let (_dir, backend) = prepared();
    let before = config_text(&backend);
    let mut draft = backend.load_state(now()).config;
    draft.db.server = String::new();
    draft.public.port = 0;
    draft.oidc.client_secret = Sealed(CLIENT_SECRET.into());

    let outcome = backend
        .save_draft_with(draft, now(), |_| panic!("kein Neustart bei Fehlern"))
        .unwrap();

    assert!(!outcome.saved);
    assert!(outcome.apply.is_none());
    assert!(has(&outcome.findings, "db.server", "required"));
    assert!(has(&outcome.findings, "public.port", "invalid_port"));
    assert_eq!(config_text(&backend), before);
}

#[test]
fn draft_secret_never_written_plain() {
    let (_dir, backend) = prepared();
    let mut draft = backend.load_state(now()).config;
    draft.oidc.client_secret = Sealed(CLIENT_SECRET.into());
    draft.mcp.enabled = true;

    let outcome = backend.save_draft_with(draft, now(), unsupported).unwrap();

    assert!(outcome.saved, "{:?}", outcome.findings);
    assert!(outcome.apply.is_none());
    assert_eq!(outcome.warnings.len(), 1, "Hinweis: nicht neu gestartet");
    let text = config_text(&backend);
    assert!(!text.contains(CLIENT_SECRET), "{text}");
    let saved = stored(&backend);
    assert!(saved.mcp.enabled);
    let secrets = saved.open_secrets(&*backend.protector).unwrap();
    assert_eq!(secrets.oidc_client_secret.unwrap().expose(), CLIENT_SECRET);
    // `***` hat die übrigen Secrets behalten
    assert_eq!(secrets.db_password.unwrap().expose(), DB_PASSWORD);
}

#[cfg(not(windows))]
#[test]
fn save_draft_without_windows_saves_but_cannot_restart() {
    let (_dir, backend) = prepared();
    let mut draft = backend.load_state(now()).config;
    draft.oidc.provider_name = "Siemens ID".into();

    let outcome = backend.save_draft(draft, now()).unwrap();

    assert!(outcome.saved);
    assert!(outcome.apply.is_none());
    assert_eq!(outcome.warnings.len(), 1);
    assert_eq!(stored(&backend).oidc.provider_name, "Siemens ID");
}

#[test]
fn save_draft_restarts_after_writing_and_reports_outcome() {
    let (_dir, backend) = prepared();
    let mut draft = backend.load_state(now()).config;
    draft.db.port = 14330;
    let applied = ApplyOutcome {
        ok: true,
        state: Some(ServiceState::Running),
        message: "Der Dienst läuft, die Anwendung ist bereit.".into(),
        waited_seconds: 7,
    };

    let outcome = backend
        .save_draft_with(draft, now(), |paths| {
            // Erst gespeichert, dann neu gestartet
            assert_eq!(config::load(&paths.config_file()).unwrap().db.port, 14330);
            Ok(applied.clone())
        })
        .unwrap();

    assert!(outcome.saved);
    assert_eq!(outcome.apply, Some(applied));
    assert!(outcome.warnings.is_empty());
}

#[test]
fn save_draft_keeps_unreadable_config() {
    let (_dir, backend) = empty();
    let broken = "schema = 1\n[db]\npasswort = \"geheim\"\n";
    fs::write(backend.paths.config_file(), broken).unwrap();
    let draft = backend.load_state(now()).config;

    let outcome = backend
        .save_draft_with(draft, now(), |_| panic!("nicht gespeichert"))
        .unwrap();

    assert!(!outcome.saved);
    assert!(has(&outcome.findings, "config", "config_unreadable"));
    assert_eq!(config_text(&backend), broken);
}

#[test]
fn hand_written_plain_secret_is_reported_at_its_field_and_can_be_replaced() {
    let (_dir, backend) = prepared();
    // Von Hand eingetragen: Klartext statt `dpapi:…`
    let text = config_text(&backend);
    let sealed = stored(&backend).db.password.0;
    fs::write(
        backend.paths.config_file(),
        text.replace(&sealed, "von-hand-1"),
    )
    .unwrap();

    let state = backend.load_state(now());
    assert!(has(&state.findings, "config", "config_unreadable"));
    assert_eq!(state.config.db.password.0, "***");
    assert!(
        !serde_json::to_string(&state)
            .unwrap()
            .contains("von-hand-1")
    );

    // Unverändert übernommen ⇒ Befund am Feld, nicht gespeichert
    let findings = backend.validate_draft(state.config.clone(), now());
    assert!(has(&findings, "db.password", "config_secret_unsealed"));

    // Neu eingegeben ⇒ versiegelt gespeichert
    let mut draft = state.config;
    draft.db.password = Sealed("Neu-Pässwort-2".into());
    let outcome = backend.save_draft_with(draft, now(), unsupported).unwrap();
    assert!(outcome.saved, "{:?}", outcome.findings);
    let secrets = stored(&backend).open_secrets(&*backend.protector).unwrap();
    assert_eq!(secrets.db_password.unwrap().expose(), "Neu-Pässwort-2");
}

// ---------------------------------------------------------------------------------------------
// Werkzeuge
// ---------------------------------------------------------------------------------------------

#[test]
fn db_test_blocks_on_config_errors_without_running_tool() {
    let (_dir, backend) = prepared();
    let mut draft = backend.load_state(now()).config;
    draft.db.server = String::new();

    let result = backend.db_test(draft).unwrap();

    assert!(!result.ok);
    assert_eq!(result.code, "config_invalid");
    assert!(
        result
            .steps
            .iter()
            .any(|step| step.code == "required" && step.details["field"] == "db.server"),
        "{:?}",
        result.steps
    );
}

#[test]
fn db_test_runs_tool_with_draft() {
    // Ohne Node im Installationsordner meldet der Aufruf das fehlende Werkzeug
    let (_dir, backend) = prepared();
    let draft = backend.load_state(now()).config;

    let error = backend.db_test(draft).unwrap_err();

    assert_eq!(error.code, "tool_missing");
}

#[test]
fn oidc_test_blocks_on_invalid_tenant() {
    let (_dir, backend) = prepared();
    let mut draft = backend.load_state(now()).config;
    draft.oidc.tenant_id = "kein-guid".into();

    let result = backend.oidc_test(draft, true).unwrap();

    assert_eq!(result.code, "config_invalid");
    assert!(
        result
            .steps
            .iter()
            .any(|step| step.details["field"] == "oidc.tenant_id")
    );
}

#[test]
fn db_setup_generates_password_when_unset_and_saves_only_that() {
    let (_dir, backend) = empty();
    let mut config = valid_config(&backend);
    config.db.password = Sealed::default();
    config::save(&backend.paths.config_file(), &config).unwrap();
    let mut draft = backend.load_state(now()).config;
    assert_eq!(draft.db.password.0, "");
    draft.db.database = "anders".into();

    let outcome = backend
        .db_setup(draft, "sa", Secret::new("Admin-Pässwort"))
        .unwrap();

    assert!(outcome.password_generated);
    assert!(!outcome.result.ok);
    assert_eq!(outcome.result.code, "tool_missing");
    let saved = stored(&backend);
    assert!(!saved.db.password.is_empty());
    assert_eq!(saved.db.database, "pds", "Entwurf nicht gespeichert");
}

#[test]
fn db_setup_needs_admin_login() {
    let (_dir, backend) = prepared();
    let draft = backend.load_state(now()).config;

    let user = backend
        .db_setup(draft.clone(), "  ", Secret::new("x"))
        .unwrap_err();
    let password = backend.db_setup(draft, "sa", Secret::new("")).unwrap_err();

    assert_eq!(user.code, "db_admin_user_missing");
    assert_eq!(password.code, "db_admin_password_missing");
}

#[test]
fn db_script_needs_only_names() {
    let (dir, backend) = prepared();
    let target = dir.path().join("setup.sql");
    let mut draft = backend.load_state(now()).config;
    // Server und Passwort braucht das Skript nicht
    draft.db.server = String::new();
    draft.db.password = Sealed::default();

    let error = backend.db_script(draft.clone(), &target).unwrap_err();
    assert_eq!(error.code, "tool_missing");

    draft.db.database = String::new();
    let result = backend.db_script(draft, &target).unwrap();
    assert_eq!(result.code, "config_invalid");
    assert!(!target.exists());
}

// ---------------------------------------------------------------------------------------------
// Ports, Dienst, App-Secret, Logs
// ---------------------------------------------------------------------------------------------

#[test]
fn ports_check_reports_occupied_port() {
    let listener = TcpListener::bind(("0.0.0.0", 0)).unwrap();
    let busy = listener.local_addr().unwrap().port();
    let mut draft = Config::default();
    draft.tls.mode = TlsMode::Off;
    draft.listen.http_port = busy;

    let ports = logic::ports_check(&draft);

    // Bei `off` lauscht nichts auf `public.port`
    let numbers: Vec<u16> = ports.iter().map(|port| port.port).collect();
    assert_eq!(numbers, vec![busy, draft.internal.port]);
    assert!(!ports[0].free);
}

#[test]
fn wanted_ports_are_unique_and_ordered() {
    let mut draft = Config::default();
    draft.public.port = 8443;
    draft.listen.http_port = 8080;
    draft.internal.port = 8080;

    assert_eq!(logic::wanted_ports(&draft), vec![8080, 8443]);
}

#[cfg(not(windows))]
#[test]
fn service_control_without_windows_is_unsupported() {
    let (_dir, backend) = prepared();

    let error = backend.service_control(ServiceAction::Restart).unwrap_err();

    assert_eq!(error.code, "platform_unsupported");
}

#[test]
fn service_action_from_ui() {
    let action: ServiceAction = serde_json::from_str("\"restart\"").unwrap();
    assert_eq!(action, ServiceAction::Restart);
    assert!(serde_json::from_str::<ServiceAction>("\"pause\"").is_err());
}

#[test]
fn get_status_names_the_address() {
    let (_dir, backend) = prepared();

    let report = backend.get_status();

    assert_eq!(report.app_url, format!("https://{HOST}"));
    assert!(report.status.is_none());
}

#[test]
fn regenerate_app_secret_replaces_it() {
    let (_dir, backend) = prepared();
    let before = stored(&backend).app.secret;

    backend.regenerate_app_secret().unwrap();

    let after = stored(&backend).app.secret;
    assert!(!after.is_empty());
    assert_ne!(after, before);
}

#[test]
fn logs_dir_must_exist() {
    let (_dir, backend) = prepared();
    assert_eq!(backend.logs_dir().unwrap_err().code, "logs_dir_missing");

    fs::create_dir_all(backend.paths.logs_dir()).unwrap();
    assert_eq!(backend.logs_dir().unwrap(), backend.paths.logs_dir());
}

#[test]
fn web_console_url_comes_from_the_saved_config() {
    let (_dir, backend) = prepared();
    assert_eq!(
        backend.web_console_url().unwrap(),
        format!("https://{HOST}")
    );

    // Ein Entwurf ändert nichts, solange er nicht gespeichert ist
    let mut draft = backend.load_state(now()).config;
    draft.public.host = "anders.example.com".into();
    backend.validate_draft(draft, now());
    assert_eq!(
        backend.web_console_url().unwrap(),
        format!("https://{HOST}")
    );
}

#[test]
fn web_console_url_needs_a_host() {
    let dir = TempDir::new().unwrap();
    let backend = Backend::new(
        Paths::new(dir.path().join("install"), dir.path().join("data")),
        system_protector(),
    );
    assert_eq!(
        backend.web_console_url().unwrap_err().code,
        "web_console_unconfigured"
    );
}

#[test]
fn web_console_url_only_plain_http_addresses() {
    let mut config = Config::default();
    config.public.host = "PDS.Example.com".into();
    config.public.port = 8443;
    assert_eq!(
        logic::web_console_url(&config).unwrap(),
        "https://pds.example.com:8443"
    );

    config.tls.mode = TlsMode::Off;
    config.public.scheme = "http".into();
    config.public.port = 80;
    assert_eq!(
        logic::web_console_url(&config).unwrap(),
        "http://pds.example.com"
    );

    config.public.host = "::1".into();
    assert_eq!(logic::web_console_url(&config).unwrap(), "http://[::1]");

    // explorer.exe deutet Kommas, Leerzeichen und Anführungszeichen; Pfade sind keine Adressen
    for host in [
        "a,b.example.com",
        "a b",
        "a\"b",
        "pds.example.com/x",
        r"C:\Windows",
        "-x",
    ] {
        config.public.host = host.into();
        assert_eq!(
            logic::web_console_url(&config).unwrap_err().code,
            "web_console_url_invalid",
            "{host}"
        );
    }
    config.public.scheme = "file".into();
    config.public.host = "pds.example.com".into();
    assert_eq!(
        logic::web_console_url(&config).unwrap_err().code,
        "web_console_url_invalid"
    );
}

// ---------------------------------------------------------------------------------------------
// Zertifikat
// ---------------------------------------------------------------------------------------------

/// Konfiguration mit dem Hostnamen des Testzertifikats.
fn prepared_for_fixture() -> (TempDir, Backend) {
    let (dir, backend) = empty();
    let mut config = valid_config(&backend);
    config.public.host = FIXTURE_HOST.into();
    config.tls.mode = TlsMode::Certificate;
    config::save(&backend.paths.config_file(), &config).unwrap();
    (dir, backend)
}

#[test]
fn tls_import_pfx_stores_certificate() {
    let (_dir, backend) = prepared_for_fixture();
    assert!(has(
        &backend.load_state(now()).findings,
        "tls",
        "certificate_missing"
    ));

    let info = backend
        .tls_import_pfx(&fixture_pfx(), Secret::new(FIXTURE_PASSWORD), "", now())
        .unwrap();

    assert_eq!(info.subject, format!("CN={FIXTURE_HOST}"));
    let state = backend.load_state(now());
    assert_eq!(state.certificate, Some(info));
    assert!(!has_errors(&state.findings), "{:?}", state.findings);
}

#[test]
fn tls_import_pfx_with_wrong_password_names_the_problem_not_the_password() {
    let (_dir, backend) = prepared_for_fixture();

    let error = backend
        .tls_import_pfx(&fixture_pfx(), Secret::new("falsch-123"), "", now())
        .unwrap_err();

    assert_eq!(error.code, "tls_wrong_password");
    assert!(!error.message.contains("falsch-123"));
}

#[test]
fn tls_import_rejects_foreign_hostname() {
    let (_dir, backend) = prepared();

    let error = backend
        .tls_import_pfx(&fixture_pfx(), Secret::new(FIXTURE_PASSWORD), "", now())
        .unwrap_err();

    assert_eq!(error.code, "rejected");
    assert!(tls::load_info(&backend.paths).unwrap().is_none());
}

#[test]
fn tls_import_pem_reads_both_files() {
    let (dir, backend) = prepared_for_fixture();
    let material = tls::from_pfx(
        &fs::read(fixture_pfx()).unwrap(),
        &Secret::new(FIXTURE_PASSWORD),
    )
    .unwrap();
    let cert = dir.path().join("chain.pem");
    let key = dir.path().join("key.pem");
    fs::write(&cert, &material.chain_pem).unwrap();
    fs::write(&key, material.key_pem.expose()).unwrap();

    let info = backend.tls_import_pem(&cert, &key, "", now()).unwrap();
    assert_eq!(info.subject, format!("CN={FIXTURE_HOST}"));

    let missing = backend
        .tls_import_pem(&dir.path().join("fehlt.pem"), &key, "", now())
        .unwrap_err();
    assert_eq!(missing.code, "file_unreadable");
}

#[test]
fn tls_import_checks_the_draft_host_so_host_and_certificate_can_change_together() {
    // Gespeichert: Hostname A mit Zertifikat A
    let (_dir, backend) = empty();
    let mut config = valid_config(&backend);
    config.tls.mode = TlsMode::Certificate;
    config::save(&backend.paths.config_file(), &config).unwrap();
    backend
        .tls_import_pem(&fixture(HOST_CERT), &fixture(HOST_KEY), "", now())
        .unwrap();
    assert!(!has_errors(&backend.load_state(now()).findings));

    // Gegen den gespeicherten Hostnamen geprüft, passt Zertifikat B nicht …
    let rejected = backend
        .tls_import_pfx(&fixture_pfx(), Secret::new(FIXTURE_PASSWORD), " ", now())
        .unwrap_err();
    assert_eq!(rejected.code, "rejected");
    // … und ohne Zertifikat B lässt sich Hostname B nicht speichern
    let mut draft = backend.load_state(now()).config;
    draft.public.host = FIXTURE_HOST.into();
    let blocked = backend
        .save_draft_with(draft.clone(), now(), unsupported)
        .unwrap();
    assert!(has(
        &blocked.findings,
        "public.host",
        "certificate_hostname_mismatch"
    ));

    // Mit dem Hostnamen aus dem Entwurf geht beides
    let info = backend
        .tls_import_pfx(
            &fixture_pfx(),
            Secret::new(FIXTURE_PASSWORD),
            FIXTURE_HOST,
            now(),
        )
        .unwrap();
    assert_eq!(info.subject, format!("CN={FIXTURE_HOST}"));
    assert_eq!(
        stored(&backend).public.host,
        HOST,
        "Import speichert nur das Zertifikat"
    );
    let outcome = backend.save_draft_with(draft, now(), unsupported).unwrap();
    assert!(outcome.saved, "{:?}", outcome.findings);
    assert_eq!(stored(&backend).public.host, FIXTURE_HOST);
}

#[test]
fn tls_import_store_checks_thumbprint_first() {
    let (_dir, backend) = prepared_for_fixture();

    let error = backend.tls_import_store("12:34", "", now()).unwrap_err();

    assert_eq!(error.code, "certificate_thumbprint_invalid");
}

// ---------------------------------------------------------------------------------------------
// Fehlerform und Programmstart
// ---------------------------------------------------------------------------------------------

#[test]
fn ui_error_is_code_and_message() {
    let error = UiError::from(OpsError::DataDirMissing);

    let json = serde_json::to_value(&error).unwrap();

    assert_eq!(json["code"], "data_dir_missing");
    assert!(json["message"].as_str().unwrap().contains("Datenordner"));
    assert_eq!(json.as_object().unwrap().len(), 2);
}

#[cfg(not(windows))]
#[test]
fn program_without_windows_says_so() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_pds-config"))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("nur unter Windows"));
}

// ---------------------------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------------------------

/// Gespeicherte Konfiguration mit SQLite statt SQL Server.
fn sqlite_draft(backend: &Backend) -> Config {
    let mut draft = backend.load_state(now()).config;
    draft.db.kind = DbKind::Sqlite;
    draft
}

#[test]
fn load_state_names_the_default_database_file() {
    let (_dir, backend) = prepared();

    let state = backend.load_state(now());

    assert_eq!(
        state.default_db_path,
        backend.paths.default_sqlite_file().display().to_string()
    );
    assert!(
        state
            .status
            .database
            .starts_with("SQL Server: sql01.example.com:1433")
    );
}

#[test]
fn save_draft_switches_to_sqlite_without_sql_server_fields() {
    let (_dir, backend) = prepared();
    let mut draft = sqlite_draft(&backend);
    // Die Felder des SQL Servers bleiben, zählen aber nicht mehr
    draft.db.server = String::new();
    draft.db.password = Sealed::default();

    let outcome = backend.save_draft_with(draft, now(), unsupported).unwrap();

    assert!(outcome.saved, "{:?}", outcome.findings);
    assert_eq!(stored(&backend).db.kind, DbKind::Sqlite);
}

#[test]
fn save_draft_rejects_a_network_path() {
    let (_dir, backend) = prepared();
    let before = config_text(&backend);
    let mut draft = sqlite_draft(&backend);
    draft.db.path = r"\\fileserver\pds\pds.db".into();

    let outcome = backend
        .save_draft_with(draft, now(), |_| panic!("kein Neustart bei Fehlern"))
        .unwrap();

    assert!(!outcome.saved);
    assert!(has(&outcome.findings, "db.path", "sqlite_network_path"));
    assert_eq!(config_text(&backend), before);
}

#[test]
fn db_setup_and_script_refuse_sqlite_drafts() {
    let (dir, backend) = prepared();
    let draft = sqlite_draft(&backend);

    let setup = backend
        .db_setup(draft.clone(), "sa", Secret::new("x"))
        .unwrap_err();
    let script = backend
        .db_script(draft, &dir.path().join("setup.sql"))
        .unwrap_err();

    assert_eq!(setup.code, "sqlserver_only");
    assert_eq!(script.code, "sqlserver_only");
}

#[test]
fn db_backup_for_sqlite_only_and_with_a_valid_path() {
    let (dir, backend) = prepared();
    let target = dir.path().join("sicherung.db");

    // SQL Server: keine Sicherung über das Werkzeug
    let draft = backend.load_state(now()).config;
    assert_eq!(
        backend.db_backup(draft, &target).unwrap_err().code,
        "sqlite_only"
    );

    // Ungültiger Pfad: Befund statt Aufruf
    let mut draft = sqlite_draft(&backend);
    draft.db.path = "relativ.db".into();
    let result = backend.db_backup(draft, &target).unwrap();
    assert_eq!(result.code, "config_invalid");

    // Gültig: ohne Node im Installationsordner fehlt das Werkzeug
    let draft = sqlite_draft(&backend);
    assert_eq!(
        backend.db_backup(draft, &target).unwrap_err().code,
        "tool_missing"
    );
}
