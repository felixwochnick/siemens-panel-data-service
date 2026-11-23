//! Validierung der Konfiguration: die einzige Quelle der Wahrheit für UI, CLI und Dienst.
//!
//! [`validate`] liefert alle Befunde auf einmal (Feldpfad, Code, deutsche Meldung, Schwere), damit
//! Admins nicht von Fehler zu Fehler stolpern. Der Dienst startet die Kindprozesse erst, wenn
//! [`has_errors`] `false` meldet. Die Regeln decken `packages/core/server/plugins/01.config-check.ts`
//! ab (App-Secret ab 32 Zeichen, Datenbank-URL, Issuer und Client-ID). Die Codes sind
//! Schnittstelle (UI und CLI verzweigen darauf); Meldungen enthalten nie den Wert eines Secrets.
//!
//! Fast alles ist rein. Ausnahmen, weil nur das Dateisystem sie beantworten kann: ob die Datei aus
//! `tls.acme_ca_root` existiert, und beim SQLite-Pfad, ob er ein Ordner ist oder auf einem
//! Netzlaufwerk liegt (nur unter Windows).

use std::net::{IpAddr, Ipv6Addr};
use std::path::Path;

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime, UtcOffset};
use ts_rs::TS;

use crate::config::{Config, DbKind, SecretField, Secrets, TlsMode};
use crate::paths::Paths;
use crate::platform::{self, DriveKind};
use crate::secret::Secret;
use crate::tls::{CertInfo, hostname_matches};

/// So viele Zeichen muss das App-Secret mindestens haben (wie `01.config-check.ts`).
const APP_SECRET_MIN_CHARS: usize = 32;
/// Ab so vielen Tagen vor Ablauf warnt die Prüfung.
const EXPIRY_WARNING_DAYS: i64 = 30;
/// Ein Name darf höchstens 253 Zeichen lang sein, ein Label höchstens 63 (RFC 1035).
const MAX_HOSTNAME_LEN: usize = 253;
const MAX_LABEL_LEN: usize = 63;
const GUID_GROUP_LENS: [usize; 5] = [8, 4, 4, 4, 12];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Severity {
    /// Blockiert den Start der Kindprozesse.
    Error,
    /// Hinweis, der den Start nicht verhindert.
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Finding {
    /// Feldpfad wie in `config set` (`db.port`) oder `tls` für das Zertifikat als Ganzes.
    pub field: String,
    /// Stabiler Code in `snake_case`.
    pub code: String,
    /// Deutsche Meldung für Admins.
    pub message: String,
    pub severity: Severity,
}

/// Alles, was die Prüfung braucht. Zertifikat und Schlüsselprüfung kommen von außen, damit
/// `validate` rein bleibt (kein Dateizugriff auf das Zertifikat, keine Uhr).
#[derive(Debug, Clone, Copy)]
pub struct ValidationInput<'a> {
    pub config: &'a Config,
    pub secrets: &'a Secrets,
    /// Das gespeicherte Leaf-Zertifikat, `None` wenn keins hinterlegt ist.
    pub certificate: Option<&'a CertInfo>,
    /// Passt der gespeicherte Schlüssel zum Zertifikat? `None` = nicht geprüft.
    pub certificate_key_matches: Option<bool>,
    pub now: OffsetDateTime,
    /// Installations- und Datenordner: Eine SQLite-Datei darf nicht darin liegen (außer in `data\`).
    pub paths: &'a Paths,
}

/// Prüft die Konfiguration. Die Reihenfolge der Befunde ist fest: Adresse und Ports, TLS,
/// Datenbank, Anmeldung, Proxy, App.
pub fn validate(input: &ValidationInput) -> Vec<Finding> {
    let mut out = Findings::default();
    let config = input.config;
    let host_ok = check_host(&mut out, &config.public.host);
    check_scheme(&mut out, config);
    check_ports(&mut out, config);
    match config.tls.mode {
        TlsMode::Certificate => check_certificate(&mut out, input, host_ok),
        TlsMode::Acme => check_acme(&mut out, config, input.secrets),
        TlsMode::Internal | TlsMode::Off => {}
    }
    match config.db.kind {
        DbKind::Sqlite => check_sqlite(&mut out, config, input.paths),
        DbKind::Sqlserver => check_database(&mut out, config, input.secrets),
    }
    check_oidc(&mut out, config, input.secrets);
    check_proxy(&mut out, config);
    check_app_secret(&mut out, input.secrets);
    out.0
}

/// Befund für einen Schlüssel, der nicht zum Zertifikat passt. Prüfung und Import verwenden
/// denselben, damit beide gleich melden.
pub fn key_mismatch_finding() -> Finding {
    Finding {
        field: "tls".to_owned(),
        code: "certificate_key_mismatch".to_owned(),
        message: "Der private Schlüssel passt nicht zum Zertifikat".to_owned(),
        severity: Severity::Error,
    }
}

/// Nur die Befunde zum SQLite-Pfad: Das Speichern bereitet den Ordner nur vor, wenn es keine Fehler
/// gibt (kein Laufwerksstamm, kein Systemordner, kein Netzlaufwerk).
pub fn sqlite_findings(config: &Config, paths: &Paths) -> Vec<Finding> {
    let mut out = Findings::default();
    if config.db.kind == DbKind::Sqlite {
        check_sqlite(&mut out, config, paths);
    }
    out.0
}

pub fn has_errors(findings: &[Finding]) -> bool {
    findings
        .iter()
        .any(|finding| finding.severity == Severity::Error)
}

// ---------------------------------------------------------------------------------------------
// Sammler
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Findings(Vec<Finding>);

impl Findings {
    fn push(&mut self, severity: Severity, field: &str, code: &str, message: String) {
        self.0.push(Finding {
            field: field.to_owned(),
            code: code.to_owned(),
            message,
            severity,
        });
    }

    fn error(&mut self, field: &str, code: &str, message: impl Into<String>) {
        self.push(Severity::Error, field, code, message.into());
    }

    fn warning(&mut self, field: &str, code: &str, message: impl Into<String>) {
        self.push(Severity::Warning, field, code, message.into());
    }

    /// Pflichtfeld: `required`, wenn nach dem Kürzen nichts übrig bleibt. Liefert `true`, wenn
    /// ein Wert da ist, damit der Aufrufer ihn weiter prüfen kann.
    fn require(&mut self, field: &str, value: &str, message: &str) -> bool {
        let present = !value.trim().is_empty();
        if !present {
            self.error(field, "required", message);
        }
        present
    }

    fn port(&mut self, field: &str, port: u16) {
        if port == 0 {
            self.error(
                field,
                "invalid_port",
                "Port muss zwischen 1 und 65535 liegen",
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Adresse und Ports
// ---------------------------------------------------------------------------------------------

/// Liefert `true`, wenn der Host brauchbar ist (für die Zertifikatsprüfung).
fn check_host(out: &mut Findings, host: &str) -> bool {
    if !out.require("public.host", host, "Hostname fehlt") {
        return false;
    }
    if !is_host(host) {
        out.error(
            "public.host",
            "invalid_hostname",
            "Hostname ist ungültig: erlaubt sind Buchstaben, Ziffern, Bindestriche und Punkte \
             oder eine IP-Adresse, ohne Schema und Port",
        );
        return false;
    }
    true
}

fn check_scheme(out: &mut Findings, config: &Config) {
    // Nur bei `off` bestimmt das Schema die öffentliche URL, sonst ist es immer https
    if config.tls.mode == TlsMode::Off && !matches!(config.public.scheme.as_str(), "http" | "https")
    {
        out.error(
            "public.scheme",
            "invalid_scheme",
            "Das Schema muss http oder https sein",
        );
    }
}

fn check_ports(out: &mut Findings, config: &Config) {
    out.port("listen.http_port", config.listen.http_port);
    out.port("public.port", config.public.port);
    out.port("internal.port", config.internal.port);
    // Der Port des SQL Servers zählt nur, wenn er gebraucht wird
    if config.db.kind == DbKind::Sqlserver {
        out.port("db.port", config.db.port);
    }

    // Reihenfolge = Rangfolge: der Befund steht am späteren Feld eines Paares. Bei `off` lauscht
    // kein Port auf `public.port`, er steht nur in der URL.
    let mut listening: Vec<(&str, u16)> = Vec::with_capacity(3);
    if config.tls.mode != TlsMode::Off {
        listening.push(("public.port", config.public.port));
    }
    listening.push(("listen.http_port", config.listen.http_port));
    listening.push(("internal.port", config.internal.port));
    for (index, (field, port)) in listening.iter().enumerate() {
        // Port 0 ist schon als ungültig gemeldet, ein Folgebefund wäre Lärm
        if *port == 0 {
            continue;
        }
        if let Some((other, _)) = listening[..index].iter().find(|(_, p)| p == port) {
            out.error(
                field,
                "port_conflict",
                format!("Port {port} wird bereits von {other} verwendet"),
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------------------------

fn check_certificate(out: &mut Findings, input: &ValidationInput, host_ok: bool) {
    let Some(certificate) = input.certificate else {
        out.error(
            "tls",
            "certificate_missing",
            "Es ist kein Zertifikat hinterlegt",
        );
        return;
    };
    if input.certificate_key_matches == Some(false) {
        out.0.push(key_mismatch_finding());
    }

    let not_after = certificate.not_after;
    if input.now > not_after {
        out.error(
            "tls",
            "certificate_expired",
            format!(
                "Das Zertifikat ist am {} abgelaufen",
                german_date(not_after)
            ),
        );
    } else if not_after - input.now <= Duration::days(EXPIRY_WARNING_DAYS) {
        out.warning(
            "tls",
            "certificate_expires_soon",
            format!("Das Zertifikat läuft am {} ab", german_date(not_after)),
        );
    }

    // Ohne brauchbaren Host steht der Fehler schon da, ein Folgebefund wäre irreführend
    let host = &input.config.public.host;
    if host_ok && !hostname_matches(certificate, host) {
        out.error(
            "public.host",
            "certificate_hostname_mismatch",
            format!("Das Zertifikat gilt nicht für {host}"),
        );
    }
}

fn check_acme(out: &mut Findings, config: &Config, secrets: &Secrets) {
    let tls = &config.tls;
    if out.require(
        "tls.acme_email",
        &tls.acme_email,
        "E-Mail-Adresse für ACME fehlt",
    ) && !is_email(&tls.acme_email)
    {
        out.error(
            "tls.acme_email",
            "invalid_email",
            "Die E-Mail-Adresse ist ungültig (erwartet: name@domain.tld)",
        );
    }

    if !tls.acme_ca_url.is_empty() && url_host(&tls.acme_ca_url, &["https"]).is_none() {
        out.error(
            "tls.acme_ca_url",
            "invalid_url",
            "Die CA-URL muss eine gültige Adresse mit https:// sein",
        );
    }

    if !tls.acme_ca_root.is_empty() && !Path::new(&tls.acme_ca_root).exists() {
        out.error(
            "tls.acme_ca_root",
            "file_not_found",
            format!("Datei {} nicht gefunden", tls.acme_ca_root),
        );
    }

    // Key-ID und HMAC gehören zusammen: eins allein macht die Registrierung ungültig
    let key_id = !tls.acme_eab_key_id.is_empty();
    let hmac = is_set(&secrets.acme_eab_hmac);
    if key_id && !hmac {
        out.error(
            "tls.acme_eab_key_id",
            "acme_eab_incomplete",
            "EAB-Key-ID ist gesetzt, der EAB-HMAC-Schlüssel fehlt",
        );
    } else if hmac && !key_id {
        out.error(
            "tls.acme_eab_key_id",
            "acme_eab_incomplete",
            "Der EAB-HMAC-Schlüssel ist gesetzt, die EAB-Key-ID fehlt",
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Datenbank: SQLite
// ---------------------------------------------------------------------------------------------

const SQLITE_FIELD: &str = "db.path";

/// Ordner direkt unter einem Laufwerk, die dem System gehören: Darin (auch tiefer) nie eine Datenbank.
const SYSTEM_TREES: [&str; 6] = [
    "windows",
    "program files",
    "program files (x86)",
    "$recycle.bin",
    "system volume information",
    "recovery",
];
/// Benutzerprofile (auch `Public` und `Default`): Darin (auch tiefer) nie eine Datenbank des Dienstes.
const PROFILES: &str = "users";
/// Gemeinsame Programmdaten: Die Rechte des Ordners selbst dürfen nie gelockert werden, und
/// `ProgramData\Microsoft` (etwa der Autostart aller Benutzer) gehört Windows; ein eigener
/// Unterordner wie `C:\ProgramData\PDS\pds.db` ist in Ordnung.
const PROGRAM_DATA: &str = "programdata";
const PROGRAM_DATA_WINDOWS: &str = "microsoft";
/// Gerätenamen, die Windows in jedem Ordner kennt (auch mit Endung, `nul.db`).
const RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
const PATH_EXAMPLE: &str = r"D:\PDS\pds.db";

/// Bei SQLite zählt nur der Pfad; leer heißt `data\pds.db` im Datenordner und ist immer gültig.
/// Ein eigener Pfad muss lokal und vollständig sein und darf nicht dort liegen, wo das Dienstkonto
/// nie Ändern bekommen darf (der Ordner der Datei bekommt es beim Speichern, wegen der WAL-Dateien).
fn check_sqlite(out: &mut Findings, config: &Config, paths: &Paths) {
    if !config.db.has_custom_path() {
        return;
    }
    let path = config.db.path.trim();
    if let Err((code, message)) = sqlite_path_problem(path, paths) {
        out.error(SQLITE_FIELD, code, message);
        return;
    }
    // Entscheidend ist, wohin der Pfad tatsächlich führt: Ein Verweis (Junction) in einem Teil davon,
    // ein Kurzname oder ein subst-Laufwerk lenkt ihn sonst unbemerkt etwa nach C:\Windows. Nur unter
    // Windows; das Speichern prüft dasselbe noch einmal über das Handle des Ordners.
    if let Some(real) = platform::resolved_path(Path::new(path)) {
        let real = real.to_string_lossy();
        if normalized(&real) != normalized(path)
            && let Err((code, message)) = sqlite_path_problem(&real, paths)
        {
            out.error(
                SQLITE_FIELD,
                code,
                format!(
                    "{path} führt tatsächlich nach {real} (über einen Verweis, einen Kurznamen oder \
                     ein subst-Laufwerk): {message}"
                ),
            );
            return;
        }
    }
    // Ein verbundenes Laufwerk sieht man dem Buchstaben nicht an
    match platform::drive_kind(Path::new(path)) {
        DriveKind::Remote => out.error(SQLITE_FIELD, "sqlite_network_path", network_message()),
        DriveKind::Missing => out.warning(
            SQLITE_FIELD,
            "sqlite_drive_missing",
            format!(
                "Das Laufwerk {} gibt es auf diesem Rechner nicht – der Dienst kann die Datenbank \
                 dort nicht anlegen",
                &path[..2]
            ),
        ),
        DriveKind::Local | DriveKind::Unknown => {}
    }
    if Path::new(path).is_dir() {
        out.error(
            SQLITE_FIELD,
            "sqlite_path_is_directory",
            format!(
                "{path} ist ein Ordner – bitte den vollständigen Pfad der Datei angeben, z. B. \
                 {path}\\pds.db"
            ),
        );
    }
}

fn network_message() -> String {
    "Die SQLite-Datei darf nicht auf einem Netzlaufwerk liegen (Freigabe \\\\server\\… oder \
     verbundenes Laufwerk): Sperren und WAL funktionieren dort nicht zuverlässig, die Datenbank \
     kann beschädigt werden. Bitte ein lokales Laufwerk verwenden oder SQL Server wählen"
        .to_owned()
}

/// Prüft die Form eines eigenen SQLite-Pfads ohne Dateisystem: Code und Meldung des ersten
/// Problems. Windows-Schreibweise (`X:\…`, `/` geht auch), Vergleiche ohne Groß-/Kleinschreibung.
/// Auch für den aufgelösten Pfad hinter einem Handle (`platform::prepare_sqlite_dir`).
pub(crate) fn sqlite_path_problem(path: &str, paths: &Paths) -> Result<(), (&'static str, String)> {
    let invalid = |message: String| Err(("invalid_path", message));
    let bytes = path.as_bytes();
    let separator = |byte: u8| byte == b'\\' || byte == b'/';

    if bytes.len() >= 2 && separator(bytes[0]) && separator(bytes[1]) {
        let device = path[2..].to_ascii_lowercase().replace('/', "\\");
        let device_prefix = device.starts_with("?\\") || device.starts_with(".\\");
        if device_prefix && !device[2..].starts_with("unc\\") {
            return invalid(format!(
                "Gerätepfade wie {} werden nicht unterstützt – bitte den Pfad mit \
                 Laufwerksbuchstaben angeben, z. B. {PATH_EXAMPLE}",
                &path[..path.len().min(4)]
            ));
        }
        return Err(("sqlite_network_path", network_message()));
    }
    let absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && separator(bytes[2]);
    if !absolute {
        return Err((
            "sqlite_path_not_absolute",
            format!(
                "Der Pfad der SQLite-Datei muss vollständig mit Laufwerksbuchstaben angegeben \
                 werden, z. B. {PATH_EXAMPLE}"
            ),
        ));
    }

    let rest = &path[3..];
    if rest
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return invalid(
            "Der Pfad enthält Zeichen, die Windows in Datei- und Ordnernamen nicht erlaubt \
             (< > : \" | ? * oder Steuerzeichen)"
                .to_owned(),
        );
    }
    if rest.is_empty() || rest.ends_with(['\\', '/']) {
        return invalid(format!(
            "Der Pfad endet ohne Dateinamen – bitte die Datei angeben, z. B. {PATH_EXAMPLE}"
        ));
    }
    // Leere Teile (`\\` mitten im Pfad) übergeht Windows, alle anderen müssen echte Namen sein
    let parts: Vec<&str> = rest
        .split(['\\', '/'])
        .filter(|part| !part.is_empty())
        .collect();
    for part in &parts {
        if *part == "." || *part == ".." {
            return invalid("Der Pfad darf keine Teile . oder .. enthalten".to_owned());
        }
        // Windows schneidet Punkte und Leerzeichen am Ende stillschweigend ab
        if part.ends_with(['.', ' ']) {
            return invalid(format!(
                "„{part}“ endet mit Punkt oder Leerzeichen – das schneidet Windows ab"
            ));
        }
        // Kurznamen (8.3, `PROGRA~1`) verbergen den eigentlichen Ordner; aufgelöst prüft ihn erst das
        // Dateisystem, deshalb hier gar nicht erst zulassen
        if part
            .split('~')
            .skip(1)
            .any(|tail| tail.starts_with(|c: char| c.is_ascii_digit()))
        {
            return invalid(format!(
                "„{part}“ sieht aus wie ein Kurzname (8.3, etwa PROGRA~1) – bitte den vollständigen \
                 Namen angeben"
            ));
        }
        let stem = part.split('.').next().unwrap_or_default().trim_end();
        if RESERVED_NAMES
            .iter()
            .any(|name| stem.eq_ignore_ascii_case(name))
        {
            return invalid(format!(
                "„{part}“ ist ein reservierter Gerätename von Windows"
            ));
        }
    }

    let forbidden = |message: String| Err(("sqlite_path_forbidden", message));
    let [first, .., _file] = parts[..] else {
        return forbidden(format!(
            "Die Datei darf nicht direkt im Stammverzeichnis eines Laufwerks liegen: Das \
             Dienstkonto bekäme sonst Ändern auf dem ganzen Laufwerk. Bitte einen eigenen Ordner \
             verwenden, z. B. {PATH_EXAMPLE}"
        ));
    };
    let candidate = normalized(path);
    let dir_parts = &parts[..parts.len() - 1];
    // Der Standardordner (und darunter) gehört der Datenbank, dort ist alles erlaubt
    if is_inside(&candidate, &normalized_path(&paths.sqlite_dir())) {
        return Ok(());
    }
    if is_inside(&candidate, &normalized_path(&paths.data_dir)) {
        return forbidden(format!(
            "Im Datenordner {} liegen Konfiguration und Schlüssel; eine eigene Datenbank dort nur \
             im Unterordner data\\ (oder das Feld leer lassen für {})",
            paths.data_dir.display(),
            paths.default_sqlite_file().display()
        ));
    }
    if is_inside(&candidate, &normalized_path(&paths.install_dir)) {
        return forbidden(format!(
            "Der Programmordner {} wird bei Update und Deinstallation ersetzt – bitte einen \
             eigenen Ordner verwenden, z. B. {PATH_EXAMPLE}",
            paths.install_dir.display()
        ));
    }
    let top = first.to_ascii_lowercase();
    if SYSTEM_TREES.contains(&top.as_str()) {
        return forbidden(format!(
            "{}{first} ist ein Systemordner – bitte einen eigenen Ordner verwenden, z. B. \
             {PATH_EXAMPLE}",
            &path[..3]
        ));
    }
    let drive = &path[..3];
    if top == PROFILES {
        return forbidden(format!(
            "{drive}{first} enthält die Benutzerprofile (auch Public) – eine Datenbank des Dienstes \
             gehört nicht dorthin. Bitte einen eigenen Ordner verwenden, z. B. {PATH_EXAMPLE}"
        ));
    }
    if top == PROGRAM_DATA {
        if dir_parts.len() == 1 {
            return forbidden(format!(
                "Die Rechte von {drive}{first} dürfen nicht gelockert werden – bitte einen eigenen \
                 Unterordner verwenden, z. B. {drive}{first}\\PDS\\pds.db"
            ));
        }
        if dir_parts[1].eq_ignore_ascii_case(PROGRAM_DATA_WINDOWS) {
            return forbidden(format!(
                "{drive}{first}\\{} gehört Windows (darunter etwa der Autostart aller Benutzer) – \
                 bitte einen eigenen Unterordner verwenden, z. B. {drive}{first}\\PDS\\pds.db",
                dir_parts[1]
            ));
        }
    }
    Ok(())
}

/// Für Vergleiche: `\` als Trenner, klein, ohne Trenner am Ende und ohne doppelte Trenner.
fn normalized(path: &str) -> String {
    let lower = path.to_ascii_lowercase().replace('/', "\\");
    let mut out = String::with_capacity(lower.len());
    for c in lower.chars() {
        if c == '\\' && out.ends_with('\\') {
            continue;
        }
        out.push(c);
    }
    out.trim_end_matches('\\').to_owned()
}

fn normalized_path(path: &Path) -> String {
    normalized(&path.to_string_lossy())
}

/// Liegt `candidate` in `base` oder ist es `base`? Ein leerer Ordner enthält nichts.
fn is_inside(candidate: &str, base: &str) -> bool {
    !base.is_empty()
        && (candidate == base
            || candidate
                .strip_prefix(base)
                .is_some_and(|rest| rest.starts_with('\\')))
}

// ---------------------------------------------------------------------------------------------
// Datenbank: SQL Server
// ---------------------------------------------------------------------------------------------

fn check_database(out: &mut Findings, config: &Config, secrets: &Secrets) {
    let db = &config.db;
    if out.require("db.server", &db.server, "Datenbankserver fehlt") {
        check_db_server(out, &db.server);
    }
    check_identifier(out, "db.database", &db.database, "Datenbankname");
    check_not_system_database(out, &db.database);
    check_identifier(out, "db.user", &db.user, "Datenbankbenutzer");
    if !is_set(&secrets.db_password) {
        out.error(
            SecretField::DbPassword.path(),
            "required",
            "Datenbankpasswort fehlt",
        );
    }
}

/// Der Server landet unkodiert in `NUXT_DATABASE_URL`: Nur ein Hostname oder eine IPv4-Adresse
/// ergibt eine URL, die `new URL` in der App so liest, wie sie gemeint ist (ein `@` würde den Host
/// umdeuten, ein Leerzeichen oder `\` die URL ablehnen und die App am Start scheitern lassen).
fn check_db_server(out: &mut Findings, server: &str) {
    if server.contains('\\') {
        out.error(
            "db.server",
            "named_instance_not_supported",
            "Benannte Instanzen bitte über ihren festen TCP-Port angeben \
             (nur den Servernamen eintragen, Port unter db.port)",
        );
        return;
    }
    // Auch in Klammern: Die App reicht `url.hostname` samt Klammern an den Treiber, der das
    // nicht auflösen kann
    let bare = server
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(server);
    if bare.parse::<Ipv6Addr>().is_ok() {
        out.error(
            "db.server",
            "ipv6_not_supported",
            "IPv6-Adressen werden für den Datenbankserver nicht unterstützt – bitte den \
             Hostnamen oder eine IPv4-Adresse eintragen",
        );
    } else if !is_db_server(server) {
        out.error(
            "db.server",
            "invalid_hostname",
            "Der Datenbankserver ist ungültig: erlaubt sind Buchstaben, Ziffern, Bindestriche, \
             Unterstriche und Punkte oder eine IPv4-Adresse, ohne Port und ohne Instanznamen",
        );
    }
}

/// `]` und `'` lassen sich im Setup-T-SQL nicht sicher quoten (wie `init.sh`), deshalb abgelehnt.
fn check_identifier(out: &mut Findings, field: &str, value: &str, label: &str) {
    if out.require(field, value, &format!("{label} fehlt")) && value.contains([']', '\'']) {
        out.error(
            field,
            "invalid_identifier",
            format!("{label} darf weder ] noch ' enthalten"),
        );
    }
}

/// Systemdatenbanken von SQL Server. Die Einrichtung schaltet dort `READ_COMMITTED_SNAPSHOT` ein und
/// trägt einen `db_owner` ein: In `model` erbte das jede künftige Datenbank, `master` und `msdb`
/// gehören dem Server.
const SYSTEM_DATABASES: [&str; 4] = ["master", "model", "msdb", "tempdb"];

/// SQL Server vergleicht Namen ohne Groß-/Kleinschreibung und ohne Leerzeichen am Ende. Ein leerer
/// oder ungültiger Name hat schon `check_identifier` gemeldet.
fn check_not_system_database(out: &mut Findings, database: &str) {
    let name = database.trim();
    if SYSTEM_DATABASES
        .iter()
        .any(|system| name.eq_ignore_ascii_case(system))
    {
        out.error(
            "db.database",
            "system_database_not_allowed",
            "Der Datenbankname darf keine SQL-Server-Systemdatenbank sein (master, model, msdb, \
             tempdb) – bitte eine eigene Datenbank für den EPLAN Panel Data Service verwenden",
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Anmeldung (OIDC)
// ---------------------------------------------------------------------------------------------

fn check_oidc(out: &mut Findings, config: &Config, secrets: &Secrets) {
    let oidc = &config.oidc;
    // Im Modus mit eigenem Issuer bleibt `tenant_id` ungenutzt und wird nicht geprüft.
    let tenant_mode = oidc.tenant_mode();

    if tenant_mode {
        if out.require(
            "oidc.tenant_id",
            &oidc.tenant_id,
            "Tenant-ID fehlt (oder einen eigenen Issuer angeben)",
        ) && !is_guid(&oidc.tenant_id)
        {
            out.error(
                "oidc.tenant_id",
                "invalid_guid",
                "Die Tenant-ID muss eine GUID sein (z. B. 11111111-2222-3333-4444-555555555555)",
            );
        }
    } else if !is_valid_issuer(&oidc.issuer) {
        out.error(
            "oidc.issuer",
            "invalid_url",
            "Der Issuer muss eine gültige Adresse mit https:// sein (http:// nur für localhost)",
        );
    }

    if out.require("oidc.client_id", &oidc.client_id, "Client-ID fehlt")
        && tenant_mode
        && !is_guid(&oidc.client_id)
    {
        out.error(
            "oidc.client_id",
            "invalid_guid",
            "Die Client-ID muss eine GUID sein (z. B. 11111111-2222-3333-4444-555555555555)",
        );
    }

    if !is_set(&secrets.oidc_client_secret) {
        out.warning(
            SecretField::OidcClientSecret.path(),
            "oidc_client_secret_missing",
            "Das Client-Secret fehlt, die Anmeldung schlägt ohne es meist fehl",
        );
    }
}

fn is_valid_issuer(issuer: &str) -> bool {
    if url_host(issuer, &["https"]).is_some() {
        return true;
    }
    // Lokale Entwicklung gegen einen Identity-Provider auf dem eigenen Rechner
    url_host(issuer, &["http"]).is_some_and(|host| host.eq_ignore_ascii_case("localhost"))
}

// ---------------------------------------------------------------------------------------------
// Proxy und App
// ---------------------------------------------------------------------------------------------

fn check_proxy(out: &mut Findings, config: &Config) {
    let url = &config.proxy.url;
    if url.is_empty() {
        return;
    }
    if url_host(url, &["http", "https"]).is_none() {
        out.error(
            "proxy.url",
            "invalid_url",
            "Die Proxy-Adresse muss eine gültige Adresse mit http:// oder https:// sein",
        );
    } else if has_userinfo(url) {
        // Die Adresse stünde unverschlüsselt in `config.toml` und in der Umgebung der Kindprozesse
        out.error(
            "proxy.url",
            "proxy_credentials_not_supported",
            "Zugangsdaten in der Proxy-Adresse werden nicht unterstützt – sie stünden im \
             Klartext in der Konfiguration",
        );
    }
}

fn check_app_secret(out: &mut Findings, secrets: &Secrets) {
    let field = SecretField::AppSecret.path();
    match &secrets.app_secret {
        Some(secret) if !secret.is_empty() => {
            // Zeichen statt Bytes, damit Umlaute nicht doppelt zählen
            if secret.expose().chars().count() < APP_SECRET_MIN_CHARS {
                out.error(
                    field,
                    "app_secret_too_short",
                    format!(
                        "Das App-Secret muss mindestens {APP_SECRET_MIN_CHARS} Zeichen lang sein"
                    ),
                );
            }
        }
        _ => out.error(field, "app_secret_missing", "Das App-Secret fehlt"),
    }
}

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

/// Ein leeres Secret zählt wie ein fehlendes.
fn is_set(secret: &Option<Secret>) -> bool {
    secret.as_ref().is_some_and(|secret| !secret.is_empty())
}

/// `TT.MM.JJJJ` in UTC, wie Zertifikate ihre Zeiten angeben.
fn german_date(at: OffsetDateTime) -> String {
    let date = at.to_offset(UtcOffset::UTC).date();
    format!(
        "{:02}.{:02}.{:04}",
        date.day(),
        u8::from(date.month()),
        date.year()
    )
}

/// RFC 1123: Labels aus `A–Z a–z 0–9 -`, nicht mit `-` an Anfang oder Ende; oder eine IP-Adresse.
fn is_host(host: &str) -> bool {
    host.parse::<IpAddr>().is_ok() || is_hostname(host, false)
}

/// Datenbankserver: wie [`is_host`], aber mit `_` in den Labels (NetBIOS-artige Namen wie
/// `SQL_PROD` sind bei Firmenservern üblich) und ohne IPv6 (siehe [`check_db_server`]).
fn is_db_server(server: &str) -> bool {
    match server.parse::<IpAddr>() {
        Ok(address) => address.is_ipv4(),
        Err(_) => is_hostname(server, true),
    }
}

fn is_hostname(host: &str, allow_underscore: bool) -> bool {
    if host.is_empty() || host.len() > MAX_HOSTNAME_LEN {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    // Eine rein numerische Endung wäre ein misslungenes IP-Literal (`999.1.1.1`), kein Name
    let numeric_tail = labels
        .last()
        .is_some_and(|label| label.bytes().all(|b| b.is_ascii_digit()));
    !numeric_tail && labels.iter().all(|label| is_label(label, allow_underscore))
}

fn is_label(label: &str, allow_underscore: bool) -> bool {
    !label.is_empty()
        && label.len() <= MAX_LABEL_LEN
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || (allow_underscore && b == b'_'))
}

/// Minimal: `local@domain`, in der Domain ein Punkt und keine leeren Labels, keine Leerzeichen.
fn is_email(value: &str) -> bool {
    if value.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.contains('@')
        && domain.split('.').all(|label| !label.is_empty())
}

/// 8-4-4-4-12 Hexziffern mit Bindestrichen, Groß-/Kleinschreibung egal.
fn is_guid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == GUID_GROUP_LENS.len()
        && groups
            .iter()
            .zip(GUID_GROUP_LENS)
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Der Teil zwischen `://` und dem ersten `/`, `?` oder `#`.
fn authority(value: &str) -> Option<&str> {
    let (_, rest) = value.split_once("://")?;
    Some(&rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())])
}

/// Steht vor dem Host ein Benutzername (`user[:pass]@`)? Ein leerer Teil vor dem `@` zählt nicht.
fn has_userinfo(value: &str) -> bool {
    authority(value)
        .and_then(|authority| authority.rsplit_once('@'))
        .is_some_and(|(userinfo, _)| !userinfo.is_empty())
}

/// Host einer URL mit einem der erlaubten Schemas, `None` bei allem, was keine brauchbare Adresse
/// ist. Bewusst klein gehalten: Schema, optionale Zugangsdaten, Host oder `[IPv6]`, optionaler
/// Port; der Rest (Pfad, Query) bleibt ungeprüft. Das Schema muss klein geschrieben sein, weil der
/// Wert unverändert an Caddy und Node geht.
fn url_host<'a>(value: &'a str, schemes: &[&str]) -> Option<&'a str> {
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (scheme, _) = value.split_once("://")?;
    if !schemes.contains(&scheme) {
        return None;
    }
    let authority = authority(value)?;
    // Zugangsdaten stehen vor dem letzten `@`
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host_port)| host_port);

    let (host, port) = match host_port.strip_prefix('[') {
        Some(inner) => {
            let (host, tail) = inner.split_once(']')?;
            host.parse::<Ipv6Addr>().ok()?;
            let port = match tail {
                "" => None,
                _ => Some(tail.strip_prefix(':')?),
            };
            (host, port)
        }
        None => {
            let (host, port) = match host_port.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (host_port, None),
            };
            // Ein weiterer Doppelpunkt wäre eine IPv6-Adresse ohne Klammern
            if host.is_empty() || host.contains(':') {
                return None;
            }
            (host, port)
        }
    };
    if let Some(port) = port
        && !port.parse::<u16>().is_ok_and(|port| port != 0)
    {
        return None;
    }
    Some(host)
}
