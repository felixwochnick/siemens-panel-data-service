//! Quelle `pds` im Anwendungsprotokoll.
//!
//! Die Nachrichten-DLL ist die von .NET Framework 4 (auf jedem Windows Server vorhanden): Sie hat
//! für jede Event-ID den Text `%1`, so erscheint unsere Meldung unverändert in der Ereignisanzeige.

use std::path::Path;

use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, WIN32_ERROR};
use windows::Win32::System::EventLog::{
    DeregisterEventSource, EVENTLOG_ERROR_TYPE, EVENTLOG_INFORMATION_TYPE, EVENTLOG_WARNING_TYPE,
    REPORT_EVENT_TYPE, RegisterEventSourceW, ReportEventW,
};
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_SET_VALUE, REG_DWORD, REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE,
    REG_VALUE_TYPE, RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegSetValueExW,
};
use windows::core::{HSTRING, PCWSTR};

use super::os_error;
use crate::names::EVENT_SOURCE;
use crate::platform::{EventLevel, PlatformError, event_text};

const MESSAGE_FILE: &str =
    r"%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\EventLogMessages.dll";
/// Fehler, Warnung und Information.
const TYPES_SUPPORTED: u32 = 7;

fn source_key() -> HSTRING {
    HSTRING::from(format!(
        r"SYSTEM\CurrentControlSet\Services\EventLog\Application\{EVENT_SOURCE}"
    ))
}

/// Registriert die Quelle (braucht Administratorrechte). Idempotent.
///
/// `_exe` ist die Dienst-EXE. Sie hat keine eigene Nachrichtentabelle, deshalb zeigt die Quelle
/// auf die Nachrichten-DLL von .NET. Der Parameter bleibt, damit eine spätere eigene Tabelle
/// die Aufrufer nicht ändert.
pub fn register_source(_exe: &Path) -> Result<(), PlatformError> {
    let mut key = HKEY::default();
    // SAFETY: `key` nimmt das neue Handle auf; RegKey schließt es.
    let result = unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            &source_key(),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        )
    };
    registry_result("Ereignisquelle registrieren", result)?;
    let key = RegKey(key);

    // REG_EXPAND_SZ, damit Windows %SystemRoot% selbst auflöst; UTF-16LE mit abschließender Null
    let message_file: Vec<u8> = MESSAGE_FILE
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect();
    key.set("EventMessageFile", REG_EXPAND_SZ, &message_file)?;
    key.set("TypesSupported", REG_DWORD, &TYPES_SUPPORTED.to_le_bytes())
}

/// Entfernt die Quelle; fehlt sie schon, ist das kein Fehler.
pub fn deregister_source() -> Result<(), PlatformError> {
    // SAFETY: Löscht nur den eigenen Schlüssel (ohne Unterschlüssel) unter einem vordefinierten Handle.
    let result = unsafe { RegDeleteKeyW(HKEY_LOCAL_MACHINE, &source_key()) };
    if result == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    registry_result("Ereignisquelle entfernen", result)
}

/// Schreibt einen Eintrag mit Event-ID 1/2/3 und dem Text als einziger Einfügezeichenkette.
///
/// Ist die Quelle nicht registriert, schreibt Windows trotzdem (die Ereignisanzeige zeigt dann
/// einen Hinweis zur fehlenden Beschreibung). Aufrufer behandeln Fehler als nicht kritisch.
pub fn write(level: EventLevel, message: &str) -> Result<(), PlatformError> {
    let kind: REPORT_EVENT_TYPE = match level {
        EventLevel::Info => EVENTLOG_INFORMATION_TYPE,
        EventLevel::Warning => EVENTLOG_WARNING_TYPE,
        EventLevel::Error => EVENTLOG_ERROR_TYPE,
    };
    // SAFETY: Öffnet ein Handle auf das lokale Protokoll; es wird unten wieder geschlossen.
    let handle = unsafe { RegisterEventSourceW(PCWSTR::null(), &HSTRING::from(EVENT_SOURCE)) }
        .map_err(|error| os_error("Ereignisquelle öffnen", &error))?;
    let text = HSTRING::from(event_text(message).as_ref());
    let strings = [PCWSTR(text.as_ptr())];
    // SAFETY: Handle und Zeichenkette (nullterminiert, lebt bis zum Ende der Funktion) sind gültig.
    let result = unsafe {
        ReportEventW(
            handle,
            kind,
            0,
            level.event_id(),
            None,
            0,
            Some(strings.as_slice()),
            None,
        )
    };
    // SAFETY: Das Handle stammt von RegisterEventSourceW und wird danach nicht mehr benutzt.
    // Scheitert das Schließen, bleibt nur ein Handle bis Prozessende offen.
    let _ = unsafe { DeregisterEventSource(handle) };
    result.map_err(|error| os_error("Ereignis schreiben", &error))
}

/// Geöffneter Registry-Schlüssel, der beim Drop geschlossen wird.
struct RegKey(HKEY);

impl RegKey {
    fn set(&self, name: &str, kind: REG_VALUE_TYPE, data: &[u8]) -> Result<(), PlatformError> {
        // SAFETY: Schlüssel und Daten sind gültig, bis der Aufruf zurückkehrt.
        let result =
            unsafe { RegSetValueExW(self.0, &HSTRING::from(name), None, kind, Some(data)) };
        registry_result("Ereignisquelle registrieren", result)
    }
}

impl Drop for RegKey {
    fn drop(&mut self) {
        // SAFETY: Das Handle stammt von RegCreateKeyExW und wird danach nicht mehr benutzt.
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn registry_result(context: &'static str, result: WIN32_ERROR) -> Result<(), PlatformError> {
    result.ok().map_err(|error| os_error(context, &error))
}
