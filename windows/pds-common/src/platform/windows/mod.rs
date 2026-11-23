//! Windows-Implementierung der Plattform-API. Jede Datei kapselt einen Win32-Bereich; Handles und
//! von Windows belegter Speicher stecken in Typen, die beim Drop freigeben, damit auch Fehlerpfade
//! nichts liegen lassen.

pub(super) mod acl;
pub(super) mod cert_store;
pub(super) mod dpapi;
pub(super) mod drive;
pub(super) mod eventlog;
pub(super) mod firewall;
pub(super) mod job;
pub(super) mod ports;
pub(super) mod scm;

use std::ffi::c_void;

use windows::Win32::Foundation::{E_ACCESSDENIED, HLOCAL, LocalFree};

use super::PlatformError;

/// Win32- bzw. COM-Fehler als [`PlatformError`]. Zugriff verweigert bekommt einen eigenen Code,
/// weil die Abhilfe (als Administrator ausführen) klar ist.
pub(super) fn os_error(context: &'static str, error: &windows::core::Error) -> PlatformError {
    let code = error.code();
    if code == E_ACCESSDENIED {
        return PlatformError::AccessDenied;
    }
    PlatformError::Os {
        context,
        // Bitmuster des HRESULT, so wie Windows ihn anzeigt (0x8007…)
        code: code.0 as u32,
        message: error.message().trim().to_owned(),
    }
}

/// Von Windows mit `LocalAlloc` belegter Speicher (SID-Text, Sicherheitsbeschreibung); wird beim
/// Drop mit `LocalFree` freigegeben.
pub(super) struct LocalMemory(pub(super) *mut c_void);

impl Drop for LocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: Der Zeiger stammt aus einer Win32-Funktion, die mit LocalAlloc belegt, und
            // wird nach dem Drop nicht mehr benutzt.
            unsafe {
                LocalFree(Some(HLOCAL(self.0)));
            }
        }
    }
}
