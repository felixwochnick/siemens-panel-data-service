//! Die Befehle der Konfigurations-UI ohne Tauri, damit sie unter Linux testbar sind. Die
//! Tauri-Befehle (`commands.rs`, nur Windows) reichen nur durch.
//!
//! Die Oberfläche bekommt die Konfiguration nur maskiert (`***` = gesetzt, `""` = leer) und schickt
//! einen Entwurf zurück, in dem ein Secret `***` (unverändert), `""` (entfernen) oder neuer
//! Klartext ist. Aufgelöst wird er gegen die gespeicherte Datei ([`merge_masked`]); neuer Klartext
//! wird sofort versiegelt und verlässt diesen Prozess nur über den Umgebungsblock des Werkzeugs.

use std::fs;
use std::path::{Path, PathBuf};

use pds_common::config::masking::{masked, merge_masked};
use pds_common::config::{self, Config, ConfigError, DbKind, Secrets, TlsMode};
use pds_common::eplan::{
    self, Account, Control, EplanError, EplanInstallOutcome, Host, SystemHost,
};
use pds_common::ops::{self, ApplyOutcome, DbSetupOutcome, OpsError, StatusReport, TlsSource};
use pds_common::platform::cert_store::{self, normalize_thumbprint};
use pds_common::platform::{PlatformError, PortStatus, StoreCert, ports, scm};
use pds_common::tls::{self, CertInfo, TlsError};
use pds_common::tools::{ToolError, ToolLine, ToolResult};
use pds_common::validate::{self, Finding, Severity, ValidationInput, has_errors};
use pds_common::{Paths, Protector, Secret, render, system_protector};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use ts_rs::TS;

const CONFIG_INVALID: &str = "Die Konfiguration hat Fehler, die Prüfung wurde nicht gestartet.";

// ---------------------------------------------------------------------------------------------
// Typen der Schnittstelle (ts-rs ⇒ `ui/src/bindings/`)
// ---------------------------------------------------------------------------------------------

/// Alles, was die Oberfläche beim Start und nach dem Speichern lädt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UiState {
    /// Gespeicherte Konfiguration mit maskierten Secrets; die Standardwerte, wenn die Datei nicht
    /// lesbar ist (dann erklärt das ein Befund `config_unreadable`).
    pub config: Config,
    /// Befunde wie bei `config validate`.
    pub findings: Vec<Finding>,
    pub certificate: Option<CertInfo>,
    pub status: StatusReport,
    /// Öffentliche Adresse, Redirect-URI und Issuer der gespeicherten Konfiguration; leer, solange
    /// Hostname bzw. Tenant fehlen.
    pub app_url: String,
    pub redirect_uri: String,
    pub issuer: String,
    /// SQLite-Datei, wenn `db.path` leer bleibt (`data\pds.db` im Datenordner).
    pub default_db_path: String,
}

/// Ergebnis von `save_draft`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveDraftOutcome {
    /// Befunde zum Entwurf. Mit Fehlern darunter wurde nichts gespeichert.
    pub findings: Vec<Finding>,
    pub saved: bool,
    /// Neustart des Dienstes nach dem Speichern; `None`, wenn nicht gespeichert wurde oder der
    /// Neustart gar nicht erst möglich war (der Grund steht dann in `warnings`).
    pub apply: Option<ApplyOutcome>,
    /// Gespeichert, aber mit Einschränkung (Firewall-Regel, kein Neustart). Deutsch, für Admins.
    pub warnings: Vec<String>,
}

impl SaveDraftOutcome {
    fn rejected(findings: Vec<Finding>) -> Self {
        Self {
            findings,
            saved: false,
            apply: None,
            warnings: Vec::new(),
        }
    }
}

/// Fehler eines Befehls: stabiler Code (`snake_case`) und deutsche Meldung, nie mit Secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UiError {
    pub code: String,
    pub message: String,
}

impl UiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for UiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for UiError {}

macro_rules! ui_error_from {
    ($($error:ty),*) => {$(
        impl From<$error> for UiError {
            fn from(error: $error) -> Self {
                Self::new(error.code(), error.to_string())
            }
        }
    )*};
}

ui_error_from!(
    OpsError,
    ConfigError,
    PlatformError,
    TlsError,
    ToolError,
    EplanError
);

/// `service_control(action)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

/// Abgeleitete Adressen, wie sie die App verwendet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Addresses {
    pub app_url: String,
    pub redirect_uri: String,
    pub issuer: String,
}

/// Adressen aus [`render`]; ohne Hostname bzw. Tenant leer statt halber URLs wie `https://`.
pub fn addresses(config: &Config) -> Addresses {
    let has_host = !config.public.host.trim().is_empty();
    let oidc = &config.oidc;
    let has_issuer = !oidc.tenant_mode() || !oidc.tenant_id.trim().is_empty();
    let when = |present: bool, value: String| if present { value } else { String::new() };
    Addresses {
        app_url: when(has_host, render::app_url(config)),
        redirect_uri: when(has_host, render::redirect_uri(config)),
        issuer: when(has_issuer, render::issuer(config)),
    }
}

/// Adresse für „Web-App öffnen“ aus einer Konfiguration. Sie geht als Argument an
/// `explorer.exe`, deshalb nur `http(s)://` mit Host (Buchstaben, Ziffern, `.`, `-`, IPv6 in `[]`)
/// und Port: `explorer.exe` deutet etwa Kommas als Trenner, und eine Datei oder ein Programm darf
/// so nie geöffnet werden.
pub fn web_console_url(config: &Config) -> Result<String, UiError> {
    if config.public.host.trim().is_empty() {
        return Err(UiError::new(
            "web_console_unconfigured",
            "Es ist noch kein Hostname gespeichert. Bitte zuerst unter „Adresse und TLS“ den \
             Hostnamen eintragen und speichern.",
        ));
    }
    let url = render::app_url(config);
    if is_plain_web_url(&url) {
        Ok(url)
    } else {
        Err(UiError::new(
            "web_console_url_invalid",
            format!("Die gespeicherte Adresse „{url}“ ist keine gültige http(s)-Adresse."),
        ))
    }
}

fn is_plain_web_url(url: &str) -> bool {
    let Some(authority) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    else {
        return false;
    };
    let allowed = |byte: u8| byte.is_ascii_alphanumeric() || b".-:[]".contains(&byte);
    !authority.is_empty()
        && authority.len() <= 300
        && authority.bytes().all(allowed)
        && authority
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'[')
}

// ---------------------------------------------------------------------------------------------
// Befehle
// ---------------------------------------------------------------------------------------------

/// Ordner und Protector, mit denen alle Befehle arbeiten.
pub struct Backend {
    pub paths: Paths,
    pub protector: Box<dyn Protector>,
}

/// Entwurf mit aufgelösten Secrets. Neuer Klartext ist darin schon versiegelt; geschrieben ist
/// noch nichts.
struct Resolved {
    config: Config,
    secrets: Secrets,
}

impl Backend {
    pub fn new(paths: Paths, protector: Box<dyn Protector>) -> Self {
        Self { paths, protector }
    }

    /// Ordner aus Umgebung und Ort der EXE, Secrets mit DPAPI des Computers.
    pub fn system() -> Self {
        Self::new(Paths::detect(), system_protector())
    }

    pub fn load_state(&self, now: OffsetDateTime) -> UiState {
        let checked = ops::check(&self.paths, &*self.protector, now);
        let (config, certificate) = match checked.loaded {
            Some(loaded) => (loaded.config, loaded.certificate),
            // Lässt sich nur ein Secret oder das Zertifikat nicht öffnen, bleibt der Rest sichtbar
            None => (
                config::load(&self.paths.config_file()).unwrap_or_default(),
                tls::load_info(&self.paths).ok().flatten(),
            ),
        };
        let addresses = addresses(&config);
        UiState {
            config: masked(&config),
            findings: checked.findings,
            certificate,
            status: ops::status_report(&self.paths),
            app_url: addresses.app_url,
            redirect_uri: addresses.redirect_uri,
            issuer: addresses.issuer,
            default_db_path: self.paths.default_sqlite_file().display().to_string(),
        }
    }

    /// Prüft den Entwurf wie `config validate`, ohne etwas zu schreiben.
    pub fn validate_draft(&self, draft: Config, now: OffsetDateTime) -> Vec<Finding> {
        match self.resolve(draft) {
            Ok(resolved) => self.check(&resolved, now),
            Err(finding) => vec![finding],
        }
    }

    /// Prüfen, bei Fehlern nicht speichern, sonst speichern und den Dienst neu starten.
    pub fn save_draft(
        &self,
        draft: Config,
        now: OffsetDateTime,
    ) -> Result<SaveDraftOutcome, UiError> {
        self.save_draft_with(draft, now, |paths| ops::apply(paths, ops::APPLY_TIMEOUT))
    }

    /// Wie [`Self::save_draft`] mit eigenem Neustart (Tests).
    pub fn save_draft_with(
        &self,
        draft: Config,
        now: OffsetDateTime,
        apply: impl FnOnce(&Paths) -> Result<ApplyOutcome, OpsError>,
    ) -> Result<SaveDraftOutcome, UiError> {
        let resolved = match self.resolve(draft) {
            Ok(resolved) => resolved,
            Err(finding) => return Ok(SaveDraftOutcome::rejected(vec![finding])),
        };
        let findings = self.check(&resolved, now);
        if has_errors(&findings) {
            return Ok(SaveDraftOutcome::rejected(findings));
        }
        let mut warnings = ops::save_config(&self.paths, &resolved.config)?.warnings;
        let apply = match apply(&self.paths) {
            Ok(outcome) => Some(outcome),
            Err(error) => {
                warnings.push(format!("Neustart des Dienstes nicht möglich: {error}"));
                None
            }
        };
        Ok(SaveDraftOutcome {
            findings,
            saved: true,
            apply,
            warnings,
        })
    }

    pub fn get_status(&self) -> StatusReport {
        ops::status_report(&self.paths)
    }

    /// Steuert den Dienst und liefert danach den Status. Start und Neustart warten nicht auf die
    /// Anwendung, das zeigt die laufende Statusabfrage der Oberfläche.
    pub fn service_control(&self, action: ServiceAction) -> Result<StatusReport, UiError> {
        match action {
            ServiceAction::Start => scm::start(),
            ServiceAction::Stop => scm::stop(ops::STOP_TIMEOUT),
            ServiceAction::Restart => scm::restart(ops::STOP_TIMEOUT),
        }?;
        Ok(self.get_status())
    }

    // -- EPLAN-Worker --------------------------------------------------------------------------

    /// Richtet den Worker-Dienst unter `account` ein oder ändert Konto und Passwort (siehe
    /// [`eplan::install`]). Das Passwort wird nirgends gespeichert.
    pub fn eplan_install(
        &self,
        account: &str,
        password: Secret,
    ) -> Result<EplanInstallOutcome, UiError> {
        self.eplan_install_with(&SystemHost, account, password)
    }

    /// Wie [`Self::eplan_install`] mit eigenem Rechner (Tests).
    pub fn eplan_install_with(
        &self,
        host: &dyn Host,
        account: &str,
        password: Secret,
    ) -> Result<EplanInstallOutcome, UiError> {
        let account = Account::parse(account)?;
        Ok(eplan::install(host, &self.paths, &account, &password)?)
    }

    /// Startet, stoppt oder startet den Worker neu und liefert danach den Status.
    pub fn eplan_control(&self, action: ServiceAction) -> Result<StatusReport, UiError> {
        let action = match action {
            ServiceAction::Start => Control::Start,
            ServiceAction::Stop => Control::Stop,
            ServiceAction::Restart => Control::Restart,
        };
        eplan::control(&SystemHost, action)?;
        Ok(self.get_status())
    }

    // -- Zertifikat ----------------------------------------------------------------------------

    // `host` ist der Hostname aus dem Entwurf, siehe `import`.

    pub fn tls_import_pfx(
        &self,
        path: &Path,
        password: Secret,
        host: &str,
        now: OffsetDateTime,
    ) -> Result<CertInfo, UiError> {
        let bytes = fs::read(path).map_err(|error| file_error(path, &error))?;
        self.import(TlsSource::Pfx { bytes, password }, host, now)
    }

    pub fn tls_import_pem(
        &self,
        cert_path: &Path,
        key_path: &Path,
        host: &str,
        now: OffsetDateTime,
    ) -> Result<CertInfo, UiError> {
        let cert = fs::read_to_string(cert_path).map_err(|error| file_error(cert_path, &error))?;
        let key = fs::read_to_string(key_path).map_err(|error| file_error(key_path, &error))?;
        self.import(
            TlsSource::Pem {
                cert,
                key: Secret::new(key),
            },
            host,
            now,
        )
    }

    pub fn tls_import_store(
        &self,
        thumbprint: &str,
        host: &str,
        now: OffsetDateTime,
    ) -> Result<CertInfo, UiError> {
        let thumbprint =
            normalize_thumbprint(thumbprint).ok_or(PlatformError::InvalidThumbprint)?;
        self.import(TlsSource::Store { thumbprint }, host, now)
    }

    /// Prüft gegen `host` (leer: den gespeicherten Hostnamen) und speichert nur das Zertifikat;
    /// wirksam nach dem nächsten Start. Der Hostname des Entwurfs zählt, damit Hostname und
    /// Zertifikat zusammen wechseln können: Gegen den alten geprüft, ließe sich das neue Zertifikat
    /// nicht importieren und ohne es der neue Hostname nicht speichern.
    fn import(
        &self,
        source: TlsSource,
        host: &str,
        now: OffsetDateTime,
    ) -> Result<CertInfo, UiError> {
        let mut config = config::load(&self.paths.config_file())?;
        let host = host.trim();
        if !host.is_empty() {
            // Nur für die Prüfung, gespeichert wird der Hostname mit dem Entwurf
            config.public.host = host.to_owned();
        }
        Ok(ops::import_tls(
            &self.paths,
            &config,
            source,
            &*self.protector,
            now,
        )?)
    }

    // -- Werkzeuge -----------------------------------------------------------------------------

    pub fn db_test(&self, draft: Config) -> Result<ToolResult, UiError> {
        match self.tool_draft(draft, &["db."], &[]) {
            Ok(resolved) => Ok(ops::db_test(
                &self.paths,
                &resolved.config,
                &resolved.secrets,
            )?),
            Err(blocked) => Ok(blocked),
        }
    }

    /// Ohne Datenbankpasswort im Entwurf (und in der Datei) erzeugt die Einrichtung eins und
    /// speichert nur dieses (`password_generated`); der übrige Entwurf bleibt ungespeichert.
    pub fn db_setup(
        &self,
        draft: Config,
        admin_user: &str,
        admin_password: Secret,
    ) -> Result<DbSetupOutcome, UiError> {
        if draft.db.kind != DbKind::Sqlserver {
            return Err(OpsError::SqlServerOnly("Die Einrichtung der Datenbank").into());
        }
        let admin_user = admin_user.trim();
        if admin_user.is_empty() {
            return Err(UiError::new(
                "db_admin_user_missing",
                "Der Administrator-Login fehlt.",
            ));
        }
        if admin_password.is_empty() {
            return Err(UiError::new(
                "db_admin_password_missing",
                "Das Passwort des Administrator-Logins fehlt.",
            ));
        }
        // Das App-Passwort darf fehlen: Die Einrichtung erzeugt es
        let resolved = match self.tool_draft(draft, &["db."], &["db.password"]) {
            Ok(resolved) => resolved,
            Err(result) => {
                return Ok(DbSetupOutcome {
                    result,
                    password_generated: false,
                });
            }
        };
        Ok(ops::db_setup(
            &self.paths,
            &resolved.config,
            &resolved.secrets,
            admin_user,
            &admin_password,
            &*self.protector,
        )?)
    }

    /// Schreibt das SQL-Skript für DBAs nach `path` (UTF-8). Es braucht nur die Namen von
    /// Datenbank und Login, keine Secrets; das Passwort bleibt darin ein Platzhalter.
    pub fn db_script(&self, draft: Config, path: &Path) -> Result<ToolResult, UiError> {
        if draft.db.kind != DbKind::Sqlserver {
            return Err(OpsError::SqlServerOnly("Das SQL-Skript").into());
        }
        let blocking = blocking_findings(
            &self.paths,
            &draft,
            &Secrets::default(),
            &["db."],
            &["db.server", "db.port", "db.password"],
        );
        if !blocking.is_empty() {
            return Ok(blocked(blocking));
        }
        let result = ops::db_script(&self.paths, &draft)?;
        if result.ok {
            let script = result
                .details
                .get("script")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    UiError::new("tool_no_script", "Das Werkzeug hat kein Skript geliefert.")
                })?;
            fs::write(path, script).map_err(|error| {
                UiError::new("file_write_failed", format!("{}: {error}", path.display()))
            })?;
        }
        Ok(result)
    }

    /// Sichert die SQLite-Datenbank des Entwurfs nach `path` (die Datei darf es noch nicht geben),
    /// auch während der Dienst läuft. Nur für SQLite.
    pub fn db_backup(&self, draft: Config, path: &Path) -> Result<ToolResult, UiError> {
        if draft.db.kind != DbKind::Sqlite {
            return Err(OpsError::SqliteOnly.into());
        }
        match self.tool_draft(draft, &["db."], &[]) {
            Ok(resolved) => Ok(ops::db_backup(&self.paths, &resolved.config, path)?),
            Err(blocked) => Ok(blocked),
        }
    }

    pub fn oidc_test(&self, draft: Config, check_client: bool) -> Result<ToolResult, UiError> {
        // Das Client-Secret braucht nur die Clientprüfung
        let except: &[&str] = if check_client {
            &[]
        } else {
            &["oidc.client_secret"]
        };
        match self.tool_draft(draft, &["oidc.", "proxy."], except) {
            Ok(resolved) => Ok(ops::oidc_test(
                &self.paths,
                &resolved.config,
                &resolved.secrets,
                check_client,
            )?),
            Err(blocked) => Ok(blocked),
        }
    }

    // -- Sonstiges -----------------------------------------------------------------------------

    pub fn regenerate_app_secret(&self) -> Result<(), UiError> {
        Ok(ops::regenerate_app_secret(&self.paths, &*self.protector)?)
    }

    /// Adresse der Web-App aus der gespeicherten Konfiguration, nie aus der Oberfläche: Ein
    /// ungespeicherter Entwurf soll nicht schon im Browser landen.
    pub fn web_console_url(&self) -> Result<String, UiError> {
        web_console_url(&config::load(&self.paths.config_file())?)
    }

    /// Der Logordner als Start der Dateiauswahl; ohne ihn (Dienst nie gelaufen) ein Fehler statt
    /// einer Auswahl, die irgendwo anders aufgeht.
    pub fn logs_dir(&self) -> Result<PathBuf, UiError> {
        let dir = self.paths.logs_dir();
        if dir.is_dir() {
            Ok(dir)
        } else {
            Err(UiError::new(
                "logs_dir_missing",
                format!(
                    "Den Logordner {} gibt es nicht – ist der Dienst installiert?",
                    dir.display()
                ),
            ))
        }
    }

    /// Die Logdatei `path` zum Öffnen, aufgelöst. Der Pfad kommt aus der Oberfläche und wird mit
    /// Adminrechten geöffnet, deshalb nur eine Datei im Logordner (nach `..` und Verknüpfungen).
    pub fn log_file(&self, path: &Path) -> Result<PathBuf, UiError> {
        file_inside(&self.logs_dir()?, path)
    }

    // -- Entwurf -------------------------------------------------------------------------------

    /// Löst die Secrets des Entwurfs gegen die gespeicherte Konfiguration auf. Was dabei
    /// scheitert, ist ein Befund: Die Oberfläche zeigt ihn wie jeden anderen.
    fn resolve(&self, draft: Config) -> Result<Resolved, Finding> {
        let existing = config::load(&self.paths.config_file())
            .map_err(|error| ops::unreadable_finding(&error))?;
        let config = merge_masked(&existing, draft, &*self.protector)
            .map_err(|error| secret_finding(&error))?;
        let secrets = config
            .open_secrets(&*self.protector)
            .map_err(|error| secret_finding(&error))?;
        Ok(Resolved { config, secrets })
    }

    /// Befunde zum aufgelösten Entwurf mit dem gespeicherten Zertifikat.
    fn check(&self, resolved: &Resolved, now: OffsetDateTime) -> Vec<Finding> {
        let validate = |certificate: Option<&CertInfo>, key_matches: Option<bool>| {
            validate::validate(&ValidationInput {
                config: &resolved.config,
                secrets: &resolved.secrets,
                certificate,
                certificate_key_matches: key_matches,
                now,
                paths: &self.paths,
            })
        };
        match self.stored_certificate(resolved.config.tls.mode) {
            Ok((certificate, key_matches)) => validate(certificate.as_ref(), key_matches),
            Err(problem) => {
                // Die unlesbare Ablage erklärt mehr als „kein Zertifikat hinterlegt“
                let mut findings = vec![problem];
                findings.extend(
                    validate(None, None)
                        .into_iter()
                        .filter(|finding| finding.code != "certificate_missing"),
                );
                findings
            }
        }
    }

    /// Das gespeicherte Zertifikat wie bei `ops::load`, aber für den TLS-Modus des Entwurfs: Nur
    /// im Modus `certificate` ist eine unlesbare Ablage ein Befund, und nur dort wird der
    /// Schlüssel geprüft.
    fn stored_certificate(
        &self,
        mode: TlsMode,
    ) -> Result<(Option<CertInfo>, Option<bool>), Finding> {
        let uses_certificate = mode == TlsMode::Certificate;
        let certificate = match tls::load_info(&self.paths) {
            Ok(info) => info,
            Err(error) if uses_certificate => return Err(tls_finding(error)),
            Err(_) => None,
        };
        let key_matches = match &certificate {
            Some(_) if uses_certificate => {
                let checked = tls::load(&self.paths, &*self.protector)
                    .and_then(|material| material.ok_or(TlsError::NoPrivateKey))
                    .and_then(|material| tls::key_matches(&material));
                Some(checked.map_err(tls_finding)?)
            }
            _ => None,
        };
        Ok((certificate, key_matches))
    }

    /// Entwurf für ein Werkzeug: aufgelöst und ohne Fehler an den Feldern, die es braucht. Sonst
    /// das Ergebnis, das die Oberfläche statt eines Aufrufs zeigt.
    fn tool_draft(
        &self,
        draft: Config,
        prefixes: &[&str],
        except: &[&str],
    ) -> Result<Resolved, ToolResult> {
        let resolved = self
            .resolve(draft)
            .map_err(|finding| blocked(vec![finding]))?;
        let blocking = blocking_findings(
            &self.paths,
            &resolved.config,
            &resolved.secrets,
            prefixes,
            except,
        );
        if blocking.is_empty() {
            Ok(resolved)
        } else {
            Err(blocked(blocking))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Ohne Kontext
// ---------------------------------------------------------------------------------------------

/// Zertifikate aus `LocalMachine\My` zur Auswahl (nur Windows).
pub fn tls_list_store() -> Result<Vec<StoreCert>, UiError> {
    Ok(cert_store::list()?)
}

/// Ports, die Caddy und die App öffnen, je einmal und ohne ungültige `0`: HTTP, HTTPS (bei `off`
/// lauscht dort nichts), intern.
pub fn wanted_ports(config: &Config) -> Vec<u16> {
    let mut wanted = vec![config.listen.http_port];
    if config.tls.mode != TlsMode::Off {
        wanted.push(config.public.port);
    }
    wanted.push(config.internal.port);
    let mut unique: Vec<u16> = Vec::with_capacity(wanted.len());
    for port in wanted {
        if port != 0 && !unique.contains(&port) {
            unique.push(port);
        }
    }
    unique
}

/// Belegung der Ports aus dem Entwurf.
pub fn ports_check(draft: &Config) -> Vec<PortStatus> {
    ports::check(&wanted_ports(draft))
}

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

/// `path` aufgelöst, wenn es eine Datei in `dir` (oder darunter) ist, sonst `invalid_path`.
fn file_inside(dir: &Path, path: &Path) -> Result<PathBuf, UiError> {
    let invalid = || {
        UiError::new(
            "invalid_path",
            format!(
                "{} ist keine Datei im Logordner {}",
                path.display(),
                dir.display()
            ),
        )
    };
    let dir = fs::canonicalize(dir).map_err(|_| invalid())?;
    let file = fs::canonicalize(path).map_err(|_| invalid())?;
    if file.starts_with(&dir) && file.is_file() {
        Ok(file)
    } else {
        Err(invalid())
    }
}

fn file_error(path: &Path, error: &std::io::Error) -> UiError {
    UiError::new("file_unreadable", format!("{}: {error}", path.display()))
}

/// Ein Secret, das sich nicht öffnen lässt, steht an seinem Feld: Dort lässt es sich neu
/// eingeben und so ersetzen.
fn secret_finding(error: &ConfigError) -> Finding {
    let field = match error {
        ConfigError::UnsealedSecret(field) | ConfigError::SecretUnreadable { field, .. } => field,
        _ => "config",
    };
    Finding {
        field: field.to_owned(),
        code: error.code().to_owned(),
        message: error.to_string(),
        severity: Severity::Error,
    }
}

fn tls_finding(error: TlsError) -> Finding {
    ops::load_error_finding(&OpsError::Tls(error))
}

/// Fehler an Feldern mit einem der `prefixes` (ohne `except`) machen einen Aufruf des Werkzeugs
/// sinnlos und erklären besser, was fehlt, als dessen Fehlermeldung (wie in der CLI).
fn blocking_findings(
    paths: &Paths,
    config: &Config,
    secrets: &Secrets,
    prefixes: &[&str],
    except: &[&str],
) -> Vec<Finding> {
    validate::validate(&ValidationInput {
        config,
        secrets,
        certificate: None,
        certificate_key_matches: None,
        now: OffsetDateTime::now_utc(),
        paths,
    })
    .into_iter()
    .filter(|finding| {
        finding.severity == Severity::Error
            && prefixes
                .iter()
                .any(|prefix| finding.field.starts_with(prefix))
            && !except.contains(&finding.field.as_str())
    })
    .collect()
}

/// Statt eines Aufrufs: ein Ergebnis in der Form des Werkzeugs, ein Schritt je Befund, damit die
/// Oberfläche es wie jedes andere zeigt.
fn blocked(findings: Vec<Finding>) -> ToolResult {
    let steps = findings
        .iter()
        .map(|finding| ToolLine {
            kind: "step".to_owned(),
            ok: false,
            code: finding.code.clone(),
            message: finding.message.clone(),
            details: json!({ "error": finding.code, "field": finding.field }),
        })
        .collect();
    ToolResult {
        ok: false,
        code: "config_invalid".to_owned(),
        message: CONFIG_INVALID.to_owned(),
        steps,
        details: json!({ "findings": findings }),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    /// `logs/` mit `service.log` und `logs/alt/`, daneben `geheim.txt` und `anders/app.log`.
    fn layout() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let logs = dir.path().join("logs");
        fs::create_dir_all(logs.join("alt")).unwrap();
        fs::create_dir_all(dir.path().join("anders")).unwrap();
        fs::write(logs.join("service.log"), "x").unwrap();
        fs::write(dir.path().join("geheim.txt"), "x").unwrap();
        fs::write(dir.path().join("anders").join("app.log"), "x").unwrap();
        (dir, logs)
    }

    #[test]
    fn file_inside_accepts_a_file_in_the_dir() {
        let (_dir, logs) = layout();

        let file = file_inside(&logs, &logs.join("service.log")).unwrap();

        assert_eq!(file, fs::canonicalize(logs.join("service.log")).unwrap());
    }

    #[test]
    fn file_inside_rejects_dot_dot_escape() {
        let (_dir, logs) = layout();

        let error = file_inside(&logs, &logs.join("..").join("geheim.txt")).unwrap_err();

        assert_eq!(error.code, "invalid_path");
    }

    #[test]
    fn file_inside_rejects_other_dir_missing_file_and_dirs() {
        let (dir, logs) = layout();

        for path in [
            dir.path().join("anders").join("app.log"),
            logs.join("fehlt.log"),
            logs.clone(),
            logs.join("alt"),
        ] {
            assert_eq!(
                file_inside(&logs, &path).unwrap_err().code,
                "invalid_path",
                "{}",
                path.display()
            );
        }
    }

    // Verknüpfungen werden aufgelöst: Ein Link im Logordner auf eine Datei außerhalb zählt nicht
    #[cfg(unix)]
    #[test]
    fn file_inside_rejects_link_to_outside() {
        let (dir, logs) = layout();
        std::os::unix::fs::symlink(dir.path().join("geheim.txt"), logs.join("link.log")).unwrap();

        let error = file_inside(&logs, &logs.join("link.log")).unwrap_err();

        assert_eq!(error.code, "invalid_path");
    }
}
