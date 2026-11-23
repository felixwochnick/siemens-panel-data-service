//! Laufwerksart über `GetDriveTypeW` (eine SQLite-Datei darf nicht auf einem Netzlaufwerk liegen) und
//! der tatsächliche Pfad hinter einem Handle über `GetFinalPathNameByHandleW`: Verweise (Junctions,
//! symbolische Links) in jedem Teil des Pfads, Kurznamen (8.3) und `subst`-Laufwerke sind darin
//! aufgelöst. Nur so lässt sich prüfen, wohin ein Pfad wirklich führt.

use std::fs;
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, GETFINALPATHNAMEBYHANDLE_FLAGS, GetDriveTypeW,
    GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
};
use windows::core::HSTRING;

use crate::platform::{DriveKind, without_verbatim};

// Rückgabewerte von GetDriveTypeW (winbase.h)
const DRIVE_UNKNOWN: u32 = 0;
const DRIVE_NO_ROOT_DIR: u32 = 1;
const DRIVE_REMOTE: u32 = 4;

pub(crate) fn kind(path: &Path) -> DriveKind {
    let text = path.to_string_lossy();
    let bytes = text.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return DriveKind::Unknown;
    }
    let root = HSTRING::from(format!("{}:\\", char::from(bytes[0])));
    // SAFETY: nullterminierter Text, der bis zum Ende des Aufrufs lebt.
    match unsafe { GetDriveTypeW(&root) } {
        DRIVE_REMOTE => DriveKind::Remote,
        DRIVE_NO_ROOT_DIR => DriveKind::Missing,
        DRIVE_UNKNOWN => DriveKind::Unknown,
        _ => DriveKind::Local,
    }
}

/// Der tatsächliche Pfad des geöffneten Objekts, ohne `\\?\` (`\\?\UNC\…` wird `\\…`).
pub(crate) fn final_path(file: &fs::File) -> windows::core::Result<String> {
    let handle = HANDLE(file.as_raw_handle());
    // Lange Namen statt 8.3, Laufwerksbuchstabe statt Volume-GUID
    let flags = GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0);
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: Das Handle gehört `file`; der Puffer ist beschreibbar und so lang wie angegeben.
        let len = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, flags) } as usize;
        if len == 0 {
            return Err(windows::core::Error::from_thread());
        }
        // Zu kurz: `len` ist dann die nötige Länge samt abschließender Null
        if len < buffer.len() {
            buffer.truncate(len);
            return Ok(without_verbatim(&String::from_utf16_lossy(&buffer)));
        }
        buffer.resize(len + 1, 0);
    }
}

/// Wohin `path` tatsächlich führt: der nächste vorhandene Teil des Pfads aufgelöst, der Rest (noch
/// nicht vorhanden) unverändert angehängt. `None`, wenn sich nichts öffnen lässt.
pub(crate) fn resolve(path: &Path) -> Option<PathBuf> {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match open_following(existing) {
            Ok(file) => {
                let mut resolved = PathBuf::from(final_path(&file).ok()?);
                for part in missing.iter().rev() {
                    resolved.push(part);
                }
                return Some(resolved);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(existing.file_name()?.to_owned());
                existing = existing.parent()?;
            }
            Err(_) => return None,
        }
    }
}

/// Öffnet Datei oder Ordner nur zum Lesen der Attribute und folgt dabei Verweisen (anders als die
/// ACL-Funktionen): gefragt ist hier gerade das Ziel.
fn open_following(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
}
