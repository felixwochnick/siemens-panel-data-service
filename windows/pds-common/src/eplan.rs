//! EPLAN-Worker `pds-eplan`: ein zweiter Windows-Dienst, der EPLAN unter einem lizenzierten
//! Benutzerkonto ausführt und über die Named Pipe `\\.\pipe\pds-eplan` mit der App spricht.
//!
//! Hier steht, was CLI (`pds eplan …`), `setup install`/`uninstall` und die Konfigurations-UI gleich
//! tun: Kontonamen prüfen, Dienst-Parameter, Ordnerrechte (ACL-Plan), Statusmodell und die Abläufe
//! Einrichten, Entfernen, Starten und Stoppen. Die Windows-Aufrufe stecken hinter [`Host`];
//! [`SystemHost`] reicht sie an [`crate::platform`] durch, Tests setzen einen eigenen ein.
//!
//! Das Passwort des Kontos geht nur an die Anmeldeprüfung und an den Dienststeuerungs-Manager (der
//! es als LSA-Secret ablegt). Es steht nie in einer Datei, einem Log oder einem Prozess-Argument.

use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use thiserror::Error;
use ts_rs::TS;

use crate::names::{
    EPLAN_SERVICE_DESCRIPTION, EPLAN_SERVICE_DISPLAY_NAME, EPLAN_SERVICE_NAME, SERVICE_NAME,
};
use crate::paths::Paths;
use crate::platform::{self, DirAccess, PlatformError, ScmInfo, ScmState, SecureOutcome};
use crate::secret::Secret;

/// Argument, mit dem der SCM den Worker startet (`pds-eplan.exe service`).
pub const WORKER_ARGUMENT: &str = "service";
/// Wiederherstellung: neu starten nach 10 s, 30 s und 60 s.
pub const RECOVERY_DELAYS: [Duration; 3] = [
    Duration::from_secs(10),
    Duration::from_secs(30),
    Duration::from_secs(60),
];
/// Nach einem Tag ohne Fehler beginnt die Zählung der Fehler wieder bei null.
pub const RECOVERY_RESET: Duration = Duration::from_secs(24 * 60 * 60);
/// So lange darf das Stoppen dauern: EPLAN schließt ein offenes Projekt erst ab.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(120);
/// Recht „Als Dienst anmelden“.
pub const SERVICE_LOGON_RIGHT: &str = "SeServiceLogonRight";

/// Höchstlänge eines Kontonamens samt Domäne.
const MAX_ACCOUNT_LEN: usize = 256;
/// Zeichen, die in Benutzer- und Domänennamen nicht vorkommen dürfen (SAM-Regeln).
const FORBIDDEN_CHARS: &[char] = &[
    '"', '/', '\\', '[', ']', ':', ';', '|', '=', ',', '+', '*', '?', '<', '>', '@',
];
/// Domänen virtueller und eingebauter Konten, auch in der deutschen Schreibweise von Windows.
const BUILTIN_DOMAINS: &[&str] = &[
    "nt authority",
    "nt-autorität",
    "nt service",
    "builtin",
    "vordefiniert",
    "iis apppool",
    "nt virtual machine",
    "window manager",
    "font driver host",
];
/// Eingebaute Dienstkonten, die ohne Domäne geschrieben werden.
const BUILTIN_NAMES: &[&str] = &[
    "localsystem",
    "localservice",
    "networkservice",
    "system",
    "lokales system",
    "lokaler dienst",
    "netzwerkdienst",
];

// ---------------------------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------------------------

/// Fehler beim Einrichten und Steuern des Workers. UI und CLI zeigen den Text, Tests prüfen
/// [`Self::code`]. Kein Text enthält das Passwort.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EplanError {
    #[error("Das Konto fehlt. Erwartet wird DOMÄNE\\Benutzer, .\\Benutzer oder benutzer@domäne.")]
    AccountMissing,
    #[error("Das Konto „{0}“ ist ungültig: {1}")]
    AccountInvalid(String, String),
    #[error(
        "„{0}“ ist ein eingebautes oder virtuelles Konto. Der EPLAN-Worker braucht ein \
         Benutzerkonto mit EPLAN-Lizenz (DOMÄNE\\Benutzer, .\\Benutzer oder benutzer@domäne)."
    )]
    BuiltinAccount(String),
    #[error(
        "„{0}“ ist ein verwaltetes Dienstkonto oder ein Computerkonto. Der EPLAN-Worker braucht ein \
         Benutzerkonto mit Passwort und EPLAN-Lizenz."
    )]
    ManagedAccount(String),
    #[error("Das Konto „{0}“ wurde nicht gefunden.")]
    AccountNotFound(String),
    #[error(
        "„{0}“ ist kein Benutzerkonto (etwa eine Gruppe oder ein eingebautes Konto). Der \
         EPLAN-Worker braucht ein Benutzerkonto mit EPLAN-Lizenz."
    )]
    NotAUser(String),
    #[error("Das Passwort fehlt.")]
    PasswordMissing,
    #[error(
        "Die Anmeldung als „{account}“ ist fehlgeschlagen: {reason}. Am Dienst wurde nichts geändert."
    )]
    LogonFailed { account: String, reason: String },
    #[error(
        "Der EPLAN-Worker fehlt in dieser Installation ({0}). Das MSI wurde ohne EPLAN gebaut \
         (build-payload.ps1 -SkipEplanWorker); bitte ein MSI mit Worker installieren."
    )]
    WorkerMissing(PathBuf),
    #[error(
        "Datenordner fehlt – bitte die Installation reparieren (msiexec /fa …) oder \
         `pds setup install` als Administrator ausführen"
    )]
    DataDirMissing,
    #[error("Der EPLAN-Worker ist nicht eingerichtet – zuerst `pds eplan install --user <konto>`.")]
    NotInstalled,
    #[error(transparent)]
    Platform(#[from] PlatformError),
}

impl EplanError {
    /// Stabiler Code für UI und CLI.
    pub fn code(&self) -> &'static str {
        match self {
            Self::AccountMissing => "eplan_account_missing",
            Self::AccountInvalid(..) => "eplan_account_invalid",
            Self::BuiltinAccount(_) => "eplan_account_builtin",
            Self::ManagedAccount(_) => "eplan_account_managed",
            Self::AccountNotFound(_) => "eplan_account_not_found",
            Self::NotAUser(_) => "eplan_account_not_user",
            Self::PasswordMissing => "eplan_password_missing",
            Self::LogonFailed { .. } => "eplan_logon_failed",
            Self::WorkerMissing(_) => "eplan_worker_missing",
            Self::DataDirMissing => "data_dir_missing",
            Self::NotInstalled => "eplan_not_installed",
            Self::Platform(error) => error.code(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Konto
// ---------------------------------------------------------------------------------------------

/// Schreibweise des Kontos, so wie der Admin es angegeben hat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountForm {
    /// `DOMÄNE\Benutzer` (Domäne als NetBIOS- oder DNS-Name).
    Domain(String),
    /// `.\Benutzer`: lokales Konto dieses Computers.
    Local,
    /// `benutzer@domäne` (UPN); die Domäne steht hier.
    Upn(String),
}

/// Ein geprüfter Kontoname für den Worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub user: String,
    pub form: AccountForm,
}

impl Account {
    /// Prüft den Kontonamen: `DOMÄNE\Benutzer`, `.\Benutzer` oder `benutzer@domäne`. Abgelehnt
    /// werden eingebaute und virtuelle Konten (`LocalSystem`, `NT AUTHORITY\…`, `NT SERVICE\…`,
    /// `BUILTIN\…` …), verwaltete Dienst- und Computerkonten (`…$`) und Namen ohne Domäne.
    pub fn parse(text: &str) -> Result<Self, EplanError> {
        let text = text.trim();
        let invalid = |reason: &str| EplanError::AccountInvalid(text.to_owned(), reason.to_owned());
        if text.is_empty() {
            return Err(EplanError::AccountMissing);
        }
        if text.chars().count() > MAX_ACCOUNT_LEN {
            return Err(invalid("zu lang"));
        }
        if text.chars().any(char::is_control) {
            return Err(invalid("enthält Steuerzeichen"));
        }
        let lower = text.to_lowercase();
        let bare = lower.strip_prefix(r".\").unwrap_or(&lower);
        if BUILTIN_NAMES.contains(&bare) {
            return Err(EplanError::BuiltinAccount(text.to_owned()));
        }

        if let Some((domain, user)) = text.split_once('\\') {
            let form = if domain == "." {
                AccountForm::Local
            } else if BUILTIN_DOMAINS.contains(&domain.to_lowercase().as_str()) {
                return Err(EplanError::BuiltinAccount(text.to_owned()));
            } else {
                check_domain(domain).map_err(|reason| invalid(&reason))?;
                AccountForm::Domain(domain.to_owned())
            };
            check_user(user).map_err(|reason| invalid(&reason))?;
            if user.ends_with('$') {
                return Err(EplanError::ManagedAccount(text.to_owned()));
            }
            return Ok(Self {
                user: user.to_owned(),
                form,
            });
        }

        if let Some((user, domain)) = text.rsplit_once('@') {
            // Im UPN darf der Benutzerteil Punkte enthalten, aber kein zweites `@`
            check_user(user).map_err(|reason| invalid(&reason))?;
            check_domain(domain).map_err(|reason| invalid(&reason))?;
            if user.ends_with('$') {
                return Err(EplanError::ManagedAccount(text.to_owned()));
            }
            return Ok(Self {
                user: user.to_owned(),
                form: AccountForm::Upn(domain.to_owned()),
            });
        }

        Err(invalid(&format!(
            "die Domäne fehlt – lokale Konten als .\\{text}, Domänenkonten als DOMÄNE\\{text} \
             oder {text}@domäne angeben"
        )))
    }

    /// Name, so wie ihn der Dienststeuerungs-Manager bekommt (und anzeigt).
    pub fn service_name(&self) -> String {
        match &self.form {
            AccountForm::Domain(domain) => format!("{domain}\\{}", self.user),
            AccountForm::Local => format!(".\\{}", self.user),
            AccountForm::Upn(domain) => format!("{}@{domain}", self.user),
        }
    }

    /// Name für `LookupAccountNameW`: `.` steht dort nicht für diesen Computer.
    pub fn lookup_name(&self, computer: &str) -> String {
        lookup_name_of(&self.service_name(), computer)
    }

    /// Benutzer und Domäne für `LogonUserW`: beim UPN steht alles im Benutzer, die Domäne fehlt.
    pub fn logon_parts(&self) -> (String, Option<String>) {
        match &self.form {
            AccountForm::Domain(domain) => (self.user.clone(), Some(domain.clone())),
            AccountForm::Local => (self.user.clone(), Some(".".to_owned())),
            AccountForm::Upn(_) => (self.service_name(), None),
        }
    }
}

impl fmt::Display for Account {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.service_name())
    }
}

/// Ein Kontoname, wie ihn der SCM liefert, für `LookupAccountNameW`: `.\Benutzer` wird
/// `<Computer>\Benutzer`, alles andere bleibt.
pub fn lookup_name_of(account: &str, computer: &str) -> String {
    match account.strip_prefix(r".\") {
        Some(user) if !computer.is_empty() => format!("{computer}\\{user}"),
        _ => account.to_owned(),
    }
}

fn check_user(user: &str) -> Result<(), String> {
    if user.is_empty() {
        return Err("der Benutzername fehlt".to_owned());
    }
    if user.trim() != user {
        return Err("Leerzeichen am Anfang oder Ende".to_owned());
    }
    if let Some(c) = user.chars().find(|c| FORBIDDEN_CHARS.contains(c)) {
        return Err(format!(
            "das Zeichen {c} ist im Benutzernamen nicht erlaubt"
        ));
    }
    if user.chars().all(|c| c == '.' || c == ' ') {
        return Err("der Benutzername besteht nur aus Punkten".to_owned());
    }
    Ok(())
}

fn check_domain(domain: &str) -> Result<(), String> {
    if domain.is_empty() {
        return Err("die Domäne fehlt".to_owned());
    }
    if let Some(c) = domain
        .chars()
        .find(|c| c.is_whitespace() || FORBIDDEN_CHARS.contains(c))
    {
        return Err(format!(
            "das Zeichen „{c}“ ist im Domänennamen nicht erlaubt"
        ));
    }
    if domain.starts_with(['.', '-']) || domain.ends_with(['.', '-']) || domain.contains("..") {
        return Err("der Domänenname ist ungültig".to_owned());
    }
    Ok(())
}

/// Nur Benutzerkonten (Domäne oder lokal) haben SIDs der Form `S-1-5-21-…`; Gruppen, eingebaute
/// und virtuelle Konten (`S-1-5-18`, `S-1-5-80-…`, `S-1-5-32-…` …) werden abgelehnt.
pub fn check_user_sid(account: &str, sid: &str, is_user: bool) -> Result<(), EplanError> {
    if is_user && sid.starts_with("S-1-5-21-") {
        Ok(())
    } else {
        Err(EplanError::NotAUser(account.to_owned()))
    }
}

/// Deutscher Grund zu einem Win32-Fehler von `LogonUserW`.
pub fn logon_failure_text(code: u32) -> String {
    match code {
        1326 => "Benutzername oder Passwort ist falsch".to_owned(),
        1327 => "Kontoeinschränkung (etwa leeres Passwort oder Anmeldezeiten)".to_owned(),
        1328 => "außerhalb der erlaubten Anmeldezeiten".to_owned(),
        1329 => "das Konto darf sich an diesem Computer nicht anmelden".to_owned(),
        1330 => "das Passwort ist abgelaufen".to_owned(),
        1331 => "das Konto ist deaktiviert".to_owned(),
        1311 => "kein Anmeldeserver erreichbar (Domänencontroller)".to_owned(),
        1385 => "das Recht „Als Dienst anmelden“ fehlt (eine Gruppenrichtlinie kann es entziehen)"
            .to_owned(),
        1793 => "das Konto ist abgelaufen".to_owned(),
        1907 => "das Passwort muss geändert werden".to_owned(),
        1909 => "das Konto ist gesperrt".to_owned(),
        code => format!("Windows-Fehler {code}"),
    }
}

// ---------------------------------------------------------------------------------------------
// Dienst-Parameter und Rechte
// ---------------------------------------------------------------------------------------------

/// Wie der Dienst `pds-eplan` angelegt wird.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServicePlan {
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub executable: PathBuf,
    /// `service --log-dir <Logordner>`: Der Worker schreibt seine Logs dorthin, wo diese Installation
    /// dem Konto die Rechte gibt und die Web-App sie liest (auch mit `PDS_DATA_DIR`).
    pub arguments: Vec<String>,
    /// Start automatisch, verzögert: EPLAN braucht Netzwerk und Lizenzserver.
    pub delayed_auto_start: bool,
    /// Wiederherstellung: je Fehler ein Neustart nach dieser Wartezeit.
    pub recovery: Vec<Duration>,
    pub recovery_reset: Duration,
    /// Die Wiederherstellung greift auch, wenn der Worker mit einem Fehlercode endet.
    pub failure_actions_on_non_crash: bool,
}

/// Parameter des Worker-Dienstes für diese Installation.
pub fn service_plan(paths: &Paths) -> ServicePlan {
    ServicePlan {
        name: EPLAN_SERVICE_NAME,
        display_name: EPLAN_SERVICE_DISPLAY_NAME,
        description: EPLAN_SERVICE_DESCRIPTION,
        executable: paths.eplan_exe(),
        arguments: vec![
            WORKER_ARGUMENT.to_owned(),
            "--log-dir".to_owned(),
            paths.logs_dir().display().to_string(),
        ],
        delayed_auto_start: true,
        recovery: RECOVERY_DELAYS.to_vec(),
        recovery_reset: RECOVERY_RESET,
        failure_actions_on_non_crash: true,
    }
}

/// Befehlszeile des Dienstes, wie sie im SCM steht: Pfad in Anführungszeichen (er enthält
/// Leerzeichen), dann die Argumente, mit Leerraum in Anführungszeichen.
pub fn command_line(plan: &ServicePlan) -> String {
    let mut line = format!("\"{}\"", plan.executable.display());
    for argument in &plan.arguments {
        line.push(' ');
        line.push_str(&quote_argument(argument));
    }
    line
}

/// Ein Argument nach den Regeln von CommandLineToArgvW: in Anführungszeichen, wenn es leer ist oder
/// Leerraum bzw. Anführungszeichen enthält; Backslashes vor einem Anführungszeichen (auch dem
/// schließenden) werden verdoppelt.
fn quote_argument(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
        return argument.to_owned();
    }
    let mut quoted = String::from('"');
    let mut backslashes = 0;
    for c in argument.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(c);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

/// Ein Recht des Worker-Kontos auf einem Ordner des Datenordners.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirGrant {
    pub dir: PathBuf,
    pub access: DirAccess,
}

/// Was das Worker-Konto im Datenordner darf: hochgeladene Projekte lesen, im Arbeitsordner und in
/// den Logs ändern. Sonst nichts (keine Konfiguration, keine Secrets, keine Datenbank).
pub fn acl_plan(paths: &Paths) -> Vec<DirGrant> {
    vec![
        DirGrant {
            dir: paths.uploads_dir(),
            access: DirAccess::Read,
        },
        DirGrant {
            dir: paths.work_dir(),
            access: DirAccess::Modify,
        },
        DirGrant {
            dir: paths.logs_dir(),
            access: DirAccess::Modify,
        },
    ]
}

/// SID des virtuellen Dienstkontos `NT SERVICE\<name>`: `S-1-5-80-` und SHA-1 des großgeschriebenen
/// Namens (UTF-16LE) als fünf Zahlen. So steht sie fest, auch bevor der Dienst existiert.
pub fn virtual_service_sid(name: &str) -> String {
    let bytes: Vec<u8> = name
        .to_uppercase()
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let digest = Sha1::digest(&bytes);
    let (chunks, _) = digest.as_chunks::<4>();
    let parts: Vec<String> = chunks
        .iter()
        .map(|chunk| u32::from_le_bytes(*chunk).to_string())
        .collect();
    format!("S-1-5-80-{}", parts.join("-"))
}

/// DACL des Worker-Dienstes: der Standard von Windows (SYSTEM steuert, Administratoren dürfen
/// alles, angemeldete Benutzer und Dienste fragen ab) und dazu für den Web-Dienst `pds_sid`
/// Abfragen, Starten und Stoppen – für „Worker neu starten“ in der Web-App.
pub fn service_sddl(pds_sid: &str) -> String {
    format!(
        "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)\
         (A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWRPWPLORC;;;{pds_sid})"
    )
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/// Zustand des Workers für `pds status`, `pds eplan status` und die UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EplanStatus {
    /// Angaben des SCM zu `pds-eplan` (Zustand, Start, Konto); `None`, wenn nicht abfragbar (ohne
    /// Windows oder ohne Rechte).
    pub service: Option<ScmInfo>,
    /// `eplan\pds-eplan.exe` liegt im Installationsordner; fehlt in einem MSI ohne Worker.
    pub worker_present: bool,
    /// Pfad des Programms, zur Anzeige.
    pub executable: String,
}

impl EplanStatus {
    /// Der Dienst `pds-eplan` existiert.
    pub fn installed(&self) -> bool {
        self.service
            .as_ref()
            .is_some_and(|service| service.state != ScmState::NotInstalled)
    }
}

/// Ergebnis von [`install`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EplanInstallOutcome {
    /// Der Dienst wurde neu angelegt; sonst wurden Konto und Passwort geändert.
    pub created: bool,
    /// Konto, unter dem der Dienst jetzt läuft (wie der SCM es anzeigt).
    pub account: String,
    /// Der Dienst wurde gestartet.
    pub started: bool,
    /// Eingerichtet, aber mit Einschränkung oder Hinweis (Rechte, Start). Deutsch, für Admins.
    pub warnings: Vec<String>,
}

/// Ergebnis von [`uninstall`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UninstallOutcome {
    /// Der Dienst war eingerichtet und ist jetzt entfernt.
    pub removed: bool,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------------------------
// Abläufe
// ---------------------------------------------------------------------------------------------

/// Die Windows-Aufrufe der Abläufe. [`SystemHost`] ist der echte Rechner.
pub trait Host {
    /// Name dieses Computers (für `.\Benutzer`).
    fn computer_name(&self) -> String;
    /// SID (`S-1-…`) und ob es ein Benutzerkonto ist; `None`, wenn es das Konto nicht gibt.
    fn lookup_account(&self, name: &str) -> Result<Option<(String, bool)>, PlatformError>;
    fn grant_service_logon(&self, sid: &str) -> Result<(), PlatformError>;
    /// Meldet sich mit dem Anmeldetyp „Dienst“ an und gleich wieder ab;
    /// [`PlatformError::LogonFailed`], wenn Windows ablehnt.
    fn check_logon(
        &self,
        user: &str,
        domain: Option<&str>,
        password: &Secret,
    ) -> Result<(), PlatformError>;
    fn query(&self) -> Result<ScmInfo, PlatformError>;
    /// Legt den Dienst an (`true`) oder ändert ihn (`false`), samt Start, Beschreibung und
    /// Wiederherstellung.
    fn configure(
        &self,
        plan: &ServicePlan,
        account: &str,
        password: &Secret,
    ) -> Result<bool, PlatformError>;
    fn set_service_security(&self, sddl: &str) -> Result<(), PlatformError>;
    fn secure_data(&self, paths: &Paths) -> Result<SecureOutcome, PlatformError>;
    fn propagate_data(&self, paths: &Paths) -> Result<Vec<String>, PlatformError>;
    fn start(&self) -> Result<(), PlatformError>;
    fn stop(&self, timeout: Duration) -> Result<(), PlatformError>;
    /// Entfernt den Dienst; `false`, wenn es ihn nicht gab.
    fn delete(&self) -> Result<bool, PlatformError>;
}

/// Der echte Rechner: [`crate::platform`].
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemHost;

impl Host for SystemHost {
    fn computer_name(&self) -> String {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }

    fn lookup_account(&self, name: &str) -> Result<Option<(String, bool)>, PlatformError> {
        platform::eplan::lookup_account(name)
    }

    fn grant_service_logon(&self, sid: &str) -> Result<(), PlatformError> {
        platform::eplan::add_account_right(sid, SERVICE_LOGON_RIGHT)
    }

    fn check_logon(
        &self,
        user: &str,
        domain: Option<&str>,
        password: &Secret,
    ) -> Result<(), PlatformError> {
        platform::eplan::check_logon(user, domain, password)
    }

    fn query(&self) -> Result<ScmInfo, PlatformError> {
        platform::scm::query_service(EPLAN_SERVICE_NAME)
    }

    fn configure(
        &self,
        plan: &ServicePlan,
        account: &str,
        password: &Secret,
    ) -> Result<bool, PlatformError> {
        platform::eplan::configure_service(plan, account, password)
    }

    fn set_service_security(&self, sddl: &str) -> Result<(), PlatformError> {
        platform::eplan::set_service_security(EPLAN_SERVICE_NAME, sddl)
    }

    fn secure_data(&self, paths: &Paths) -> Result<SecureOutcome, PlatformError> {
        platform::secure_data_dir(paths)
    }

    fn propagate_data(&self, paths: &Paths) -> Result<Vec<String>, PlatformError> {
        platform::propagate_data_rights(paths).map(|outcome| outcome.warnings)
    }

    fn start(&self) -> Result<(), PlatformError> {
        platform::scm::start_service(EPLAN_SERVICE_NAME)
    }

    fn stop(&self, timeout: Duration) -> Result<(), PlatformError> {
        platform::scm::stop_service(EPLAN_SERVICE_NAME, timeout)
    }

    fn delete(&self) -> Result<bool, PlatformError> {
        platform::eplan::delete_service(EPLAN_SERVICE_NAME)
    }
}

/// Zustand des Workers. Scheitert die Abfrage, fehlt nur `service`.
pub fn status(host: &dyn Host, paths: &Paths) -> EplanStatus {
    let executable = paths.eplan_exe();
    EplanStatus {
        service: host.query().ok(),
        worker_present: executable.is_file(),
        executable: executable.display().to_string(),
    }
}

/// Richtet den Worker-Dienst unter `account` ein oder ändert Konto und Passwort eines vorhandenen:
///
/// 1. prüfen, ohne etwas zu ändern: Passwort, Programm, Datenordner, Konto (muss ein
///    Benutzerkonto sein);
/// 2. Recht „Als Dienst anmelden“ gewähren und die Anmeldung mit Konto und Passwort vorab prüfen –
///    scheitert sie, bleibt der Dienst unverändert ([`EplanError::LogonFailed`]);
/// 3. Dienst stoppen (falls er läuft), anlegen bzw. ändern (automatisch verzögert,
///    Wiederherstellung), Dienst-DACL für `NT SERVICE\pds`;
/// 4. Ordnerrechte setzen und an vorhandene Dateien weitergeben, Dienst starten. Was hier scheitert,
///    steht in den Warnungen; eingerichtet ist der Dienst dann trotzdem.
pub fn install(
    host: &dyn Host,
    paths: &Paths,
    account: &Account,
    password: &Secret,
) -> Result<EplanInstallOutcome, EplanError> {
    if password.is_empty() {
        return Err(EplanError::PasswordMissing);
    }
    let plan = service_plan(paths);
    if !plan.executable.is_file() {
        return Err(EplanError::WorkerMissing(plan.executable));
    }
    if !paths.data_dir.is_dir() {
        return Err(EplanError::DataDirMissing);
    }
    let name = account.service_name();
    let (sid, is_user) = host
        .lookup_account(&account.lookup_name(&host.computer_name()))?
        .ok_or_else(|| EplanError::AccountNotFound(name.clone()))?;
    check_user_sid(&name, &sid, is_user)?;

    host.grant_service_logon(&sid)?;
    let (user, domain) = account.logon_parts();
    host.check_logon(&user, domain.as_deref(), password)
        .map_err(|error| match error {
            PlatformError::LogonFailed(code) => EplanError::LogonFailed {
                account: name.clone(),
                reason: logon_failure_text(code),
            },
            other => other.into(),
        })?;

    // Ab hier ändert sich der Dienst
    let before = host.query()?;
    if !matches!(before.state, ScmState::NotInstalled | ScmState::Stopped) {
        host.stop(STOP_TIMEOUT)?;
    }
    let created = host.configure(&plan, &name, password)?;
    host.set_service_security(&service_sddl(&virtual_service_sid(SERVICE_NAME)))?;

    let mut warnings = rights_step(host, paths);
    let started = match host.start() {
        Ok(()) => true,
        Err(error) => {
            warnings.push(format!(
                "Der Dienst ließ sich nicht starten: {error} – Ereignisanzeige (System) und \
                 `pds eplan status` prüfen"
            ));
            false
        }
    };
    Ok(EplanInstallOutcome {
        created,
        account: name,
        started,
        warnings,
    })
}

/// Ordnerrechte nach einer Änderung des Kontos: Datenordner neu einrichten (mit dem Konto, das der
/// SCM jetzt nennt) und an vorhandene Dateien weitergeben. Fehler werden zu Warnungen.
fn rights_step(host: &dyn Host, paths: &Paths) -> Vec<String> {
    let mut warnings = Vec::new();
    match host.secure_data(paths) {
        Ok(outcome) => {
            warnings.extend(outcome.warnings);
            if !outcome.removed_aces.is_empty() {
                warnings.push(format!(
                    "Bisherige Rechte im Datenordner entfernt: {}",
                    outcome.removed_aces.join("; ")
                ));
            }
        }
        Err(error) => warnings.push(format!(
            "Ordnerrechte nicht gesetzt: {error} – `pds setup install` als Administrator \
             wiederholt das"
        )),
    }
    match host.propagate_data(paths) {
        Ok(more) => warnings.extend(more),
        Err(error) => warnings.push(format!(
            "Rechte vorhandener Dateien in uploads, work und logs nicht angepasst: {error}"
        )),
    }
    warnings
}

/// Stoppt und entfernt den Worker-Dienst und nimmt seinem Konto die Ordnerrechte. Gibt es ihn
/// nicht, ist das kein Fehler. Das Recht „Als Dienst anmelden“ bleibt beim Konto: Es kann anderen
/// Diensten gehören.
pub fn uninstall(host: &dyn Host, paths: &Paths) -> Result<UninstallOutcome, EplanError> {
    if !remove(host)? {
        return Ok(UninstallOutcome::default());
    }
    let warnings = if paths.data_dir.is_dir() {
        rights_step(host, paths)
    } else {
        Vec::new()
    };
    Ok(UninstallOutcome {
        removed: true,
        warnings,
    })
}

/// Nur stoppen und entfernen, ohne die Ordnerrechte anzufassen: für `setup uninstall`, wenn das MSI
/// den Dienst `pds` (und damit dessen Konto) schon entfernt hat. `false`, wenn es den Worker nicht
/// gab.
pub fn remove(host: &dyn Host) -> Result<bool, EplanError> {
    if host.query()?.state == ScmState::NotInstalled {
        return Ok(false);
    }
    host.stop(STOP_TIMEOUT)?;
    Ok(host.delete()?)
}

/// Steuerbefehle für den eingerichteten Worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Start,
    Stop,
    Restart,
}

/// Startet, stoppt oder startet den Worker neu; ohne eingerichteten Dienst
/// [`EplanError::NotInstalled`].
pub fn control(host: &dyn Host, action: Control) -> Result<(), EplanError> {
    if host.query()?.state == ScmState::NotInstalled {
        return Err(EplanError::NotInstalled);
    }
    match action {
        Control::Start => host.start()?,
        Control::Stop => host.stop(STOP_TIMEOUT)?,
        Control::Restart => {
            host.stop(STOP_TIMEOUT)?;
            host.start()?;
        }
    }
    Ok(())
}

/// Nach einem Update (`setup install`): einen eingerichteten, nicht deaktivierten Worker wieder
/// starten. `Ok(true)`, wenn er gestartet wurde; `Ok(false)` ohne Worker oder wenn er deaktiviert
/// ist.
pub fn start_after_update(host: &dyn Host) -> Result<bool, EplanError> {
    let info = host.query()?;
    if info.state == ScmState::NotInstalled || info.start_type == "disabled" {
        return Ok(false);
    }
    host.start()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;
    use std::path::Path;

    use tempfile::TempDir;

    use super::*;

    // -- Konto -----------------------------------------------------------------------------------

    #[test]
    fn parses_the_three_forms() {
        let domain = Account::parse(r" EXAMPLE\svc-eplan ").unwrap();
        assert_eq!(domain.form, AccountForm::Domain("EXAMPLE".into()));
        assert_eq!(domain.user, "svc-eplan");
        assert_eq!(domain.to_string(), r"EXAMPLE\svc-eplan");

        let local = Account::parse(r".\eplan").unwrap();
        assert_eq!(local.form, AccountForm::Local);
        assert_eq!(local.service_name(), r".\eplan");

        let upn = Account::parse("svc.eplan@corp.example.com").unwrap();
        assert_eq!(upn.form, AccountForm::Upn("corp.example.com".into()));
        assert_eq!(upn.user, "svc.eplan");
        assert_eq!(upn.service_name(), "svc.eplan@corp.example.com");

        // DNS-Name als Domäne
        let dns = Account::parse(r"corp.example.com\svc-eplan").unwrap();
        assert_eq!(dns.form, AccountForm::Domain("corp.example.com".into()));
    }

    #[test]
    fn rejects_builtin_and_virtual_accounts() {
        for text in [
            "LocalSystem",
            r".\LocalSystem",
            "SYSTEM",
            "NetworkService",
            r"NT AUTHORITY\SYSTEM",
            r"nt authority\NetworkService",
            r"NT-AUTORITÄT\Netzwerkdienst",
            r"NT SERVICE\pds",
            r"NT SERVICE\pds-eplan",
            r"BUILTIN\Administrators",
            r"VORDEFINIERT\Administratoren",
            r"IIS APPPOOL\DefaultAppPool",
        ] {
            assert!(
                matches!(Account::parse(text), Err(EplanError::BuiltinAccount(_))),
                "{text}"
            );
        }
    }

    #[test]
    fn rejects_managed_and_computer_accounts() {
        for text in [
            r"EXAMPLE\gmsa-eplan$",
            r"EXAMPLE\SERVER01$",
            "gmsa$@example.com",
        ] {
            assert!(
                matches!(Account::parse(text), Err(EplanError::ManagedAccount(_))),
                "{text}"
            );
        }
    }

    #[test]
    fn rejects_invalid_names() {
        assert_eq!(Account::parse("  "), Err(EplanError::AccountMissing));
        for text in [
            "eplan",
            r"EXAMPLE\",
            r"\eplan",
            r"EXAMPLE\a\b",
            r"EXAMPLE\a*b",
            // Leerzeichen am Anfang des Benutzernamens (im Namen sind sie erlaubt)
            r"EXAMPLE\ eplan",
            r"EX AMPLE\eplan",
            r"EXAMPLE\...",
            "@example.com",
            "eplan@",
            "eplan@.example.com",
            "eplan@example..com",
            "a\u{7}b@example.com",
        ] {
            let result = Account::parse(text);
            assert!(
                matches!(result, Err(EplanError::AccountInvalid(..))),
                "{text}: {result:?}"
            );
        }
        let long = format!(r"EXAMPLE\{}", "a".repeat(300));
        assert!(matches!(
            Account::parse(&long),
            Err(EplanError::AccountInvalid(..))
        ));
        // Der Hinweis nennt die richtige Schreibweise
        let message = Account::parse("eplan").unwrap_err().to_string();
        assert!(message.contains(r".\eplan"), "{message}");
        assert!(message.contains(r"DOMÄNE\eplan"), "{message}");
    }

    #[test]
    fn lookup_and_logon_names() {
        let local = Account::parse(r".\eplan").unwrap();
        assert_eq!(local.lookup_name("SERVER01"), r"SERVER01\eplan");
        assert_eq!(local.logon_parts(), ("eplan".into(), Some(".".into())));

        let domain = Account::parse(r"EXAMPLE\eplan").unwrap();
        assert_eq!(domain.lookup_name("SERVER01"), r"EXAMPLE\eplan");
        assert_eq!(
            domain.logon_parts(),
            ("eplan".into(), Some("EXAMPLE".into()))
        );

        let upn = Account::parse("eplan@example.com").unwrap();
        assert_eq!(upn.lookup_name("SERVER01"), "eplan@example.com");
        assert_eq!(upn.logon_parts(), ("eplan@example.com".into(), None));

        // Ohne Computername bleibt `.` stehen
        assert_eq!(lookup_name_of(r".\eplan", ""), r".\eplan");
    }

    #[test]
    fn only_user_sids_are_accepted() {
        assert!(check_user_sid("a", "S-1-5-21-1-2-3-1104", true).is_ok());
        for (sid, is_user) in [
            ("S-1-5-21-1-2-3-513", false),
            ("S-1-5-18", true),
            ("S-1-5-80-1-2-3-4-5", true),
            ("S-1-5-32-544", false),
            ("S-1-12-1-1-2-3-4", true),
        ] {
            assert_eq!(
                check_user_sid("a", sid, is_user),
                Err(EplanError::NotAUser("a".into())),
                "{sid}"
            );
        }
    }

    #[test]
    fn logon_failures_have_german_reasons() {
        assert_eq!(
            logon_failure_text(1326),
            "Benutzername oder Passwort ist falsch"
        );
        assert!(logon_failure_text(1909).contains("gesperrt"));
        assert!(logon_failure_text(1385).contains("Als Dienst anmelden"));
        assert_eq!(logon_failure_text(42), "Windows-Fehler 42");
    }

    // -- Dienst und Rechte -----------------------------------------------------------------------

    #[test]
    fn service_plan_for_this_installation() {
        let paths = Paths::new(r"/inst", "/daten");
        let plan = service_plan(&paths);

        assert_eq!(plan.name, "pds-eplan");
        assert_eq!(plan.executable, Path::new("/inst/eplan/pds-eplan.exe"));
        assert_eq!(plan.arguments, ["service", "--log-dir", "/daten/logs"]);
        assert!(plan.delayed_auto_start);
        assert!(plan.failure_actions_on_non_crash);
        assert_eq!(
            plan.recovery,
            [10, 30, 60].map(Duration::from_secs).to_vec()
        );
        assert_eq!(plan.recovery_reset, Duration::from_secs(86_400));
        assert_eq!(
            command_line(&plan),
            "\"/inst/eplan/pds-eplan.exe\" service --log-dir /daten/logs"
        );
    }

    #[test]
    fn quote_argument_follows_windows_rules() {
        assert_eq!(quote_argument("service"), "service");
        assert_eq!(quote_argument(""), "\"\"");
        assert_eq!(
            quote_argument(r"C:\ProgramData\EPLAN Panel Data Service\logs"),
            r#""C:\ProgramData\EPLAN Panel Data Service\logs""#
        );
        // Ein abschließender Backslash würde sonst das schließende Anführungszeichen maskieren
        assert_eq!(quote_argument(r"C:\A B\"), r#""C:\A B\\""#);
        assert_eq!(quote_argument(r#"a "b""#), r#""a \"b\"""#);
    }

    #[test]
    fn acl_plan_reads_uploads_and_changes_work_and_logs() {
        let paths = Paths::new("/inst", "/daten");
        assert_eq!(
            acl_plan(&paths),
            [
                DirGrant {
                    dir: PathBuf::from("/daten/uploads"),
                    access: DirAccess::Read,
                },
                DirGrant {
                    dir: PathBuf::from("/daten/work"),
                    access: DirAccess::Modify,
                },
                DirGrant {
                    dir: PathBuf::from("/daten/logs"),
                    access: DirAccess::Modify,
                },
            ]
        );
    }

    #[test]
    fn virtual_service_sid_matches_windows() {
        // Bekannte SID von NT SERVICE\TrustedInstaller
        assert_eq!(
            virtual_service_sid("TrustedInstaller"),
            "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
        );
        // Groß-/Kleinschreibung spielt keine Rolle
        assert_eq!(virtual_service_sid("pds"), virtual_service_sid("PDS"));
        assert_eq!(
            virtual_service_sid("pds"),
            "S-1-5-80-1545110108-1806417553-1220071408-3039100996-914646944"
        );
    }

    #[test]
    fn service_sddl_lets_the_web_service_query_start_and_stop() {
        let sid = virtual_service_sid("pds");
        let sddl = service_sddl(&sid);
        let entry = format!("(A;;CCLCSWRPWPLORC;;;{sid})");
        assert!(sddl.ends_with(&entry), "{sddl}");
        // Abfragen (CC, LC), Starten (RP), Stoppen (WP) – aber nicht ändern, löschen oder Rechte setzen
        let rights = "CCLCSWRPWPLORC";
        for forbidden in ["DC", "SD", "WD", "WO"] {
            assert!(!rights.contains(forbidden), "{forbidden}");
        }
        // Administratoren behalten alles
        assert!(sddl.contains("(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)"));
    }

    // -- Abläufe mit einem Ersatz-Rechner ----------------------------------------------------------

    /// Zeichnet die Aufrufe auf; Verhalten über die Felder.
    struct FakeHost {
        calls: RefCell<Vec<String>>,
        state: RefCell<ScmState>,
        start_type: &'static str,
        account: Option<(String, bool)>,
        logon_error: Option<u32>,
        start_fails: bool,
        removed_aces: Vec<String>,
    }

    impl FakeHost {
        fn new(state: ScmState) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                state: RefCell::new(state),
                start_type: "auto",
                account: Some(("S-1-5-21-1-2-3-1104".into(), true)),
                logon_error: None,
                start_fails: false,
                removed_aces: Vec::new(),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }

        fn record(&self, call: impl Into<String>) {
            self.calls.borrow_mut().push(call.into());
        }
    }

    impl Host for FakeHost {
        fn computer_name(&self) -> String {
            "SERVER01".into()
        }

        fn lookup_account(&self, name: &str) -> Result<Option<(String, bool)>, PlatformError> {
            self.record(format!("lookup {name}"));
            Ok(self.account.clone())
        }

        fn grant_service_logon(&self, sid: &str) -> Result<(), PlatformError> {
            self.record(format!("grant {sid}"));
            Ok(())
        }

        fn check_logon(
            &self,
            user: &str,
            domain: Option<&str>,
            password: &Secret,
        ) -> Result<(), PlatformError> {
            assert_eq!(password.expose(), "Pässwort 1!");
            self.record(format!("logon {user} {}", domain.unwrap_or("-")));
            match self.logon_error {
                Some(code) => Err(PlatformError::LogonFailed(code)),
                None => Ok(()),
            }
        }

        fn query(&self) -> Result<ScmInfo, PlatformError> {
            let state = *self.state.borrow();
            Ok(ScmInfo {
                state,
                start_type: self.start_type.into(),
                delayed: true,
                account: r"EXAMPLE\alt".into(),
            })
        }

        fn configure(
            &self,
            plan: &ServicePlan,
            account: &str,
            password: &Secret,
        ) -> Result<bool, PlatformError> {
            assert_eq!(password.expose(), "Pässwort 1!");
            assert_eq!(plan.name, "pds-eplan");
            self.record(format!("configure {account}"));
            let created = *self.state.borrow() == ScmState::NotInstalled;
            *self.state.borrow_mut() = ScmState::Stopped;
            Ok(created)
        }

        fn set_service_security(&self, sddl: &str) -> Result<(), PlatformError> {
            assert_eq!(sddl, service_sddl(&virtual_service_sid("pds")));
            self.record("service-dacl");
            Ok(())
        }

        fn secure_data(&self, _paths: &Paths) -> Result<SecureOutcome, PlatformError> {
            self.record("secure");
            Ok(SecureOutcome {
                removed_aces: self.removed_aces.clone(),
                ..SecureOutcome::default()
            })
        }

        fn propagate_data(&self, _paths: &Paths) -> Result<Vec<String>, PlatformError> {
            self.record("propagate");
            Ok(Vec::new())
        }

        fn start(&self) -> Result<(), PlatformError> {
            self.record("start");
            if self.start_fails {
                return Err(PlatformError::ServiceTimeout);
            }
            *self.state.borrow_mut() = ScmState::Running;
            Ok(())
        }

        fn stop(&self, timeout: Duration) -> Result<(), PlatformError> {
            assert_eq!(timeout, STOP_TIMEOUT);
            self.record("stop");
            *self.state.borrow_mut() = ScmState::Stopped;
            Ok(())
        }

        fn delete(&self) -> Result<bool, PlatformError> {
            self.record("delete");
            *self.state.borrow_mut() = ScmState::NotInstalled;
            Ok(true)
        }
    }

    /// Installation mit Worker und Datenordner.
    fn installed() -> (TempDir, Paths) {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path().join("inst"), dir.path().join("daten"));
        fs::create_dir_all(paths.eplan_exe().parent().unwrap()).unwrap();
        fs::write(paths.eplan_exe(), b"MZ").unwrap();
        fs::create_dir_all(&paths.data_dir).unwrap();
        (dir, paths)
    }

    fn password() -> Secret {
        Secret::new("Pässwort 1!")
    }

    #[test]
    fn install_creates_the_service_in_order() {
        let (_dir, paths) = installed();
        let host = FakeHost::new(ScmState::NotInstalled);
        let account = Account::parse(r".\eplan").unwrap();

        let outcome = install(&host, &paths, &account, &password()).unwrap();

        assert_eq!(
            host.calls(),
            [
                r"lookup SERVER01\eplan",
                "grant S-1-5-21-1-2-3-1104",
                "logon eplan .",
                r"configure .\eplan",
                "service-dacl",
                "secure",
                "propagate",
                "start",
            ]
        );
        assert_eq!(
            outcome,
            EplanInstallOutcome {
                created: true,
                account: r".\eplan".into(),
                started: true,
                warnings: Vec::new(),
            }
        );
    }

    #[test]
    fn install_stops_a_running_service_before_changing_it() {
        let (_dir, paths) = installed();
        let mut host = FakeHost::new(ScmState::Running);
        host.removed_aces = vec![r"work: EXAMPLE\alt (S-1-5-21-1-2-3-1100)".into()];
        let account = Account::parse("eplan@example.com").unwrap();

        let outcome = install(&host, &paths, &account, &password()).unwrap();

        let calls = host.calls();
        let stop = calls.iter().position(|call| call == "stop").unwrap();
        let configure = calls
            .iter()
            .position(|call| call.starts_with("configure"))
            .unwrap();
        assert!(stop < configure, "{calls:?}");
        assert!(calls.contains(&"logon eplan@example.com -".to_owned()));
        assert!(!outcome.created);
        // Die Rechte des alten Kontos fallen weg; das steht als Hinweis da
        assert!(
            outcome.warnings[0].contains(r"EXAMPLE\alt"),
            "{:?}",
            outcome.warnings
        );
    }

    #[test]
    fn wrong_password_changes_nothing() {
        let (_dir, paths) = installed();
        let mut host = FakeHost::new(ScmState::Running);
        host.logon_error = Some(1326);
        let account = Account::parse(r"EXAMPLE\eplan").unwrap();

        let error = install(&host, &paths, &account, &password()).unwrap_err();

        assert_eq!(error.code(), "eplan_logon_failed");
        let message = error.to_string();
        assert!(message.contains("Passwort ist falsch"), "{message}");
        assert!(!message.contains("Pässwort"), "{message}");
        assert_eq!(
            host.calls(),
            [
                r"lookup EXAMPLE\eplan",
                "grant S-1-5-21-1-2-3-1104",
                "logon eplan EXAMPLE",
            ]
        );
        assert_eq!(*host.state.borrow(), ScmState::Running);
    }

    #[test]
    fn install_checks_before_touching_anything() {
        let (dir, paths) = installed();
        let account = Account::parse(r"EXAMPLE\eplan").unwrap();

        // Leeres Passwort
        let host = FakeHost::new(ScmState::NotInstalled);
        assert_eq!(
            install(&host, &paths, &account, &Secret::new("")),
            Err(EplanError::PasswordMissing)
        );
        // Konto unbekannt
        let mut host = FakeHost::new(ScmState::NotInstalled);
        host.account = None;
        assert_eq!(
            install(&host, &paths, &account, &password()).unwrap_err(),
            EplanError::AccountNotFound(r"EXAMPLE\eplan".into())
        );
        // Gruppe statt Benutzer
        let mut host = FakeHost::new(ScmState::NotInstalled);
        host.account = Some(("S-1-5-21-1-2-3-513".into(), false));
        assert_eq!(
            install(&host, &paths, &account, &password())
                .unwrap_err()
                .code(),
            "eplan_account_not_user"
        );
        assert_eq!(host.calls(), [r"lookup EXAMPLE\eplan"]);

        // MSI ohne Worker
        fs::remove_file(paths.eplan_exe()).unwrap();
        let host = FakeHost::new(ScmState::NotInstalled);
        assert_eq!(
            install(&host, &paths, &account, &password())
                .unwrap_err()
                .code(),
            "eplan_worker_missing"
        );
        assert!(host.calls().is_empty());

        // Ohne Datenordner
        let paths = Paths::new(paths.install_dir.clone(), dir.path().join("fehlt"));
        fs::write(paths.eplan_exe(), b"MZ").unwrap();
        assert_eq!(
            install(&host, &paths, &account, &password()),
            Err(EplanError::DataDirMissing)
        );
    }

    #[test]
    fn failed_start_is_a_warning_not_an_error() {
        let (_dir, paths) = installed();
        let mut host = FakeHost::new(ScmState::NotInstalled);
        host.start_fails = true;
        let account = Account::parse(r"EXAMPLE\eplan").unwrap();

        let outcome = install(&host, &paths, &account, &password()).unwrap();

        assert!(!outcome.started);
        assert!(outcome.warnings[0].contains("nicht starten"));
    }

    #[test]
    fn uninstall_stops_deletes_and_resets_rights() {
        let (_dir, paths) = installed();
        let host = FakeHost::new(ScmState::Running);

        let outcome = uninstall(&host, &paths).unwrap();

        assert!(outcome.removed);
        assert_eq!(host.calls(), ["stop", "delete", "secure", "propagate"]);

        // Nicht eingerichtet: nichts zu tun
        let host = FakeHost::new(ScmState::NotInstalled);
        assert_eq!(
            uninstall(&host, &paths).unwrap(),
            UninstallOutcome::default()
        );
        assert!(host.calls().is_empty());
    }

    #[test]
    fn remove_leaves_the_rights_alone() {
        let host = FakeHost::new(ScmState::Stopped);
        assert!(remove(&host).unwrap());
        assert_eq!(host.calls(), ["stop", "delete"]);

        let host = FakeHost::new(ScmState::NotInstalled);
        assert!(!remove(&host).unwrap());
        assert!(host.calls().is_empty());
    }

    #[test]
    fn control_needs_an_installed_service() {
        let host = FakeHost::new(ScmState::NotInstalled);
        assert_eq!(
            control(&host, Control::Start),
            Err(EplanError::NotInstalled)
        );

        let host = FakeHost::new(ScmState::Running);
        control(&host, Control::Restart).unwrap();
        control(&host, Control::Stop).unwrap();
        control(&host, Control::Start).unwrap();
        assert_eq!(host.calls(), ["stop", "start", "stop", "start"]);
    }

    #[test]
    fn start_after_update_skips_missing_and_disabled_workers() {
        let host = FakeHost::new(ScmState::NotInstalled);
        assert!(!start_after_update(&host).unwrap());

        let mut host = FakeHost::new(ScmState::Stopped);
        host.start_type = "disabled";
        assert!(!start_after_update(&host).unwrap());
        assert!(host.calls().is_empty());

        let host = FakeHost::new(ScmState::Stopped);
        assert!(start_after_update(&host).unwrap());
        assert_eq!(host.calls(), ["start"]);
    }

    #[test]
    fn status_reports_service_and_worker_file() {
        let (_dir, paths) = installed();
        let host = FakeHost::new(ScmState::Running);

        let status = status(&host, &paths);

        assert!(status.worker_present);
        assert!(status.installed());
        assert_eq!(status.executable, paths.eplan_exe().display().to_string());

        // Ohne Windows ist der SCM nicht abfragbar
        let status = super::status(&SystemHost, &paths);
        if cfg!(not(windows)) {
            assert_eq!(status.service, None);
            assert!(!status.installed());
        }
    }

    #[test]
    fn error_codes_are_snake_case() {
        let errors = [
            EplanError::AccountMissing,
            EplanError::AccountInvalid(String::new(), String::new()),
            EplanError::BuiltinAccount(String::new()),
            EplanError::ManagedAccount(String::new()),
            EplanError::AccountNotFound(String::new()),
            EplanError::NotAUser(String::new()),
            EplanError::PasswordMissing,
            EplanError::LogonFailed {
                account: String::new(),
                reason: String::new(),
            },
            EplanError::WorkerMissing(PathBuf::new()),
            EplanError::DataDirMissing,
            EplanError::NotInstalled,
            EplanError::Platform(PlatformError::LogonFailed(1326)),
        ];
        for error in errors {
            let code = error.code();
            assert!(
                code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
                "{code}"
            );
        }
    }
}
