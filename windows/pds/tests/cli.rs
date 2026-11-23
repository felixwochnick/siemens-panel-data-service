//! CLI als Prozess: Status, Konfiguration, Secrets, Setup und der Dienst im Vordergrund.
//!
//! Jeder Test bekommt eigene Ordner über `PDS_DATA_DIR`/`PDS_INSTALL_DIR`.

use std::fs;
use std::path::{Path, PathBuf};

use assert_cmd::Command;
use pds_common::config::{self, Config, DbKind, SecretField, TlsMode};
use pds_common::{Secret, system_protector};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_pds");
const SECRET_AS_ARGUMENT: &str =
    "Secrets nie als Argument übergeben – Wert wird abgefragt oder mit --stdin gelesen";

struct Env {
    dir: TempDir,
}

impl Env {
    /// Mit vorhandenem Datenordner (unter Windows legt nur `setup install` ihn an).
    fn new() -> Self {
        let env = Self::fresh();
        fs::create_dir_all(env.data()).unwrap();
        env
    }

    /// Ohne Datenordner, wie vor der Installation.
    fn fresh() -> Self {
        Self {
            dir: TempDir::new().unwrap(),
        }
    }

    fn data(&self) -> PathBuf {
        self.dir.path().join("data")
    }

    fn install(&self) -> PathBuf {
        self.dir.path().join("install")
    }

    fn config_file(&self) -> PathBuf {
        self.data().join("config.toml")
    }

    fn status_file(&self) -> PathBuf {
        self.data().join("state").join("status.json")
    }

    fn cmd(&self) -> Command {
        let mut cmd = Command::new(BIN);
        cmd.env("PDS_DATA_DIR", self.data())
            .env("PDS_INSTALL_DIR", self.install());
        cmd
    }

    /// Für den Dienst als Kindprozess (nur ohne Windows im Vordergrund möglich).
    #[cfg(not(windows))]
    fn std_cmd(&self) -> std::process::Command {
        let mut cmd = std::process::Command::new(BIN);
        cmd.env("PDS_DATA_DIR", self.data())
            .env("PDS_INSTALL_DIR", self.install());
        cmd
    }

    fn config(&self) -> Config {
        config::load(&self.config_file()).unwrap()
    }

    fn secret(&self, field: SecretField) -> Option<String> {
        let secrets = self.config().open_secrets(&*system_protector()).unwrap();
        let secret = match field {
            SecretField::DbPassword => secrets.db_password,
            SecretField::OidcClientSecret => secrets.oidc_client_secret,
            SecretField::AppSecret => secrets.app_secret,
            SecretField::AcmeEabHmac => secrets.acme_eab_hmac,
        };
        secret.map(|secret| secret.expose().to_owned())
    }

    fn show_json(&self) -> serde_json::Value {
        let output = self
            .cmd()
            .args(["config", "show", "--json"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

fn stdout(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Inhalt aller Dateien unterhalb von `dir` (für "Klartext steht nirgends").
fn all_file_contents(dir: &Path) -> String {
    let mut text = String::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            text.push_str(&all_file_contents(&path));
        } else {
            text.push_str(&String::from_utf8_lossy(&fs::read(&path).unwrap()));
        }
    }
    text
}

/// Gültig ohne Zertifikat: Modus `internal`, SQL Server, alle Pflichtfelder gesetzt. Ohne
/// `db_password` bleibt das Datenbankpasswort leer.
fn write_valid_config(env: &Env, db_password: Option<&str>) {
    let protector = system_protector();
    let mut config = Config::default();
    config.public.host = "trainee.example.com".into();
    config.tls.mode = TlsMode::Internal;
    config.db.kind = DbKind::Sqlserver;
    config.db.server = "sql.example.com".into();
    config.oidc.tenant_id = "11111111-2222-3333-4444-555555555555".into();
    config.oidc.client_id = "11111111-2222-3333-4444-666666666666".into();
    config.internal.port = 3123;
    let secrets = [
        (SecretField::DbPassword, db_password),
        (SecretField::OidcClientSecret, Some("client-secret-Wert")),
        (SecretField::AppSecret, Some(&*"x".repeat(64))),
    ];
    for (field, value) in secrets {
        config
            .seal(field, value.map(Secret::new).as_ref(), &*protector)
            .unwrap();
    }
    fs::create_dir_all(env.data()).unwrap();
    config::save(&env.config_file(), &config).unwrap();
}

// ---------------------------------------------------------------------------------------------
// Status und Setup
// ---------------------------------------------------------------------------------------------

/// Unter Windows braucht `setup install` das Dienstkonto, das erst das MSI anlegt (Smoke-Test).
#[cfg(not(windows))]
#[test]
fn status_json_unconfigured() {
    let env = Env::fresh();

    env.cmd().args(["setup", "install"]).assert().success();

    // App-Secret: versiegelt, nach dem Öffnen 64 Zeichen base64url
    let text = fs::read_to_string(env.config_file()).unwrap();
    let scheme = system_protector().scheme();
    assert!(text.contains(&format!("secret = \"{scheme}:")), "{text}");
    let app_secret = env.secret(SecretField::AppSecret).unwrap();
    assert_eq!(app_secret.len(), 64);
    assert!(!text.contains(&app_secret));
    // `data` für eine SQLite-Datenbank, falls sie gewählt wird; Standard ist SQL Server
    for dir in ["tls", "state", "logs", "caddy", "data"] {
        assert!(env.data().join(dir).is_dir(), "{dir}");
    }
    assert!(text.contains("kind = \"sqlserver\""), "{text}");

    // Vor dem ersten Dienststart gibt es keinen Status
    let output = env.cmd().args(["status", "--json"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"], serde_json::Value::Null);

    // Der Dienst meldet "nicht eingerichtet", `status` zeigt das ohne Fehler-Exit
    let daemon = foreground::Daemon::start(&env);
    daemon.wait_for_state("unconfigured");
    let output = env.cmd().args(["status", "--json"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"]["state"], "unconfigured");
    assert_eq!(report["stale"], false);
    let codes: Vec<&str> = report["status"]["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|finding| finding["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"required"), "{codes:?}");
    assert!(!codes.contains(&"app_secret_missing"), "{codes:?}");

    let output = env.cmd().arg("status").output().unwrap();
    assert!(output.status.success());
    let text = stdout(&output);
    assert!(text.contains("nicht eingerichtet"), "{text}");
    assert!(text.contains("public.host"), "{text}");
    daemon.terminate();
}

#[test]
fn status_text_reports_stale_service_first() {
    use pds_common::status::{self, ChildStatus, ServiceState, Status};
    use time::OffsetDateTime;

    let env = Env::new();
    let heartbeat = OffsetDateTime::now_utc() - time::Duration::seconds(120);
    status::write(
        &env.status_file(),
        &Status {
            state: ServiceState::Running,
            since: heartbeat,
            heartbeat,
            product_version: "0.1.0".into(),
            node_version: "24.0.0".into(),
            caddy_version: "2.11.9".into(),
            health: None,
            last_error: None,
            next_attempt: None,
            findings: Vec::new(),
            certificate_not_after: None,
            app: ChildStatus::default(),
            proxy: ChildStatus::default(),
        },
    )
    .unwrap();

    let output = env.cmd().arg("status").output().unwrap();

    assert!(output.status.success(), "{output:?}");
    let text = stdout(&output);
    let first = text.lines().next().unwrap_or_default();
    assert!(
        first.starts_with("Dienst läuft nicht (letztes Lebenszeichen vor 1"),
        "{text}"
    );
    // Der zuletzt gemeldete Zustand steht trotzdem da
    assert!(
        text.contains("Zustand:") && text.contains("läuft"),
        "{text}"
    );
}

#[test]
fn status_without_anything_is_ok() {
    let env = Env::fresh();

    let output = env.cmd().arg("status").output().unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(
        stdout(&output).contains("Kein Status"),
        "{}",
        stdout(&output)
    );
}

/// Wie ein Aufruf ohne Administratorrechte unter Windows: Status und Konfiguration sind da, aber
/// nicht lesbar.
#[cfg(unix)]
#[test]
fn status_without_read_access_says_so() {
    use std::os::unix::fs::PermissionsExt;

    let env = Env::fresh();
    env.cmd().args(["setup", "install"]).assert().success();
    fs::write(env.status_file(), "{}").unwrap();
    for file in [env.status_file(), env.config_file()] {
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
    }
    if fs::read(env.status_file()).is_ok() {
        eprintln!("übersprungen: läuft als root, chmod 000 sperrt nichts");
        return;
    }

    let output = env.cmd().arg("status").output().unwrap();

    assert!(output.status.success(), "{output:?}");
    let text = stdout(&output);
    assert!(
        text.contains("Status nicht lesbar – bitte als Administrator ausführen"),
        "{text}"
    );
    assert!(
        text.contains("Konfiguration nicht lesbar – bitte als Administrator ausführen"),
        "{text}"
    );
    assert!(!text.contains("lief noch nie"), "{text}");
    assert!(!text.contains("kein Hostname"), "{text}");

    let output = env.cmd().args(["status", "--json"]).output().unwrap();
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["statusError"]["accessDenied"], true);
    assert_eq!(report["configError"]["accessDenied"], true);
}

#[cfg(not(windows))]
#[test]
fn setup_install_is_idempotent_and_uninstall_removes_data() {
    let env = Env::fresh();
    env.cmd().args(["setup", "install"]).assert().success();
    let first = env.secret(SecretField::AppSecret).unwrap();

    env.cmd().args(["setup", "install"]).assert().success();
    assert_eq!(env.secret(SecretField::AppSecret).unwrap(), first);

    env.cmd().args(["setup", "uninstall"]).assert().success();
    assert!(
        env.config_file().is_file(),
        "ohne --remove-data bleiben die Daten"
    );

    env.cmd()
        .args(["setup", "uninstall", "--remove-data"])
        .assert()
        .success();
    assert!(!env.data().exists());
}

#[cfg(not(windows))]
#[test]
fn setup_install_keeps_unreadable_config() {
    let env = Env::new();
    fs::write(env.config_file(), "[public\n").unwrap();

    let output = env.cmd().args(["setup", "install"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(
        stderr(&output).contains("nicht lesbar"),
        "{}",
        stderr(&output)
    );
    assert_eq!(fs::read_to_string(env.config_file()).unwrap(), "[public\n");
}

#[test]
fn hidden_commands_stay_out_of_help() {
    let env = Env::new();

    let output = env.cmd().arg("--help").output().unwrap();

    assert!(output.status.success());
    let text = stdout(&output);
    assert!(text.contains("status"), "{text}");
    assert!(text.contains("config"), "{text}");
    assert!(text.contains("service"), "{text}");
    assert!(!text.contains("daemon"), "{text}");
    assert!(!text.contains("setup"), "{text}");
    assert!(text.contains("Aufruf:"), "{text}");
}

#[test]
fn unknown_command_is_error_in_german() {
    let env = Env::new();

    let output = env.cmd().arg("statsu").output().unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("Unbekannter Befehl"),
        "{}",
        stderr(&output)
    );
}

// ---------------------------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------------------------

#[test]
fn config_validate_lists_missing() {
    let env = Env::new();

    let output = env.cmd().args(["config", "validate"]).output().unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let text = stdout(&output);
    assert!(text.contains("public.host"), "{text}");
    // Neu eingerichtet ist SQL Server der Standard: Server und Passwort fehlen noch
    assert!(text.contains("db.server"), "{text}");
    assert!(text.contains("db.password"), "{text}");
}

#[test]
fn config_validate_json_and_unreadable_config() {
    let env = Env::new();
    fs::write(env.config_file(), "schema = 99\n").unwrap();

    let output = env
        .cmd()
        .args(["config", "validate", "--json"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let findings: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(findings[0]["field"], "config");
    assert_eq!(findings[0]["code"], "config_unreadable");
}

#[test]
fn config_set_and_show() {
    let env = Env::new();

    env.cmd()
        .args(["config", "set", "public.host", "trainee.example.com"])
        .assert()
        .success();

    let json = env.show_json();
    assert_eq!(json["public"]["host"], "trainee.example.com");
    assert_eq!(json["db"]["password"], "");
    assert!(json["findings"].is_array());

    let output = env.cmd().args(["config", "show"]).output().unwrap();
    assert!(output.status.success());
    let text = stdout(&output);
    assert!(text.contains("public.host = trainee.example.com"), "{text}");
    assert!(text.contains("db.server"), "{text}");
}

#[test]
fn config_set_rejects_unknown_field_and_bad_value() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["config", "set", "public.hots", "x"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("Unbekanntes Feld"),
        "{}",
        stderr(&output)
    );

    let output = env
        .cmd()
        .args(["config", "set", "db.port", "abc"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("Ungültiger Wert"),
        "{}",
        stderr(&output)
    );
    assert!(!env.config_file().exists(), "nichts gespeichert");
}

#[test]
fn secret_as_argument_rejected() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["config", "set", "db.password", "geheim"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains(SECRET_AS_ARGUMENT),
        "{}",
        stderr(&output)
    );
    assert!(!stderr(&output).contains("geheim"));
    assert!(!stdout(&output).contains("geheim"));
    assert!(!env.config_file().exists(), "nichts gespeichert");
}

#[test]
fn secret_without_stdin_flag_and_without_terminal_fails() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["config", "set", "db.password"])
        .write_stdin("geheim\n")
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(stderr(&output).contains("--stdin"), "{}", stderr(&output));
    assert_eq!(env.config().db.password.0, "");
}

#[test]
fn secret_via_stdin() {
    let env = Env::new();

    env.cmd()
        .args(["config", "set", "db.password", "--stdin"])
        .write_stdin("Pa'ss@w%rd\n")
        .assert()
        .success();

    assert_eq!(env.show_json()["db"]["password"], "***");
    let output = env.cmd().args(["config", "show"]).output().unwrap();
    assert!(
        stdout(&output).contains("db.password = ***"),
        "{}",
        stdout(&output)
    );
    assert_eq!(
        env.secret(SecretField::DbPassword).as_deref(),
        Some("Pa'ss@w%rd")
    );
    assert!(
        !fs::read_to_string(env.config_file())
            .unwrap()
            .contains("Pa'ss@w%rd")
    );
}

/// Setzt `db.password` über stdin und prüft, dass es geklappt hat.
fn set_password(env: &Env, value: &str) {
    env.cmd()
        .args(["config", "set", "db.password", "--stdin"])
        .write_stdin(format!("{value}\n"))
        .assert()
        .success();
    assert_eq!(env.secret(SecretField::DbPassword).as_deref(), Some(value));
}

#[test]
fn secret_stdin_without_input_keeps_the_secret() {
    // Ein Skript, dessen Erzeuger in der Pipe scheitert, darf das Passwort nicht löschen
    let env = Env::new();
    set_password(&env, "Vorher-1");

    let output = env
        .cmd()
        .args(["config", "set", "db.password", "--stdin"])
        .write_stdin("")
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("Keine Eingabe auf stdin"),
        "{}",
        stderr(&output)
    );
    assert_eq!(
        env.secret(SecretField::DbPassword).as_deref(),
        Some("Vorher-1")
    );
}

#[test]
fn secret_stdin_empty_line_keeps_the_secret() {
    let env = Env::new();
    set_password(&env, "Vorher-2");

    for input in ["\n", "\r\n"] {
        let output = env
            .cmd()
            .args(["config", "set", "db.password", "--stdin"])
            .write_stdin(input)
            .output()
            .unwrap();

        assert_eq!(output.status.code(), Some(1), "{input:?}: {output:?}");
        assert!(
            stderr(&output).contains("Leerer Wert – zum Entfernen --clear verwenden"),
            "{}",
            stderr(&output)
        );
        assert_eq!(
            env.secret(SecretField::DbPassword).as_deref(),
            Some("Vorher-2")
        );
    }
}

#[test]
fn secret_clear_removes_it() {
    let env = Env::new();
    set_password(&env, "Vorher-3");

    let output = env
        .cmd()
        .args(["config", "set", "db.password", "--clear"])
        .output()
        .unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(
        stdout(&output).contains("db.password gelöscht"),
        "{}",
        stdout(&output)
    );
    assert_eq!(env.secret(SecretField::DbPassword), None);
    assert_eq!(env.show_json()["db"]["password"], "");
}

#[test]
fn clear_is_only_for_secrets_and_not_with_stdin() {
    let env = Env::new();
    set_password(&env, "Vorher-4");

    let output = env
        .cmd()
        .args(["config", "set", "public.host", "--clear"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");

    let output = env
        .cmd()
        .args(["config", "set", "db.password", "--clear", "--stdin"])
        .write_stdin("x\n")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert_eq!(
        env.secret(SecretField::DbPassword).as_deref(),
        Some("Vorher-4")
    );
}

#[test]
fn secret_set_checks_config_before_reading_the_value() {
    // Eine kaputte Datei fällt auf, bevor jemand das Passwort eintippt bzw. verbraucht
    let env = Env::new();
    fs::write(env.config_file(), "[db\n").unwrap();

    let output = env
        .cmd()
        .args(["config", "set", "db.password"])
        .write_stdin("geheim\n")
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("nicht lesbar"),
        "{}",
        stderr(&output)
    );
    assert!(!stderr(&output).contains("Terminal"), "{}", stderr(&output));
}

#[test]
fn secret_via_stdin_keeps_inner_whitespace_and_crlf_is_stripped() {
    let env = Env::new();

    env.cmd()
        .args(["config", "set", "oidc.client_secret", "--stdin"])
        .write_stdin(" a b \r\n")
        .assert()
        .success();

    assert_eq!(
        env.secret(SecretField::OidcClientSecret).as_deref(),
        Some(" a b ")
    );
}

#[test]
fn export_import_roundtrip() {
    let env = Env::new();
    env.cmd()
        .args(["config", "set", "public.host", "trainee.example.com"])
        .assert()
        .success();
    env.cmd()
        .args(["config", "set", "db.password", "--stdin"])
        .write_stdin("Erstes-Passwort\n")
        .assert()
        .success();
    let export_file = env.dir.path().join("export.toml");

    // Export: Secrets nur als ***, auch auf stdout
    env.cmd()
        .args(["config", "export"])
        .arg(&export_file)
        .assert()
        .success();
    let exported = fs::read_to_string(&export_file).unwrap();
    assert!(exported.contains("password = \"***\""), "{exported}");
    assert!(!exported.contains("Erstes-Passwort"));
    let output = env.cmd().args(["config", "export"]).output().unwrap();
    assert!(output.status.success());
    assert!(stdout(&output).contains("password = \"***\""));

    // Import der unveränderten Datei: Secrets bleiben
    env.cmd()
        .args(["config", "import"])
        .arg(&export_file)
        .assert()
        .success();
    assert_eq!(
        env.secret(SecretField::DbPassword).as_deref(),
        Some("Erstes-Passwort")
    );
    assert_eq!(env.config().public.host, "trainee.example.com");

    // Import mit Klartext-Passwort: wird versiegelt, steht nirgends im Datenordner
    let plain = exported.replace("password = \"***\"", "password = \"Neu:Klar@Text#1\"");
    fs::write(&export_file, plain).unwrap();
    let output = env
        .cmd()
        .args(["config", "import"])
        .arg(&export_file)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(stdout(&output).contains("löschen"), "{}", stdout(&output));
    assert_eq!(
        env.secret(SecretField::DbPassword).as_deref(),
        Some("Neu:Klar@Text#1")
    );
    assert!(!all_file_contents(&env.data()).contains("Neu:Klar@Text#1"));
    assert!(!stdout(&output).contains("Neu:Klar@Text#1"));
}

#[test]
fn import_is_a_complete_configuration() {
    let env = Env::new();
    env.cmd()
        .args(["config", "set", "db.server", "sql.example.com"])
        .assert()
        .success();
    env.cmd()
        .args(["config", "set", "db.password", "--stdin"])
        .write_stdin("geheim\n")
        .assert()
        .success();
    let partial = env.dir.path().join("partial.toml");
    fs::write(&partial, "[public]\nhost = \"trainee.example.com\"\n").unwrap();

    env.cmd()
        .args(["config", "import"])
        .arg(&partial)
        .assert()
        .success();

    let config = env.config();
    assert_eq!(config.public.host, "trainee.example.com");
    assert_eq!(config.db.server, "", "fehlender Schlüssel ⇒ Standardwert");
    assert_eq!(
        env.secret(SecretField::DbPassword),
        None,
        "fehlendes Secret ⇒ gelöscht"
    );
}

#[test]
fn import_help_explains_complete_file() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["config", "import", "--help"])
        .output()
        .unwrap();

    assert!(output.status.success());
    let text = stdout(&output);
    assert!(text.contains("vollständige Konfiguration"), "{text}");
    assert!(text.contains("Standardwerte"), "{text}");
}

#[test]
fn import_rejects_broken_file() {
    let env = Env::new();
    env.cmd()
        .args(["config", "set", "public.host", "trainee.example.com"])
        .assert()
        .success();
    let broken = env.dir.path().join("broken.toml");
    fs::write(&broken, "[public\n").unwrap();

    let output = env
        .cmd()
        .args(["config", "import"])
        .arg(&broken)
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(env.config().public.host, "trainee.example.com");
}

#[test]
fn app_secret_regenerate_requires_yes() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["config", "app-secret", "regenerate"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(stderr(&output).contains("--yes"), "{}", stderr(&output));
    assert!(
        !env.config_file().exists(),
        "ohne Bestätigung nichts geändert"
    );

    env.cmd()
        .args(["config", "app-secret", "regenerate", "--yes"])
        .assert()
        .success();
    let first = env.secret(SecretField::AppSecret).unwrap();
    assert_eq!(first.len(), 64);

    env.cmd()
        .args(["config", "app-secret", "regenerate", "--yes"])
        .assert()
        .success();
    let second = env.secret(SecretField::AppSecret).unwrap();
    assert_ne!(first, second);
}

#[cfg(not(windows))]
#[test]
fn service_commands_are_unsupported_without_windows() {
    let env = Env::new();

    let output = env.cmd().args(["service", "start"]).output().unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("nicht verfügbar"),
        "{}",
        stderr(&output)
    );
}

// ---------------------------------------------------------------------------------------------
// Dienst im Vordergrund (ohne Windows)
// ---------------------------------------------------------------------------------------------

#[cfg(not(windows))]
mod foreground {
    use std::process::{Child, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use pds_common::status;

    use super::Env;

    pub struct Daemon<'a> {
        env: &'a Env,
        child: Option<Child>,
    }

    impl<'a> Daemon<'a> {
        pub fn start(env: &'a Env) -> Self {
            let child = env
                .std_cmd()
                .arg("daemon")
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            Self {
                env,
                child: Some(child),
            }
        }

        pub fn wait_for_state(&self, state: &str) -> status::Status {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Ok(Some(status)) = status::read(&self.env.status_file())
                    && serde_json::to_value(status.state).unwrap() == state
                {
                    return status;
                }
                assert!(Instant::now() < deadline, "Zustand {state} nicht erreicht");
                thread::sleep(Duration::from_millis(50));
            }
        }

        /// SIGTERM wie beim Herunterfahren; der Dienst soll geordnet enden.
        pub fn terminate(mut self) -> std::process::Output {
            let child = self.child.take().unwrap();
            let pid = child.id().to_string();
            let killed = std::process::Command::new("kill")
                .args(["-TERM", &pid])
                .status()
                .unwrap();
            assert!(killed.success());
            child.wait_with_output().unwrap()
        }
    }

    impl Drop for Daemon<'_> {
        fn drop(&mut self) {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    #[test]
    fn daemon_foreground_writes_status() {
        let env = Env::new();

        let daemon = Daemon::start(&env);
        let status = daemon.wait_for_state("unconfigured");
        assert!(!status.findings.is_empty());
        let output = daemon.terminate();

        assert!(output.status.success(), "{output:?}");
        let status = status::read(&env.status_file()).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(status.state).unwrap(),
            "stopped",
            "nach SIGTERM"
        );
        let log = std::fs::read_to_string(env.data().join("logs").join("service.log")).unwrap();
        assert!(log.contains("nicht eingerichtet"), "{log}");
        // Im Vordergrund auch auf stderr
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("nicht eingerichtet"),
            "{output:?}"
        );
    }

    #[test]
    fn daemon_reports_unreadable_config() {
        let env = Env::new();
        std::fs::write(env.config_file(), "[db]\npassword = \"Zx9-Geheimwert\"\n").unwrap();

        let daemon = Daemon::start(&env);
        let status = daemon.wait_for_state("unconfigured");
        daemon.terminate();

        assert_eq!(status.findings.len(), 1);
        assert_eq!(status.findings[0].code, "config_unreadable");
        assert_eq!(status.findings[0].field, "config");
        let log = std::fs::read_to_string(env.data().join("logs").join("service.log")).unwrap();
        assert!(!log.contains("Zx9-Geheimwert"), "{log}");
    }
}

// ---------------------------------------------------------------------------------------------
// Hilfe und Aufruf der neuen Befehle
// ---------------------------------------------------------------------------------------------

#[test]
fn help_lists_all_commands_in_german() {
    let env = Env::new();

    let output = env.cmd().arg("--help").output().unwrap();

    assert!(output.status.success());
    let text = stdout(&output);
    for command in [
        "run", "status", "service", "config", "tls", "db", "oidc", "ports", "eplan",
    ] {
        assert!(
            text.lines()
                .any(|line| line.trim_start().starts_with(&format!("{command} "))),
            "{command} fehlt:\n{text}"
        );
    }
    assert!(!text.contains("daemon"), "{text}");
    assert!(!text.contains("setup"), "{text}");
}

#[test]
fn subcommand_helps_name_all_options() {
    let env = Env::new();
    let expectations: [(&[&str], &[&str]); 10] = [
        (
            &["tls", "import"],
            &["--pfx", "--password-stdin", "--pem", "--store"],
        ),
        (&["tls", "show"], &["--json"]),
        (
            &["db", "setup"],
            &["--admin-user", "--admin-password-stdin", "--json"],
        ),
        (&["db", "test"], &["--json"]),
        (&["db", "script"], &["DATEI"]),
        (&["oidc", "test"], &["--check-client", "--json"]),
        (&["ports", "check"], &["--json"]),
        (&["service", "restart"], &["--wait", "--timeout"]),
        (&["eplan", "install"], &["--user", "--password-stdin"]),
        (&["eplan", "status"], &["--json"]),
    ];
    for (args, options) in expectations {
        let output = env.cmd().args(args).arg("--help").output().unwrap();
        assert!(output.status.success(), "{args:?}: {output:?}");
        let text = stdout(&output);
        assert!(text.contains("Aufruf:"), "{args:?}:\n{text}");
        assert!(!text.contains("Usage"), "{args:?}:\n{text}");
        for option in options {
            assert!(text.contains(option), "{args:?} ohne {option}:\n{text}");
        }
    }
}

#[test]
fn tls_import_needs_exactly_one_source() {
    let env = Env::new();

    let none = env.cmd().args(["tls", "import"]).output().unwrap();
    assert_eq!(none.status.code(), Some(1), "{none:?}");
    assert!(stderr(&none).contains("Angabe fehlt"), "{}", stderr(&none));

    let two = env
        .cmd()
        .args(["tls", "import", "--pfx", "a.pfx", "--store", "AA"])
        .output()
        .unwrap();
    assert_eq!(two.status.code(), Some(1), "{two:?}");
    assert!(
        stderr(&two).contains("lässt sich nicht mit"),
        "{}",
        stderr(&two)
    );
}

#[test]
fn service_timeout_needs_wait() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["service", "restart", "--timeout", "5"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(stderr(&output).contains("--wait"), "{}", stderr(&output));
}

#[cfg(not(windows))]
#[test]
fn service_wait_is_unsupported_without_windows() {
    let env = Env::new();

    for command in ["start", "restart"] {
        let output = env
            .cmd()
            .args(["service", command, "--wait", "--timeout", "5"])
            .output()
            .unwrap();

        assert_eq!(output.status.code(), Some(1), "{command}: {output:?}");
        assert!(
            stderr(&output).contains("nicht verfügbar"),
            "{command}: {}",
            stderr(&output)
        );
    }
}

// ---------------------------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------------------------

/// Zertifikat und Schlüssel als PEM-Dateien.
struct TestCert {
    cert: PathBuf,
    key: PathBuf,
}

/// Ein selbst signiertes Zertifikat für `hosts`, gültig von 2020 bis `not_after_year`.
fn issue(dir: &Path, name: &str, hosts: &[&str], not_after_year: i32) -> TestCert {
    let key = rcgen::KeyPair::generate().unwrap();
    issue_with_key(dir, name, hosts, not_after_year, &key)
}

fn issue_with_key(
    dir: &Path,
    name: &str,
    hosts: &[&str],
    not_after_year: i32,
    key: &rcgen::KeyPair,
) -> TestCert {
    let mut params =
        rcgen::CertificateParams::new(hosts.iter().map(ToString::to_string).collect::<Vec<_>>())
            .unwrap();
    params.not_before = rcgen::date_time_ymd(2020, 1, 1);
    params.not_after = rcgen::date_time_ymd(not_after_year, 1, 1);
    let cert = params.self_signed(key).unwrap();
    let files = TestCert {
        cert: dir.join(format!("{name}.pem")),
        key: dir.join(format!("{name}.key")),
    };
    fs::write(&files.cert, cert.pem()).unwrap();
    fs::write(&files.key, key.serialize_pem()).unwrap();
    files
}

fn tls_import_pem(env: &Env, files: &TestCert) -> std::process::Output {
    env.cmd()
        .args(["tls", "import", "--pem"])
        .arg(&files.cert)
        .arg(&files.key)
        .output()
        .unwrap()
}

fn stored_certificate(env: &Env) -> PathBuf {
    env.data().join("tls").join("certificate.pem")
}

#[test]
fn tls_import_pem_and_show() {
    let env = Env::new();
    let files = issue(
        env.dir.path(),
        "ok",
        &["trainee.example.com", "*.lpd.example.com"],
        2090,
    );
    let key_text = fs::read_to_string(&files.key).unwrap();

    let output = tls_import_pem(&env, &files);

    assert!(output.status.success(), "{output:?}");
    let text = stdout(&output);
    assert!(text.contains("importiert"), "{text}");
    assert!(text.contains("trainee.example.com"), "{text}");
    // Kette liegt offen da, der Schlüssel nur versiegelt und nirgends im Klartext
    assert!(stored_certificate(&env).is_file());
    let everything = all_file_contents(&env.data());
    assert!(!everything.contains("PRIVATE KEY"), "Schlüssel im Klartext");
    let key_body: String = key_text
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    assert!(!everything.contains(&key_body), "Schlüssel im Klartext");

    // Mit gesetztem Hostnamen bewertet `show` auch, ob das Zertifikat dazu passt
    env.cmd()
        .args(["config", "set", "public.host", "trainee.example.com"])
        .assert()
        .success();
    let output = env.cmd().args(["tls", "show"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    let text = stdout(&output);
    assert!(text.contains("trainee.example.com"), "{text}");
    assert!(text.contains("*.lpd.example.com"), "{text}");
    assert!(text.contains("Fingerabdruck"), "{text}");
    assert!(text.contains("2090"), "{text}");
    assert!(text.contains("passt"), "{text}");
    assert!(!text.contains("passt nicht"), "{text}");

    let output = env.cmd().args(["tls", "show", "--json"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let names: Vec<&str> = json["certificate"]["dnsNames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap())
        .collect();
    assert_eq!(names, ["trainee.example.com", "*.lpd.example.com"]);
    assert_eq!(json["findings"], serde_json::json!([]));
}

#[test]
fn tls_show_without_certificate_says_so() {
    let env = Env::new();

    let output = env.cmd().args(["tls", "show"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(
        stdout(&output).contains("Kein Zertifikat"),
        "{}",
        stdout(&output)
    );
    let output = env.cmd().args(["tls", "show", "--json"]).output().unwrap();
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["certificate"], serde_json::Value::Null);
}

#[test]
fn tls_show_reports_hostname_mismatch() {
    let env = Env::new();
    let files = issue(env.dir.path(), "ok", &["trainee.example.com"], 2090);
    assert!(tls_import_pem(&env, &files).status.success());
    env.cmd()
        .args(["config", "set", "public.host", "anders.example.com"])
        .assert()
        .success();

    let output = env.cmd().args(["tls", "show"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    let text = stdout(&output);
    assert!(text.contains("passt nicht"), "{text}");
    assert!(text.contains("certificate_hostname_mismatch"), "{text}");
}

#[test]
fn tls_import_hostname_mismatch_rejected() {
    let env = Env::new();
    env.cmd()
        .args(["config", "set", "public.host", "anders.example.com"])
        .assert()
        .success();
    let files = issue(env.dir.path(), "falsch", &["trainee.example.com"], 2090);

    let output = tls_import_pem(&env, &files);

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        stderr(&output).contains("certificate_hostname_mismatch"),
        "{}",
        stderr(&output)
    );
    assert!(!stored_certificate(&env).exists(), "nichts gespeichert");
}

#[test]
fn tls_import_expired_rejected() {
    let env = Env::new();
    let files = issue(env.dir.path(), "alt", &["trainee.example.com"], 2021);

    let output = tls_import_pem(&env, &files);

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        stderr(&output).contains("certificate_expired"),
        "{}",
        stderr(&output)
    );
    assert!(!stored_certificate(&env).exists(), "nichts gespeichert");
}

#[test]
fn tls_import_key_mismatch_rejected() {
    let env = Env::new();
    let files = issue(env.dir.path(), "a", &["trainee.example.com"], 2090);
    let other = issue(env.dir.path(), "b", &["trainee.example.com"], 2090);
    let mixed = TestCert {
        cert: files.cert,
        key: other.key,
    };

    let output = tls_import_pem(&env, &mixed);

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        stderr(&output).contains("certificate_key_mismatch"),
        "{}",
        stderr(&output)
    );
    assert!(!stored_certificate(&env).exists(), "nichts gespeichert");
}

#[test]
fn tls_import_unreadable_file_is_an_error() {
    let env = Env::new();
    let files = issue(env.dir.path(), "ok", &["trainee.example.com"], 2090);

    let output = env
        .cmd()
        .args(["tls", "import", "--pem"])
        .arg(env.dir.path().join("fehlt.pem"))
        .arg(&files.key)
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(stderr(&output).contains("fehlt.pem"), "{}", stderr(&output));
}

#[test]
fn tls_import_hints_when_mode_is_not_certificate() {
    let env = Env::new();
    env.cmd()
        .args(["config", "set", "tls.mode", "internal"])
        .assert()
        .success();
    let files = issue(env.dir.path(), "ok", &["trainee.example.com"], 2090);

    let output = tls_import_pem(&env, &files);

    assert!(output.status.success(), "{output:?}");
    assert!(
        stdout(&output).contains("tls.mode certificate"),
        "{}",
        stdout(&output)
    );
}

/// PFX von OpenSSL aus den Tests der Bibliothek (Leaf `windows-legacy.example.com`).
fn fixture_pfx() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../pds-common/tests/fixtures/openssl-aes256.pfx")
}

#[test]
fn tls_pfx_password_stdin() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["tls", "import", "--pfx"])
        .arg(fixture_pfx())
        .arg("--password-stdin")
        .write_stdin("Pässwört 1!\n")
        .output()
        .unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(stored_certificate(&env).is_file());
    let text = stdout(&output);
    assert!(text.contains("windows-legacy.example.com"), "{text}");
    assert!(!text.contains("Pässwört"), "{text}");
    assert!(!stderr(&output).contains("Pässwört"));
}

#[test]
fn tls_pfx_wrong_password_is_an_error() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["tls", "import", "--pfx"])
        .arg(fixture_pfx())
        .arg("--password-stdin")
        .write_stdin("Falsch-Geheim\n")
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(stderr(&output).contains("Passwort"), "{}", stderr(&output));
    assert!(!stderr(&output).contains("Falsch-Geheim"));
    assert!(!stored_certificate(&env).exists());
}

#[test]
fn tls_pfx_without_flag_and_terminal_asks_for_stdin() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["tls", "import", "--pfx"])
        .arg(fixture_pfx())
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("--password-stdin"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn tls_pfx_password_as_argument_rejected() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["tls", "import", "--pfx"])
        .arg(fixture_pfx())
        .args(["--password", "Pässwört 1!"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains(SECRET_AS_ARGUMENT),
        "{}",
        stderr(&output)
    );
    assert!(!stderr(&output).contains("Pässwört"), "{}", stderr(&output));
    assert!(!stored_certificate(&env).exists());
}

#[cfg(not(windows))]
#[test]
fn tls_import_store_is_windows_only() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["tls", "import", "--store", &"AB".repeat(20)])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(stderr(&output).contains("Windows"), "{}", stderr(&output));
}

#[test]
fn tls_import_store_rejects_bad_thumbprint() {
    let env = Env::new();

    let output = env
        .cmd()
        .args(["tls", "import", "--store", "kein-fingerabdruck"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
}

// ---------------------------------------------------------------------------------------------
// Datenbank-Werkzeug mit einem Ersatz für `node`
// ---------------------------------------------------------------------------------------------

/// Statt des echten Werkzeugs läuft ein Shell-Skript als `node/node`: `$3` ist der Befehl. Es
/// hängt seine Umgebung an `tool-env.txt` im Testordner, damit die Tests sehen, was ankam.
#[cfg(unix)]
mod fake_tool {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use super::Env;

    pub fn env_dump(env: &Env) -> PathBuf {
        env.dir.path().join("tool-env.txt")
    }

    /// `body` ist der Rumpf eines Shell-Skripts; `$3` ist der Befehl des Werkzeugs.
    pub fn install(env: &Env, body: &str) {
        let dump = env_dump(env);
        let script = format!(
            "#!/bin/sh\n\
             {{\n\
             printf 'cmd=%s\\n' \"$3\"\n\
             printf 'password=%s\\n' \"$PDS_DB_PASSWORD\"\n\
             printf 'admin=%s\\n' \"$PDS_ADMIN_DATABASE_URL\"\n\
             printf 'url=%s\\n' \"$NUXT_DATABASE_URL\"\n\
             printf 'name=%s\\n' \"$PDS_DB_NAME\"\n\
             printf 'user=%s\\n' \"$PDS_DB_USER\"\n\
             printf 'check=%s\\n' \"$PDS_OIDC_CHECK_CLIENT\"\n\
             printf 'client_secret=%s\\n' \"$NUXT_OIDC_CLIENT_SECRET\"\n\
             printf 'issuer=%s\\n' \"$NUXT_OIDC_ISSUER\"\n\
             printf 'backup=%s\\n' \"$PDS_BACKUP_FILE\"\n\
             }} > '{}'\n{body}\n",
            dump.display()
        );
        fs::create_dir_all(env.install().join("node")).unwrap();
        fs::create_dir_all(env.install().join("tools")).unwrap();
        fs::write(
            env.install().join("tools").join("pds-tools.mjs"),
            "// Platzhalter",
        )
        .unwrap();
        let node = env.install().join("node").join("node");
        fs::write(&node, script).unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
    }

    pub fn dump(env: &Env) -> String {
        fs::read_to_string(env_dump(env)).unwrap_or_default()
    }

    pub const RESULT_OK: &str = r#"
echo '{"type":"step","ok":true,"code":"connect","message":"Verbunden mit dem Server.","details":{}}'
echo '{"type":"step","ok":false,"code":"rcsi","message":"READ_COMMITTED_SNAPSHOT ist aus.","details":{"warning":true}}'
echo '{"type":"result","ok":true,"code":"ok","message":"Alles bereit.","details":{}}'
"#;

    pub const RESULT_FAILED: &str = r#"
echo '{"type":"step","ok":true,"code":"connect","message":"Verbunden mit dem Server.","details":{}}'
echo '{"type":"step","ok":false,"code":"login","message":"Die Anmeldung ist fehlgeschlagen.","details":{"error":"login_failed"}}'
echo '{"type":"result","ok":false,"code":"login_failed","message":"Die Anmeldung ist fehlgeschlagen.","details":{}}'
exit 3
"#;
}

#[cfg(unix)]
#[test]
fn db_test_prints_steps_and_succeeds() {
    let env = Env::new();
    write_valid_config(&env, Some("Db-Passwort-1"));
    fake_tool::install(&env, fake_tool::RESULT_OK);

    let output = env.cmd().args(["db", "test"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    let text = stdout(&output);
    assert!(text.contains("Verbunden mit dem Server."), "{text}");
    assert!(text.contains("Warnung"), "{text}");
    assert!(text.contains("READ_COMMITTED_SNAPSHOT"), "{text}");
    assert!(text.contains("Alles bereit."), "{text}");
    // Das Werkzeug bekommt die URL der App mit dem Passwort, nur über die Umgebung
    let dump = fake_tool::dump(&env);
    assert!(dump.contains("cmd=db-test"), "{dump}");
    assert!(
        dump.contains("url=mssql://pds_app:Db-Passwort-1@sql.example.com:1433/"),
        "{dump}"
    );
    assert!(!text.contains("Db-Passwort-1") && !stderr(&output).contains("Db-Passwort-1"));
}

#[cfg(unix)]
#[test]
fn db_test_failure_exits_3() {
    let env = Env::new();
    write_valid_config(&env, Some("Db-Passwort-1"));
    fake_tool::install(&env, fake_tool::RESULT_FAILED);

    let output = env.cmd().args(["db", "test"]).output().unwrap();

    assert_eq!(output.status.code(), Some(3), "{output:?}");
    let text = stdout(&output);
    assert!(text.contains("login_failed"), "{text}");
    assert!(text.contains("Die Anmeldung ist fehlgeschlagen."), "{text}");
    // Der gescheiterte Schritt und das Ergebnis nennen dasselbe: nur einmal ausgeben
    assert_eq!(
        text.matches("Die Anmeldung ist fehlgeschlagen.").count(),
        1,
        "{text}"
    );
}

#[cfg(unix)]
#[test]
fn db_test_json_passes_the_tool_result_through() {
    let env = Env::new();
    write_valid_config(&env, Some("Db-Passwort-1"));
    fake_tool::install(&env, fake_tool::RESULT_FAILED);

    let output = env.cmd().args(["db", "test", "--json"]).output().unwrap();

    assert_eq!(output.status.code(), Some(3), "{output:?}");
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["code"], "login_failed");
    assert_eq!(json["steps"].as_array().unwrap().len(), 2);
}

#[cfg(unix)]
#[test]
fn db_test_with_config_errors_does_not_call_the_tool() {
    let env = Env::new();
    write_valid_config(&env, Some("Db-Passwort-1"));
    env.cmd()
        .args(["config", "set", "db.server", ""])
        .assert()
        .success();
    fake_tool::install(&env, fake_tool::RESULT_OK);

    let output = env.cmd().args(["db", "test"]).output().unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(stdout(&output).contains("db.server"), "{}", stdout(&output));
    assert!(fake_tool::dump(&env).is_empty(), "Werkzeug lief trotzdem");

    // Als JSON dieselbe Form wie das Ergebnis des Werkzeugs
    let output = env.cmd().args(["db", "test", "--json"]).output().unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["code"], "config_invalid");
    assert_eq!(json["details"]["findings"][0]["field"], "db.server");
}

#[test]
fn db_tool_missing_is_an_error() {
    let env = Env::new();
    write_valid_config(&env, Some("Db-Passwort-1"));

    let output = env.cmd().args(["db", "test"]).output().unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(stderr(&output).contains("Werkzeug"), "{}", stderr(&output));
}

#[cfg(unix)]
#[test]
fn db_setup_generates_and_seals_the_password_before_the_call() {
    let env = Env::new();
    write_valid_config(&env, None);
    fake_tool::install(&env, fake_tool::RESULT_OK);

    let output = env
        .cmd()
        .args([
            "db",
            "setup",
            "--admin-user",
            "sa",
            "--admin-password-stdin",
        ])
        .write_stdin("Admin-Pw/1\n")
        .output()
        .unwrap();

    assert!(output.status.success(), "{output:?}");
    // Erzeugt, versiegelt gespeichert, und genau dieses Passwort ging ans Werkzeug
    let password = env.secret(SecretField::DbPassword).expect("gespeichert");
    assert_eq!(password.chars().count(), 32, "{password}");
    assert!(
        password
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    );
    assert!(password.chars().any(|c| c.is_ascii_uppercase()));
    assert!(password.chars().any(|c| c.is_ascii_lowercase()));
    assert!(password.chars().any(|c| c.is_ascii_digit()));
    assert_eq!(password.matches('-').count(), 1);
    let dump = fake_tool::dump(&env);
    assert!(dump.contains("cmd=db-setup"), "{dump}");
    assert!(dump.contains(&format!("password={password}\n")), "{dump}");
    assert!(dump.contains("name=pds\n"), "{dump}");
    assert!(dump.contains("user=pds_app\n"), "{dump}");
    // Admin-Zugang an `master`, das Passwort URL-kodiert
    assert!(
        dump.contains("admin=mssql://sa:Admin-Pw%2F1@sql.example.com:1433/master?"),
        "{dump}"
    );

    // Der Hinweis nennt das neue Passwort nicht, und kein Secret steht in der Ausgabe
    let text = stdout(&output);
    assert!(text.contains("erzeugt"), "{text}");
    for secret in [password.as_str(), "Admin-Pw"] {
        assert!(!text.contains(secret), "{text}");
        assert!(!stderr(&output).contains(secret), "{}", stderr(&output));
    }
    assert!(!all_file_contents(&env.data()).contains(&password));

    // Ein zweiter Lauf behält das Passwort
    let output = env
        .cmd()
        .args([
            "db",
            "setup",
            "--admin-user",
            "sa",
            "--admin-password-stdin",
        ])
        .write_stdin("Admin-Pw/1\n")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(env.secret(SecretField::DbPassword), Some(password));
    assert!(!stdout(&output).contains("erzeugt"), "{}", stdout(&output));
}

#[cfg(unix)]
#[test]
fn db_setup_failure_keeps_the_generated_password() {
    let env = Env::new();
    write_valid_config(&env, None);
    fake_tool::install(&env, fake_tool::RESULT_FAILED);

    let output = env
        .cmd()
        .args([
            "db",
            "setup",
            "--admin-user",
            "sa",
            "--admin-password-stdin",
        ])
        .write_stdin("Admin-Pw\n")
        .output()
        .unwrap();

    // Exit 3; das Passwort bleibt, damit ein zweiter Lauf dasselbe setzt
    assert_eq!(output.status.code(), Some(3), "{output:?}");
    assert!(env.secret(SecretField::DbPassword).is_some());
}

#[cfg(unix)]
#[test]
fn db_setup_asks_for_the_admin_password_before_changing_anything() {
    let env = Env::new();
    write_valid_config(&env, None);
    fake_tool::install(&env, fake_tool::RESULT_OK);

    // Weder Terminal noch --admin-password-stdin
    let output = env
        .cmd()
        .args(["db", "setup", "--admin-user", "sa"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("--admin-password-stdin"),
        "{}",
        stderr(&output)
    );
    assert_eq!(env.secret(SecretField::DbPassword), None, "nichts geändert");
    assert!(fake_tool::dump(&env).is_empty());
}

#[cfg(unix)]
#[test]
fn db_setup_admin_password_as_argument_rejected() {
    let env = Env::new();
    write_valid_config(&env, None);
    fake_tool::install(&env, fake_tool::RESULT_OK);

    let output = env
        .cmd()
        .args([
            "db",
            "setup",
            "--admin-user",
            "sa",
            "--admin-password",
            "Geheim-1",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains(SECRET_AS_ARGUMENT),
        "{}",
        stderr(&output)
    );
    assert!(!stderr(&output).contains("Geheim-1"));
    assert_eq!(env.secret(SecretField::DbPassword), None, "nichts geändert");
    assert!(fake_tool::dump(&env).is_empty());
}

#[test]
fn db_setup_needs_an_admin_user() {
    let env = Env::new();

    let output = env.cmd().args(["db", "setup"]).output().unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("--admin-user"),
        "{}",
        stderr(&output)
    );
}

#[cfg(unix)]
#[test]
fn db_script_stdout_contains_setvar_via_fake_tool() {
    let env = Env::new();
    write_valid_config(&env, None);
    fake_tool::install(
        &env,
        // printf statt echo: dash (/bin/sh unter Debian/Ubuntu) macht aus `\n` in echo-Text einen Umbruch
        r#"printf '%s\n' '{"type":"result","ok":true,"code":"ok","message":"SQL-Skript erzeugt.","details":{"script":":setvar DB_NAME pds\nGO\n"}}'"#,
    );

    let output = env.cmd().args(["db", "script"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    // Nur das Skript auf stdout, damit sich die Ausgabe umleiten lässt
    assert_eq!(stdout(&output), ":setvar DB_NAME pds\nGO\n");
    let dump = fake_tool::dump(&env);
    assert!(dump.contains("cmd=db-script"), "{dump}");
    assert!(dump.contains("name=pds\n"), "{dump}");

    // In eine Datei: nichts auf stdout außer der Bestätigung
    let file = env.dir.path().join("setup.sql");
    let output = env
        .cmd()
        .args(["db", "script"])
        .arg(&file)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        ":setvar DB_NAME pds\nGO\n"
    );
    assert!(stdout(&output).contains("setup.sql"), "{}", stdout(&output));
}

/// Mit dem echten, gebauten Werkzeug: `pnpm --filter @pds/node-tools
/// build`, dann `cargo test -- --ignored db_script_stdout_contains_setvar`.
#[cfg(unix)]
#[test]
#[ignore = "braucht die gebauten node-tools (windows/node-tools/dist/pds-tools.mjs)"]
fn db_script_stdout_contains_setvar() {
    use std::os::unix::fs::symlink;

    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../node-tools/dist/pds-tools.mjs");
    assert!(
        bundle.is_file(),
        "node-tools nicht gebaut: pnpm --filter @pds/node-tools build"
    );
    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
        .expect("node nicht im PATH");
    let env = Env::new();
    write_valid_config(&env, None);
    fs::create_dir_all(env.install().join("node")).unwrap();
    fs::create_dir_all(env.install().join("tools")).unwrap();
    symlink(node, env.install().join("node").join("node")).unwrap();
    fs::copy(&bundle, env.install().join("tools").join("pds-tools.mjs")).unwrap();

    let output = env.cmd().args(["db", "script"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    let script = stdout(&output);
    assert!(script.contains(r#":setvar DB_NAME "pds""#), "{script}");
    assert!(script.contains(r#":setvar DB_USER "pds_app""#), "{script}");
    assert!(script.contains(":setvar DB_PASSWORD"), "{script}");
    assert!(stderr(&output).is_empty(), "{}", stderr(&output));
}

#[test]
fn db_script_with_invalid_names_exits_2() {
    let env = Env::new();
    write_valid_config(&env, None);
    env.cmd()
        .args(["config", "set", "db.user", "a]b"])
        .assert()
        .success();

    let output = env.cmd().args(["db", "script"]).output().unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    // Auf stdout steht nur ein Skript, hier also nichts; die Meldung geht auf stderr
    assert!(stdout(&output).is_empty(), "{}", stdout(&output));
    assert!(stderr(&output).contains("db.user"), "{}", stderr(&output));
}

// ---------------------------------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn oidc_test_passes_issuer_and_only_asks_for_the_secret_on_request() {
    let env = Env::new();
    write_valid_config(&env, Some("Db-Passwort-1"));
    fake_tool::install(&env, fake_tool::RESULT_OK);

    let output = env.cmd().args(["oidc", "test"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    let dump = fake_tool::dump(&env);
    assert!(dump.contains("cmd=oidc-test"), "{dump}");
    assert!(
        dump.contains(
            "issuer=https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0"
        ),
        "{dump}"
    );
    assert!(
        dump.contains("client_secret=\n"),
        "ohne Clientprüfung kein Secret: {dump}"
    );

    let output = env
        .cmd()
        .args(["oidc", "test", "--check-client"])
        .output()
        .unwrap();

    assert!(output.status.success(), "{output:?}");
    let dump = fake_tool::dump(&env);
    assert!(dump.contains("check=1\n"), "{dump}");
    assert!(
        dump.contains("client_secret=client-secret-Wert\n"),
        "{dump}"
    );
    assert!(!stdout(&output).contains("client-secret-Wert"));
    assert!(!stderr(&output).contains("client-secret-Wert"));
}

#[cfg(unix)]
#[test]
fn oidc_test_failure_exits_3() {
    let env = Env::new();
    write_valid_config(&env, Some("Db-Passwort-1"));
    fake_tool::install(
        &env,
        r#"echo '{"type":"result","ok":false,"code":"issuer_mismatch","message":"Der Aussteller stimmt nicht überein.","details":{}}'
exit 3"#,
    );

    let output = env.cmd().args(["oidc", "test"]).output().unwrap();

    assert_eq!(output.status.code(), Some(3), "{output:?}");
    assert!(
        stdout(&output).contains("issuer_mismatch"),
        "{}",
        stdout(&output)
    );
}

#[cfg(unix)]
#[test]
fn oidc_test_with_config_errors_exits_2_without_the_tool() {
    let env = Env::new();
    write_valid_config(&env, Some("Db-Passwort-1"));
    env.cmd()
        .args(["config", "set", "oidc.client_id", ""])
        .assert()
        .success();
    fake_tool::install(&env, fake_tool::RESULT_OK);

    let output = env.cmd().args(["oidc", "test"]).output().unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        stdout(&output).contains("oidc.client_id"),
        "{}",
        stdout(&output)
    );
    assert!(fake_tool::dump(&env).is_empty());
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

/// Drei verschiedene freie Ports; der erste bleibt belegt, solange der Listener lebt.
fn ports_with_one_busy() -> (std::net::TcpListener, u16, u16, u16) {
    let busy = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let first = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let second = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let ports = (
        busy.local_addr().unwrap().port(),
        first.local_addr().unwrap().port(),
        second.local_addr().unwrap().port(),
    );
    (busy, ports.0, ports.1, ports.2)
}

fn set_ports(env: &Env, http: u16, public: u16, internal: u16) {
    for (field, port) in [
        ("listen.http_port", http),
        ("public.port", public),
        ("internal.port", internal),
    ] {
        env.cmd()
            .args(["config", "set", field, &port.to_string()])
            .assert()
            .success();
    }
}

#[test]
fn ports_check_reports_busy() {
    let env = Env::new();
    let (_busy, http, public, internal) = ports_with_one_busy();
    set_ports(&env, http, public, internal);

    let output = env.cmd().args(["ports", "check"]).output().unwrap();

    assert_eq!(output.status.code(), Some(3), "{output:?}");
    let text = stdout(&output);
    let busy_line = text
        .lines()
        .find(|line| line.contains(&http.to_string()))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(busy_line.contains("belegt"), "{text}");
    for port in [public, internal] {
        let line = text
            .lines()
            .find(|line| line.contains(&port.to_string()))
            .unwrap_or_else(|| panic!("{text}"));
        assert!(line.contains("frei"), "{text}");
    }

    let output = env
        .cmd()
        .args(["ports", "check", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3), "{output:?}");
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["ok"], false);
    let ports = json["ports"].as_array().unwrap();
    assert_eq!(ports.len(), 3);
    assert_eq!(ports[0]["port"], http);
    assert_eq!(ports[0]["role"], "http");
    assert_eq!(ports[0]["free"], false);
    assert_eq!(ports[1]["role"], "public");
    assert_eq!(ports[1]["free"], true);
    assert_eq!(ports[2]["role"], "internal");
}

#[test]
fn ports_check_succeeds_when_all_are_free() {
    let env = Env::new();
    let (busy, http, public, internal) = ports_with_one_busy();
    drop(busy);
    set_ports(&env, http, public, internal);

    let output = env.cmd().args(["ports", "check"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(stdout(&output).contains("frei"), "{}", stdout(&output));
}

#[test]
fn ports_check_skips_the_public_port_without_tls() {
    let env = Env::new();
    // Bei `off` lauscht kein Port auf public.port, er steht nur in der Adresse
    let (_busy, public, http, internal) = ports_with_one_busy();
    set_ports(&env, http, public, internal);
    env.cmd()
        .args(["config", "set", "tls.mode", "off"])
        .assert()
        .success();

    let output = env
        .cmd()
        .args(["ports", "check", "--json"])
        .output()
        .unwrap();

    assert!(output.status.success(), "{output:?}");
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let roles: Vec<&str> = json["ports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|port| port["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["http", "internal"]);
}

#[test]
fn ports_check_with_unreadable_config_is_an_error() {
    let env = Env::new();
    fs::write(env.config_file(), "[public\n").unwrap();

    let output = env.cmd().args(["ports", "check"]).output().unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("nicht lesbar"),
        "{}",
        stderr(&output)
    );
}

// ---------------------------------------------------------------------------------------------
// Vordergrundbetrieb `run` (ohne Windows, mit Dummy-Kindern)
// ---------------------------------------------------------------------------------------------

#[cfg(unix)]
mod run {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Child, Output, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use pds_common::status;

    use super::{Env, stderr, write_valid_config};

    fn script(path: &std::path::Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Node und Caddy als Shell-Skripte: Node wartet auf stdin-EOF (das Zeichen zum Beenden),
    /// Caddy liest seine Konfiguration und bleibt, bis es beendet wird.
    fn dummy_children(env: &Env) {
        // Node läuft im Ordner `app`; ohne ihn startet der Supervisor es gar nicht
        fs::create_dir_all(env.install().join("app")).unwrap();
        script(
            &env.install().join("node").join("node"),
            "#!/bin/sh\ncat > /dev/null\n",
        );
        script(
            &env.install().join("caddy"),
            "#!/bin/sh\ncat > /dev/null\nexec sleep 60\n",
        );
    }

    fn state(env: &Env) -> Option<String> {
        let status = status::read(&env.status_file()).ok().flatten()?;
        serde_json::to_value(status.state)
            .unwrap()
            .as_str()
            .map(str::to_owned)
    }

    /// `run` als Kindprozess. Endet ein Test vorzeitig, wird es beendet, damit nichts zurückbleibt.
    struct Foreground<'a> {
        env: &'a Env,
        child: Option<Child>,
    }

    impl<'a> Foreground<'a> {
        fn start(env: &'a Env) -> Self {
            let child = env
                .std_cmd()
                .arg("run")
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            Self {
                env,
                child: Some(child),
            }
        }

        fn wait_for_state(&self, accepted: &[&str]) {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(state) = state(self.env)
                    && accepted.contains(&state.as_str())
                {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "Zustand {accepted:?} nicht erreicht"
                );
                thread::sleep(Duration::from_millis(50));
            }
        }

        /// Sendet das Signal (`INT` = Strg+C) und wartet auf das Ende.
        fn stop_with(mut self, signal: &str) -> Output {
            let child = self.child.take().unwrap();
            let sent = std::process::Command::new("kill")
                .args([format!("-{signal}"), child.id().to_string()])
                .status()
                .unwrap();
            assert!(sent.success());
            child.wait_with_output().unwrap()
        }
    }

    impl Drop for Foreground<'_> {
        /// Erst SIGTERM (geordnetes Ende samt Kindprozessen), nach kurzer Frist SIGKILL.
        fn drop(&mut self) {
            let Some(mut child) = self.child.take() else {
                return;
            };
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &child.id().to_string()])
                .status();
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[test]
    fn run_starts_and_stops() {
        let env = Env::new();
        write_valid_config(&env, Some("Db-Passwort-1"));
        dummy_children(&env);

        let run = Foreground::start(&env);
        // Die Dummy-Kinder melden keine Health: `starting` ist der erwartete Zustand
        run.wait_for_state(&["starting", "running"]);
        let output = run.stop_with("INT");

        assert_eq!(output.status.code(), Some(0), "{output:?}");
        assert_eq!(state(&env).as_deref(), Some("stopped"));
        // Log im Vordergrund auf stderr, ohne Secrets
        let log = stderr(&output);
        assert!(log.contains("Vordergrund"), "{log}");
        assert!(!log.contains("Db-Passwort-1"), "{log}");
        assert!(!log.contains("client-secret-Wert"), "{log}");
    }

    #[test]
    fn run_without_configuration_reports_unconfigured_and_stops() {
        let env = Env::new();

        let run = Foreground::start(&env);
        run.wait_for_state(&["unconfigured"]);
        let output = run.stop_with("TERM");

        assert_eq!(output.status.code(), Some(0), "{output:?}");
        assert_eq!(state(&env).as_deref(), Some("stopped"));
    }
}

// ---------------------------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------------------------

/// Wie [`write_valid_config`], aber mit SQLite unter `path` (leer = Standard im Datenordner).
fn write_sqlite_config(env: &Env, path: &str) {
    write_valid_config(env, None);
    let mut config = env.config();
    config.db.kind = DbKind::Sqlite;
    config.db.path = path.into();
    config::save(&env.config_file(), &config).unwrap();
}

#[test]
fn old_config_with_server_stays_sql_server() {
    let env = Env::new();
    // Datei von vor SQLite: kein `kind`, aber ein Server
    fs::write(env.config_file(), "[db]\nserver = \"sql01\"\n").unwrap();

    let json = env.show_json();
    assert_eq!(json["db"]["kind"], "sqlserver");

    let output = env.cmd().args(["config", "show"]).output().unwrap();
    let text = stdout(&output);
    assert!(text.contains("db.kind = sqlserver"), "{text}");
    assert!(text.contains("db.path = \"\""), "{text}");
}

#[test]
fn config_set_db_kind_and_path() {
    let env = Env::new();

    env.cmd()
        .args(["config", "set", "db.kind", "sqlserver"])
        .assert()
        .success();
    assert_eq!(env.config().db.kind, DbKind::Sqlserver);

    let output = env
        .cmd()
        .args(["config", "set", "db.kind", "mysql"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("sqlite oder sqlserver"),
        "{}",
        stderr(&output)
    );

    env.cmd()
        .args(["config", "set", "db.kind", "sqlite"])
        .assert()
        .success();
    env.cmd()
        .args(["config", "set", "db.path", r"\\server\freigabe\pds.db"])
        .assert()
        .success();
    let config = env.config();
    assert_eq!(config.db.kind, DbKind::Sqlite);
    assert_eq!(config.db.path, r"\\server\freigabe\pds.db");

    // Gespeichert ist es, die Prüfung lehnt das Netzlaufwerk ab
    let output = env.cmd().args(["config", "validate"]).output().unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        stdout(&output).contains("db.path: ") && stdout(&output).contains("(sqlite_network_path)"),
        "{}",
        stdout(&output)
    );
}

#[test]
fn db_setup_and_script_are_sql_server_only() {
    let env = Env::new();
    write_sqlite_config(&env, "");

    // Ohne Terminal und ohne --admin-password-stdin: die Art der Datenbank zählt vor der Abfrage
    let output = env
        .cmd()
        .args(["db", "setup", "--admin-user", "sa"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("nur für SQL Server"),
        "{}",
        stderr(&output)
    );
    assert_eq!(env.secret(SecretField::DbPassword), None, "nichts erzeugt");

    let output = env.cmd().args(["db", "script"]).output().unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(stdout(&output).is_empty());
    assert!(
        stderr(&output).contains("Das SQL-Skript gilt nur für SQL Server"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn db_backup_is_sqlite_only() {
    let env = Env::new();
    write_valid_config(&env, Some("Db-Passwort-1"));

    let output = env
        .cmd()
        .args(["db", "backup", "sicherung.db"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("nur für SQLite"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn db_backup_with_invalid_path_does_not_call_the_tool() {
    let env = Env::new();
    write_sqlite_config(&env, "relativ.db");

    let output = env
        .cmd()
        .args(["db", "backup", "sicherung.db"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(stdout(&output).contains("db.path"), "{}", stdout(&output));
}

#[cfg(unix)]
#[test]
fn db_test_and_backup_with_sqlite_pass_the_file() {
    let env = Env::new();
    write_sqlite_config(&env, "");
    fake_tool::install(&env, fake_tool::RESULT_OK);
    let file = env.data().join("data").join("pds.db");

    let output = env.cmd().args(["db", "test"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    let dump = fake_tool::dump(&env);
    assert!(dump.contains("cmd=db-test"), "{dump}");
    assert!(
        dump.contains(&format!("url=sqlite:{}\n", file.display())),
        "{dump}"
    );
    // Ohne SQL Server geht kein Passwort an das Werkzeug
    assert!(dump.contains("password=\n"), "{dump}");

    // Ein relativer Zielpfad gilt ab dem aktuellen Ordner und geht absolut ans Werkzeug
    let output = env
        .cmd()
        .current_dir(env.dir.path())
        .args(["db", "backup", "sicherung.db"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let dump = fake_tool::dump(&env);
    assert!(dump.contains("cmd=db-backup"), "{dump}");
    assert!(
        dump.contains(&format!("url=sqlite:{}\n", file.display())),
        "{dump}"
    );
    assert!(
        dump.contains(&format!(
            "backup={}\n",
            env.dir.path().join("sicherung.db").display()
        )),
        "{dump}"
    );
}

#[test]
fn status_names_the_database() {
    let env = Env::new();
    write_sqlite_config(&env, r"D:\PDS\pds.db");

    let output = env.cmd().args(["status"]).output().unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(
        stdout(&output).contains(r"Datenbank:         SQLite: D:\PDS\pds.db"),
        "{}",
        stdout(&output)
    );
}

// ---------------------------------------------------------------------------------------------
// EPLAN-Worker
// ---------------------------------------------------------------------------------------------

#[test]
fn eplan_install_rejects_a_password_argument_without_echoing_it() {
    let env = Env::new();

    let output = env
        .cmd()
        .args([
            "eplan",
            "install",
            "--user",
            r"EXAMPLE\eplan",
            "--password",
            "Geheim-123",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("nie als Argument"),
        "{}",
        stderr(&output)
    );
    assert!(!stderr(&output).contains("Geheim-123"));
    assert!(!stdout(&output).contains("Geheim-123"));
}

#[test]
fn eplan_install_checks_account_and_worker_before_asking_for_the_password() {
    let env = Env::new();

    // Ohne Domäne: Hinweis auf die richtige Schreibweise, keine Passwortabfrage
    let output = env
        .cmd()
        .args(["eplan", "install", "--user", "eplan", "--password-stdin"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(stderr(&output).contains(r".\eplan"), "{}", stderr(&output));

    let output = env
        .cmd()
        .args([
            "eplan",
            "install",
            "--user",
            r"NT SERVICE\pds",
            "--password-stdin",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("eingebautes oder virtuelles Konto"),
        "{}",
        stderr(&output)
    );

    // Ein MSI ohne Worker (hier: kein eplan\pds-eplan.exe im Installationsordner)
    let output = env
        .cmd()
        .args([
            "eplan",
            "install",
            "--user",
            r"EXAMPLE\eplan",
            "--password-stdin",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        stderr(&output).contains("fehlt in dieser Installation"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn eplan_status_names_a_missing_worker() {
    let env = Env::new();

    let output = env.cmd().args(["eplan", "status"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(
        stdout(&output).contains("Worker:    fehlt in dieser Installation"),
        "{}",
        stdout(&output)
    );

    let output = env
        .cmd()
        .args(["eplan", "status", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["workerPresent"], false);
    assert!(
        json["executable"]
            .as_str()
            .unwrap()
            .ends_with("pds-eplan.exe")
    );

    // `status` zeigt den Worker mit an
    let output = env.cmd().arg("status").output().unwrap();
    assert!(
        stdout(&output).contains("EPLAN-Worker:      fehlt in dieser Installation"),
        "{}",
        stdout(&output)
    );
}

#[cfg(not(windows))]
#[test]
fn eplan_control_without_windows_is_unsupported() {
    let env = Env::new();

    for command in ["start", "stop", "restart", "uninstall"] {
        let output = env.cmd().args(["eplan", command]).output().unwrap();
        assert_eq!(output.status.code(), Some(1), "{command}: {output:?}");
        assert!(
            stderr(&output).contains("nicht verfügbar"),
            "{command}: {}",
            stderr(&output)
        );
    }
}
