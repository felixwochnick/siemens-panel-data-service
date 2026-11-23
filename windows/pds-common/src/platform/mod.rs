//! Anbindung an das Betriebssystem: DPAPI, ACL des Datenordners und des SQLite-Ordners,
//! Laufwerksart, Dienststeuerung (SCM), Ereignisprotokoll, Firewall, Portprüfung, Job Object und
//! Zertifikatspeicher.
//!
//! Die Windows-Teile stehen in `windows/`. Ohne Windows gibt es Ersatz mit derselben API, damit
//! Aufrufer und Tests unter Linux übersetzbar bleiben: Die Portprüfung bindet testweise,
//! `secure_data_dir` legt nur die Ordner an, Job Object und Ereignisprotokoll tun nichts, alles
//! andere meldet [`PlatformError::Unsupported`].

use std::borrow::Cow;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::OffsetDateTime;
use ts_rs::TS;

use crate::paths::Paths;
use crate::tls::TlsError;

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use self::windows::dpapi::DpapiProtector;
#[cfg(windows)]
pub use self::windows::job::JobObject;

// ---------------------------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------------------------

/// Fehler der Plattformfunktionen. UI und CLI zeigen den Text, Tests prüfen [`Self::code`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PlatformError {
    #[error("Unter diesem Betriebssystem nicht verfügbar.")]
    Unsupported,
    #[error("Zugriff verweigert. Bitte als Administrator ausführen.")]
    AccessDenied,
    /// Wie [`Self::AccessDenied`], mit dem betroffenen Pfad und ggf. einem Hinweis (etwa beiseite
    /// gelegte Ordner); derselbe Code.
    #[error("Zugriff verweigert: {0}. Bitte als Administrator ausführen.")]
    AccessDeniedAt(String),
    #[error("Der Dienst ist nicht installiert.")]
    ServiceNotInstalled,
    #[error("Der Dienst hat nicht rechtzeitig reagiert.")]
    ServiceTimeout,
    #[error(
        "Das Dienstkonto {account} existiert nicht. Ist der Dienst installiert?",
        account = crate::names::SERVICE_ACCOUNT
    )]
    AccountNotFound,
    #[error("Das Zertifikat wurde im Zertifikatspeicher des Computers nicht gefunden.")]
    CertificateNotFound,
    #[error("Der Fingerabdruck ist ungültig: erwartet werden 40 Hexadezimalzeichen.")]
    InvalidThumbprint,
    #[error("Der private Schlüssel des Zertifikats ist nicht exportierbar.")]
    NotExportable,
    #[error("Dateisystemfehler: {0}")]
    Io(String),
    /// Win32- oder COM-Fehler; `code` ist der HRESULT bzw. Win32-Fehlercode.
    #[error("{context} fehlgeschlagen: {message} (Code 0x{code:08X})")]
    Os {
        context: &'static str,
        code: u32,
        message: String,
    },
    #[error(transparent)]
    Tls(#[from] TlsError),
}

impl PlatformError {
    /// Stabiler Code für UI und CLI.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported => "platform_unsupported",
            Self::AccessDenied | Self::AccessDeniedAt(_) => "access_denied",
            Self::ServiceNotInstalled => "service_not_installed",
            Self::ServiceTimeout => "service_timeout",
            Self::AccountNotFound => "service_account_not_found",
            Self::CertificateNotFound => "certificate_not_found",
            Self::InvalidThumbprint => "certificate_thumbprint_invalid",
            Self::NotExportable => "certificate_not_exportable",
            Self::Io(_) => "platform_io_error",
            Self::Os { .. } => "platform_os_error",
            Self::Tls(error) => error.code(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Datenordner
// ---------------------------------------------------------------------------------------------

/// Ergebnis von [`secure_data_dir`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SecureOutcome {
    /// Nicht vertrauenswürdige Ordner (der Datenordner oder einer seiner Unterordner), die beiseite
    /// gelegt wurden, mit ihrem neuen Pfad. Gehört ins Ereignisprotokoll.
    pub moved_aside: Vec<PathBuf>,
    /// Zusätzliche Berechtigungen, die beim erneuten Setzen der Rechte weggefallen sind: Konto (Name
    /// und SID, soweit auflösbar), bei Unterordnern und Dateien mit vorangestelltem Ort
    /// (`config.toml: …`). Gehört als Warnung ins Ereignisprotokoll.
    pub removed_aces: Vec<String>,
}

/// Richtet Datenordner, `tls\`, `state\`, `logs\`, `caddy\` und `data\` (SQLite) ein. Idempotent.
///
/// Unter Windows (braucht SYSTEM oder Administratorrechte):
/// - Fehlt der Datenordner, entsteht er gleich mit seiner endgültigen Sicherheitsbeschreibung:
///   Besitzer Administratoren, geschützt, SYSTEM und Administratoren Vollzugriff, das Dienstkonto
///   Lesen. Die Unterordner sind ebenso geschützt (erben also nichts); in `state\`, `logs\`,
///   `caddy\` und `data\` bekommt das Dienstkonto statt Lesen Ändern.
/// - Ein vorhandener Datenordner wird übernommen, wenn er ein echter Ordner (kein Verweis) ist,
///   Administratoren oder SYSTEM gehört und eine geschützte DACL hat. Dann werden seine Rechte und
///   die der Unterordner erneut gesetzt, jeweils über das Handle, mit dem sie geprüft wurden, und
///   ohne Verteilung an vorhandene Kinder; die Konfiguration bleibt (Update). Zusätzliche Einträge
///   (etwa Lesen für ein Sicherungskonto) fallen dabei weg und stehen in
///   [`SecureOutcome::removed_aces`]. Dateien direkt im Datenordner (`config.toml`) bekommen wieder
///   genau die geerbten Einträge des Datenordners, sonst behielten sie Kopien der entfernten.
/// - Sonst (fremder Besitzer, ungeschützte DACL, Verweis, keine lesbare Sicherheitsbeschreibung)
///   wird er beiseite gelegt (`<Ordner> (unsicher JJJJMMTT-hhmmss-xxxx)`, Zeit in UTC) und neu
///   angelegt. Wer ihn vorher angelegt hat, behält so auch mit offenen Handles keinen Zugriff auf den
///   neuen Ordner. Unterordner, die Verweise, keine Ordner oder nicht zu öffnen sind, ebenso. Alles,
///   was sich nicht eindeutig lesen lässt, gilt als fremd.
/// - Einen eigenen Datenordner, dessen Rechte der Aufrufer nicht ändern darf (nicht erhöht), lässt
///   die Funktion unangetastet und meldet `access_denied`.
///
/// Ohne Windows nur die Ordner (es gibt dort keinen Produktivbetrieb).
pub fn secure_data_dir(paths: &Paths) -> Result<SecureOutcome, PlatformError> {
    #[cfg(windows)]
    {
        self::windows::acl::secure(paths)
    }
    #[cfg(not(windows))]
    {
        for dir in [
            paths.data_dir.clone(),
            paths.tls_dir(),
            paths.state_dir(),
            paths.logs_dir(),
            paths.caddy_dir(),
            paths.sqlite_dir(),
        ] {
            std::fs::create_dir_all(&dir)
                .map_err(|error| PlatformError::Io(format!("{}: {error}", dir.display())))?;
        }
        Ok(SecureOutcome::default())
    }
}

/// Wie [`secure_data_dir`], aber mit der SID (Text, `S-1-…`) eines anderen Kontos anstelle des
/// Dienstkontos. Nur für Tests, die ohne installierten Dienst laufen.
#[cfg(windows)]
#[doc(hidden)]
pub fn secure_data_dir_for_sid(paths: &Paths, sid: &str) -> Result<SecureOutcome, PlatformError> {
    self::windows::acl::secure_for_sid(paths, sid)
}

// ---------------------------------------------------------------------------------------------
// SQLite-Ordner und Laufwerke
// ---------------------------------------------------------------------------------------------

/// Ergebnis von [`prepare_sqlite_dir`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SqliteDirOutcome {
    /// Der Ordner der Datenbank wurde neu angelegt.
    pub created: Option<PathBuf>,
    /// Ordner und vorhandene Datenbankdateien, die dem Dienstkonto jetzt Ändern gewähren.
    pub granted: Vec<PathBuf>,
}

/// Bereitet den Ordner der SQLite-Datei `file` für das Dienstkonto vor. Idempotent; braucht
/// Administratorrechte. Den Pfad hat vorher die Validierung geprüft (lokal, kein Laufwerksstamm,
/// kein Systemordner).
///
/// Unter Windows:
/// - Der Standardordner `data\` entsteht wie `logs\` (geschützt, Dienstkonto Ändern), falls er fehlt;
///   sonst pflegt ihn `setup install`.
/// - Ein eigener Ordner, der fehlt, entsteht gleich mit geschützter DACL: SYSTEM und Administratoren
///   Vollzugriff, das Dienstkonto Ändern (fehlende Elternordner mit geerbten Rechten). Ein
///   vorhandener behält seine Rechte und bekommt nur einen vererbbaren Eintrag „Ändern“ für das
///   Dienstkonto, sofern es ihn noch nicht hat.
/// - Vorhandene Datenbankdateien (`<datei>`, `-wal`, `-shm`, `-journal`) bekommen denselben Eintrag
///   ohne Vererbung: Vererbung erreicht nur neue Dateien, eine hineinverschobene Datei behielte ihre
///   alten Rechte.
///
/// Rechte gehen wie beim Datenordner nur über Handles, die keinem Verweis folgen, und werden nicht an
/// Kinder verteilt. Ein Verweis oder eine Datei mit mehreren Namen wird abgelehnt. Ohne Windows tut
/// die Funktion nichts.
pub fn prepare_sqlite_dir(paths: &Paths, file: &Path) -> Result<SqliteDirOutcome, PlatformError> {
    #[cfg(windows)]
    {
        self::windows::acl::prepare_sqlite(paths, file)
    }
    #[cfg(not(windows))]
    {
        let _ = (paths, file);
        Ok(SqliteDirOutcome::default())
    }
}

/// Wie [`prepare_sqlite_dir`], mit der SID eines anderen Kontos. Nur für Tests.
#[cfg(windows)]
#[doc(hidden)]
pub fn prepare_sqlite_dir_for_sid(
    paths: &Paths,
    file: &Path,
    sid: &str,
) -> Result<SqliteDirOutcome, PlatformError> {
    self::windows::acl::prepare_sqlite_for_sid(paths, file, sid)
}

/// Art des Laufwerks, auf dem ein Pfad liegt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveKind {
    /// Lokal (Festplatte, Wechseldatenträger, RAM-Disk …).
    Local,
    /// Netzlaufwerk (verbundener Laufwerksbuchstabe).
    Remote,
    /// Den Laufwerksbuchstaben gibt es für diesen Prozess nicht.
    Missing,
    /// Nicht feststellbar: kein Laufwerksbuchstabe oder ohne Windows.
    Unknown,
}

/// Laufwerksart von `path` (`GetDriveTypeW` auf `X:\`). Ohne Windows immer [`DriveKind::Unknown`].
pub fn drive_kind(path: &Path) -> DriveKind {
    #[cfg(windows)]
    {
        self::windows::drive::kind(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        DriveKind::Unknown
    }
}

/// Wohin `path` tatsächlich führt (Verweise in jedem Teil, Kurznamen und `subst`-Laufwerke aufgelöst):
/// der nächste vorhandene Teil aufgelöst, der noch fehlende Rest angehängt. Ohne Windows oder wenn
/// sich nichts öffnen lässt `None`.
pub fn resolved_path(path: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        self::windows::drive::resolve(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// Ein Pfad aus `GetFinalPathNameByHandleW` ohne den Präfix `\\?\`: `\\?\C:\x` wird `C:\x`,
/// `\\?\UNC\server\x` wird `\\server\x` (so erkennt die Prüfung die Freigabe).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn without_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
}

/// Recht „Ändern“ als Zahl, wie Windows es in SDDL schreibt.
const MODIFY_MASK: u32 = 0x0013_01bf;

/// Ergänzt eine DACL in SDDL (`D:…`, wie Windows sie ausgibt) um „Ändern“ für `account` (SDDL-Form
/// der SID; `sid` ist die `S-1-…`-Form für den neuen Eintrag). `inheritable`: für Ordner, vererbt an
/// neue Dateien und Unterordner. Liefert `Some(None)`, wenn das Konto das Recht schon hat (auch
/// geerbt), `Some(Some(neu))` mit dem Eintrag nach den expliziten und vor den geerbten Einträgen
/// (kanonische Reihenfolge), `None`, wenn sich die DACL nicht eindeutig lesen lässt.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn dacl_with_modify(
    sddl: &str,
    account: &str,
    sid: &str,
    inheritable: bool,
) -> Option<Option<String>> {
    let parts = sddl_parts(sddl)?;
    let dacl = parts
        .iter()
        .find(|(tag, _)| *tag == 'D')
        .map(|(_, value)| *value)?;
    let (flags, aces) = dacl.split_at(dacl.find('(').unwrap_or(dacl.len()));
    dacl_protected(flags)?;
    let parsed = parse_aces(aces)?;
    let has_modify = parsed.iter().any(|ace| {
        let applies = !ace.flags.contains("IO")
            && (!inheritable || (ace.flags.contains("OI") && ace.flags.contains("CI")));
        ace.kind == "A" && !ace.object && ace.sid == account && applies && covers_modify(ace.rights)
    });
    if has_modify {
        return Some(None);
    }
    let inherit = if inheritable { "OICI" } else { "" };
    let entry = format!("(A;{inherit};0x{MODIFY_MASK:x};;;{sid})");
    // Vor dem ersten geerbten Eintrag (Flag `ID`), sonst ans Ende
    let insert_at = parsed
        .iter()
        .find(|ace| ace.flags.contains("ID"))
        .map_or(aces.len(), |ace| ace.start);
    Some(Some(format!(
        "D:{flags}{}{entry}{}",
        &aces[..insert_at],
        &aces[insert_at..]
    )))
}

/// Deckt ein Recht in SDDL (`FA`, `GA` oder `0x…`) mindestens „Ändern“ ab?
fn covers_modify(rights: &str) -> bool {
    match rights {
        "FA" | "GA" => true,
        _ => rights
            .strip_prefix("0x")
            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
            .is_some_and(|mask| mask & MODIFY_MASK == MODIFY_MASK),
    }
}

/// Ein Eintrag der DACL, der nicht zu den eigenen gehört (alles außer „Erlauben“ für SYSTEM,
/// Administratoren und das Dienstkonto).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExtraAce {
    /// Art in SDDL: `A` Erlauben, `D` Verweigern, `OA`/`XA` … Objekt- und bedingte Einträge.
    pub kind: String,
    /// Konto in SDDL-Form: Kürzel (`BU`) oder `S-1-…`.
    pub sid: String,
}

impl ExtraAce {
    /// Text für Log und Ereignisprotokoll; `principal` ist das aufgelöste Konto (`Name (SID)`).
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn describe(&self, principal: &str) -> String {
        match self.kind.as_str() {
            "A" => principal.to_owned(),
            "D" => format!("Verweigern für {principal}"),
            kind => format!("{kind}-Eintrag für {principal}"),
        }
    }
}

/// Was eine Sicherheitsbeschreibung (SDDL mit Besitzer und DACL, wie Windows sie ausgibt) über
/// einen vorhandenen Ordner sagt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SddlFacts {
    /// Besitzer Administratoren oder SYSTEM.
    pub owned: bool,
    /// Die DACL ist geschützt (erbt nichts vom Elternordner).
    pub protected: bool,
    /// Zusätzliche Einträge, ohne Doppelte, in der Reihenfolge der DACL.
    pub extra: Vec<ExtraAce>,
}

impl SddlFacts {
    /// Gehört der Ordner uns? Besitzer und Schutz entscheiden: Wer nicht Administrator ist, kann
    /// beides nicht so herstellen. Zusätzliche Einträge machen ihn nicht fremd, sie fallen beim
    /// erneuten Setzen der Rechte weg.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn trusted(&self) -> bool {
        self.owned && self.protected
    }
}

/// Liest Besitzer und DACL aus SDDL; `account` ist die SDDL-Form der Dienst-SID (`S-1-5-80-…`).
/// `None`, wenn sich die Beschreibung nicht eindeutig lesen lässt (gilt als fremd): ohne Besitzer
/// oder DACL, Null-DACL, unbekannte Flags, kaputte Einträge.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn sddl_facts(sddl: &str, account: &str) -> Option<SddlFacts> {
    let parts = sddl_parts(sddl)?;
    let owner = parts
        .iter()
        .find(|(tag, _)| *tag == 'O')
        .map(|(_, value)| *value)?;
    let dacl = parts
        .iter()
        .find(|(tag, _)| *tag == 'D')
        .map(|(_, value)| *value)?;
    let (flags, aces) = dacl.split_at(dacl.find('(').unwrap_or(dacl.len()));
    let protected = dacl_protected(flags)?;
    let mut extra: Vec<ExtraAce> = Vec::new();
    for ace in parse_aces(aces)? {
        let ours = ace.kind == "A"
            && !ace.object
            && (ace.sid == "SY" || ace.sid == "BA" || ace.sid == account);
        let entry = ExtraAce {
            kind: ace.kind.to_owned(),
            sid: ace.sid.to_owned(),
        };
        if !ours && !extra.contains(&entry) {
            extra.push(entry);
        }
    }
    Some(SddlFacts {
        owned: owner == "BA" || owner == "SY",
        protected,
        extra,
    })
}

/// Zerlegt SDDL in Teile (`O:`, `G:`, `D:`, `S:`). Werte enthalten keinen Doppelpunkt; der
/// Buchstabe vor dem nächsten `:` beginnt den nächsten Teil.
fn sddl_parts(sddl: &str) -> Option<Vec<(char, &str)>> {
    let mut parts = Vec::new();
    let mut rest = sddl;
    while !rest.is_empty() {
        let tag = rest.chars().next()?;
        if !matches!(tag, 'O' | 'G' | 'D' | 'S') || parts.iter().any(|(seen, _)| *seen == tag) {
            return None;
        }
        let body = rest.get(1..)?.strip_prefix(':')?;
        let end = body
            .find(':')
            .map_or(body.len(), |colon| colon.saturating_sub(1));
        // `get` statt Indexierung: kein Abbruch, falls vor dem `:` kein ASCII-Zeichen steht
        parts.push((tag, body.get(..end)?));
        rest = body.get(end..)?;
    }
    Some(parts)
}

/// Ist die DACL geschützt? Erlaubt sind nur die Flags `P` (geschützt), `AI` und `AR`; alles andere
/// (auch `NO_ACCESS_CONTROL`, die Null-DACL) ist `None`.
fn dacl_protected(flags: &str) -> Option<bool> {
    let mut rest = flags;
    let mut protected = false;
    while !rest.is_empty() {
        if let Some(tail) = rest.strip_prefix('P') {
            protected = true;
            rest = tail;
        } else {
            rest = rest
                .strip_prefix("AI")
                .or_else(|| rest.strip_prefix("AR"))?;
        }
    }
    Some(protected)
}

/// Ein Eintrag `(art;flags;rechte;objekt;geerbtes_objekt;konto[;(bedingung)])`.
struct Ace<'a> {
    kind: &'a str,
    flags: &'a str,
    rights: &'a str,
    /// Objekt-GUIDs gesetzt (Objekteintrag).
    object: bool,
    sid: &'a str,
    /// Position der öffnenden Klammer im Text der Einträge.
    start: usize,
}

/// Zerlegt die Einträge einer DACL; `None` bei allem, was nicht genau so aussieht. Bedingte Einträge
/// enthalten Klammern, deshalb wird die Tiefe gezählt.
fn parse_aces(aces: &str) -> Option<Vec<Ace<'_>>> {
    let mut parsed = Vec::new();
    let mut rest = aces;
    while !rest.is_empty() {
        let position = aces.len() - rest.len();
        let inner = rest.strip_prefix('(')?;
        let mut depth = 1usize;
        let mut close = None;
        let mut fields = Vec::new();
        let mut start = 0;
        for (index, c) in inner.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(index);
                        break;
                    }
                }
                ';' if depth == 1 => {
                    fields.push(&inner[start..index]);
                    start = index + 1;
                }
                _ => {}
            }
        }
        let close = close?;
        fields.push(&inner[start..close]);
        let (kind, flags, rights, object, inherited_object, sid) = match fields[..] {
            [kind, flags, rights, object, inherited_object, sid] => {
                (kind, flags, rights, object, inherited_object, sid)
            }
            // Bedingter Eintrag: die Bedingung steht in eigenen Klammern dahinter
            [
                kind,
                flags,
                rights,
                object,
                inherited_object,
                sid,
                condition,
            ] if condition.starts_with('(') => (kind, flags, rights, object, inherited_object, sid),
            _ => return None,
        };
        if kind.is_empty() || sid.is_empty() {
            return None;
        }
        parsed.push(Ace {
            kind,
            flags,
            rights,
            object: !object.is_empty() || !inherited_object.is_empty(),
            sid,
            start: position,
        });
        rest = &inner[close + 1..];
    }
    Some(parsed)
}

/// Neuer Name für einen beiseite gelegten Ordner neben dem alten:
/// `<Name> (unsicher JJJJMMTT-hhmmss-xxxx)`, mit Zeit (UTC) und 16 Zufallsbits gegen Kollisionen.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn aside_path(path: &Path, now: OffsetDateTime, tag: u16) -> Option<PathBuf> {
    let mut name = path.file_name()?.to_os_string();
    name.push(format!(
        " (unsicher {:04}{:02}{:02}-{:02}{:02}{:02}-{tag:04x})",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    ));
    Some(path.with_file_name(name))
}

// ---------------------------------------------------------------------------------------------
// Dienststeuerung
// ---------------------------------------------------------------------------------------------

/// Zustand des Dienstes im Service Control Manager.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ScmState {
    NotInstalled,
    Stopped,
    StartPending,
    Running,
    StopPending,
    /// Pausiert oder ein Fortsetzen/Pausieren läuft; der Dienst selbst kennt das nicht.
    Other,
}

/// Angaben des SCM zum Dienst für UI und CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScmInfo {
    pub state: ScmState,
    /// `auto`, `manual`, `disabled` (bzw. `boot`/`system` bei Treibern); leer, wenn nicht installiert.
    pub start_type: String,
    /// Automatischer Start mit Verzögerung.
    pub delayed: bool,
    /// Konto, unter dem der Dienst läuft; leer, wenn nicht installiert.
    pub account: String,
}

impl ScmInfo {
    pub fn not_installed() -> Self {
        Self {
            state: ScmState::NotInstalled,
            start_type: String::new(),
            delayed: false,
            account: String::new(),
        }
    }
}

/// Start, Stopp und Abfrage des Dienstes `pds`. Wartezeiten haben immer eine
/// Obergrenze; ein hängender Dienst führt zu [`PlatformError::ServiceTimeout`].
pub mod scm {
    #[cfg(windows)]
    pub use super::windows::scm::{query, restart, start, stop};

    #[cfg(not(windows))]
    mod unsupported {
        use std::time::Duration;

        use super::super::{PlatformError, ScmInfo};

        pub fn query() -> Result<ScmInfo, PlatformError> {
            Err(PlatformError::Unsupported)
        }

        pub fn start() -> Result<(), PlatformError> {
            Err(PlatformError::Unsupported)
        }

        pub fn stop(_timeout: Duration) -> Result<(), PlatformError> {
            Err(PlatformError::Unsupported)
        }

        pub fn restart(_timeout: Duration) -> Result<(), PlatformError> {
            Err(PlatformError::Unsupported)
        }
    }
    #[cfg(not(windows))]
    pub use unsupported::{query, restart, start, stop};
}

// ---------------------------------------------------------------------------------------------
// Ereignisprotokoll
// ---------------------------------------------------------------------------------------------

/// Schwere eines Eintrags im Ereignisprotokoll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventLevel {
    Info,
    Warning,
    Error,
}

impl EventLevel {
    /// Event-ID im Protokoll: 1 = Information, 2 = Warnung, 3 = Fehler. So lässt sich danach filtern.
    pub fn event_id(self) -> u32 {
        match self {
            Self::Info => 1,
            Self::Warning => 2,
            Self::Error => 3,
        }
    }
}

/// Höchstlänge einer Einfügezeichenkette für `ReportEventW` (31 839 UTF-16-Einheiten), mit Abstand.
const EVENT_TEXT_MAX_UNITS: usize = 31_000;

/// Kürzt zu lange Texte für das Ereignisprotokoll, das sie sonst ganz ablehnt.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn event_text(message: &str) -> Cow<'_, str> {
    let mut units = 0;
    for (index, c) in message.char_indices() {
        units += c.len_utf16();
        if units > EVENT_TEXT_MAX_UNITS {
            return Cow::Owned(format!("{} …", &message[..index]));
        }
    }
    Cow::Borrowed(message)
}

/// Quelle `pds` im Anwendungsprotokoll.
pub mod eventlog {
    #[cfg(windows)]
    pub use super::windows::eventlog::{deregister_source, register_source, write};

    #[cfg(not(windows))]
    mod unsupported {
        use std::path::Path;

        use super::super::{EventLevel, PlatformError};

        pub fn register_source(_exe: &Path) -> Result<(), PlatformError> {
            Err(PlatformError::Unsupported)
        }

        pub fn deregister_source() -> Result<(), PlatformError> {
            Err(PlatformError::Unsupported)
        }

        /// Ohne Windows gibt es kein Ereignisprotokoll; der Dienst loggt trotzdem in seine Datei.
        pub fn write(_level: EventLevel, _message: &str) -> Result<(), PlatformError> {
            Ok(())
        }
    }
    #[cfg(not(windows))]
    pub use unsupported::{deregister_source, register_source, write};
}

// ---------------------------------------------------------------------------------------------
// Firewall
// ---------------------------------------------------------------------------------------------

/// Ports für die Firewall-Regel: aufsteigend, ohne Doppelte und ohne 0, mit Komma getrennt.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn port_list(ports: &[u16]) -> String {
    let mut ports: Vec<u16> = ports.iter().copied().filter(|port| *port != 0).collect();
    ports.sort_unstable();
    ports.dedup();
    ports
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// Eingehende Regel `EPLAN Panel Data Service (HTTP/HTTPS)` für Caddy. Sie gehört dem Programm, nicht
/// dem MSI: `setup install` und das Speichern geänderter Ports rufen `ensure_rule` auf.
pub mod firewall {
    #[cfg(windows)]
    pub use super::windows::firewall::{ensure_rule, remove_rule};

    #[cfg(not(windows))]
    mod unsupported {
        use std::path::Path;

        use super::super::PlatformError;

        pub fn ensure_rule(_caddy_exe: &Path, _tcp_ports: &[u16]) -> Result<(), PlatformError> {
            Err(PlatformError::Unsupported)
        }

        pub fn remove_rule() -> Result<(), PlatformError> {
            Err(PlatformError::Unsupported)
        }
    }
    #[cfg(not(windows))]
    pub use unsupported::{ensure_rule, remove_rule};
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

/// Belegung eines TCP-Ports, den Caddy öffnen soll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PortStatus {
    pub port: u16,
    pub free: bool,
    pub owner_pid: Option<u32>,
    /// Dateiname des Prozesses (ohne Pfad), soweit lesbar.
    pub owner_name: Option<String>,
    /// Der Port gehört http.sys (IIS, WinRM, Reservierungen) und damit dem System-Prozess (PID 4).
    pub http_sys: bool,
}

/// Bind-Versuch auf allen Adressen, wie Caddy später lauscht. Klappt er, ist der Port frei.
fn bind_status(port: u16) -> PortStatus {
    PortStatus {
        port,
        free: TcpListener::bind(("0.0.0.0", port)).is_ok(),
        owner_pid: None,
        owner_name: None,
        http_sys: false,
    }
}

/// Prüft, ob Caddy die Ports öffnen könnte. Ein Eintrag je angefragtem Port, in derselben
/// Reihenfolge.
pub mod ports {
    use super::PortStatus;

    /// Unter Windows aus der TCP-Tabelle (lauschende Sockets auf 0.0.0.0 und `::`, mit Besitzer);
    /// was dort nicht steht, prüft ein Bind-Versuch. Ohne Windows nur der Bind-Versuch.
    pub fn check(ports: &[u16]) -> Vec<PortStatus> {
        #[cfg(windows)]
        {
            super::windows::ports::check(ports)
        }
        #[cfg(not(windows))]
        {
            ports.iter().map(|&port| super::bind_status(port)).collect()
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Job Object
// ---------------------------------------------------------------------------------------------

/// Ohne Windows ein Platzhalter mit derselben API, der nichts tut; der Supervisor beendet seine
/// Kinder dort selbst.
#[cfg(not(windows))]
#[derive(Debug, Default)]
pub struct JobObject;

#[cfg(not(windows))]
impl JobObject {
    pub fn new_kill_on_close() -> Result<Self, PlatformError> {
        Ok(Self)
    }

    pub fn assign(&self, _child: &std::process::Child) -> Result<(), PlatformError> {
        Ok(())
    }

    pub fn terminate(&self) -> Result<(), PlatformError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Zertifikatspeicher
// ---------------------------------------------------------------------------------------------

/// Zertifikat im Speicher `LocalMachine\My` zur Auswahl in der UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoreCert {
    /// SHA-1 des Zertifikats in Großbuchstaben, wie Windows ihn zeigt.
    pub thumbprint: String,
    /// Anzeigename (meist der CN).
    pub subject: String,
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub not_after: OffsetDateTime,
    pub has_private_key: bool,
}

/// Zertifikate aus `LocalMachine\My`: auflisten und samt Schlüssel übernehmen.
pub mod cert_store {
    #[cfg(windows)]
    pub use super::windows::cert_store::{export, list};

    /// Bringt einen Fingerabdruck in die Form von Windows (40 Hexziffern, groß). Leerzeichen,
    /// Doppelpunkte und unsichtbare Steuerzeichen fallen weg: Beim Kopieren aus der
    /// Zertifikatsanzeige kommt oft ein U+200E mit. `None`, wenn es kein SHA-1-Fingerabdruck ist.
    pub fn normalize_thumbprint(value: &str) -> Option<String> {
        let invisible = ['\u{200b}', '\u{200e}', '\u{200f}', '\u{feff}'];
        let digits: String = value
            .chars()
            .filter(|c| !c.is_whitespace() && *c != ':' && !invisible.contains(c))
            .collect();
        (digits.len() == 40 && digits.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| digits.to_ascii_uppercase())
    }

    #[cfg(not(windows))]
    mod unsupported {
        use super::super::{PlatformError, StoreCert};
        use crate::tls::TlsMaterial;

        pub fn list() -> Result<Vec<StoreCert>, PlatformError> {
            Err(PlatformError::Unsupported)
        }

        pub fn export(_thumbprint: &str) -> Result<TlsMaterial, PlatformError> {
            Err(PlatformError::Unsupported)
        }
    }
    #[cfg(not(windows))]
    pub use unsupported::{export, list};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_ids() {
        assert_eq!(EventLevel::Info.event_id(), 1);
        assert_eq!(EventLevel::Warning.event_id(), 2);
        assert_eq!(EventLevel::Error.event_id(), 3);
    }

    #[test]
    fn event_text_keeps_short_messages() {
        assert!(matches!(event_text("kurz"), Cow::Borrowed("kurz")));
        let exact = "ä".repeat(EVENT_TEXT_MAX_UNITS);
        assert!(matches!(event_text(&exact), Cow::Borrowed(_)));
    }

    #[test]
    fn event_text_cuts_long_messages_at_char_boundary() {
        // Zeichen außerhalb der BMP zählen in UTF-16 doppelt
        let long = "😀".repeat(EVENT_TEXT_MAX_UNITS);
        let cut = event_text(&long);
        assert!(cut.ends_with(" …"));
        let units: usize = cut.encode_utf16().count();
        assert!(units <= EVENT_TEXT_MAX_UNITS + 2, "{units}");
        assert!(units > EVENT_TEXT_MAX_UNITS - 4, "{units}");
    }

    #[test]
    fn port_list_is_sorted_and_unique() {
        assert_eq!(port_list(&[443, 80, 443, 0, 8080]), "80,443,8080");
        assert_eq!(port_list(&[]), "");
        assert_eq!(port_list(&[0]), "");
    }

    const SERVICE: &str = "S-1-5-80-1-2-3-4-5";

    fn trusted(sddl: &str, account: &str) -> bool {
        sddl_facts(sddl, account).is_some_and(|facts| facts.trusted())
    }

    fn extra(sddl: &str) -> Vec<(String, String)> {
        sddl_facts(sddl, SERVICE)
            .unwrap()
            .extra
            .into_iter()
            .map(|ace| (ace.kind, ace.sid))
            .collect()
    }

    #[test]
    fn sddl_trusted_when_only_ours() {
        let ours =
            format!("O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;{SERVICE})");
        assert!(trusted(&ours, SERVICE));
        assert!(extra(&ours).is_empty());
        assert!(trusted("O:SYD:P(A;OICI;FA;;;SY)", SERVICE));
        assert!(trusted("O:BAD:PAR", SERVICE), "leer, aber geschützt");
        assert!(trusted("O:BAG:SYD:P(A;;FA;;;BA)", SERVICE), "Gruppe egal");
        assert!(trusted("O:BAD:P(A;OICI;FA;;;NS)", "NS"), "Alias als Konto");
        assert!(
            sddl_facts("O:BAD:P(A;OICI;FA;;;NS)", "NS")
                .unwrap()
                .extra
                .is_empty()
        );
    }

    #[test]
    fn sddl_extra_aces_keep_dir_trusted_and_are_listed() {
        // Etwa Lesen für ein Sicherungskonto, das ein Admin am Datenordner ergänzt hat
        let backup = "O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;S-1-5-21-1-2-3-1001)";
        assert!(trusted(backup, SERVICE));
        assert_eq!(
            extra(backup),
            [("A".to_owned(), "S-1-5-21-1-2-3-1001".to_owned())]
        );

        let cases: [(&str, &[(&str, &str)]); 6] = [
            ("O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BU)", &[("A", "BU")]),
            ("O:BAD:P(A;OICIID;FA;;;WD)", &[("A", "WD")]),
            // Verweigern zählt auch für eigene Konten als zusätzlich
            ("O:BAD:P(D;OICI;FA;;;SY)", &[("D", "SY")]),
            (
                "O:BAD:P(OA;;FA;00000000-0000-0000-0000-000000000000;;SY)",
                &[("OA", "SY")],
            ),
            ("O:BAD:P(XA;;FA;;;SY;(@User.x == 1))", &[("XA", "SY")]),
            // Doppelte nur einmal, Reihenfolge der DACL
            (
                "O:SYD:P(A;OICI;FR;;;BU)(A;;FA;;;BA)(A;OICI;FX;;;BU)(D;;FA;;;WD)",
                &[("A", "BU"), ("D", "WD")],
            ),
        ];
        for (sddl, expected) in cases {
            assert!(trusted(sddl, SERVICE), "{sddl}");
            let expected: Vec<(String, String)> = expected
                .iter()
                .map(|(kind, sid)| ((*kind).to_owned(), (*sid).to_owned()))
                .collect();
            assert_eq!(extra(sddl), expected, "{sddl}");
        }
        // Das Dienstkonto zählt nur, wenn es das erwartete ist
        assert_eq!(
            extra("O:BAD:P(A;OICI;FA;;;S-1-5-80-9)"),
            [("A".to_owned(), "S-1-5-80-9".to_owned())]
        );
    }

    #[test]
    fn sddl_untrusted_owner_and_flags() {
        let cases = [
            // fremder Besitzer
            "O:BUD:P(A;OICI;FA;;;SY)",
            "O:S-1-5-21-1-2-3-1001D:P(A;OICI;FA;;;SY)",
            // nicht geschützt
            "O:BAD:AI(A;OICI;FA;;;SY)",
            "O:BAD:(A;OICI;FA;;;SY)",
        ];
        for sddl in cases {
            let facts = sddl_facts(sddl, SERVICE).unwrap();
            assert!(!facts.trusted(), "{sddl}");
        }
        assert!(!sddl_facts("O:BUD:P", SERVICE).unwrap().owned);
        assert!(!sddl_facts("O:BAD:AI", SERVICE).unwrap().protected);
    }

    #[test]
    fn sddl_unreadable() {
        let cases = [
            // Null-DACL: Vollzugriff für alle
            "O:BAD:NO_ACCESS_CONTROL",
            // kaputt oder unvollständig
            "",
            "D:P(A;OICI;FA;;;SY)",
            "O:BA",
            "O:BAD:P(A;OICI;FA;;;SY",
            "O:BAD:P(A;OICI;FA;;;SY)x",
            "O:BAD:P(A;OICI;FA;;SY)",
            "O:BAD:P(A;OICI;FA;;;)",
            "O:BAD:P(;OICI;FA;;;SY)",
            "O:BAD:P(A;OICI;FA;;;SY;x)",
            "O:BAD:P(XA;;FA;;;SY;(@User.x == 1)",
            "O:BAO:SYD:P(A;OICI;FA;;;SY)",
            "X:BAD:P(A;OICI;FA;;;SY)",
            "O:BÄ:P(A;OICI;FA;;;SY)",
            "O:BAD:P(A;OICI;FA;;;SY)Ö:",
        ];
        for sddl in cases {
            assert_eq!(sddl_facts(sddl, SERVICE), None, "{sddl}");
            assert!(!trusted(sddl, SERVICE), "{sddl}");
        }
    }

    #[test]
    fn dacl_with_modify_inserts_before_inherited_entries() {
        let sid = "S-1-5-80-1-2-3-4-5";
        // Typischer Ordner auf D:\: nur geerbte Einträge
        let inherited = "D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1301bf;;;AU)";
        assert_eq!(
            dacl_with_modify(inherited, sid, sid, true),
            Some(Some(format!(
                "D:AI(A;OICI;0x1301bf;;;{sid})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)\
                 (A;OICIID;0x1301bf;;;AU)"
            )))
        );
        // Explizite zuerst, dann der neue, dann die geerbten
        let mixed = "D:PAI(D;;FA;;;BG)(A;OICI;FA;;;BA)(A;OICIID;FA;;;SY)";
        assert_eq!(
            dacl_with_modify(mixed, sid, sid, true),
            Some(Some(format!(
                "D:PAI(D;;FA;;;BG)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;{sid})(A;OICIID;FA;;;SY)"
            )))
        );
        // Ohne geerbte Einträge ans Ende; Dateien ohne Vererbung
        assert_eq!(
            dacl_with_modify("D:P(A;;FA;;;BA)", "NS", "S-1-5-20", false),
            Some(Some("D:P(A;;FA;;;BA)(A;;0x1301bf;;;S-1-5-20)".to_owned()))
        );
        assert_eq!(
            dacl_with_modify("D:P", "NS", "S-1-5-20", true),
            Some(Some("D:P(A;OICI;0x1301bf;;;S-1-5-20)".to_owned()))
        );
    }

    #[test]
    fn dacl_with_modify_keeps_existing_grant() {
        let cases = [
            ("D:P(A;OICI;0x1301bf;;;NS)", true),
            ("D:AI(A;OICIID;FA;;;NS)", true),
            ("D:P(A;OICI;0x1f01ff;;;NS)", true),
            ("D:P(A;;0x1301bf;;;NS)", false),
            ("D:AI(A;ID;0x1301bf;;;NS)", false),
        ];
        for (sddl, inheritable) in cases {
            assert_eq!(
                dacl_with_modify(sddl, "NS", "S-1-5-20", inheritable),
                Some(None),
                "{sddl}"
            );
        }
        // Zu wenig (Lesen), nur für Kinder (IO), ohne Vererbung am Ordner, anderes Konto,
        // Verweigern: der Eintrag fehlt noch
        for (sddl, inheritable) in [
            ("D:P(A;OICI;0x1200a9;;;NS)", true),
            ("D:P(A;OICIIO;0x1301bf;;;NS)", true),
            ("D:P(A;;0x1301bf;;;NS)", true),
            ("D:P(A;OICI;0x1301bf;;;LS)", true),
            ("D:P(D;OICI;0x1301bf;;;NS)", false),
        ] {
            assert!(
                matches!(
                    dacl_with_modify(sddl, "NS", "S-1-5-20", inheritable),
                    Some(Some(_))
                ),
                "{sddl}"
            );
        }
    }

    #[test]
    fn dacl_with_modify_rejects_unreadable() {
        for sddl in ["", "D:NO_ACCESS_CONTROL", "D:P(A;OICI;FA;;;SY", "O:BA"] {
            assert_eq!(
                dacl_with_modify(sddl, "NS", "S-1-5-20", true),
                None,
                "{sddl}"
            );
        }
    }

    #[test]
    fn without_verbatim_gives_the_usual_form() {
        assert_eq!(
            without_verbatim(r"\\?\C:\Program Files\x"),
            r"C:\Program Files\x"
        );
        assert_eq!(
            without_verbatim(r"\\?\UNC\fileserver\freigabe\x"),
            r"\\fileserver\freigabe\x"
        );
        assert_eq!(without_verbatim(r"D:\PDS"), r"D:\PDS");
    }

    #[test]
    fn resolved_path_without_windows_is_none() {
        if cfg!(not(windows)) {
            assert_eq!(resolved_path(Path::new(r"C:\PROGRA~1\pds.db")), None);
        }
    }

    #[test]
    fn drive_kind_without_windows_is_unknown() {
        if cfg!(not(windows)) {
            assert_eq!(
                drive_kind(Path::new(r"C:\Daten\pds.db")),
                DriveKind::Unknown
            );
        }
    }

    #[test]
    fn prepare_sqlite_dir_without_windows_does_nothing() {
        if cfg!(not(windows)) {
            let outcome = prepare_sqlite_dir(
                &Paths::new("/inst", "/daten"),
                Path::new(r"D:\PDS\pds.db"),
            )
            .unwrap();
            assert_eq!(outcome, SqliteDirOutcome::default());
        }
    }

    #[test]
    fn extra_ace_descriptions() {
        let ace = |kind: &str| ExtraAce {
            kind: kind.to_owned(),
            sid: "BU".to_owned(),
        };
        let principal = r"VORDEFINIERT\Benutzer (S-1-5-32-545)";
        assert_eq!(ace("A").describe(principal), principal);
        assert_eq!(
            ace("D").describe(principal),
            format!("Verweigern für {principal}")
        );
        assert_eq!(
            ace("XA").describe(principal),
            format!("XA-Eintrag für {principal}")
        );
    }

    #[test]
    fn aside_path_next_to_original() {
        let now = OffsetDateTime::from_unix_timestamp(1_803_902_400).unwrap(); // 2027-03-01 12:00 UTC
        let path = Path::new("daten").join("EPLAN Panel Data Service");
        let aside = aside_path(&path, now, 0x0a1b).unwrap();
        assert_eq!(
            aside,
            Path::new("daten")
                .join("EPLAN Panel Data Service (unsicher 20270301-120000-0a1b)")
        );
        assert_eq!(aside_path(Path::new("/"), now, 1), None);
    }

    #[test]
    fn bind_status_detects_listener() {
        let listener = TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!bind_status(port).free);
        drop(listener);
        assert!(bind_status(port).free);
    }
}
