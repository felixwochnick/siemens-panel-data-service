//! Portbelegung aus der TCP-Tabelle (`GetExtendedTcpTable`), mit Besitzerprozess.
//!
//! Gezählt werden lauschende Sockets auf allen Adressen (0.0.0.0 bzw. `::`), denn dort lauscht
//! auch Caddy. Steht ein Port nicht in der Tabelle (oder ist sie nicht lesbar), entscheidet ein
//! Bind-Versuch; der erkennt auch von Windows reservierte Portbereiche.

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;

use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, HANDLE, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows::Win32::Networking::WinSock::{ADDRESS_FAMILY, AF_INET, AF_INET6};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::PWSTR;

use crate::platform::{PortStatus, bind_status};

/// PID des System-Prozesses; ihm gehören die Sockets von http.sys (IIS, WinRM, URL-Reservierungen).
const SYSTEM_PID: u32 = 4;

pub(crate) fn check(ports: &[u16]) -> Vec<PortStatus> {
    let listeners = listeners();
    ports
        .iter()
        .map(|&port| {
            let owner = listeners
                .iter()
                .find(|listener| listener.port == port)
                .map(|listener| listener.pid);
            match owner {
                Some(pid) => occupied(port, pid),
                None => bind_status(port),
            }
        })
        .collect()
}

fn occupied(port: u16, pid: u32) -> PortStatus {
    let http_sys = pid == SYSTEM_PID;
    PortStatus {
        port,
        free: false,
        owner_pid: Some(pid),
        owner_name: if http_sys {
            Some("System (http.sys)".to_owned())
        } else {
            process_name(pid)
        },
        http_sys,
    }
}

struct Listener {
    port: u16,
    pid: u32,
}

/// Lauschende Sockets auf allen Adressen, IPv4 und IPv6. Eine nicht lesbare Tabelle bleibt leer;
/// dann entscheidet der Bind-Versuch.
fn listeners() -> Vec<Listener> {
    let mut listeners = Vec::new();
    if let Some(buffer) = tcp_table(AF_INET) {
        let table = buffer.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
        // SAFETY: tcp_table hat eine vollständige MIB_TCPTABLE_OWNER_PID in den Puffer geschrieben;
        // er ist mindestens 8 Bytes groß und passend ausgerichtet.
        let rows = unsafe {
            rows(
                &buffer,
                (*table).dwNumEntries,
                (&raw const (*table).table).cast::<MIB_TCPROW_OWNER_PID>(),
            )
        };
        listeners.extend(
            rows.iter()
                .filter(|row| row.dwLocalAddr == 0)
                .map(|row| Listener {
                    port: port_of(row.dwLocalPort),
                    pid: row.dwOwningPid,
                }),
        );
    }
    if let Some(buffer) = tcp_table(AF_INET6) {
        let table = buffer.as_ptr().cast::<MIB_TCP6TABLE_OWNER_PID>();
        // SAFETY: wie oben, mit MIB_TCP6TABLE_OWNER_PID
        let rows = unsafe {
            rows(
                &buffer,
                (*table).dwNumEntries,
                (&raw const (*table).table).cast::<MIB_TCP6ROW_OWNER_PID>(),
            )
        };
        listeners.extend(
            rows.iter()
                .filter(|row| row.ucLocalAddr == [0; 16])
                .map(|row| Listener {
                    port: port_of(row.dwLocalPort),
                    pid: row.dwOwningPid,
                }),
        );
    }
    listeners
}

/// Der Port steht in Netzwerk-Bytereihenfolge in den unteren 16 Bit.
fn port_of(raw: u32) -> u16 {
    u16::from_be(raw as u16)
}

/// Liest die Tabelle der lauschenden TCP-Sockets einer Adressfamilie. Der Puffer ist aus `u64`,
/// damit die Tabelle richtig ausgerichtet ist.
fn tcp_table(family: ADDRESS_FAMILY) -> Option<Vec<u64>> {
    let mut size = 0u32;
    // Die Tabelle kann zwischen Größenabfrage und Lesen wachsen: einige Versuche
    for _ in 0..5 {
        let mut buffer = vec![0u64; (size as usize).div_ceil(8).max(1)];
        let mut len = u32::try_from(buffer.len() * 8).ok()?;
        // SAFETY: Puffer und Länge passen zusammen; Windows schreibt höchstens `len` Bytes.
        let result = unsafe {
            GetExtendedTcpTable(
                Some(buffer.as_mut_ptr().cast()),
                &mut len,
                false,
                u32::from(family.0),
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if result == NO_ERROR.0 {
            return Some(buffer);
        }
        if result != ERROR_INSUFFICIENT_BUFFER.0 {
            return None;
        }
        size = len;
    }
    None
}

/// Die `count` Zeilen ab `first`, begrenzt auf das, was in den Puffer passt.
///
/// # Safety
/// `first` muss in `buffer` zeigen, und der Puffer muss von `GetExtendedTcpTable` mit Zeilen vom
/// Typ `R` gefüllt sein.
unsafe fn rows<R>(buffer: &[u64], count: u32, first: *const R) -> &[R] {
    let offset = first as usize - buffer.as_ptr() as usize;
    let capacity = (buffer.len() * 8).saturating_sub(offset) / size_of::<R>();
    let count = (count as usize).min(capacity);
    // SAFETY: `first` liegt im Puffer, und `count` Zeilen passen laut obiger Rechnung hinein.
    unsafe { std::slice::from_raw_parts(first, count) }
}

/// Dateiname des Prozesses (ohne Pfad). `None`, wenn er nicht lesbar ist, etwa bei geschützten
/// Prozessen ohne Administratorrechte.
fn process_name(pid: u32) -> Option<String> {
    // SAFETY: Öffnet nur ein Abfrage-Handle; OwnedHandle schließt es.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    // SAFETY: Das Handle ist gültig und gehört ab hier nur noch `handle`.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
    // Lange Pfade (\\?\…) können bis 32 767 Zeichen haben
    let mut buffer = vec![0u16; 32_768];
    let mut len = buffer.len() as u32;
    // SAFETY: Puffer und Länge passen zusammen; das Handle lebt bis zum Ende der Funktion.
    unsafe {
        QueryFullProcessImageNameW(
            HANDLE(handle.as_raw_handle()),
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
    }
    .ok()?;
    let path = OsString::from_wide(buffer.get(..len as usize)?);
    Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}
