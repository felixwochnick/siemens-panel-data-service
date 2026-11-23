//! Aufruf des Node-Werkzeugs `tools\pds-tools.mjs` (Datenbank- und Anmeldungsprüfung, Sicherung
//! einer SQLite-Datenbank).
//!
//! Das Werkzeug läuft mit dem mitgelieferten `node.exe` (`--use-system-ca`: Zertifikate der
//! Firmen-PKI aus dem Windows-Speicher). Eingaben gehen nur über die Umgebung, nie über Argumente,
//! weil Prozessargumente für andere sichtbar sind. Jede Zeile auf stdout ist ein JSON-Objekt: Schritte
//! (`type: "step"`) und am Ende das Ergebnis (`type: "result"`); das Protokoll steht in
//! `windows/node-tools/src/protocol.ts`.

use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use ts_rs::TS;

use crate::config::{Config, Secrets};
use crate::ops::base_env;
use crate::paths::Paths;
use crate::render;
use crate::secret::Secret;

/// Üblicher Zeitrahmen für `run_tool` (Prüfungen: Verbindung, Discovery).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
/// Zeitrahmen für `db-setup`: Das Werkzeug wartet auf `CREATE`/`ALTER DATABASE` bis zu 120 s je
/// Anweisung, dazu kommt der Verbindungsaufbau; mit weniger bräche Rust das Werkzeug mittendrin ab.
pub const SETUP_TIMEOUT: Duration = Duration::from_secs(240);
/// Zeitrahmen für `db-backup`: Kopie und Prüfung einer großen SQLite-Datei dauern.
pub const BACKUP_TIMEOUT: Duration = Duration::from_secs(900);
/// Datenbank, in der ein Admin-Login Datenbanken anlegt.
const ADMIN_DATABASE: &str = "master";
/// So viel Ausgabe liest `run_tool` höchstens; der Rest wird verworfen, damit der Kindprozess nie an
/// einer vollen Pipe hängen bleibt.
const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
/// So viele Zeichen vom Ende der Fehlerausgabe nennt die Meldung, wenn ein Ergebnis fehlt.
const STDERR_TAIL_CHARS: usize = 600;
/// Abfrageabstand beim Warten auf das Ende des Kindprozesses.
const POLL_INTERVAL: Duration = Duration::from_millis(20);
/// Texte kürzer als das (Passwörter sind länger) werden nicht maskiert, sonst zerfiele normale Ausgabe.
const MIN_MASKED_LEN: usize = 4;
const MASK: &str = "***";
/// Variablen, deren Werte (und bei URLs das Passwort darin) nie in einer Meldung stehen dürfen.
const SECRET_VARIABLES: [&str; 4] = [
    "NUXT_DATABASE_URL",
    "PDS_ADMIN_DATABASE_URL",
    "PDS_DB_PASSWORD",
    "NUXT_OIDC_CLIENT_SECRET",
];
const URL_VARIABLES: [&str; 2] = ["NUXT_DATABASE_URL", "PDS_ADMIN_DATABASE_URL"];

/// Windows: kein Konsolenfenster für `node.exe` (die UI hat keine Konsole).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------------------------
// Befehle und Ergebnisse
// ---------------------------------------------------------------------------------------------

/// Die Befehle des Werkzeugs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCommand {
    DbTest,
    DbSetup,
    DbScript,
    DbBackup,
    OidcTest,
}

impl ToolCommand {
    /// Befehlswort für `pds-tools.mjs`.
    pub fn as_arg(self) -> &'static str {
        match self {
            Self::DbTest => "db-test",
            Self::DbSetup => "db-setup",
            Self::DbScript => "db-script",
            Self::DbBackup => "db-backup",
            Self::OidcTest => "oidc-test",
        }
    }
}

/// Eine Ausgabezeile des Werkzeugs: Zwischenschritt oder Abschluss.
///
/// Bei einem Schritt nennt `code` den Schritt (`connect`, `db_owner` …); `details.error` trägt bei
/// einem Fehlschlag den Fehlercode, `details.warning` kennzeichnet eine Warnung (`ok: false`, das
/// Ergebnis bleibt ok). Beim Ergebnis ist `code` der Fehlercode oder `ok`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolLine {
    /// `step` oder `result`.
    #[serde(rename = "type")]
    pub kind: String,
    pub ok: bool,
    pub code: String,
    /// Deutsche Meldung für Menschen.
    pub message: String,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub details: Value,
}

/// Das Gesamtergebnis eines Aufrufs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolResult {
    pub ok: bool,
    /// `ok` oder ein Fehlercode (`login_failed`, `issuer_mismatch`, …, `internal_error`).
    pub code: String,
    pub message: String,
    pub steps: Vec<ToolLine>,
    #[ts(type = "unknown")]
    pub details: Value,
}

/// Das Werkzeug ließ sich nicht aufrufen oder antwortete nicht. Ein Werkzeug, das *läuft* und
/// scheitert, ist kein Fehler hier, sondern ein [`ToolResult`] mit `ok: false`.
#[derive(Debug, Error)]
pub enum ToolError {
    #[error("Das Werkzeug fehlt: {0} – bitte die Installation reparieren (msiexec /fa …)")]
    Missing(String),
    #[error("Das Werkzeug ließ sich nicht starten: {0}")]
    Spawn(String),
    #[error("Das Werkzeug hat nach {0} Sekunden nicht geantwortet")]
    Timeout(u64),
    #[error("Die Ausgabe des Werkzeugs ließ sich nicht lesen: {0}")]
    Io(String),
}

impl ToolError {
    /// Stabiler Code für UI und CLI.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Missing(_) => "tool_missing",
            Self::Spawn(_) => "tool_spawn_failed",
            Self::Timeout(_) => "tool_timeout",
            Self::Io(_) => "tool_io_failed",
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Aufruf
// ---------------------------------------------------------------------------------------------

/// Startet `node --use-system-ca <tools_script> <befehl>` mit einer minimalen Umgebung
/// ([`base_env`]) plus `env` und wartet höchstens `timeout`.
///
/// Fehlt die Abschlusszeile (Absturz, Abbruch, falsche Node-Version), ist das Ergebnis
/// `internal_error` mit dem Ende der Fehlerausgabe. Secrets aus `env` stehen nie im Ergebnis: Das
/// Werkzeug entfernt sie selbst, und hier wird noch einmal maskiert, was sich auf sie zurückführen lässt.
pub fn run_tool(
    paths: &Paths,
    command: ToolCommand,
    env: Vec<(String, Secret)>,
    timeout: Duration,
) -> Result<ToolResult, ToolError> {
    let node = paths.node_exe();
    let script = paths.tools_script();
    for file in [&node, &script] {
        if !file.is_file() {
            return Err(ToolError::Missing(file.display().to_string()));
        }
    }

    let mut process = Command::new(&node);
    process
        .arg("--use-system-ca")
        .arg(&script)
        .arg(command.as_arg())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Später gesetzte Variablen gewinnen: `env` überschreibt die Basis
    for (name, value) in base_env().iter().chain(env.iter()) {
        process.env(name, value.expose());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        process.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = process
        .spawn()
        .map_err(|error| ToolError::Spawn(format!("{}: {error}", node.display())))?;
    let stdout = child.stdout.take().expect("stdout ist gepiped");
    let stderr = child.stderr.take().expect("stderr ist gepiped");
    // Beide Ströme nebenher leeren, sonst blockiert der Kindprozess an einer vollen Pipe
    let stdout_reader = thread::spawn(move || read_capped(stdout));
    let stderr_reader = thread::spawn(move || read_capped(stderr));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                // Die Leser enden, sobald die Pipes zu sind
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ToolError::Timeout(timeout.as_secs()));
            }
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(error) => return Err(ToolError::Io(error.to_string())),
        }
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| ToolError::Io("Lesefehler".to_owned()))?
        .map_err(|error| ToolError::Io(error.to_string()))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| ToolError::Io("Lesefehler".to_owned()))?
        .map_err(|error| ToolError::Io(error.to_string()))?;

    let masker = Masker::new(&env);
    let mut result = parse_output(
        &String::from_utf8_lossy(&stdout),
        &String::from_utf8_lossy(&stderr),
        status.code(),
    );
    masker.mask_result(&mut result);
    Ok(result)
}

/// Liest bis zum Ende, behält aber höchstens [`MAX_OUTPUT_BYTES`]; den Rest verwirft sie.
fn read_capped(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut kept = Vec::new();
    (&mut reader)
        .take(MAX_OUTPUT_BYTES)
        .read_to_end(&mut kept)?;
    io::copy(&mut reader, &mut io::sink())?;
    Ok(kept)
}

/// Baut das Ergebnis aus den Ausgaben. Zeilen, die kein JSON-Objekt dieser Form sind (etwa eine
/// Warnung von Node), werden übergangen.
fn parse_output(stdout: &str, stderr: &str, exit_code: Option<i32>) -> ToolResult {
    let mut steps = Vec::new();
    let mut result = None;
    for line in BufReader::new(stdout.as_bytes())
        .lines()
        .map_while(Result::ok)
    {
        let Ok(parsed) = serde_json::from_str::<ToolLine>(line.trim()) else {
            continue;
        };
        match parsed.kind.as_str() {
            "step" => steps.push(parsed),
            // Genau eine Abschlusszeile; bei mehreren gilt die letzte
            "result" => result = Some(parsed),
            _ => {}
        }
    }

    match result {
        Some(line) => ToolResult {
            ok: line.ok,
            code: line.code,
            message: line.message,
            steps,
            details: line.details,
        },
        None => {
            let tail = tail_chars(stderr.trim(), STDERR_TAIL_CHARS);
            let exit = exit_code.map_or_else(
                || "abgebrochen".to_owned(),
                |code| format!("Exit-Code {code}"),
            );
            let message = if tail.is_empty() {
                format!("Das Werkzeug hat kein Ergebnis geliefert ({exit}).")
            } else {
                format!("Das Werkzeug hat kein Ergebnis geliefert ({exit}): {tail}")
            };
            ToolResult {
                ok: false,
                code: "internal_error".to_owned(),
                message,
                steps,
                details: json!({ "exitCode": exit_code }),
            }
        }
    }
}

/// Die letzten `max` Zeichen (nicht Bytes), ohne mitten in ein Zeichen zu schneiden.
fn tail_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        text.to_owned()
    } else {
        let skipped: String = text.chars().skip(count - max).collect();
        format!("…{skipped}")
    }
}

// ---------------------------------------------------------------------------------------------
// Secrets aus der Ausgabe fernhalten
// ---------------------------------------------------------------------------------------------

/// Zweite Sicherung neben dem Werkzeug selbst: maskiert die Werte der Secret-Variablen (bei URLs
/// auch das Passwort darin, kodiert und dekodiert) in allem, was an Menschen geht.
struct Masker(Vec<String>);

impl Masker {
    fn new(env: &[(String, Secret)]) -> Self {
        let mut needles: Vec<String> = Vec::new();
        let mut add = |value: &str| {
            if value.chars().count() >= MIN_MASKED_LEN && !needles.iter().any(|n| n == value) {
                needles.push(value.to_owned());
            }
        };
        for (name, value) in env {
            if !SECRET_VARIABLES.contains(&name.as_str()) {
                continue;
            }
            add(value.expose());
            if URL_VARIABLES.contains(&name.as_str())
                && let Some(password) = url_password(value.expose())
            {
                add(password);
                add(&percent_decode_str(password).decode_utf8_lossy());
            }
        }
        // Längste zuerst: Die ganze URL enthält das Passwort, das sonst einzeln ersetzt würde
        needles.sort_by_key(|needle| std::cmp::Reverse(needle.len()));
        Self(needles)
    }

    fn mask(&self, text: &str) -> String {
        self.0
            .iter()
            .fold(text.to_owned(), |text, needle| text.replace(needle, MASK))
    }

    fn mask_value(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.mask(text),
            Value::Array(items) => items.iter_mut().for_each(|item| self.mask_value(item)),
            Value::Object(map) => map.values_mut().for_each(|item| self.mask_value(item)),
            _ => {}
        }
    }

    fn mask_result(&self, result: &mut ToolResult) {
        if self.0.is_empty() {
            return;
        }
        result.message = self.mask(&result.message);
        self.mask_value(&mut result.details);
        for step in &mut result.steps {
            step.message = self.mask(&step.message);
            self.mask_value(&mut step.details);
        }
    }
}

/// Das (noch kodierte) Passwort aus `scheme://user:passwort@host/…`.
fn url_password(url: &str) -> Option<&str> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let userinfo = authority.rsplit_once('@')?.0;
    Some(userinfo.split_once(':')?.1)
}

// ---------------------------------------------------------------------------------------------
// Umgebung je Befehl
// ---------------------------------------------------------------------------------------------

fn plain(name: &str, value: impl Into<String>) -> (String, Secret) {
    (name.to_owned(), Secret::new(value))
}

/// `db-test`: die Datenbank-URL der App (`NUXT_DATABASE_URL`), bei SQLite `sqlite:<pfad>`.
pub fn db_test_env(config: &Config, paths: &Paths, secrets: &Secrets) -> Vec<(String, Secret)> {
    let password = secrets.db_password.clone().unwrap_or_default();
    vec![(
        "NUXT_DATABASE_URL".to_owned(),
        render::database_url(config, paths, &password),
    )]
}

/// `db-backup`: die SQLite-Datei der App (`NUXT_DATABASE_URL`) und die Zieldatei
/// (`PDS_BACKUP_FILE`, absolut).
pub fn db_backup_env(config: &Config, paths: &Paths, target: &Path) -> Vec<(String, Secret)> {
    vec![
        (
            "NUXT_DATABASE_URL".to_owned(),
            render::database_url(config, paths, &Secret::default()),
        ),
        plain("PDS_BACKUP_FILE", target.display().to_string()),
    ]
}

/// `db-setup`: der Admin-Zugang an `master` (`PDS_ADMIN_DATABASE_URL`, gebaut wie die URL der App, nur
/// mit anderem Login und Datenbank) sowie Datenbank, Login und Passwort der App.
pub fn db_setup_env(
    config: &Config,
    secrets: &Secrets,
    admin_user: &str,
    admin_password: &Secret,
) -> Vec<(String, Secret)> {
    // Gleiche Kodierung und gleiche TLS-Schalter wie die App: einen Satz Regeln, nicht zwei
    let mut admin = config.clone();
    admin.db.user = admin_user.to_owned();
    admin.db.database = ADMIN_DATABASE.to_owned();

    let mut env = vec![(
        "PDS_ADMIN_DATABASE_URL".to_owned(),
        render::sqlserver_url(&admin, admin_password),
    )];
    env.extend(db_script_env(config));
    env.push((
        "PDS_DB_PASSWORD".to_owned(),
        secrets.db_password.clone().unwrap_or_default(),
    ));
    env
}

/// `db-script`: nur Datenbank- und Login-Name; das Passwort bleibt im Skript ein Platzhalter.
pub fn db_script_env(config: &Config) -> Vec<(String, Secret)> {
    vec![
        plain("PDS_DB_NAME", config.db.database.as_str()),
        plain("PDS_DB_USER", config.db.user.as_str()),
    ]
}

/// `oidc-test`: Issuer, Client-ID und der ausgehende Proxy (`NODE_USE_ENV_PROXY` schaltet ihn in
/// Nodes `fetch` ein). Das Client-Secret gibt es nur mit `check_client`: Ohne die Prüfung braucht
/// das Werkzeug es nicht.
pub fn oidc_test_env(
    config: &Config,
    secrets: &Secrets,
    check_client: bool,
) -> Vec<(String, Secret)> {
    let mut env = vec![
        plain("NUXT_OIDC_ISSUER", render::issuer(config)),
        plain("NUXT_OIDC_CLIENT_ID", config.oidc.client_id.as_str()),
    ];
    if check_client {
        env.push(plain("PDS_OIDC_CHECK_CLIENT", "1"));
        if let Some(secret) = secrets
            .oidc_client_secret
            .as_ref()
            .filter(|secret| !secret.is_empty())
        {
            env.push(("NUXT_OIDC_CLIENT_SECRET".to_owned(), secret.clone()));
        }
    }
    env.extend(render::proxy_variables(config));
    env
}
