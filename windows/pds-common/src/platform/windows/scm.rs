//! Dienststeuerung über den Service Control Manager (`windows-service`): der Dienst `pds` und, über
//! die Funktionen mit Namen, der Worker `pds-eplan`.
//!
//! Start und Stopp warten nie unbegrenzt: `stop` fragt den Zustand in kurzen Abständen ab und gibt
//! nach `timeout` mit [`PlatformError::ServiceTimeout`] auf.

use std::ffi::OsStr;
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_SERVICE_ALREADY_RUNNING, ERROR_SERVICE_CANNOT_ACCEPT_CTRL,
    ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SERVICE_NOT_ACTIVE,
};
use windows::Win32::System::Services::{
    QueryServiceConfig2W, SC_HANDLE, SERVICE_CONFIG_DELAYED_AUTO_START_INFO,
    SERVICE_DELAYED_AUTO_START_INFO,
};
use windows_service::service::{Service, ServiceAccess, ServiceStartType, ServiceState};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::names::SERVICE_NAME;
use crate::platform::{PlatformError, ScmInfo, ScmState};

/// Abstand der Zustandsabfragen beim Warten.
const POLL: Duration = Duration::from_millis(250);

pub fn query() -> Result<ScmInfo, PlatformError> {
    query_service(SERVICE_NAME)
}

/// Fordert den Start von `pds` an und wartet nicht darauf.
pub fn start() -> Result<(), PlatformError> {
    start_service(SERVICE_NAME)
}

/// Stoppt `pds` und wartet höchstens `timeout`.
pub fn stop(timeout: Duration) -> Result<(), PlatformError> {
    stop_service(SERVICE_NAME, timeout)
}

/// Angaben des SCM zum Dienst `name`; nicht installiert ist kein Fehler.
pub fn query_service(name: &str) -> Result<ScmInfo, PlatformError> {
    let service = match open(
        name,
        ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG,
    ) {
        Ok(service) => service,
        Err(PlatformError::ServiceNotInstalled) => return Ok(ScmInfo::not_installed()),
        Err(error) => return Err(error),
    };
    let status = service
        .query_status()
        .map_err(|error| service_error("Dienststatus abfragen", error))?;
    let config = service
        .query_config()
        .map_err(|error| service_error("Dienstkonfiguration abfragen", error))?;
    Ok(ScmInfo {
        state: scm_state(status.current_state),
        start_type: start_type(config.start_type).to_owned(),
        delayed: config.start_type == ServiceStartType::AutoStart && delayed_auto_start(&service),
        account: config
            .account_name
            .map(|account| account.to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
}

/// Fordert den Start an und wartet nicht darauf. Läuft der Dienst schon, ist das kein Fehler.
pub fn start_service(name: &str) -> Result<(), PlatformError> {
    let service = open(name, ServiceAccess::START | ServiceAccess::QUERY_STATUS)?;
    match service.start::<&OsStr>(&[]) {
        Ok(()) => Ok(()),
        Err(error) if os_code(&error) == Some(ERROR_SERVICE_ALREADY_RUNNING.0) => Ok(()),
        Err(error) => Err(service_error("Dienst starten", error)),
    }
}

/// Stoppt den Dienst und wartet höchstens `timeout`, bis er steht. Läuft er nicht, ist das kein
/// Fehler.
pub fn stop_service(name: &str, timeout: Duration) -> Result<(), PlatformError> {
    let service = open(name, ServiceAccess::STOP | ServiceAccess::QUERY_STATUS)?;
    // Ohne `Instant + timeout`: Eine sehr große Wartezeit darf nicht überlaufen
    let started = Instant::now();
    let mut stop_sent = false;
    loop {
        let state = service
            .query_status()
            .map_err(|error| service_error("Dienststatus abfragen", error))?
            .current_state;
        match state {
            ServiceState::Stopped => return Ok(()),
            // Während eines Übergangs nimmt der Dienst keine Steuerbefehle an: abwarten
            ServiceState::StartPending
            | ServiceState::StopPending
            | ServiceState::ContinuePending
            | ServiceState::PausePending => {}
            ServiceState::Running | ServiceState::Paused => {
                if !stop_sent {
                    match service.stop() {
                        Ok(_) => stop_sent = true,
                        // Inzwischen von selbst beendet
                        Err(error) if os_code(&error) == Some(ERROR_SERVICE_NOT_ACTIVE.0) => {
                            return Ok(());
                        }
                        // Gerade im Übergang; beim nächsten Durchlauf erneut versuchen
                        Err(error)
                            if os_code(&error) == Some(ERROR_SERVICE_CANNOT_ACCEPT_CTRL.0) => {}
                        Err(error) => return Err(service_error("Dienst stoppen", error)),
                    }
                }
            }
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err(PlatformError::ServiceTimeout);
        }
        thread::sleep(POLL.min(timeout - elapsed));
    }
}

/// Stoppt (höchstens `timeout`) und startet den Dienst wieder.
pub fn restart(timeout: Duration) -> Result<(), PlatformError> {
    stop(timeout)?;
    start()
}

pub(super) fn open(name: &str, access: ServiceAccess) -> Result<Service, PlatformError> {
    // CONNECT reicht für jeden Benutzer; die eigentlichen Rechte prüft Windows am Dienst
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|error| service_error("Dienststeuerung öffnen", error))?;
    manager
        .open_service(name, access)
        .map_err(|error| service_error("Dienst öffnen", error))
}

/// Verzögerter Autostart. Nur zur Anzeige: Ist er nicht lesbar, gilt er als aus.
fn delayed_auto_start(service: &Service) -> bool {
    let mut buffer = [0u8; size_of::<SERVICE_DELAYED_AUTO_START_INFO>()];
    let mut needed = 0u32;
    // SAFETY: Das Handle gehört `service` und lebt während des Aufrufs; der Puffer hat genau die
    // Größe der erfragten Struktur.
    let result = unsafe {
        QueryServiceConfig2W(
            SC_HANDLE(service.raw_handle()),
            SERVICE_CONFIG_DELAYED_AUTO_START_INFO,
            Some(&mut buffer),
            &mut needed,
        )
    };
    if result.is_err() {
        return false;
    }
    // SAFETY: Windows hat die Struktur in den Puffer geschrieben; er ist evtl. nicht ausgerichtet.
    let info: SERVICE_DELAYED_AUTO_START_INFO =
        unsafe { std::ptr::read_unaligned(buffer.as_ptr().cast()) };
    info.fDelayedAutostart.as_bool()
}

fn scm_state(state: ServiceState) -> ScmState {
    match state {
        ServiceState::Stopped => ScmState::Stopped,
        ServiceState::StartPending => ScmState::StartPending,
        ServiceState::Running => ScmState::Running,
        ServiceState::StopPending => ScmState::StopPending,
        ServiceState::ContinuePending | ServiceState::PausePending | ServiceState::Paused => {
            ScmState::Other
        }
    }
}

fn start_type(start_type: ServiceStartType) -> &'static str {
    match start_type {
        ServiceStartType::AutoStart => "auto",
        ServiceStartType::OnDemand => "manual",
        ServiceStartType::Disabled => "disabled",
        ServiceStartType::BootStart => "boot",
        ServiceStartType::SystemStart => "system",
    }
}

pub(super) fn os_code(error: &windows_service::Error) -> Option<u32> {
    match error {
        windows_service::Error::Winapi(error) => error.raw_os_error().map(|code| code as u32),
        _ => None,
    }
}

pub(super) fn service_error(context: &'static str, error: windows_service::Error) -> PlatformError {
    match os_code(&error) {
        Some(code) if code == ERROR_SERVICE_DOES_NOT_EXIST.0 => PlatformError::ServiceNotInstalled,
        Some(code) if code == ERROR_ACCESS_DENIED.0 => PlatformError::AccessDenied,
        code => PlatformError::Os {
            context,
            code: code.unwrap_or_default(),
            message: error.to_string(),
        },
    }
}
