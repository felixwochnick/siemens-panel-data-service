//! Datenordner `%ProgramData%\EPLAN Panel Data Service\` mit seiner ACL einrichten, dazu der
//! Ordner einer SQLite-Datenbank außerhalb (siehe [`prepare_sqlite`]).
//!
//! - Datenordner: Besitzer Administratoren, DACL geschützt (nichts vom Elternordner geerbt). SYSTEM
//!   und Administratoren haben Vollzugriff, das Dienstkonto Lesen und Ausführen; alles vererbt sich
//!   nach unten (OICI), `config.toml` erbt das, der Dienst liest dort also nur.
//! - `tls\`, `state\`, `logs\`, `caddy\` und `data\` (SQLite): ebenfalls geschützt, mit denselben
//!   Einträgen; nur in `state\`, `logs\`, `caddy\` und `data\` bekommt das Dienstkonto Ändern.
//!   Geschützt deshalb, damit kein Unterordner von einer Vererbung abhängt, die durch einen vom
//!   Dienst beschreibbaren Baum läuft.
//!
//! Warum so streng: DPAPI mit `LOCAL_MACHINE` kann jeder lokale Benutzer öffnen, die ACL ist also
//! der einzige Schutz der Secrets. `C:\ProgramData` erlaubt Benutzern, Ordner anzulegen. Einen
//! Ordner, den jemand anderes angelegt hat, nachträglich zu "reparieren", ist nicht sicher: Er
//! behält offene Handles, kann mit Oplocks Zeit gewinnen und Verweise unter Namen verstecken, die
//! Win32-Pfade nicht erreichen. Deshalb wird ein vorhandener Ordner nur übernommen, wenn er schon
//! nachweislich uns gehört: echter Ordner, Besitzer Administratoren oder SYSTEM, geschützte DACL
//! (Prüfung über ein Handle, das keinem Verweis folgt). Beides kann nur ein Administrator so
//! herstellen. Zusätzliche Einträge, die ein Administrator ergänzt hat (etwa Lesen für ein
//! Sicherungskonto), machen ihn nicht fremd: Sie fallen beim erneuten Setzen weg und werden gemeldet.
//! Sonst wird er beiseite gelegt und ein neuer gleich mit der endgültigen Sicherheitsbeschreibung
//! angelegt.
//!
//! Rechte werden nie über einen Pfad gesetzt: Pfadbasierte Aufrufe (`SetNamedSecurityInfoW`)
//! folgen Verweisen, und ihre Vererbung an vorhandene Kinder läuft über Namen durch den Teilbaum.
//! Ein kompromittierter Dienst, der `logs\` leert und an Ort und Stelle in einen Verweis verwandelt
//! oder darunter einen Verweis anlegt, bekäme so Ändern auf ein Ziel seiner Wahl. Stattdessen wird
//! jeder Ordner einmal über ein Handle geöffnet, auf diesem Handle geprüft und über dasselbe Handle
//! mit `SetKernelObjectSecurity` (NtSetSecurityObject) beschrieben: Das ändert genau dieses Objekt
//! und verteilt nichts an Kinder. Neue Ordner entstehen gleich mit ihrer endgültigen Beschreibung.
//! Dateien direkt im Datenordner (`config.toml`) tragen Kopien der geerbten Einträge aus der Zeit
//! ihres Anlegens; sie bekommen deshalb über ihr eigenes Handle wieder genau die geerbten Einträge
//! des Datenordners.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

use time::OffsetDateTime;
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_NONE_MAPPED, HANDLE};
use windows::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows::Win32::Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom};
use windows::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
    LookupAccountNameW, LookupAccountSidW, OBJECT_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
    SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR_CONTROL, SID_NAME_USE, SetKernelObjectSecurity,
    UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateDirectoryW, FILE_ACCESS_RIGHTS, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    GetFileInformationByHandle, MOVE_FILE_FLAGS, MoveFileExW, READ_CONTROL, WRITE_DAC, WRITE_OWNER,
};
use windows::core::{BOOL, HSTRING, PCWSTR, PWSTR};

use super::drive::{final_path, resolve};
use super::{LocalMemory, os_error};
use crate::names::SERVICE_ACCOUNT;
use crate::paths::Paths;
use crate::platform::{
    ExtraAce, PlatformError, SddlFacts, SecureOutcome, SqliteDirOutcome, aside_path,
    dacl_with_modify, sddl_facts,
};
use crate::validate::sqlite_path_problem;

/// Lesen und Ausführen (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE), wie "Lesen, Ausführen" im Explorer.
const READ_EXECUTE: &str = "0x1200a9";
/// Ändern (Lesen, Schreiben, Ausführen, Löschen), wie "Ändern" im Explorer; ohne Rechte- und
/// Besitzerwechsel.
const MODIFY: &str = "0x1301bf";

/// Nur Attribute und Sicherheitsbeschreibung lesen.
const INSPECT: FILE_ACCESS_RIGHTS = FILE_ACCESS_RIGHTS(READ_CONTROL.0 | FILE_READ_ATTRIBUTES.0);
/// Dazu Besitzer und DACL schreiben, über dasselbe Handle wie die Prüfung.
const SECURE: FILE_ACCESS_RIGHTS = FILE_ACCESS_RIGHTS(INSPECT.0 | WRITE_DAC.0 | WRITE_OWNER.0);
/// Nur die DACL ergänzen (SQLite-Ordner): Der Besitzer bleibt.
const GRANT: FILE_ACCESS_RIGHTS = FILE_ACCESS_RIGHTS(INSPECT.0 | WRITE_DAC.0);

const CONTEXT: &str = "Datenordner einrichten";
const SQLITE_CONTEXT: &str = "SQLite-Ordner vorbereiten";

pub(crate) fn secure(paths: &Paths) -> Result<SecureOutcome, PlatformError> {
    let sid = service_sid()?;
    secure_for_sid(paths, &sid)
}

/// Wie [`secure`], mit der SID (Text) des Kontos, das Lesen bzw. Ändern bekommt.
pub(crate) fn secure_for_sid(paths: &Paths, sid: &str) -> Result<SecureOutcome, PlatformError> {
    check_sid(sid)?;
    let mut outcome = SecureOutcome::default();
    match secure_tree(paths, sid, &mut outcome) {
        Ok(()) => Ok(outcome),
        Err(error) if outcome.moved_aside.is_empty() => Err(error),
        // Schon beiseite gelegt: Wohin, darf auch bei einem späteren Fehler nicht verloren gehen
        Err(error) => Err(with_moved_hint(error, &outcome.moved_aside)),
    }
}

/// Die SID landet im SDDL-Text; nur die Form `S-1-…` zulassen, damit nichts eingeschleust wird.
fn check_sid(sid: &str) -> Result<(), PlatformError> {
    if !sid.starts_with("S-1-") || !sid.chars().skip(2).all(|c| c.is_ascii_digit() || c == '-') {
        return Err(failure("Ungültige SID".into()));
    }
    Ok(())
}

/// Vollständige, geschützte Beschreibung mit Ändern für das Konto (`state\`, `logs\`, `data\` …).
fn writable_descriptor(sid: &str) -> Result<Descriptor, PlatformError> {
    Descriptor::protected(&format!(
        "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;{MODIFY};;;{sid})"
    ))
}

fn secure_tree(paths: &Paths, sid: &str, outcome: &mut SecureOutcome) -> Result<(), PlatformError> {
    let account = sddl_account(sid)?;
    // Vollständige, geschützte Beschreibungen: So hängt kein Ordner von Vererbung ab
    let readable = Descriptor::protected(&format!(
        "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;{READ_EXECUTE};;;{sid})"
    ))?;
    let writable = writable_descriptor(sid)?;

    let trusted_root = match inspect_root(&paths.data_dir, &account)? {
        Root::Missing => {
            create_root(&paths.data_dir, &readable)?;
            None
        }
        Root::Trusted(file, extra) => {
            record_removed(outcome, None, &extra);
            Some(file)
        }
        Root::Untrusted => {
            outcome.moved_aside.push(move_aside(&paths.data_dir)?);
            create_root(&paths.data_dir, &readable)?;
            None
        }
    };

    for (dir, descriptor) in [
        (paths.tls_dir(), &readable),
        (paths.state_dir(), &writable),
        (paths.logs_dir(), &writable),
        (paths.caddy_dir(), &writable),
        (paths.sqlite_dir(), &writable),
    ] {
        match inspect(&dir) {
            // Geprüft und beschrieben über ein und dasselbe Handle, kein Pfad dazwischen
            Entry::Directory(file) => {
                if let Some(facts) = handle_facts(&file, &account) {
                    record_removed(outcome, dir.file_name(), &facts.extra);
                }
                set_security(&file, &dir, descriptor)?;
            }
            Entry::Missing => create_dir(&dir, descriptor)?,
            // In `data\` liegt die SQLite-Datenbank: Beiseite gelegt, liefe der Dienst danach mit einer
            // leeren Datenbank (und lüde alle Dateien neu hoch). Lieber abbrechen und erklären; anlegen
            // kann einen Verweis dort nur ein Administrator
            Entry::Other if dir == paths.sqlite_dir() => {
                return Err(failure(format!(
                    "{} ist kein echter Ordner (Verweis, Datei oder nicht zu öffnen). Er wird nicht \
                     beiseite gelegt, damit die SQLite-Datenbank darin nicht verloren geht: bitte \
                     durch einen echten Ordner mit demselben Inhalt ersetzen oder die Datenbank an \
                     einen eigenen Ort legen (db.path), dann die Einrichtung wiederholen",
                    dir.display()
                )));
            }
            // Verweis, Datei oder nicht zu öffnen, etwa von einem kompromittierten Dienst angelegt
            Entry::Other => {
                outcome.moved_aside.push(move_aside(&dir)?);
                create_dir(&dir, descriptor)?;
            }
        }
    }
    // Update: Der eigene Datenordner bekommt seine Rechte erneut, über das schon geprüfte Handle
    if let Some(file) = trusted_root {
        set_security(&file, &paths.data_dir, &readable)?;
        // Wie eine Datei, die gerade im Datenordner entstanden ist: nur geerbte Einträge
        let inherited = Descriptor::from_sddl(&format!(
            "O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;{READ_EXECUTE};;;{sid})"
        ))?;
        reset_root_files(&paths.data_dir, &account, &inherited, outcome)?;
    }
    Ok(())
}

/// Gibt den Dateien direkt im Datenordner (`config.toml`, ggf. Reste von Temp-Dateien) wieder genau
/// die geerbten Einträge des Datenordners, wenn sie andere haben: Kopien entfernter Einträge, eigene
/// Einträge oder eine geschützte DACL. Jede Datei wird über ein Handle geprüft und beschrieben, das
/// keinem Verweis folgt. Verweise und Dateien mit mehreren harten Links bleiben unberührt, denn ihre
/// Rechte gehören auch einem anderen Namen; Ordner hat [`secure_tree`] schon behandelt.
fn reset_root_files(
    root: &Path,
    account: &str,
    inherited: &Descriptor,
    outcome: &mut SecureOutcome,
) -> Result<(), PlatformError> {
    let entries = fs::read_dir(root).map_err(|error| io_failure(root, &error))?;
    for entry in entries {
        let path = entry.map_err(|error| io_failure(root, &error))?.path();
        // Inzwischen verschwunden (etwa eine umbenannte Temp-Datei) oder nicht zu öffnen: nichts zu tun
        let Ok(file) = open_entry(&path, SECURE) else {
            continue;
        };
        if !single_file(&file) {
            continue;
        }
        let facts = handle_facts(&file, account);
        let clean = facts
            .as_ref()
            .is_some_and(|facts| facts.owned && !facts.protected && facts.extra.is_empty());
        if clean {
            continue;
        }
        if let Some(facts) = &facts {
            record_removed(outcome, path.file_name(), &facts.extra);
        }
        set_file_security(&file, &path, inherited)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// SQLite-Ordner
// ---------------------------------------------------------------------------------------------

/// Siehe [`crate::platform::prepare_sqlite_dir`].
pub(crate) fn prepare_sqlite(
    paths: &Paths,
    file: &Path,
) -> Result<SqliteDirOutcome, PlatformError> {
    let sid = service_sid()?;
    prepare_sqlite_for_sid(paths, file, &sid)
}

/// Wie [`prepare_sqlite`], mit der SID (Text) des Kontos, das Ändern bekommt.
pub(crate) fn prepare_sqlite_for_sid(
    paths: &Paths,
    file: &Path,
    sid: &str,
) -> Result<SqliteDirOutcome, PlatformError> {
    check_sid(sid)?;
    let account = sddl_account(sid)?;
    // Nie den Stamm eines Laufwerks: Die Validierung lehnt das schon ab, hier zur Sicherheit noch einmal
    let dir = file
        .parent()
        .filter(|dir| dir.parent().is_some())
        .ok_or_else(|| {
            sqlite_failure(format!(
                "{}: Die Datei braucht einen eigenen Ordner",
                file.display()
            ))
        })?;
    let default_dir = dir == paths.sqlite_dir();
    let mut outcome = SqliteDirOutcome::default();
    let not_a_folder = || {
        sqlite_failure(format!(
            "{}: ist kein Ordner, sondern ein Verweis oder eine Datei – bitte einen echten Ordner \
             angeben",
            dir.display()
        ))
    };

    // Geprüft wird, wohin der Pfad tatsächlich führt: `FILE_FLAG_OPEN_REPARSE_POINT` schützt nur den
    // letzten Teil, ein Verweis weiter vorn, ein Kurzname (8.3) oder ein subst-Laufwerk lenkte ihn
    // sonst etwa nach C:\Windows. Den Standardordner pflegt `setup install` (geschützt wie `logs\`).
    let real_dir = match inspect_sqlite_dir(dir)? {
        Entry::Directory(handle) => {
            let real = real_dir_of(&handle, dir)?;
            if !default_dir {
                check_real(paths, &real, file, dir)?;
                // Ein eigener Ordner behält seine Rechte und bekommt nur den Eintrag für das
                // Dienstkonto, über ein zweites Handle, das auf denselben Ordner zeigen muss
                let writable = open_granting(dir)?;
                if !real_directory(&writable) || !same_path(&real_dir_of(&writable, dir)?, &real) {
                    return Err(changed(dir));
                }
                if grant_modify(&writable, dir, &account, sid, true)? {
                    outcome.granted.push(dir.to_owned());
                }
            }
            real
        }
        Entry::Missing => {
            // Wohin der Ordner käme: der nächste vorhandene Vorfahr, aufgelöst
            if !default_dir && let Some(target) = resolve(dir) {
                check_real(paths, &target.to_string_lossy(), file, dir)?;
            }
            // Den Datenordner selbst legt nur `setup install` an
            if !default_dir && let Some(parent) = dir.parent() {
                fs::create_dir_all(parent).map_err(|error| io_failure(parent, &error))?;
            }
            create_dir(dir, &writable_descriptor(sid)?)?;
            outcome.created = Some(dir.to_owned());
            // Zwischen Prüfung und Anlegen kann ein Verweis entstanden sein: über das Handle des neuen
            // Ordners noch einmal
            let Entry::Directory(handle) = inspect_sqlite_dir(dir)? else {
                return Err(not_a_folder());
            };
            let real = real_dir_of(&handle, dir)?;
            if !default_dir {
                check_real(paths, &real, file, dir)?;
            }
            real
        }
        Entry::Other => return Err(not_a_folder()),
    };

    // Vererbung erreicht nur neue Dateien: eine hineinverschobene Datenbank (etwa die der
    // .NET-Version) behielte sonst ihre alten Rechte
    for candidate in sqlite_files(file) {
        let handle = match open_entry(&candidate, GRANT) {
            Ok(handle) => handle,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Err(PlatformError::AccessDeniedAt(
                    candidate.display().to_string(),
                ));
            }
            Err(error) => return Err(io_failure(&candidate, &error)),
        };
        if !single_file(&handle) {
            return Err(sqlite_failure(format!(
                "{}: ist ein Ordner, ein Verweis oder hat mehrere Namen (harter Link) – bitte durch \
                 eine gewöhnliche Datei ersetzen",
                candidate.display()
            )));
        }
        // Die Datei muss genau im geprüften Ordner liegen, auch wenn der Pfad inzwischen woandershin führt
        let name = candidate.file_name().map(OsStr::to_string_lossy);
        let real = final_path(&handle)
            .map_err(|error| path_failure("Pfad auflösen", &candidate, &error))?;
        if !name.is_some_and(|name| same_path(&real, &format!(r"{real_dir}\{name}"))) {
            return Err(changed(&candidate));
        }
        if grant_modify(&handle, &candidate, &account, sid, false)? {
            outcome.granted.push(candidate);
        }
    }
    Ok(outcome)
}

/// Der tatsächliche Pfad des Ordners hinter dem Handle (Verweise, Kurznamen, subst aufgelöst), ohne
/// `\` am Ende.
fn real_dir_of(handle: &fs::File, dir: &Path) -> Result<String, PlatformError> {
    let real = final_path(handle).map_err(|error| path_failure("Pfad auflösen", dir, &error))?;
    Ok(real.trim_end_matches('\\').to_owned())
}

/// Prüft den tatsächlichen Ort (Ordner oder nächster vorhandener Vorfahr samt Rest) wie die
/// Validierung den eingetragenen Pfad: kein Netzlaufwerk, kein Systemordner, kein Laufwerksstamm.
fn check_real(paths: &Paths, real_dir: &str, file: &Path, dir: &Path) -> Result<(), PlatformError> {
    let name = file
        .file_name()
        .map(OsStr::to_string_lossy)
        .unwrap_or_default();
    let real_file = format!(r"{}\{name}", real_dir.trim_end_matches('\\'));
    sqlite_path_problem(&real_file, paths).map_err(|(_, message)| {
        sqlite_failure(format!(
            "{} führt tatsächlich nach {real_dir} (über einen Verweis, einen Kurznamen oder ein \
             subst-Laufwerk): {message}",
            dir.display()
        ))
    })
}

/// Pfade wie Windows vergleicht: ohne Groß-/Kleinschreibung.
fn same_path(left: &str, right: &str) -> bool {
    left.to_lowercase() == right.to_lowercase()
}

fn changed(path: &Path) -> PlatformError {
    sqlite_failure(format!(
        "{} hat sich während der Prüfung geändert (anderer Ordner oder Verweis) – bitte erneut \
         speichern",
        path.display()
    ))
}

/// Öffnet den Ordner zum Ergänzen der DACL; "Zugriff verweigert" als eigener Fehler.
fn open_granting(dir: &Path) -> Result<fs::File, PlatformError> {
    open_entry(dir, GRANT).map_err(|error| match error.kind() {
        io::ErrorKind::PermissionDenied => PlatformError::AccessDeniedAt(dir.display().to_string()),
        _ => io_failure(dir, &error),
    })
}

/// Wie [`inspect`], aber nur lesend und mit "Zugriff verweigert" als eigenem Fehler statt "fremd":
/// Ein vorhandener Ordner des Admins wird nie beiseite gelegt. Geschrieben wird über ein eigenes
/// Handle ([`open_granting`]), damit schon die Prüfung eines Systemordners ohne Schreibrecht gelingt.
fn inspect_sqlite_dir(dir: &Path) -> Result<Entry, PlatformError> {
    match open_entry(dir, INSPECT) {
        Ok(file) if real_directory(&file) => Ok(Entry::Directory(file)),
        Ok(_) => Ok(Entry::Other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Entry::Missing),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            Err(PlatformError::AccessDeniedAt(dir.display().to_string()))
        }
        Err(error) => Err(io_failure(dir, &error)),
    }
}

/// Die Datei und ihre Begleiter (WAL, gemeinsamer Speicher, Journal).
fn sqlite_files(file: &Path) -> Vec<PathBuf> {
    let mut files = vec![file.to_owned()];
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = file.as_os_str().to_owned();
        name.push(suffix);
        files.push(PathBuf::from(name));
    }
    files
}

/// Ergänzt „Ändern“ für das Konto in der DACL genau des Objekts hinter dem Handle (ohne Verteilung
/// an Kinder); `true`, wenn sich etwas geändert hat. Die übrigen Einträge, geerbte eingeschlossen,
/// und der Schutz der DACL bleiben, wie sie sind.
fn grant_modify(
    file: &fs::File,
    path: &Path,
    account: &str,
    sid: &str,
    inheritable: bool,
) -> Result<bool, PlatformError> {
    let sddl = handle_sddl_of(file, DACL_SECURITY_INFORMATION)
        .ok_or_else(|| sqlite_failure(format!("{}: Rechte nicht lesbar", path.display())))?;
    let updated = dacl_with_modify(&sddl, account, sid, inheritable).ok_or_else(|| {
        sqlite_failure(format!(
            "{}: Rechte nicht eindeutig lesbar ({sddl})",
            path.display()
        ))
    })?;
    let Some(updated) = updated else {
        return Ok(false);
    };
    let descriptor = Descriptor::from_sddl(&updated)?;
    let protection = if descriptor.dacl_protected()? {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    let info = OBJECT_SECURITY_INFORMATION(DACL_SECURITY_INFORMATION.0 | protection.0);
    // SAFETY: Handle und Sicherheitsbeschreibung leben bis zum Ende des Aufrufs.
    unsafe { SetKernelObjectSecurity(HANDLE(file.as_raw_handle()), info, descriptor.raw) }
        .map_err(|error| path_failure("Zugriffsrechte setzen", path, &error))?;
    Ok(true)
}

fn sqlite_failure(message: String) -> PlatformError {
    PlatformError::Os {
        context: SQLITE_CONTEXT,
        code: 0,
        message,
    }
}

/// Hängt die zusätzlichen Einträge lesbar an `outcome.removed_aces`; `place` ist der Name des
/// Unterordners bzw. der Datei, beim Datenordner selbst `None`.
fn record_removed(outcome: &mut SecureOutcome, place: Option<&OsStr>, extra: &[ExtraAce]) {
    for ace in extra {
        let text = ace.describe(&principal(&ace.sid));
        outcome.removed_aces.push(match place {
            Some(place) => format!("{}: {text}", place.to_string_lossy()),
            None => text,
        });
    }
}

/// Konto als `Name (SID)`, etwa `VORDEFINIERT\Benutzer (S-1-5-32-545)`; ohne Namen nur die SID.
fn principal(sddl_sid: &str) -> String {
    let mut psid = PSID::default();
    // Versteht SDDL-Kürzel (`BU`) wie `S-1-…`; `psid` wird mit LocalAlloc belegt.
    // SAFETY: Der Text lebt bis zum Ende des Aufrufs; `psid` ist beschreibbar.
    if unsafe { ConvertStringSidToSidW(&HSTRING::from(sddl_sid), &mut psid) }.is_err() {
        return sddl_sid.to_owned();
    }
    let _psid = LocalMemory(psid.0);
    let text = sid_text(psid).unwrap_or_else(|_| sddl_sid.to_owned());
    match account_name(psid) {
        Some(name) => format!("{name} ({text})"),
        None => text,
    }
}

/// `Domäne\Name` eines Kontos; `None`, wenn Windows keinen Namen kennt (etwa ein gelöschtes Konto).
fn account_name(psid: PSID) -> Option<String> {
    let mut name_len = 0u32;
    let mut domain_len = 0u32;
    let mut kind = SID_NAME_USE::default();
    // Erster Aufruf nur für die Puffergrößen; er scheitert dabei absichtlich
    // SAFETY: Ohne Puffer schreibt Windows nur die beiden Längen und `kind`.
    let _ = unsafe {
        LookupAccountSidW(
            PCWSTR::null(),
            psid,
            None,
            &mut name_len,
            None,
            &mut domain_len,
            &mut kind,
        )
    };
    if name_len == 0 {
        return None;
    }
    let mut name = vec![0u16; name_len as usize];
    let mut domain = vec![0u16; domain_len.max(1) as usize];
    // SAFETY: Beide Puffer sind so groß wie im ersten Aufruf gemeldet und leben bis zum Ende.
    unsafe {
        LookupAccountSidW(
            PCWSTR::null(),
            psid,
            Some(PWSTR(name.as_mut_ptr())),
            &mut name_len,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut kind,
        )
    }
    .ok()?;
    // Nach Erfolg sind die Längen ohne abschließende Null
    let name = String::from_utf16_lossy(&name[..name_len as usize]);
    let domain = String::from_utf16_lossy(&domain[..domain_len as usize]);
    Some(if domain.is_empty() {
        name
    } else {
        format!("{domain}\\{name}")
    })
}

/// Hängt die beiseite gelegten Pfade an die Meldung; der Fehlercode bleibt erhalten.
fn with_moved_hint(error: PlatformError, moved: &[PathBuf]) -> PlatformError {
    let places: Vec<String> = moved
        .iter()
        .map(|path| path.display().to_string())
        .collect();
    let hint = format!("Beiseite gelegt: {}", places.join(", "));
    match error {
        PlatformError::Os {
            context,
            code,
            message,
        } => PlatformError::Os {
            context,
            code,
            message: format!("{message}. {hint}"),
        },
        PlatformError::Io(message) => PlatformError::Io(format!("{message}. {hint}")),
        PlatformError::AccessDenied => PlatformError::AccessDeniedAt(hint),
        PlatformError::AccessDeniedAt(detail) => {
            PlatformError::AccessDeniedAt(format!("{detail}. {hint}"))
        }
        // Entsteht hier nach einem Umbenennen nicht; der Code ist wichtiger als der Hinweis
        other => other,
    }
}

/// Was unter dem Pfad des Datenordners liegt.
enum Root {
    Missing,
    /// Ein echter Ordner, der uns gehört; das Handle ist zum Schreiben der Rechte geöffnet. Dazu die
    /// zusätzlichen Einträge, die beim erneuten Setzen wegfallen.
    Trusted(fs::File, Vec<ExtraAce>),
    /// Fremd, Verweis, Datei oder nicht eindeutig lesbar: wird beiseite gelegt.
    Untrusted,
}

/// Prüft den Datenordner über das Handle, das ihn auch zum Schreiben der Rechte öffnet. Alles,
/// was sich nicht eindeutig als eigener, echter Ordner lesen lässt, gilt als fremd.
fn inspect_root(path: &Path, account: &str) -> Result<Root, PlatformError> {
    let trusted = |file: &fs::File| {
        real_directory(file)
            .then(|| handle_facts(file, account))
            .flatten()
            .filter(SddlFacts::trusted)
    };
    match open_entry(path, SECURE) {
        Ok(file) => match trusted(&file) {
            Some(facts) => Ok(Root::Trusted(file, facts.extra)),
            None => Ok(Root::Untrusted),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Root::Missing),
        // Ein eigener Ordner, dessen Rechte wir nicht ändern dürfen, heißt fehlende Erhöhung,
        // nicht fremd: Sonst würde ein nicht erhöhter Aufruf den echten Datenordner beiseite legen
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            match open_entry(path, INSPECT) {
                Ok(file) if trusted(&file).is_some() => {
                    Err(PlatformError::AccessDeniedAt(path.display().to_string()))
                }
                _ => Ok(Root::Untrusted),
            }
        }
        Err(_) => Ok(Root::Untrusted),
    }
}

/// Was unter dem Pfad eines Unterordners liegt.
enum Entry {
    Missing,
    /// Ein echter Ordner; das Handle ist zum Schreiben der Rechte geöffnet.
    Directory(fs::File),
    /// Verweis (Junction, symbolischer Link), Datei oder nicht einmal zu öffnen.
    Other,
}

fn inspect(path: &Path) -> Entry {
    match open_entry(path, SECURE) {
        Ok(file) if real_directory(&file) => Entry::Directory(file),
        Ok(_) => Entry::Other,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Entry::Missing,
        // Nicht zu öffnen, auch nicht mit Rechten des Administrators: Das gehört nicht uns
        Err(_) => Entry::Other,
    }
}

/// Öffnet einen Eintrag, ohne einem Verweis zu folgen (Backup-Semantik ist für Ordner nötig).
fn open_entry(path: &Path, access: FILE_ACCESS_RIGHTS) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .access_mode(access.0)
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
        .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
        .open(path)
}

/// Ist das geöffnete Objekt ein Ordner und kein Verweis? Unlesbare Attribute zählen als nein.
fn real_directory(file: &fs::File) -> bool {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: Das Handle gehört `file` und lebt während des Aufrufs; `info` ist beschreibbar.
    if unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.is_err() {
        return false;
    }
    let directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
    let link = info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0;
    directory && !link
}

/// Ist das geöffnete Objekt eine gewöhnliche Datei mit genau einem Namen (kein Ordner, kein
/// Verweis, kein weiterer harter Link)? Unlesbare Attribute zählen als nein.
fn single_file(file: &fs::File) -> bool {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: Das Handle gehört `file` und lebt während des Aufrufs; `info` ist beschreibbar.
    if unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.is_err() {
        return false;
    }
    let special = FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0;
    info.dwFileAttributes & special == 0 && info.nNumberOfLinks == 1
}

/// Besitzer und DACL des geöffneten Objekts, ausgewertet; `None`, wenn nicht lesbar.
fn handle_facts(file: &fs::File, account: &str) -> Option<SddlFacts> {
    handle_sddl(file).and_then(|sddl| sddl_facts(&sddl, account))
}

/// Besitzer und DACL des geöffneten Objekts als SDDL; `None`, wenn nicht lesbar (gilt als fremd).
fn handle_sddl(file: &fs::File) -> Option<String> {
    handle_sddl_of(
        file,
        OBJECT_SECURITY_INFORMATION(OWNER_SECURITY_INFORMATION.0 | DACL_SECURITY_INFORMATION.0),
    )
}

/// Die Teile `info` der Sicherheitsbeschreibung des geöffneten Objekts als SDDL.
fn handle_sddl_of(file: &fs::File, info: OBJECT_SECURITY_INFORMATION) -> Option<String> {
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: Das Handle ist gültig; `descriptor` nimmt einen mit LocalAlloc belegten Zeiger auf.
    let result = unsafe {
        GetSecurityInfo(
            HANDLE(file.as_raw_handle()),
            SE_FILE_OBJECT,
            info,
            None,
            None,
            None,
            None,
            Some(&mut descriptor),
        )
    };
    result.ok().ok()?;
    let _descriptor = LocalMemory(descriptor.0);
    descriptor_sddl(descriptor, info).ok()
}

fn descriptor_sddl(
    descriptor: PSECURITY_DESCRIPTOR,
    info: OBJECT_SECURITY_INFORMATION,
) -> Result<String, PlatformError> {
    let mut text = PWSTR::null();
    // SAFETY: `descriptor` ist gültig; `text` wird mit LocalAlloc belegt und unten freigegeben.
    unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            info,
            &mut text,
            None,
        )
    }
    .map_err(|error| os_error(CONTEXT, &error))?;
    let _text = LocalMemory(text.0.cast());
    // SAFETY: nullterminierte Zeichenkette, die bis zum Drop von `_text` lebt.
    unsafe { text.to_string() }.map_err(|_| failure("SDDL ist kein gültiger Text".into()))
}

/// Wie Windows die SID in SDDL schreibt: Bekannte Konten als Kürzel (`S-1-5-20` ⇒ `NS`), sonst
/// `S-1-…`. So lässt sie sich mit der SDDL eines vorhandenen Ordners vergleichen.
fn sddl_account(sid: &str) -> Result<String, PlatformError> {
    let descriptor = Descriptor::from_sddl(&format!("O:{sid}"))?;
    let text = descriptor_sddl(descriptor.raw, OWNER_SECURITY_INFORMATION)?;
    text.strip_prefix("O:")
        .map(str::to_owned)
        .ok_or_else(|| failure(format!("Unerwartete SDDL: {text}")))
}

/// Legt den Datenordner gleich mit seiner endgültigen Sicherheitsbeschreibung an, damit er keinen
/// Augenblick mit schwächeren Rechten existiert. Der Elternordner (`%ProgramData%`) entsteht bei
/// Bedarf mit den Standardrechten.
fn create_root(path: &Path, descriptor: &Descriptor) -> Result<(), PlatformError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| io_failure(parent, &error))?;
    }
    create_dir(path, descriptor)
}

/// Legt einen Ordner mit der Sicherheitsbeschreibung an; geschützt, also ohne Vererbung vom
/// Elternordner. Gibt es ihn inzwischen (Wettlauf), scheitert das, statt einen fremden Ordner zu
/// übernehmen.
fn create_dir(path: &Path, descriptor: &Descriptor) -> Result<(), PlatformError> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.raw.0,
        bInheritHandle: BOOL::from(false),
    };
    // SAFETY: Pfad und Sicherheitsbeschreibung leben bis zum Ende des Aufrufs.
    unsafe { CreateDirectoryW(&HSTRING::from(path), Some(&attributes)) }
        .map_err(|error| path_failure("Ordner anlegen", path, &error))
}

/// Benennt einen nicht vertrauenswürdigen Eintrag um (bei einem Verweis den Verweis selbst, nicht
/// sein Ziel). Scheitert das, wird nichts weiter angefasst.
fn move_aside(path: &Path) -> Result<PathBuf, PlatformError> {
    let mut random = [0u8; 2];
    // SAFETY: Füllt den Puffer mit Zufallsbytes des Systems.
    unsafe { BCryptGenRandom(None, &mut random, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
        .ok()
        .map_err(|error| os_error("Zufallszahlen erzeugen", &error))?;
    let target = aside_path(path, OffsetDateTime::now_utc(), u16::from_le_bytes(random))
        .ok_or_else(|| failure(format!("{}: kein Ordnername", path.display())))?;
    // Ohne MOVEFILE_REPLACE_EXISTING und ohne Kopieren: nur ein Umbenennen auf demselben Laufwerk
    // SAFETY: Beide Pfade leben bis zum Ende des Aufrufs.
    unsafe {
        MoveFileExW(
            &HSTRING::from(path),
            &HSTRING::from(target.as_path()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(|error| path_failure("Unsicheren Ordner beiseite legen", path, &error))?;
    Ok(target)
}

/// Setzt Besitzer und geschützte DACL genau des Objekts hinter dem Handle. Anders als
/// `SetSecurityInfo` löst das keinen Pfad auf und verteilt nichts an vorhandene Kinder; neue
/// Kinder erben ab jetzt die neuen Einträge. `path` dient nur der Fehlermeldung.
fn set_security(
    file: &fs::File,
    path: &Path,
    descriptor: &Descriptor,
) -> Result<(), PlatformError> {
    let info = OBJECT_SECURITY_INFORMATION(
        OWNER_SECURITY_INFORMATION.0
            | DACL_SECURITY_INFORMATION.0
            | PROTECTED_DACL_SECURITY_INFORMATION.0,
    );
    // SAFETY: Handle und Sicherheitsbeschreibung leben bis zum Ende des Aufrufs.
    unsafe { SetKernelObjectSecurity(HANDLE(file.as_raw_handle()), info, descriptor.raw) }
        .map_err(|error| path_failure("Zugriffsrechte setzen", path, &error))
}

/// Setzt Besitzer und eine ungeschützte DACL aus geerbten Einträgen genau der Datei hinter dem
/// Handle, wie bei [`set_security`] ohne Pfad. `path` dient nur der Fehlermeldung.
fn set_file_security(
    file: &fs::File,
    path: &Path,
    descriptor: &Descriptor,
) -> Result<(), PlatformError> {
    let info = OBJECT_SECURITY_INFORMATION(
        OWNER_SECURITY_INFORMATION.0
            | DACL_SECURITY_INFORMATION.0
            | UNPROTECTED_DACL_SECURITY_INFORMATION.0,
    );
    // SAFETY: Handle und Sicherheitsbeschreibung leben bis zum Ende des Aufrufs.
    unsafe { SetKernelObjectSecurity(HANDLE(file.as_raw_handle()), info, descriptor.raw) }
        .map_err(|error| path_failure("Zugriffsrechte setzen", path, &error))
}

fn failure(message: String) -> PlatformError {
    PlatformError::Os {
        context: CONTEXT,
        code: 0,
        message,
    }
}

fn io_failure(path: &Path, error: &io::Error) -> PlatformError {
    PlatformError::Io(format!("{}: {error}", path.display()))
}

/// Win32-Fehler mit dem betroffenen Pfad in der Meldung; der Code bleibt (Zugriff verweigert
/// bleibt `access_denied`).
fn path_failure(context: &'static str, path: &Path, error: &windows::core::Error) -> PlatformError {
    match os_error(context, error) {
        PlatformError::Os { code, message, .. } => PlatformError::Os {
            context,
            code,
            message: format!("{}: {message}", path.display()),
        },
        PlatformError::AccessDenied => PlatformError::AccessDeniedAt(path.display().to_string()),
        other => other,
    }
}

/// Sicherheitsbeschreibung aus SDDL, mit `LocalAlloc` belegt und beim Drop freigegeben.
struct Descriptor {
    raw: PSECURITY_DESCRIPTOR,
    _memory: LocalMemory,
}

impl Descriptor {
    fn from_sddl(sddl: &str) -> Result<Self, PlatformError> {
        let mut raw = PSECURITY_DESCRIPTOR::default();
        // SAFETY: `raw` nimmt einen mit LocalAlloc belegten Zeiger auf, den LocalMemory freigibt.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &HSTRING::from(sddl),
                SDDL_REVISION_1,
                &mut raw,
                None,
            )
        }
        .map_err(|error| os_error("ACL aus SDDL erzeugen", &error))?;
        Ok(Self {
            raw,
            _memory: LocalMemory(raw.0),
        })
    }

    /// Ist die DACL geschützt (erbt nichts vom Elternordner)?
    fn dacl_protected(&self) -> Result<bool, PlatformError> {
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: `raw` ist gültig, solange `self` lebt; die Ausgaben sind beschreibbar.
        unsafe { GetSecurityDescriptorControl(self.raw, &mut control, &mut revision) }
            .map_err(|error| os_error("ACL lesen", &error))?;
        Ok(SECURITY_DESCRIPTOR_CONTROL(control).contains(SE_DACL_PROTECTED))
    }

    /// Beschreibung mit vorhandener, geschützter DACL. Eine fehlende DACL hieße für Windows
    /// "Vollzugriff für alle", eine ungeschützte beim Anlegen zusätzlich Vererbung vom Elternordner.
    fn protected(sddl: &str) -> Result<Self, PlatformError> {
        let descriptor = Self::from_sddl(sddl)?;
        let mut present = BOOL::default();
        let mut defaulted = BOOL::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: `raw` ist gültig, solange `descriptor` lebt; die Ausgaben sind beschreibbar.
        let read = unsafe {
            GetSecurityDescriptorDacl(descriptor.raw, &mut present, &mut dacl, &mut defaulted)
                .and_then(|()| {
                    GetSecurityDescriptorControl(descriptor.raw, &mut control, &mut revision)
                })
        };
        read.map_err(|error| os_error("ACL lesen", &error))?;
        let protected = SECURITY_DESCRIPTOR_CONTROL(control).contains(SE_DACL_PROTECTED);
        if !present.as_bool() || dacl.is_null() || !protected {
            return Err(failure(
                "Die erzeugte Sicherheitsbeschreibung hat keine geschützte DACL".into(),
            ));
        }
        Ok(descriptor)
    }
}

/// SID des Dienstkontos als Text (`S-1-5-80-…`). Das virtuelle Konto gibt es erst, wenn der Dienst
/// installiert ist; sonst [`PlatformError::AccountNotFound`].
fn service_sid() -> Result<String, PlatformError> {
    let account = HSTRING::from(SERVICE_ACCOUNT);
    let mut sid_len = 0u32;
    let mut domain_len = 0u32;
    let mut kind = SID_NAME_USE::default();
    // Erster Aufruf nur für die Puffergrößen; er scheitert dabei absichtlich
    // SAFETY: Ohne Puffer schreibt Windows nur die beiden Längen und `kind`.
    let sizing = unsafe {
        LookupAccountNameW(
            PCWSTR::null(),
            &account,
            None,
            &mut sid_len,
            None,
            &mut domain_len,
            &mut kind,
        )
    };
    if let Err(error) = sizing
        && error.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult()
    {
        return Err(lookup_error(&error));
    }
    if sid_len == 0 {
        return Err(PlatformError::AccountNotFound);
    }

    // u32-Puffer, damit die SID passend ausgerichtet ist
    let mut sid = vec![0u32; (sid_len as usize).div_ceil(4)];
    let mut domain = vec![0u16; domain_len.max(1) as usize];
    let psid = PSID(sid.as_mut_ptr().cast());
    // SAFETY: Beide Puffer sind mindestens so groß wie im ersten Aufruf gemeldet und leben bis zum
    // Ende der Funktion.
    unsafe {
        LookupAccountNameW(
            PCWSTR::null(),
            &account,
            Some(psid),
            &mut sid_len,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut kind,
        )
    }
    .map_err(|error| lookup_error(&error))?;

    sid_text(psid)
}

/// SID als Text (`S-1-…`).
fn sid_text(psid: PSID) -> Result<String, PlatformError> {
    let mut text = PWSTR::null();
    // SAFETY: `psid` ist eine gültige SID; `text` wird mit LocalAlloc belegt.
    unsafe { ConvertSidToStringSidW(psid, &mut text) }
        .map_err(|error| os_error("SID umwandeln", &error))?;
    let _text = LocalMemory(text.0.cast());
    // SAFETY: `text` ist eine nullterminierte Zeichenkette, die bis zum Drop von `_text` lebt.
    unsafe { text.to_string() }.map_err(|_| PlatformError::Os {
        context: "SID umwandeln",
        code: 0,
        message: "Die SID ist kein gültiger Text".into(),
    })
}

fn lookup_error(error: &windows::core::Error) -> PlatformError {
    if error.code() == ERROR_NONE_MAPPED.to_hresult() {
        PlatformError::AccountNotFound
    } else {
        os_error("Dienstkonto suchen", error)
    }
}
