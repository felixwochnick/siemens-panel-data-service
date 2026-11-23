//! Aufruf des Node-Werkzeugs: Umgebung je Befehl (überall) und `run_tool` mit einem Fake-Skript (Unix).

use std::path::Path;

use pds_common::config::{Config, DbKind, Secrets};
use pds_common::tools::{
    ToolCommand, db_backup_env, db_script_env, db_setup_env, db_test_env, oidc_test_env,
};
use pds_common::{Paths, Secret, render};

/// Das Passwort aus dem Auftrag: jedes Sonderzeichen, das in einer URL etwas bedeutet.
const NASTY_PASSWORD: &str = "p@ss:w/rd#?%'ü ";
const NASTY_PASSWORD_ENCODED: &str = "p%40ss%3Aw%2Frd%23%3F%25%27%C3%BC%20";

fn config() -> Config {
    let mut config = Config::default();
    config.public.host = "trainee.example.com".into();
    config.db.kind = DbKind::Sqlserver;
    config.db.server = "sql.example.com".into();
    config.db.database = "pds".into();
    config.db.user = "pds_app".into();
    config.oidc.tenant_id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d".into();
    config.oidc.client_id = "11111111-2222-3333-4444-555555555555".into();
    config
}

fn secrets() -> Secrets {
    Secrets {
        db_password: Some(Secret::new(NASTY_PASSWORD)),
        oidc_client_secret: Some(Secret::new("client-secret-value")),
        app_secret: Some(Secret::new("a".repeat(64))),
        acme_eab_hmac: None,
    }
}

fn paths() -> Paths {
    Paths::new("/opt/pds", "/var/pds")
}

fn lookup<'a>(env: &'a [(String, Secret)], name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.expose())
}

#[test]
fn commands_have_distinct_args() {
    let args = [
        ToolCommand::DbTest,
        ToolCommand::DbSetup,
        ToolCommand::DbScript,
        ToolCommand::DbBackup,
        ToolCommand::OidcTest,
    ]
    .map(ToolCommand::as_arg);
    assert_eq!(
        args,
        ["db-test", "db-setup", "db-script", "db-backup", "oidc-test"]
    );
}

#[test]
fn db_test_env_is_the_app_url() {
    let env = db_test_env(&config(), &paths(), &secrets());

    assert_eq!(env.len(), 1);
    assert_eq!(
        lookup(&env, "NUXT_DATABASE_URL"),
        Some(
            format!(
                "mssql://pds_app:{NASTY_PASSWORD_ENCODED}@sql.example.com:1433/pds\
                 ?encrypt=true&trustServerCertificate=false"
            )
            .as_str()
        )
    );
}

#[test]
fn db_test_env_without_password_has_an_empty_one() {
    let env = db_test_env(&config(), &paths(), &Secrets::default());

    assert!(
        lookup(&env, "NUXT_DATABASE_URL")
            .unwrap()
            .starts_with("mssql://pds_app:@sql")
    );
}

#[test]
fn db_setup_env_builds_the_admin_url_like_the_app_url() {
    let mut config = config();
    config.db.encrypt = false;
    config.db.trust_server_certificate = true;
    config.db.port = 14330;
    let admin_password = Secret::new("Admin:P@ss/1");

    let env = db_setup_env(&config, &secrets(), "sql admin", &admin_password);

    // Admin-Login an master, Kodierung und Schalter wie bei der App-URL
    assert_eq!(
        lookup(&env, "PDS_ADMIN_DATABASE_URL"),
        Some(
            "mssql://sql%20admin:Admin%3AP%40ss%2F1@sql.example.com:14330/master\
             ?encrypt=false&trustServerCertificate=true"
        )
    );
    assert_eq!(lookup(&env, "PDS_DB_NAME"), Some("pds"));
    assert_eq!(lookup(&env, "PDS_DB_USER"), Some("pds_app"));
    // Das Passwort der App geht unkodiert in die Umgebung (es steht nicht in einer URL)
    assert_eq!(lookup(&env, "PDS_DB_PASSWORD"), Some(NASTY_PASSWORD));
    // Die App-Zugangsdaten stehen nicht in der Admin-URL
    assert!(
        !lookup(&env, "PDS_ADMIN_DATABASE_URL")
            .unwrap()
            .contains("pds_app")
    );
    assert!(lookup(&env, "NUXT_DATABASE_URL").is_none());
}

#[test]
fn db_setup_env_does_not_change_the_config() {
    let config = config();
    let before = config.clone();

    let _ = db_setup_env(&config, &secrets(), "sa", &Secret::new("x"));

    assert_eq!(config, before);
    // Dieselbe Funktion wie die App-URL, nur mit anderem Benutzer und Datenbank
    let app = render::database_url(&config, &paths(), &Secret::new("x"));
    assert!(app.expose().contains("/pds?"));
}

#[test]
fn db_test_env_for_sqlite_is_the_file() {
    let mut config = config();
    config.db.kind = DbKind::Sqlite;

    // Ohne eigenen Pfad die Datei im Datenordner; das gespeicherte Passwort spielt keine Rolle
    let env = db_test_env(&config, &paths(), &secrets());
    let expected = format!("sqlite:{}", paths().default_sqlite_file().display());
    assert_eq!(lookup(&env, "NUXT_DATABASE_URL"), Some(expected.as_str()));

    // Ein eigener Pfad geht roh hinein, mit Leerzeichen und Backslashes
    config.db.path = r" D:\Daten mit Leerzeichen\pds.db ".into();
    let env = db_test_env(&config, &paths(), &secrets());
    assert_eq!(
        lookup(&env, "NUXT_DATABASE_URL"),
        Some(r"sqlite:D:\Daten mit Leerzeichen\pds.db")
    );
}

#[test]
fn db_backup_env_names_file_and_target() {
    let mut config = config();
    config.db.kind = DbKind::Sqlite;
    config.db.path = r"D:\PDS\pds.db".into();

    let env = db_backup_env(&config, &paths(), Path::new("/sicherung/pds-1.db"));

    assert_eq!(env.len(), 2);
    assert_eq!(
        lookup(&env, "NUXT_DATABASE_URL"),
        Some(r"sqlite:D:\PDS\pds.db")
    );
    assert_eq!(lookup(&env, "PDS_BACKUP_FILE"), Some("/sicherung/pds-1.db"));
}

#[test]
fn db_script_env_has_names_but_no_password() {
    let env = db_script_env(&config());

    assert_eq!(env.len(), 2);
    assert_eq!(lookup(&env, "PDS_DB_NAME"), Some("pds"));
    assert_eq!(lookup(&env, "PDS_DB_USER"), Some("pds_app"));
}

#[test]
fn oidc_test_env_passes_issuer_and_proxy() {
    let mut config = config();
    config.proxy.url = "http://proxy.example.com:3128".into();
    config.proxy.no_proxy = "intern.example.com".into();

    let env = oidc_test_env(&config, &secrets(), false);

    assert_eq!(
        lookup(&env, "NUXT_OIDC_ISSUER"),
        Some("https://login.microsoftonline.com/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/v2.0")
    );
    assert_eq!(
        lookup(&env, "NUXT_OIDC_CLIENT_ID"),
        Some("11111111-2222-3333-4444-555555555555")
    );
    assert_eq!(
        lookup(&env, "HTTPS_PROXY"),
        Some("http://proxy.example.com:3128")
    );
    assert_eq!(
        lookup(&env, "HTTP_PROXY"),
        Some("http://proxy.example.com:3128")
    );
    assert_eq!(
        lookup(&env, "NO_PROXY"),
        Some("intern.example.com,127.0.0.1,localhost")
    );
    // Ohne Proxy-Schalter ignoriert Nodes fetch die Variablen
    assert_eq!(lookup(&env, "NODE_USE_ENV_PROXY"), Some("1"));
    // Ohne Clientprüfung bekommt das Werkzeug das Secret nicht
    assert!(lookup(&env, "NUXT_OIDC_CLIENT_SECRET").is_none());
    assert!(lookup(&env, "PDS_OIDC_CHECK_CLIENT").is_none());
}

#[test]
fn oidc_test_env_with_client_check_adds_the_secret() {
    let env = oidc_test_env(&config(), &secrets(), true);

    assert_eq!(lookup(&env, "PDS_OIDC_CHECK_CLIENT"), Some("1"));
    assert_eq!(
        lookup(&env, "NUXT_OIDC_CLIENT_SECRET"),
        Some("client-secret-value")
    );
    // Kein Proxy konfiguriert: keine Proxy-Variablen
    assert!(lookup(&env, "HTTPS_PROXY").is_none());
    assert!(lookup(&env, "NODE_USE_ENV_PROXY").is_none());
}

#[test]
fn oidc_test_env_uses_a_custom_issuer_without_trailing_slash() {
    let mut config = config();
    config.oidc.issuer = "https://idp.example.com/realm/".into();

    let env = oidc_test_env(&config, &Secrets::default(), true);

    assert_eq!(
        lookup(&env, "NUXT_OIDC_ISSUER"),
        Some("https://idp.example.com/realm")
    );
    // Ohne gesetztes Secret wird keins übergeben
    assert!(lookup(&env, "NUXT_OIDC_CLIENT_SECRET").is_none());
}

// ---------------------------------------------------------------------------------------------
// run_tool mit einem Fake-Skript: nur Unix (Symlink auf das System-node)
// ---------------------------------------------------------------------------------------------

#[cfg(unix)]
mod run {
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::time::Duration;

    use pds_common::tools::{ToolCommand, ToolError, run_tool};
    use pds_common::{Paths, Secret};
    use serde_json::json;
    use tempfile::TempDir;

    const TIMEOUT: Duration = Duration::from_secs(20);

    /// Das `node` des Systems: dasselbe, das auch die Tests des Werkzeugs nutzen.
    fn system_node() -> PathBuf {
        let path = std::env::var_os("PATH").expect("PATH nicht gesetzt");
        std::env::split_paths(&path)
            .map(|dir| dir.join("node"))
            .find(|candidate| candidate.is_file())
            .expect("node nicht im PATH gefunden (wird für die Tests des Werkzeugs gebraucht)")
    }

    /// Installationsordner mit `node/node` (Symlink) und `tools/pds-tools.mjs` mit dem Skript.
    fn install(script: &str) -> (TempDir, Paths) {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("node")).unwrap();
        fs::create_dir_all(dir.path().join("tools")).unwrap();
        symlink(system_node(), dir.path().join("node").join("node")).unwrap();
        fs::write(dir.path().join("tools").join("pds-tools.mjs"), script).unwrap();
        let paths = Paths::new(dir.path(), dir.path().join("data"));
        (dir, paths)
    }

    #[test]
    fn parses_steps_and_result() {
        let (_dir, paths) = install(
            r#"
const out = (line) => process.stdout.write(JSON.stringify(line) + '\n')
process.stdout.write('Rauschen, kein JSON\n')
out({ type: 'step', ok: true, code: 'connect', message: 'Verbunden', details: { server: 'x' } })
out({ type: 'step', ok: false, code: 'db_owner', message: 'Warnung', details: { warning: true } })
out({ type: 'result', ok: true, code: 'ok', message: 'Alles gut', details: { warnings: ['db_owner'] } })
"#,
        );

        let result = run_tool(&paths, ToolCommand::DbTest, Vec::new(), TIMEOUT).unwrap();

        assert!(result.ok);
        assert_eq!(result.code, "ok");
        assert_eq!(result.message, "Alles gut");
        assert_eq!(result.details, json!({ "warnings": ["db_owner"] }));
        assert_eq!(result.steps.len(), 2);
        assert_eq!(result.steps[0].kind, "step");
        assert_eq!(result.steps[0].code, "connect");
        assert!(result.steps[0].ok);
        assert_eq!(result.steps[0].details, json!({ "server": "x" }));
        assert!(!result.steps[1].ok);
        assert_eq!(result.steps[1].details, json!({ "warning": true }));
    }

    #[test]
    fn a_failing_result_is_a_result_not_an_error() {
        let (_dir, paths) = install(
            r#"
process.stdout.write(JSON.stringify({ type: 'result', ok: false, code: 'login_failed', message: 'Nein' }) + '\n')
process.exitCode = 3
"#,
        );

        let result = run_tool(&paths, ToolCommand::DbTest, Vec::new(), TIMEOUT).unwrap();

        assert!(!result.ok);
        assert_eq!(result.code, "login_failed");
        // Ohne `details` in der Zeile bleibt es leer
        assert!(result.details.is_null());
    }

    #[test]
    fn missing_result_is_internal_error() {
        let (_dir, paths) = install(
            r#"
process.stdout.write(JSON.stringify({ type: 'step', ok: true, code: 'connect', message: 'Verbunden' }) + '\n')
process.stderr.write('Zeile 1\nFehler: kaputt gegangen\n')
process.exit(7)
"#,
        );

        let result = run_tool(&paths, ToolCommand::DbTest, Vec::new(), TIMEOUT).unwrap();

        assert!(!result.ok);
        assert_eq!(result.code, "internal_error");
        assert!(
            result.message.contains("kaputt gegangen"),
            "{}",
            result.message
        );
        assert!(result.message.contains("Exit-Code 7"), "{}", result.message);
        // Die Schritte bis zum Abbruch bleiben erhalten
        assert_eq!(result.steps.len(), 1);
        assert_eq!(result.details, json!({ "exitCode": 7 }));
    }

    #[test]
    fn missing_result_without_stderr_still_explains() {
        let (_dir, paths) = install("process.exit(0)");

        let result = run_tool(&paths, ToolCommand::DbTest, Vec::new(), TIMEOUT).unwrap();

        assert_eq!(result.code, "internal_error");
        assert!(result.message.contains("kein Ergebnis"));
    }

    #[test]
    fn long_stderr_keeps_only_the_tail() {
        let (_dir, paths) = install(
            r#"
process.stderr.write('ANFANG ' + 'x'.repeat(5000) + ' ENDE äöü')
"#,
        );

        let result = run_tool(&paths, ToolCommand::DbTest, Vec::new(), TIMEOUT).unwrap();

        assert!(result.message.contains("ENDE äöü"));
        assert!(!result.message.contains("ANFANG"));
        assert!(result.message.chars().count() < 800);
    }

    #[test]
    fn env_not_in_args() {
        // Das Skript meldet seine Argumente und ob die Umgebung angekommen ist, nie den Wert selbst
        let (_dir, paths) = install(
            r#"
const secret = 'mssql://app:Geheim-Passwort-1A@host/db'
process.stdout.write(JSON.stringify({
  type: 'result', ok: true, code: 'ok', message: 'x',
  details: {
    argv: process.argv.slice(1),
    execArgv: process.execArgv,
    envArrived: process.env.NUXT_DATABASE_URL === secret,
    secretInArgs: [...process.argv, ...process.execArgv].some((arg) => arg.includes('Geheim-Passwort-1A')),
  },
}) + '\n')
"#,
        );
        let env = vec![(
            "NUXT_DATABASE_URL".to_owned(),
            Secret::new("mssql://app:Geheim-Passwort-1A@host/db"),
        )];

        let result = run_tool(&paths, ToolCommand::DbSetup, env, TIMEOUT).unwrap();

        assert!(result.ok, "{}", result.message);
        assert_eq!(result.details["envArrived"], json!(true));
        assert_eq!(result.details["secretInArgs"], json!(false));
        assert_eq!(result.details["execArgv"], json!(["--use-system-ca"]));
        let argv = result.details["argv"].as_array().unwrap();
        assert_eq!(argv.len(), 2);
        assert!(argv[0].as_str().unwrap().ends_with("tools/pds-tools.mjs"));
        assert_eq!(argv[1], json!("db-setup"));
    }

    #[test]
    fn env_is_minimal() {
        let (_dir, paths) = install(
            r#"
process.stdout.write(JSON.stringify({
  type: 'result', ok: true, code: 'ok', message: 'x',
  details: { names: Object.keys(process.env).sort() },
}) + '\n')
"#,
        );
        let env = vec![("PDS_DB_NAME".to_owned(), Secret::new("db"))];

        let result = run_tool(&paths, ToolCommand::DbScript, env, TIMEOUT).unwrap();

        let names: Vec<String> = serde_json::from_value(result.details["names"].clone()).unwrap();
        // Von der Umgebung des Tests kommt nur die Basis; sonst nur, was ausdrücklich übergeben wurde
        for name in &names {
            assert!(
                ["PATH", "HOME", "TMPDIR", "PDS_DB_NAME"].contains(&name.as_str())
                    || name.starts_with("__"),
                "unerwartete Variable {name}"
            );
        }
        assert!(names.contains(&"PDS_DB_NAME".to_owned()));
    }

    #[test]
    fn explicit_env_wins_over_the_base() {
        let (_dir, paths) = install(
            r#"
process.stdout.write(JSON.stringify({
  type: 'result', ok: true, code: 'ok', message: 'x', details: { home: process.env.HOME },
}) + '\n')
"#,
        );
        let env = vec![("HOME".to_owned(), Secret::new("/eigenes/home"))];

        let result = run_tool(&paths, ToolCommand::DbTest, env, TIMEOUT).unwrap();

        assert_eq!(result.details["home"], json!("/eigenes/home"));
    }

    #[test]
    fn secrets_are_masked_in_everything_that_comes_back() {
        // Ein fehlerhaftes Werkzeug, das Secrets ausgibt: die zweite Sicherung maskiert sie
        let (_dir, paths) = install(
            r#"
const url = process.env.NUXT_DATABASE_URL
const password = decodeURIComponent(new URL(url).password)
process.stdout.write(JSON.stringify({ type: 'step', ok: false, code: 'connect', message: 'Fehler bei ' + url, details: { list: [password] } }) + '\n')
process.stdout.write(JSON.stringify({ type: 'result', ok: false, code: 'x', message: 'Passwort ' + password + ' falsch', details: { url } }) + '\n')
"#,
        );
        let env = vec![(
            "NUXT_DATABASE_URL".to_owned(),
            Secret::new("mssql://app:Pa%27ss%40w0rd@host/db"),
        )];

        let result = run_tool(&paths, ToolCommand::DbTest, env, TIMEOUT).unwrap();

        let text = serde_json::to_string(&result).unwrap();
        assert!(!text.contains("Pa'ss@w0rd"), "{text}");
        assert!(!text.contains("Pa%27ss%40w0rd"), "{text}");
        assert_eq!(result.message, "Passwort *** falsch");
        assert_eq!(result.steps[0].message, "Fehler bei ***");
        assert_eq!(result.steps[0].details, json!({ "list": ["***"] }));
    }

    #[test]
    fn stderr_tail_is_masked() {
        let (_dir, paths) = install(
            r#"
process.stderr.write('Absturz mit ' + process.env.PDS_DB_PASSWORD)
"#,
        );
        let env = vec![(
            "PDS_DB_PASSWORD".to_owned(),
            Secret::new("Geheim-Passwort-1A"),
        )];

        let result = run_tool(&paths, ToolCommand::DbSetup, env, TIMEOUT).unwrap();

        assert!(
            result.message.contains("Absturz mit ***"),
            "{}",
            result.message
        );
        assert!(!result.message.contains("Geheim"));
    }

    #[test]
    fn times_out_and_kills_the_tool() {
        let (_dir, paths) = install("setInterval(() => {}, 1000)");

        let started = std::time::Instant::now();
        let error = run_tool(
            &paths,
            ToolCommand::DbTest,
            Vec::new(),
            Duration::from_millis(300),
        )
        .unwrap_err();

        assert!(matches!(error, ToolError::Timeout(_)), "{error:?}");
        assert_eq!(error.code(), "tool_timeout");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn missing_files_are_reported_by_name() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path(), dir.path().join("data"));

        let error = run_tool(&paths, ToolCommand::DbTest, Vec::new(), TIMEOUT).unwrap_err();

        assert!(
            matches!(&error, ToolError::Missing(file) if file.ends_with("node")),
            "{error:?}"
        );
        assert_eq!(error.code(), "tool_missing");

        // Node da, Skript fehlt
        fs::create_dir_all(dir.path().join("node")).unwrap();
        symlink(system_node(), dir.path().join("node").join("node")).unwrap();
        let error = run_tool(&paths, ToolCommand::DbTest, Vec::new(), TIMEOUT).unwrap_err();
        assert!(
            matches!(&error, ToolError::Missing(file) if file.ends_with("pds-tools.mjs")),
            "{error:?}"
        );
    }

    #[test]
    fn large_output_does_not_block_the_tool() {
        // Mehr als eine Pipe fasst, auf beiden Strömen; der Aufruf darf nicht hängen
        let (_dir, paths) = install(
            r#"
process.stderr.write('e'.repeat(300000))
process.stdout.write('Rauschen '.repeat(100000) + '\n')
process.stdout.write(JSON.stringify({ type: 'result', ok: true, code: 'ok', message: 'fertig' }) + '\n')
"#,
        );

        let result = run_tool(&paths, ToolCommand::DbTest, Vec::new(), TIMEOUT).unwrap();

        assert_eq!(result.message, "fertig");
    }
}
