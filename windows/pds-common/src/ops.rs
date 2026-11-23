//! Abläufe, die CLI, Dienst und Konfigurations-UI gleich ausführen: Konfiguration samt Zertifikat
//! laden und prüfen, speichern (samt Ordner der SQLite-Datenbank), Secrets erzeugen, Zertifikat
//! importieren, den Dienst neu starten und abwarten, die Prüfungen und die Sicherung des
//! Node-Werkzeugs, Statusbericht zusammenstellen.

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::OffsetDateTime;
use ts_rs::TS;
use zeroize::Zeroizing;

use crate::config::{self, Config, ConfigError, DbKind, SecretField, Secrets, TlsMode};
use crate::health::{self, ProbeResult};
use crate::names::{FIREWALL_RULE_NAME, SERVICE_ACCOUNT};
use crate::paths::Paths;
use crate::platform::{self, PlatformError, ScmInfo, SqliteDirOutcome};
use crate::protect::Protector;
use crate::render;
use crate::secret::Secret;
use crate::status::{self, ServiceState, Status};
use crate::tls::{self, CertInfo, TlsError};
use crate::tools::{self, ToolCommand, ToolError, ToolResult};
use crate::validate::{self, Finding, Severity, ValidationInput};

/// Zufallsbytes des App-Secrets: base64url ohne Padding ergibt genau 64 Zeichen.
const APP_SECRET_BYTES: usize = 48;
/// Länge des erzeugten Datenbankpassworts.
const DB_PASSWORD_LEN: usize = 32;
const ALPHANUMERIC: &[u8; 62] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/// So lange darf das Stoppen des Dienstes dauern: Node bekommt bis zu 15 s für laufende Anfragen.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(60);
/// So lange wartet [`apply`] standardmäßig darauf, dass der Dienst nach dem Neustart bereit ist.
pub const APPLY_TIMEOUT: Duration = Duration::from_secs(90);
/// Abstand der Statusabfragen beim Warten.
const WAIT_POLL: Duration = Duration::from_secs(1);
/// So viele Befunde nennt die Meldung zu `unconfigured`; alle zeigen `config validate` und die UI.
const MAX_LISTED_FINDINGS: usize = 5;
/// Wartezeit je Health-Abfrage im Statusbericht.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Error)]
pub enum OpsError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Tls(#[from] TlsError),
    #[error(transparent)]
    Platform(#[from] PlatformError),
    #[error(transparent)]
    Tool(#[from] ToolError),
    /// Eine Prüfung lehnt die Eingabe ab (etwa ein Zertifikat für einen anderen Hostnamen); es
    /// wurde nichts gespeichert.
    #[error("Abgelehnt: {}", rejected_text(.0))]
    Rejected(Vec<Finding>),
    /// Unter Windows legt nur `setup install` den Datenordner an (mit eigener ACL). Wer ihn sonst
    /// anlegt, erbt die schwachen Rechte von `%ProgramData%`.
    #[error(
        "Datenordner fehlt – bitte die Installation reparieren (msiexec /fa …) oder \
         `pds setup install` als Administrator ausführen"
    )]
    DataDirMissing,
    #[error("Dateisystemfehler: {0}")]
    Io(String),
    /// Einrichtung und SQL-Skript braucht nur SQL Server; `0` nennt die Aktion.
    #[error(
        "{0} gilt nur für SQL Server (db.kind = sqlserver). Mit SQLite ist nichts einzurichten: Die \
         Anwendung legt die Datenbankdatei beim ersten Start selbst an."
    )]
    SqlServerOnly(&'static str),
    #[error(
        "Die Sicherung gilt nur für SQLite (db.kind = sqlite). Eine SQL-Server-Datenbank sichert \
         die Datenbankverwaltung, z. B. mit BACKUP DATABASE."
    )]
    SqliteOnly,
}

impl OpsError {
    /// Stabiler Code für UI und CLI.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Config(error) => error.code(),
            Self::Tls(error) => error.code(),
            Self::Platform(error) => error.code(),
            Self::Tool(error) => error.code(),
            Self::Rejected(_) => "rejected",
            Self::DataDirMissing => "data_dir_missing",
            Self::Io(_) => "io_error",
            Self::SqlServerOnly(_) => "sqlserver_only",
            Self::SqliteOnly => "sqlite_only",
        }
    }
}

fn rejected_text(findings: &[Finding]) -> String {
    findings
        .iter()
        .map(|finding| finding.message.as_str())
        .collect::<Vec<_>>()
        .join("; ")
}

// ---------------------------------------------------------------------------------------------
// Laden und Prüfen
// ---------------------------------------------------------------------------------------------

/// Konfiguration mit geöffneten Secrets und dem gespeicherten Zertifikat.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub config: Config,
    pub secrets: Secrets,
    pub certificate: Option<CertInfo>,
    /// Passt der gespeicherte Schlüssel zum Zertifikat? `None` = nicht geprüft.
    pub key_matches: Option<bool>,
}

/// Lädt Konfiguration, Secrets und Zertifikat.
///
/// Zertifikat und Schlüssel zählen nur im Modus `certificate`: Dort ist eine unlesbare Ablage ein
/// Fehler, sonst wird sie übergangen (die Dateien werden dann nicht gebraucht).
pub fn load(paths: &Paths, protector: &dyn Protector) -> Result<Loaded, OpsError> {
    let config = config::load(&paths.config_file())?;
    let secrets = config.open_secrets(protector)?;
    let uses_certificate = config.tls.mode == TlsMode::Certificate;

    let certificate = match tls::load_info(paths) {
        Ok(info) => info,
        Err(error) if uses_certificate => return Err(error.into()),
        Err(_) => None,
    };
    let key_matches = match &certificate {
        Some(_) if uses_certificate => {
            let material = tls::load(paths, protector)?.ok_or(TlsError::NoPrivateKey)?;
            Some(tls::key_matches(&material)?)
        }
        _ => None,
    };
    Ok(Loaded {
        config,
        secrets,
        certificate,
        key_matches,
    })
}

/// Befunde der Validierung für eine geladene Konfiguration.
pub fn findings(paths: &Paths, loaded: &Loaded, now: OffsetDateTime) -> Vec<Finding> {
    validate::validate(&ValidationInput {
        config: &loaded.config,
        secrets: &loaded.secrets,
        certificate: loaded.certificate.as_ref(),
        certificate_key_matches: loaded.key_matches,
        now,
        paths,
    })
}

/// Befund für eine Konfiguration, die sich nicht laden lässt (Syntaxfehler, unbekanntes Feld,
/// andere Schema-Version, Klartext-Secret, nicht entschlüsselbares Secret).
pub fn unreadable_finding(error: &ConfigError) -> Finding {
    Finding {
        field: "config".to_owned(),
        code: "config_unreadable".to_owned(),
        message: error.to_string(),
        severity: Severity::Error,
    }
}

/// Befund für einen Fehler von [`load`]: Konfigurationsfehler werden `config_unreadable`, Fehler
/// der Zertifikatsablage stehen am Feld `tls` mit ihrem eigenen Code.
pub fn load_error_finding(error: &OpsError) -> Finding {
    match error {
        OpsError::Config(error) => unreadable_finding(error),
        OpsError::Tls(error) => Finding {
            field: "tls".to_owned(),
            code: error.code().to_owned(),
            message: error.to_string(),
            severity: Severity::Error,
        },
        other => Finding {
            field: "config".to_owned(),
            code: other.code().to_owned(),
            message: other.to_string(),
            severity: Severity::Error,
        },
    }
}

/// Ergebnis von [`check`].
#[derive(Debug, Clone)]
pub struct Checked {
    /// `None`, wenn sich die Konfiguration nicht laden ließ; dann erklärt der einzige Befund warum.
    pub loaded: Option<Loaded>,
    pub findings: Vec<Finding>,
}

/// Lädt und prüft in einem Schritt. Scheitert das Laden, gibt es genau einen Befund statt eines
/// Fehlers, damit Dienst, CLI und UI das wie jeden anderen Befund zeigen.
pub fn check(paths: &Paths, protector: &dyn Protector, now: OffsetDateTime) -> Checked {
    match load(paths, protector) {
        Ok(loaded) => {
            let findings = findings(paths, &loaded, now);
            Checked {
                loaded: Some(loaded),
                findings,
            }
        }
        Err(error) => Checked {
            loaded: None,
            findings: vec![load_error_finding(&error)],
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Datenordner und App-Secret
// ---------------------------------------------------------------------------------------------

/// Stellt sicher, dass der Datenordner da ist, bevor etwas hineingeschrieben wird. Unter Windows
/// wird er nie hier angelegt (sonst mit den geerbten Rechten von `%ProgramData%`), sondern nur von
/// `setup install`.
pub fn require_data_dir(paths: &Paths) -> Result<(), OpsError> {
    require_dir(&paths.data_dir, cfg!(not(windows)))
}

fn require_dir(dir: &Path, create: bool) -> Result<(), OpsError> {
    if create {
        fs::create_dir_all(dir).map_err(|error| OpsError::Io(format!("{}: {error}", dir.display())))
    } else if dir.is_dir() {
        Ok(())
    } else {
        Err(OpsError::DataDirMissing)
    }
}

/// Neues App-Secret: 48 Zufallsbytes aus der Zufallsquelle des Systems, base64url ohne Padding.
pub fn generate_app_secret() -> Secret {
    let mut bytes = Zeroizing::new([0u8; APP_SECRET_BYTES]);
    getrandom::fill(bytes.as_mut()).expect("Zufallsquelle des Systems nicht verfügbar");
    Secret::new(URL_SAFE_NO_PAD.encode(bytes.as_ref()))
}

/// Erzeugt das App-Secret, wenn keins gesetzt ist. `true` = neu erzeugt. Eine unlesbare
/// Konfiguration bleibt unangetastet (Fehler), damit nichts überschrieben wird.
pub fn ensure_app_secret(paths: &Paths, protector: &dyn Protector) -> Result<bool, OpsError> {
    require_data_dir(paths)?;
    let mut config = config::load(&paths.config_file())?;
    if !config.sealed(SecretField::AppSecret).is_empty() {
        return Ok(false);
    }
    config.seal(
        SecretField::AppSecret,
        Some(&generate_app_secret()),
        protector,
    )?;
    config::save(&paths.config_file(), &config)?;
    Ok(true)
}

/// Ersetzt das App-Secret. Danach sind alle Sitzungen und MCP-Verbindungen ungültig, und die App kann
/// die damit verschlüsselten Passwörter der Controller-Einstellungen nicht mehr lesen.
pub fn regenerate_app_secret(paths: &Paths, protector: &dyn Protector) -> Result<(), OpsError> {
    require_data_dir(paths)?;
    let mut config = config::load(&paths.config_file())?;
    config.seal(
        SecretField::AppSecret,
        Some(&generate_app_secret()),
        protector,
    )?;
    config::save(&paths.config_file(), &config)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Datenbankpasswort
// ---------------------------------------------------------------------------------------------

/// Gleichverteilte Zahl in `0..limit` (`limit` ≤ 256) aus der Zufallsquelle des Systems. Bytes
/// oberhalb des größten Vielfachen von `limit` werden verworfen, sonst wären kleine Werte häufiger.
fn random_below(limit: usize) -> usize {
    debug_assert!((1..=256).contains(&limit));
    let zone = 256 - 256 % limit;
    loop {
        let mut byte = [0u8; 1];
        getrandom::fill(&mut byte).expect("Zufallsquelle des Systems nicht verfügbar");
        if usize::from(byte[0]) < zone {
            return usize::from(byte[0]) % limit;
        }
    }
}

/// Neues Datenbankpasswort für die Einrichtung: 32 Zeichen, davon 31 aus `[A-Za-z0-9]` mit
/// mindestens je einem Groß-, Kleinbuchstaben und einer Ziffer, dazu ein `-` an zufälliger Stelle
/// im Inneren. So erfüllt es die Kennwortrichtlinie von SQL Server und bleibt in URL, T-SQL und
/// sqlcmd ohne Maskierung lesbar.
pub fn generate_db_password() -> Secret {
    loop {
        // Volle Länge von Anfang an: Ein Umkopieren beim Wachsen ließe Reste im Speicher zurück
        let mut chars: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(DB_PASSWORD_LEN));
        chars.extend(
            (0..DB_PASSWORD_LEN - 1).map(|_| ALPHANUMERIC[random_below(ALPHANUMERIC.len())]),
        );
        let has = |class: fn(&u8) -> bool| chars.iter().any(class);
        if !(has(u8::is_ascii_uppercase) && has(u8::is_ascii_lowercase) && has(u8::is_ascii_digit))
        {
            continue;
        }
        // Nie am Rand: Ein führendes `-` läse eine Befehlszeile als Option
        let at = 1 + random_below(chars.len() - 1);
        chars.insert(at, b'-');
        let text = std::str::from_utf8(&chars).expect("nur ASCII");
        return Secret::new(text);
    }
}

/// Erzeugt das Datenbankpasswort, wenn keins gesetzt ist, und speichert es versiegelt. `true` =
/// neu erzeugt. Eine unlesbare Konfiguration bleibt unangetastet (Fehler).
pub fn ensure_db_password(paths: &Paths, protector: &dyn Protector) -> Result<bool, OpsError> {
    require_data_dir(paths)?;
    let mut config = config::load(&paths.config_file())?;
    if !config.sealed(SecretField::DbPassword).is_empty() {
        return Ok(false);
    }
    config.seal(
        SecretField::DbPassword,
        Some(&generate_db_password()),
        protector,
    )?;
    config::save(&paths.config_file(), &config)?;
    Ok(true)
}

// ---------------------------------------------------------------------------------------------
// Konfiguration speichern
// ---------------------------------------------------------------------------------------------

/// Ports der Firewall-Regel: HTTP und der öffentliche HTTPS-Port; bei `off` lauscht Caddy nur auf
/// `listen.http_port`.
pub fn firewall_ports(config: &Config) -> Vec<u16> {
    let mut ports = vec![config.listen.http_port];
    if config.tls.mode != TlsMode::Off {
        ports.push(config.public.port);
    }
    ports.dedup();
    ports
}

/// Legt die Firewall-Regel über `ensure_rule` an und liefert die Ports. Ein Fehler ist nur eine
/// Warnung (Text im `Err`): Auf Servern mit abgeschaltetem oder per GPO verwaltetem Firewall-Dienst
/// muss die Installation (und jedes Speichern) trotzdem gelingen; die Ports gibt dann der Admin
/// frei.
pub fn firewall_step(
    config: &Config,
    caddy_exe: &Path,
    ensure_rule: impl FnOnce(&Path, &[u16]) -> Result<(), PlatformError>,
) -> Result<Vec<u16>, String> {
    let ports = firewall_ports(config);
    ensure_rule(caddy_exe, &ports).map_err(|error| {
        let list = ports
            .iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "Firewall-Regel „{FIREWALL_RULE_NAME}“ konnte nicht angelegt werden: {error} – bitte \
             Ports {list} von Hand freigeben"
        )
    })?;
    Ok(ports)
}

/// Ergebnis von [`save_config`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveOutcome {
    /// Gespeichert, aber mit Einschränkung (etwa: Firewall-Regel nicht angelegt). Deutsch, für
    /// Admins.
    pub warnings: Vec<String>,
}

/// Bereitet bei SQLite den Ordner der Datenbank für das Dienstkonto vor (über `prepare`, sonst
/// [`platform::prepare_sqlite_dir`]): Ordner anlegen bzw. Ändern gewähren. Nichts bei SQL Server und
/// nichts, solange der Pfad Fehler hat (die meldet die Validierung; ein Laufwerksstamm oder
/// Systemordner bekäme so nie gelockerte Rechte). Wie bei der Firewall ist ein Fehler nur eine
/// Warnung (Text im `Err`).
pub fn sqlite_dir_step(
    config: &Config,
    paths: &Paths,
    prepare: impl FnOnce(&Paths, &Path) -> Result<SqliteDirOutcome, PlatformError>,
) -> Result<SqliteDirOutcome, String> {
    if config.db.kind != DbKind::Sqlite
        || validate::has_errors(&validate::sqlite_findings(config, paths))
    {
        return Ok(SqliteDirOutcome::default());
    }
    let file = config.db.sqlite_file(paths);
    prepare(paths, &file).map_err(|error| {
        format!(
            "Rechte für die SQLite-Datenbank {} nicht gesetzt: {error} – das Dienstkonto \
             {SERVICE_ACCOUNT} braucht auf ihrem Ordner das Recht „Ändern“ (auch auf vorhandenen \
             Datenbankdateien)",
            file.display()
        )
    })
}

/// Speichert die Konfiguration und gleicht unter Windows die Firewall-Regel mit deren Ports ab,
/// damit eine Portänderung nicht an der Firewall scheitert. Die Regel gehört dem Programm, nicht dem
/// MSI. Bei SQLite bekommt der Ordner der Datenbank seine Rechte ([`sqlite_dir_step`]), damit ein
/// eigener Pfad gleich nach dem Neustart funktioniert. Ein Fehler dabei ist eine Warnung, kein
/// Fehler: Die Konfiguration ist dann gespeichert. Ohne `caddy.exe` im Installationsordner
/// (Entwicklung, Tests) ist nichts installiert: keine Regel, kein Dienstkonto, also beides unberührt.
pub fn save_config(paths: &Paths, config: &Config) -> Result<SaveOutcome, OpsError> {
    require_data_dir(paths)?;
    config::save(&paths.config_file(), config)?;

    #[cfg(windows)]
    let warnings: Vec<String> = if paths.caddy_exe().is_file() {
        let firewall = firewall_step(config, &paths.caddy_exe(), platform::firewall::ensure_rule);
        let sqlite = sqlite_dir_step(config, paths, platform::prepare_sqlite_dir);
        firewall.err().into_iter().chain(sqlite.err()).collect()
    } else {
        Vec::new()
    };
    #[cfg(not(windows))]
    let warnings = Vec::new();
    Ok(SaveOutcome { warnings })
}

// ---------------------------------------------------------------------------------------------
// TLS-Zertifikat importieren
// ---------------------------------------------------------------------------------------------

/// Woher ein Zertifikat samt Schlüssel kommt.
#[derive(Debug)]
pub enum TlsSource {
    /// PFX-Datei (Inhalt) mit ihrem Passwort.
    Pfx { bytes: Vec<u8>, password: Secret },
    /// Kette und PKCS#8-, PKCS#1- oder SEC1-Schlüssel als PEM-Text.
    Pem { cert: String, key: Secret },
    /// Zertifikat mit exportierbarem Schlüssel im Speicher `LocalMachine\My` (nur Windows).
    Store { thumbprint: String },
}

/// Befunde zum Zertifikat: Ablauf (Fehler, bzw. Warnung ab 30 Tagen davor), Hostname (nur wenn
/// `public.host` gesetzt ist) und Schlüssel (wenn `key_matches` bekannt ist). Es sind die der
/// Konfigurationsprüfung ([`validate::validate`]), auch wenn der TLS-Modus ein anderer ist: Wer ein
/// Zertifikat importiert, will wissen, ob es taugt.
pub fn certificate_findings(
    config: &Config,
    paths: &Paths,
    certificate: &CertInfo,
    key_matches: Option<bool>,
    now: OffsetDateTime,
) -> Vec<Finding> {
    let mut config = config.clone();
    config.tls.mode = TlsMode::Certificate;
    validate::validate(&ValidationInput {
        config: &config,
        secrets: &Secrets::default(),
        certificate: Some(certificate),
        certificate_key_matches: key_matches,
        now,
        paths,
    })
    .into_iter()
    .filter(|finding| finding.code.starts_with("certificate_"))
    .collect()
}

/// Liest Zertifikat und Schlüssel aus `source`, prüft sie und speichert sie (Kette offen, Schlüssel
/// versiegelt). Abgelehnt wird mit [`OpsError::Rejected`] bei Ablauf, bei einem Hostnamen, den das
/// Zertifikat nicht abdeckt (wenn `public.host` gesetzt ist), und bei einem Schlüssel, der nicht
/// dazu passt; dann bleibt die vorhandene Ablage unverändert. Die Ports ändern sich nicht, also
/// bleibt die Firewall-Regel. Wirksam wird das Zertifikat mit dem nächsten Start des Dienstes.
pub fn import_tls(
    paths: &Paths,
    config: &Config,
    source: TlsSource,
    protector: &dyn Protector,
    now: OffsetDateTime,
) -> Result<CertInfo, OpsError> {
    require_data_dir(paths)?;
    let material = match source {
        TlsSource::Pfx { bytes, password } => tls::from_pfx(&bytes, &password),
        TlsSource::Pem { cert, key } => tls::from_pem(&cert, &key),
        TlsSource::Store { thumbprint } => {
            return finish_import(
                paths,
                config,
                platform::cert_store::export(&thumbprint)?,
                protector,
                now,
            );
        }
    }
    .map_err(rejection_of)?;
    finish_import(paths, config, material, protector, now)
}

fn finish_import(
    paths: &Paths,
    config: &Config,
    material: tls::TlsMaterial,
    protector: &dyn Protector,
    now: OffsetDateTime,
) -> Result<CertInfo, OpsError> {
    let info = tls::inspect(&material.chain_pem)?;
    let key_matches = tls::key_matches(&material).map_err(rejection_of)?;
    let errors: Vec<Finding> = certificate_findings(config, paths, &info, Some(key_matches), now)
        .into_iter()
        .filter(|finding| finding.severity == Severity::Error)
        .collect();
    if !errors.is_empty() {
        return Err(OpsError::Rejected(errors));
    }
    tls::save(paths, &material, protector)?;
    Ok(info)
}

/// Ein Schlüssel, der nicht zum Zertifikat gehört, ist eine Ablehnung wie jede andere, kein
/// technischer Fehler.
fn rejection_of(error: TlsError) -> OpsError {
    match error {
        TlsError::KeyMismatch => OpsError::Rejected(vec![validate::key_mismatch_finding()]),
        other => other.into(),
    }
}

// ---------------------------------------------------------------------------------------------
// Dienst neu starten und abwarten
// ---------------------------------------------------------------------------------------------

/// Ergebnis von [`apply`] und [`wait_for_running`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApplyOutcome {
    /// Der Dienst läuft, und die Anwendung antwortet.
    pub ok: bool,
    /// Letzter Zustand aus einem Status, der nach dem Neustart entstand; `None`, wenn es keinen gab.
    pub state: Option<ServiceState>,
    /// Deutsche Meldung für Admins: bei Erfolg eine Bestätigung, sonst der Grund (Meldung der App,
    /// Befunde der Konfiguration, letzte Meldung beim Zeitablauf).
    pub message: String,
    // JSON trägt eine Zahl; ts-rs machte aus `u64` sonst `bigint`
    #[ts(type = "number")]
    pub waited_seconds: u64,
}

/// Startet den Dienst neu (stoppen, starten) und wartet höchstens `timeout`, bis er läuft und die
/// Anwendung antwortet. Eine Änderung der Konfiguration oder des Zertifikats wirkt erst so. Ohne
/// Windows: [`PlatformError::Unsupported`].
pub fn apply(paths: &Paths, timeout: Duration) -> Result<ApplyOutcome, OpsError> {
    // Vor dem Neustart festhalten: Alles, was der Dienst davor geschrieben hat, ist veraltet
    let requested = OffsetDateTime::now_utc();
    platform::scm::restart(STOP_TIMEOUT)?;
    Ok(wait_for_running(paths, requested, timeout))
}

/// Wartet auf `status.json`, bis der Dienst `running` mit gesunder Anwendung meldet (ok) oder
/// `config_error` bzw. `unconfigured` (nicht ok, mit Grund), höchstens `timeout`. Nur ein Status
/// zählt, dessen Zustand nach `requested` begann: Der Status von vor dem Neustart zeigt oft noch
/// `running`, obwohl der Dienst gerade stoppt oder abgestürzt ist.
pub fn wait_for_running(
    paths: &Paths,
    requested: OffsetDateTime,
    timeout: Duration,
) -> ApplyOutcome {
    wait_for_running_every(paths, requested, timeout, WAIT_POLL)
}

/// Wie [`wait_for_running`] mit eigenem Abfrageabstand (für Tests).
#[doc(hidden)]
pub fn wait_for_running_every(
    paths: &Paths,
    requested: OffsetDateTime,
    timeout: Duration,
    interval: Duration,
) -> ApplyOutcome {
    let started = Instant::now();
    loop {
        let now = OffsetDateTime::now_utc();
        let seen = status::read(&paths.status_file()).ok().flatten();
        if let Some(status) = seen.as_ref().filter(|status| status.since > requested)
            && let Some(outcome) = verdict(status, now, started.elapsed())
        {
            return outcome;
        }
        // Ohne `Instant + timeout`: Eine sehr große Wartezeit darf nicht überlaufen
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return timed_out(seen.as_ref(), requested, now, started.elapsed());
        }
        thread::sleep(interval.min(remaining));
    }
}

/// Endgültig? `Some` bei `running` mit Health, bei `config_error` und bei `unconfigured`.
fn verdict(status: &Status, now: OffsetDateTime, waited: Duration) -> Option<ApplyOutcome> {
    let outcome = |ok: bool, message: String| ApplyOutcome {
        ok,
        state: Some(status.state),
        message,
        waited_seconds: waited.as_secs(),
    };
    match status.state {
        ServiceState::Running
            if status.health.as_ref().is_some_and(|health| health.ok)
                && !status::is_stale(status, now) =>
        {
            Some(outcome(
                true,
                "Der Dienst läuft, die Anwendung ist bereit.".to_owned(),
            ))
        }
        ServiceState::ConfigError => {
            let reason = status
                .last_error
                .as_ref()
                .map(|error| error.message.as_str())
                .filter(|message| !message.is_empty());
            Some(outcome(
                false,
                match reason {
                    Some(reason) => format!("Die Anwendung lehnt ihre Konfiguration ab: {reason}"),
                    None => "Die Anwendung lehnt ihre Konfiguration ab.".to_owned(),
                },
            ))
        }
        ServiceState::Unconfigured => Some(outcome(
            false,
            format!(
                "Der Dienst ist nicht eingerichtet: {}",
                listed_errors(&status.findings)
            ),
        )),
        _ => None,
    }
}

/// Die Fehler unter den Befunden als `feld: Meldung`, die ersten paar; Warnungen bleiben außen vor.
fn listed_errors(findings: &[Finding]) -> String {
    let errors: Vec<&Finding> = findings
        .iter()
        .filter(|finding| finding.severity == Severity::Error)
        .collect();
    let mut text = errors
        .iter()
        .take(MAX_LISTED_FINDINGS)
        .map(|finding| format!("{}: {}", finding.field, finding.message))
        .collect::<Vec<_>>()
        .join("; ");
    if errors.len() > MAX_LISTED_FINDINGS {
        text.push_str(&format!(
            "; … und {} weitere",
            errors.len() - MAX_LISTED_FINDINGS
        ));
    }
    text
}

fn timed_out(
    seen: Option<&Status>,
    requested: OffsetDateTime,
    now: OffsetDateTime,
    waited: Duration,
) -> ApplyOutcome {
    let seconds = waited.as_secs();
    let prefix = format!("Zeitüberschreitung nach {seconds} s");
    let (state, message) = match seen {
        None => (
            None,
            format!(
                "{prefix}: Der Dienst hat keinen Status geschrieben. Läuft er? \
                 (`pds status`)"
            ),
        ),
        Some(status) if status.since <= requested => (
            None,
            format!(
                "{prefix}: Der Dienst hat seit dem Neustart keinen neuen Status gemeldet. Läuft \
                 er? (`pds status`)"
            ),
        ),
        Some(status) if status::is_stale(status, now) => (
            Some(status.state),
            format!(
                "{prefix}: Der Dienst läuft nicht (letztes Lebenszeichen vor {} s)",
                (now - status.heartbeat).whole_seconds()
            ),
        ),
        Some(status) => {
            let detail = last_message(status)
                .map(|message| format!("; letzte Meldung: {message}"))
                .unwrap_or_default();
            (
                Some(status.state),
                format!("{prefix}: Zustand „{}“{detail}", status.state.text()),
            )
        }
    };
    ApplyOutcome {
        ok: false,
        state,
        message,
        waited_seconds: seconds,
    }
}

/// Das Aufschlussreichste, was der Dienst zuletzt gemeldet hat: Fehler, Health oder Befund.
fn last_message(status: &Status) -> Option<String> {
    status
        .last_error
        .as_ref()
        .map(|error| error.message.clone())
        .or_else(|| {
            status
                .health
                .as_ref()
                .filter(|health| !health.ok)
                .and_then(|health| health.message.clone())
        })
        .filter(|message| !message.is_empty())
}

// ---------------------------------------------------------------------------------------------
// Prüfungen des Node-Werkzeugs
// ---------------------------------------------------------------------------------------------

/// Prüft die Datenbank mit der übergebenen Konfiguration (`db-test`): bei SQL Server die
/// Verbindung, bei SQLite, ob sich die Datei öffnen (oder anlegen) und beschreiben lässt.
pub fn db_test(paths: &Paths, config: &Config, secrets: &Secrets) -> Result<ToolResult, OpsError> {
    Ok(tools::run_tool(
        paths,
        ToolCommand::DbTest,
        tools::db_test_env(config, paths, secrets),
        tools::DEFAULT_TIMEOUT,
    )?)
}

/// Sichert die SQLite-Datenbank nach `target` (`db-backup`), auch während der Dienst läuft: Die
/// Kopie ist in sich stimmig und wird danach geprüft. `target` darf es noch nicht geben; ein
/// relativer Pfad gilt ab dem aktuellen Ordner. Nur für SQLite ([`OpsError::SqliteOnly`]).
pub fn db_backup(paths: &Paths, config: &Config, target: &Path) -> Result<ToolResult, OpsError> {
    if config.db.kind != DbKind::Sqlite {
        return Err(OpsError::SqliteOnly);
    }
    // Das Werkzeug soll nicht vom eigenen Arbeitsordner abhängen
    let target: PathBuf = std::path::absolute(target)
        .map_err(|error| OpsError::Io(format!("{}: {error}", target.display())))?;
    Ok(tools::run_tool(
        paths,
        ToolCommand::DbBackup,
        tools::db_backup_env(config, paths, &target),
        tools::BACKUP_TIMEOUT,
    )?)
}

/// Ergebnis von [`db_setup`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DbSetupOutcome {
    pub result: ToolResult,
    /// `db_setup` hat ein neues Datenbankpasswort erzeugt und in `config.toml` gespeichert. Der
    /// Aufrufer muss `db.password` als gesetzt behandeln (und seine Konfiguration neu laden, bevor er
    /// sie speichert), sonst überschreibt er das Passwort wieder mit einem leeren.
    pub password_generated: bool,
}

/// Richtet Datenbank, Login und Benutzer ein (`db-setup`) mit dem Zugang des Administrators, der
/// nirgends gespeichert wird.
///
/// Das Passwort des App-Logins ist, in dieser Reihenfolge:
/// 1. ein Klartext aus `secrets.db_password` (der Aufrufer hat es neu eingegeben; gespeichert wird
///    es hier nicht),
/// 2. das gespeicherte Passwort aus `config.toml`,
/// 3. sonst ein neu erzeugtes ([`generate_db_password`]).
///
/// Nur im dritten Fall schreibt die Funktion in `config.toml`, und dort ausschließlich
/// `db.password`: Sie lädt die Datei von der Platte, versiegelt das Passwort und speichert (nichts
/// aus dem übergebenen `config` gelangt auf die Platte) und meldet `password_generated`. Das
/// passiert vor dem Aufruf des Werkzeugs: Scheitert er mittendrin, setzt der nächste Lauf dasselbe
/// Passwort. Auch wenn das Werkzeug dann gar nicht läuft oder nicht antwortet, kommt das Ergebnis als
/// `Ok` mit `ok == false` zurück, damit `password_generated` nicht verloren geht. Ein erneuter Lauf
/// setzt das Passwort des Logins neu und trennt offene Verbindungen.
pub fn db_setup(
    paths: &Paths,
    config: &Config,
    secrets: &Secrets,
    admin_user: &str,
    admin_password: &Secret,
    protector: &dyn Protector,
) -> Result<DbSetupOutcome, OpsError> {
    if config.db.kind != DbKind::Sqlserver {
        return Err(OpsError::SqlServerOnly("Die Einrichtung der Datenbank"));
    }
    let mut secrets = secrets.clone();
    let mut password_generated = false;
    if secrets.db_password.as_ref().is_none_or(Secret::is_empty) {
        password_generated = ensure_db_password(paths, protector)?;
        // Aus der Datei lesen: Das Werkzeug soll genau das gespeicherte Passwort setzen
        secrets.db_password = config::load(&paths.config_file())?
            .open_secrets(protector)?
            .db_password;
    }
    let called = tools::run_tool(
        paths,
        ToolCommand::DbSetup,
        tools::db_setup_env(config, &secrets, admin_user, admin_password),
        tools::SETUP_TIMEOUT,
    );
    let result = match called {
        Ok(result) => result,
        Err(error) if password_generated => ToolResult {
            ok: false,
            code: error.code().to_owned(),
            message: error.to_string(),
            steps: Vec::new(),
            details: serde_json::Value::Null,
        },
        Err(error) => return Err(error.into()),
    };
    Ok(DbSetupOutcome {
        result,
        password_generated,
    })
}

/// Erzeugt das SQL-Skript für DBAs (`db-script`); es steht in `details.script`. Das Passwort bleibt
/// darin ein Platzhalter.
pub fn db_script(paths: &Paths, config: &Config) -> Result<ToolResult, OpsError> {
    if config.db.kind != DbKind::Sqlserver {
        return Err(OpsError::SqlServerOnly("Das SQL-Skript"));
    }
    Ok(tools::run_tool(
        paths,
        ToolCommand::DbScript,
        tools::db_script_env(config),
        tools::DEFAULT_TIMEOUT,
    )?)
}

/// Prüft die OpenID-Anmeldung (`oidc-test`): Discovery, mit `check_client` auch Client-ID und
/// -Secret.
pub fn oidc_test(
    paths: &Paths,
    config: &Config,
    secrets: &Secrets,
    check_client: bool,
) -> Result<ToolResult, OpsError> {
    Ok(tools::run_tool(
        paths,
        ToolCommand::OidcTest,
        tools::oidc_test_env(config, secrets, check_client),
        tools::DEFAULT_TIMEOUT,
    )?)
}

// ---------------------------------------------------------------------------------------------
// Umgebung der Kindprozesse
// ---------------------------------------------------------------------------------------------

/// Was ein Kindprozess (Node, Caddy) vom Betriebssystem braucht, um zu starten: unter Windows
/// `SystemRoot` (ohne startet Node nicht), `windir`, die Temp-Ordner, `ProgramData`, den
/// Computernamen und `PATH`.
#[cfg(any(windows, test))]
const WINDOWS_BASE_ENV_NAMES: &[&str] = &[
    "SystemRoot",
    "windir",
    "TEMP",
    "TMP",
    "ProgramData",
    "COMPUTERNAME",
    "PATH",
];
#[cfg(windows)]
const BASE_ENV_NAMES: &[&str] = WINDOWS_BASE_ENV_NAMES;
#[cfg(not(windows))]
const BASE_ENV_NAMES: &[&str] = &["PATH", "HOME", "TMPDIR"];

/// Was die App unter Windows zusätzlich bekommt: Sie startet für das Netzlaufwerk `powershell.exe`
/// und `net.exe`, die `ComSpec`, `PATHEXT`, die Modulpfade und die Profilordner des Dienstkontos
/// (Modul-Cache) brauchen. Nichts davon ändert das Verhalten von Node (kein Proxy, keine
/// Zertifikate, keine Node-Optionen).
#[cfg(any(windows, test))]
const WINDOWS_APP_ENV_NAMES: &[&str] = &[
    "ComSpec",
    "PATHEXT",
    "PSModulePath",
    "SystemDrive",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "USERNAME",
    "USERDOMAIN",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
];

/// Ordner unter `SystemRoot`, die im `PATH` der App stehen müssen: `net.exe`, `cmd.exe`, WMI (für
/// `New-SmbMapping`) und `powershell.exe`. Fehlende werden hinten angehängt.
#[cfg(any(windows, test))]
const WINDOWS_PATH_DIRS: &[&str] = &[
    r"System32",
    "",
    r"System32\Wbem",
    r"System32\WindowsPowerShell\v1.0",
];

/// Standard von Windows, falls der Dienst ohne `PATHEXT` läuft.
#[cfg(any(windows, test))]
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

/// Minimale Basis-Umgebung der Kindprozesse. Sie erben nie die ganze Umgebung des Dienstes: Dort
/// könnten Variablen stehen, die Node oder Caddy beeinflussen (Proxy, `NODE_OPTIONS`, Zertifikate).
/// Alles Weitere kommt ausdrücklich dazu (`render::app_env`, `tools::*_env`).
pub fn base_env() -> Vec<(String, Secret)> {
    base_env_from(env_var)
}

/// Basis-Umgebung der App (Node): unter Windows [`base_env`] plus das, was PowerShell und
/// `net.exe` für das Netzlaufwerk brauchen, mit Ersatzwerten aus `SystemRoot`, falls der Dienst
/// ohne sie läuft. Anderswo gleich [`base_env`].
pub fn app_base_env() -> Vec<(String, Secret)> {
    #[cfg(windows)]
    {
        windows_app_env_from(env_var)
    }
    #[cfg(not(windows))]
    {
        base_env()
    }
}

fn env_var(name: &str) -> Option<String> {
    std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
}

// Umgebung als Parameter, damit Tests nichts im Prozess verändern müssen.
fn base_env_from(get: impl Fn(&str) -> Option<String>) -> Vec<(String, Secret)> {
    BASE_ENV_NAMES
        .iter()
        .filter_map(|name| get(name).map(|value| ((*name).to_owned(), Secret::new(value))))
        .collect()
}

// Ohne `cfg(windows)` gebaut, damit die Tests auch unter Linux laufen.
#[cfg(any(windows, test))]
fn windows_app_env_from(get: impl Fn(&str) -> Option<String>) -> Vec<(String, Secret)> {
    let get = |name: &str| get(name).filter(|value| !value.is_empty());
    let mut env: Vec<(String, String)> = WINDOWS_BASE_ENV_NAMES
        .iter()
        .chain(WINDOWS_APP_ENV_NAMES)
        .filter_map(|name| get(name).map(|value| ((*name).to_owned(), value)))
        .collect();

    let root = get("SystemRoot")
        .or_else(|| get("windir"))
        .unwrap_or_else(|| r"C:\Windows".to_owned());
    let root = root.trim_end_matches('\\').to_owned();
    let temp = get("TEMP")
        .or_else(|| get("TMP"))
        .unwrap_or_else(|| format!(r"{root}\TEMP"));
    for (name, value) in [
        ("SystemRoot", root.clone()),
        ("windir", root.clone()),
        ("ComSpec", format!(r"{root}\System32\cmd.exe")),
        ("PATHEXT", DEFAULT_PATHEXT.to_owned()),
        ("TEMP", temp.clone()),
        ("TMP", temp),
    ] {
        if !env.iter().any(|(key, _)| key == name) {
            env.push((name.to_owned(), value));
        }
    }

    let path = with_system_dirs(get("PATH").as_deref().unwrap_or_default(), &root);
    match env.iter_mut().find(|(key, _)| key == "PATH") {
        Some((_, value)) => *value = path,
        None => env.push(("PATH".to_owned(), path)),
    }
    env.into_iter()
        .map(|(name, value)| (name, Secret::new(value)))
        .collect()
}

/// Hängt die fehlenden [`WINDOWS_PATH_DIRS`] an `path` an. Verglichen wird ohne Groß-/
/// Kleinschreibung und ohne abschließenden `\`; ein nicht aufgelöstes `%SystemRoot%` zählt mit.
#[cfg(any(windows, test))]
fn with_system_dirs(path: &str, root: &str) -> String {
    let normalize = |entry: &str| {
        entry
            .trim()
            .trim_end_matches('\\')
            .to_ascii_lowercase()
            .replace("%systemroot%", &root.to_ascii_lowercase())
    };
    let mut entries: Vec<String> = path
        .split(';')
        .filter(|entry| !entry.trim().is_empty())
        .map(str::to_owned)
        .collect();
    for dir in WINDOWS_PATH_DIRS {
        let wanted = if dir.is_empty() {
            root.to_owned()
        } else {
            format!(r"{root}\{dir}")
        };
        if !entries
            .iter()
            .any(|entry| normalize(entry) == normalize(&wanted))
        {
            entries.push(wanted);
        }
    }
    entries.join(";")
}

// ---------------------------------------------------------------------------------------------
// Statusbericht
// ---------------------------------------------------------------------------------------------

/// Alles, was `status` und die UI über den laufenden Dienst zeigen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StatusReport {
    /// Angaben des SCM; `None`, wenn nicht abfragbar (ohne Windows oder ohne Rechte).
    pub service: Option<ScmInfo>,
    /// Letzter vom Dienst geschriebener Status; `None`, wenn es keinen (lesbaren) gibt.
    pub status: Option<Status>,
    /// `state\status.json` ist vorhanden, ließ sich aber nicht lesen (meist ohne
    /// Administratorrechte) oder ist kaputt. So bleibt „nicht lesbar“ von „lief noch nie“ getrennt.
    pub status_error: Option<ReadIssue>,
    /// Heartbeat älter als 30 s: Der Dienst läuft nicht, egal was `status.state` sagt.
    pub stale: bool,
    /// Health direkt bei Node; nur abgefragt, wenn die Kinder laufen sollten.
    pub internal: Option<ProbeResult>,
    /// Health über die öffentliche Adresse (nur Windows).
    pub public: Option<ProbeResult>,
    /// Öffentliche Adresse aus der Konfiguration, leer ohne Hostname.
    pub app_url: String,
    /// Art und Ort der Datenbank aus der Konfiguration (`SQLite: C:\…\pds.db` bzw.
    /// `SQL Server: sql01:1433, Datenbank pds`); leer, wenn die Konfiguration nicht lesbar ist.
    pub database: String,
    /// `config.toml` ließ sich nicht lesen; `app_url` ist dann leer, ohne dass der Hostname fehlt.
    pub config_error: Option<ReadIssue>,
}

/// Eine Datei des Datenordners, die da ist, sich aber nicht lesen ließ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReadIssue {
    /// Zugriff verweigert: Der Datenordner ist nur für Administratoren lesbar, der Aufruf lief ohne
    /// erhöhte Rechte.
    pub access_denied: bool,
    /// Meldung mit Pfad (deutsch).
    pub message: String,
}

impl ReadIssue {
    /// Die Fehlertypen tragen nur Text; ob der Zugriff verweigert wurde, zeigt ein zweiter Versuch.
    fn new(path: &Path, message: String) -> Self {
        let access_denied = matches!(
            fs::File::open(path),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied
        );
        Self {
            access_denied,
            message,
        }
    }
}

/// Stellt den Statusbericht zusammen. Scheitert ein Teil, fehlt nur dieser.
pub fn status_report(paths: &Paths) -> StatusReport {
    let now = OffsetDateTime::now_utc();
    let service = platform::scm::query().ok();
    let status_file = paths.status_file();
    let (status, status_error) = match status::read(&status_file) {
        Ok(status) => (status, None),
        Err(error) => (None, Some(ReadIssue::new(&status_file, error.to_string()))),
    };
    let stale = status
        .as_ref()
        .is_some_and(|status| status::is_stale(status, now));
    let config_file = paths.config_file();
    let (config, config_error) = match config::load(&config_file) {
        Ok(config) => (Some(config), None),
        Err(error) => (None, Some(ReadIssue::new(&config_file, error.to_string()))),
    };
    let app_url = config.as_ref().map(app_url).unwrap_or_default();
    let database = config
        .as_ref()
        .map(|config| database_summary(config, paths))
        .unwrap_or_default();

    // Nur abfragen, wenn die Kinder laufen sollten; sonst wäre "nicht erreichbar" nur Lärm
    let children_expected = !stale
        && status.as_ref().is_some_and(|status| {
            matches!(
                status.state,
                ServiceState::Starting | ServiceState::Running | ServiceState::Backoff
            )
        });
    let (internal, public) = match &config {
        Some(config) if children_expected => (
            Some(health::probe_internal(config.internal.port, PROBE_TIMEOUT)),
            health::probe_public(&app_url, PROBE_TIMEOUT),
        ),
        _ => (None, None),
    };

    StatusReport {
        service,
        status,
        status_error,
        stale,
        internal,
        public,
        app_url,
        database,
        config_error,
    }
}

/// Art und Ort der Datenbank in einer Zeile, für `status` und die UI.
pub fn database_summary(config: &Config, paths: &Paths) -> String {
    let db = &config.db;
    match db.kind {
        DbKind::Sqlite => format!("SQLite: {}", db.sqlite_file(paths).display()),
        DbKind::Sqlserver if db.server.trim().is_empty() => {
            "SQL Server: (kein Server eingetragen)".to_owned()
        }
        DbKind::Sqlserver => format!(
            "SQL Server: {}:{}, Datenbank {}",
            db.server, db.port, db.database
        ),
    }
}

/// Öffentliche Adresse wie im Rendern (Host klein, IPv6 in Klammern), damit Statusbericht, UI und
/// die öffentliche Health-Abfrage dieselbe benutzen; leer ohne Hostname.
fn app_url(config: &Config) -> String {
    if config.public.host.trim().is_empty() {
        return String::new();
    }
    render::app_url(config)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn require_dir_creates_only_when_allowed() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("fehlt");

        assert!(matches!(
            require_dir(&missing, false),
            Err(OpsError::DataDirMissing)
        ));
        assert!(!missing.exists(), "ohne Erlaubnis nicht angelegt");

        require_dir(&missing, true).unwrap();
        assert!(missing.is_dir());
        require_dir(&missing, false).unwrap();
    }

    #[test]
    fn base_env_takes_only_known_names_that_are_set() {
        let env = base_env_from(|name| match name {
            "PATH" => Some("/usr/bin".to_owned()),
            // Gesetzt, aber nicht in der Basis
            "NODE_OPTIONS" | "HTTPS_PROXY" => Some("--irgendwas".to_owned()),
            #[cfg(windows)]
            "SystemRoot" => Some(r"C:\Windows".to_owned()),
            _ => None,
        });

        let names: Vec<&str> = env.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"PATH"));
        assert!(!names.contains(&"NODE_OPTIONS"));
        assert!(!names.contains(&"HTTPS_PROXY"));
        // Fehlende Variablen fehlen, sie werden nicht leer gesetzt
        assert!(!names.contains(&"HOME") && !names.contains(&"TEMP"));
        assert_eq!(
            env.iter()
                .find(|(name, _)| name == "PATH")
                .unwrap()
                .1
                .expose(),
            "/usr/bin"
        );
    }

    fn env_lookup(env: &[(String, Secret)], name: &str) -> Option<String> {
        env.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.expose().to_owned())
    }

    #[test]
    fn windows_app_env_copies_what_powershell_needs() {
        let env = windows_app_env_from(|name| {
            let value = match name {
                "SystemRoot" | "windir" => r"C:\Windows",
                "ComSpec" => r"C:\Windows\system32\cmd.exe",
                "PATHEXT" => ".COM;.EXE",
                "PSModulePath" => r"C:\Program Files\WindowsPowerShell\Modules",
                "TEMP" | "TMP" => r"C:\Windows\TEMP",
                "LOCALAPPDATA" => r"C:\Windows\ServiceProfiles\pds\AppData\Local",
                "PATH" => {
                    r"C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0\;C:\Program Files\EPLAN Panel Data Service"
                }
                // Gesetzt, aber nie für Kinder
                "NODE_OPTIONS" | "HTTPS_PROXY" | "NODE_EXTRA_CA_CERTS" => "--irgendwas",
                _ => return None,
            };
            Some(value.to_owned())
        });

        assert_eq!(
            env_lookup(&env, "ComSpec").as_deref(),
            Some(r"C:\Windows\system32\cmd.exe")
        );
        assert_eq!(env_lookup(&env, "PATHEXT").as_deref(), Some(".COM;.EXE"));
        assert_eq!(
            env_lookup(&env, "PSModulePath").as_deref(),
            Some(r"C:\Program Files\WindowsPowerShell\Modules")
        );
        assert!(env_lookup(&env, "LOCALAPPDATA").is_some());
        // Alles schon vorhanden (auch mit `\` am Ende): der PATH bleibt, wie er war
        assert_eq!(
            env_lookup(&env, "PATH").as_deref(),
            Some(
                r"C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0\;C:\Program Files\EPLAN Panel Data Service"
            )
        );
        for name in ["NODE_OPTIONS", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"] {
            assert!(env_lookup(&env, name).is_none(), "{name}");
        }
        // Fehlende Variablen werden nicht leer gesetzt
        assert!(env_lookup(&env, "APPDATA").is_none());
        let mut names: Vec<&str> = env.iter().map(|(name, _)| name.as_str()).collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "doppelte Namen");
    }

    #[test]
    fn windows_app_env_fills_gaps_from_system_root() {
        let env = windows_app_env_from(|name| match name {
            "SystemRoot" => Some(r"D:\WINDOWS\".to_owned()),
            "PATH" => Some(r"%SystemRoot%\system32;;D:\Tools".to_owned()),
            _ => None,
        });

        assert_eq!(
            env_lookup(&env, "SystemRoot").as_deref(),
            Some(r"D:\WINDOWS\")
        );
        assert_eq!(env_lookup(&env, "windir").as_deref(), Some(r"D:\WINDOWS"));
        assert_eq!(
            env_lookup(&env, "ComSpec").as_deref(),
            Some(r"D:\WINDOWS\System32\cmd.exe")
        );
        assert_eq!(
            env_lookup(&env, "PATHEXT").as_deref(),
            Some(DEFAULT_PATHEXT)
        );
        assert_eq!(
            env_lookup(&env, "TEMP").as_deref(),
            Some(r"D:\WINDOWS\TEMP")
        );
        assert_eq!(env_lookup(&env, "TMP").as_deref(), Some(r"D:\WINDOWS\TEMP"));
        // Nicht aufgelöstes %SystemRoot% zählt als vorhanden, leere Einträge fallen weg
        assert_eq!(
            env_lookup(&env, "PATH").as_deref(),
            Some(
                r"%SystemRoot%\system32;D:\Tools;D:\WINDOWS;D:\WINDOWS\System32\Wbem;D:\WINDOWS\System32\WindowsPowerShell\v1.0"
            )
        );
    }

    #[test]
    fn windows_app_env_without_anything_uses_windows_defaults() {
        let env = windows_app_env_from(|_| None);

        assert_eq!(
            env_lookup(&env, "SystemRoot").as_deref(),
            Some(r"C:\Windows")
        );
        assert_eq!(
            env_lookup(&env, "PATH").as_deref(),
            Some(
                r"C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0"
            )
        );
        assert_eq!(
            env_lookup(&env, "TMP").as_deref(),
            env_lookup(&env, "TEMP").as_deref()
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn app_base_env_without_windows_is_the_base() {
        let names = |env: Vec<(String, Secret)>| -> Vec<String> {
            env.into_iter().map(|(name, _)| name).collect()
        };
        assert_eq!(names(app_base_env()), names(base_env()));
    }

    #[test]
    fn base_env_reads_the_real_environment() {
        // PATH ist auf jedem System gesetzt, auf dem die Tests laufen
        assert!(
            base_env()
                .iter()
                .any(|(name, value)| name.eq_ignore_ascii_case("PATH") && !value.is_empty())
        );
    }

    #[test]
    fn load_error_finding_for_tls_uses_tls_field() {
        let finding = load_error_finding(&OpsError::Tls(TlsError::NoPrivateKey));

        assert_eq!(finding.field, "tls");
        assert_eq!(finding.code, "tls_no_private_key");
    }

    #[test]
    fn config_error_codes_are_snake_case() {
        let errors = [
            ConfigError::Unreadable(String::new()),
            ConfigError::UnsupportedSchema(2),
            ConfigError::UnsealedSecret("db.password"),
            ConfigError::SecretUnreadable {
                field: "db.password",
                reason: String::new(),
            },
            ConfigError::Write(String::new()),
        ];
        for error in errors {
            let code = OpsError::from(error).code();
            assert!(
                code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
                "{code}"
            );
        }
    }
}
