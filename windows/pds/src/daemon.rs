//! Der Dienst: unter Windows über den Service Control Manager, sonst im Vordergrund.
//!
//! Die eigentliche Arbeit macht ein [`Runner`], im Betrieb der Supervisor: Er prüft die
//! Konfiguration, startet Caddy und Node und meldet den Status samt Heartbeat.

use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use pds_common::Paths;
use pds_common::names::product_version;
#[cfg(windows)]
use pds_common::platform::{EventLevel, eventlog};

use crate::supervisor::{Supervisor, SupervisorOptions, build_production};

/// Haltesignal, das Dienststeuerung, Strg+C oder SIGTERM auslösen. Klonbar; alle Klone teilen
/// denselben Zustand.
#[derive(Debug, Clone, Default)]
pub struct StopSignal(Arc<(Mutex<bool>, Condvar)>);

impl StopSignal {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fordert das Ende an und weckt alle Wartenden.
    pub fn stop(&self) {
        let (stopped, wake) = &*self.0;
        *stopped.lock().unwrap_or_else(PoisonError::into_inner) = true;
        wake.notify_all();
    }

    pub fn is_stopped(&self) -> bool {
        *self.0.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Wartet höchstens `timeout`; `true`, sobald das Ende angefordert ist.
    pub fn wait(&self, timeout: Duration) -> bool {
        let (stopped, wake) = &*self.0;
        let guard = stopped.lock().unwrap_or_else(PoisonError::into_inner);
        let (guard, _) = wake
            .wait_timeout_while(guard, timeout, |stopped| !*stopped)
            .unwrap_or_else(PoisonError::into_inner);
        *guard
    }
}

/// Arbeit des Dienstes zwischen Start und Haltesignal. Kehrt erst zurück, wenn `stop` ausgelöst
/// ist und alles geordnet beendet wurde.
pub trait Runner {
    fn run(self, stop: &StopSignal);
}

/// Für Fehler der Dienststeuerung selbst; Zustände meldet der Supervisor über seine Statussenke.
#[cfg(windows)]
fn write_event(level: EventLevel, message: &str) {
    if let Err(error) = eventlog::write(level, message) {
        tracing::warn!("Ereignisprotokoll nicht beschreibbar: {error}");
    }
}

fn runner_for(paths: Paths) -> Supervisor {
    build_production(&paths, SupervisorOptions::default())
}

/// Dienst im Vordergrund, bis `stop` ausgelöst wird (Strg+C, SIGTERM). Das Log richtet der
/// Aufrufer ein.
pub fn run_foreground(stop: StopSignal) {
    let paths = Paths::detect();
    tracing::info!(
        "Dienst startet im Vordergrund (Version {}, Daten {})",
        product_version(),
        paths.data_dir.display()
    );
    runner_for(paths).run(&stop);
}

/// Fehler beim Anmelden beim Service Control Manager.
#[cfg(windows)]
#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
    #[error(
        "Der Unterbefehl daemon wird nur vom Dienststeuerungs-Manager gestartet; \
         den Dienst mit `pds service start` starten"
    )]
    NotAService,
    #[error("Dienststeuerung nicht erreichbar: {0}")]
    Dispatcher(windows_service::Error),
}

#[cfg(windows)]
pub use service::run_service;

/// Anbindung an den Service Control Manager.
#[cfg(windows)]
mod service {
    use std::ffi::OsString;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::Duration;

    use pds_common::Paths;
    use pds_common::names::{SERVICE_NAME, product_version};
    use pds_common::platform::EventLevel;
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState as ScmState,
        ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{
        self, ServiceControlHandlerResult, ServiceStatusHandle,
    };
    use windows_service::{define_windows_service, service_dispatcher};

    use super::{DaemonError, Runner, StopSignal, runner_for, write_event};
    use crate::logging;

    /// Zeit, die der SCM beim Starten bzw. Beenden abwarten soll. Beim Beenden bekommt Node bis zu
    /// 15 s für laufende Anfragen, dazu Caddy.
    const START_WAIT_HINT: Duration = Duration::from_secs(10);
    const STOP_WAIT_HINT: Duration = Duration::from_secs(30);

    /// `ERROR_FAILED_SERVICE_CONTROLLER_CONNECT`: nicht vom SCM gestartet (z. B. aus der Konsole).
    const NOT_STARTED_BY_SCM: i32 = 1063;

    define_windows_service!(ffi_service_main, service_main);

    /// Übergibt an den SCM; kehrt erst zurück, wenn der Dienst beendet ist.
    pub fn run_service() -> Result<(), DaemonError> {
        service_dispatcher::start(SERVICE_NAME, ffi_service_main).map_err(|error| match &error {
            windows_service::Error::Winapi(io) if io.raw_os_error() == Some(NOT_STARTED_BY_SCM) => {
                DaemonError::NotAService
            }
            _ => DaemonError::Dispatcher(error),
        })
    }

    fn service_main(_arguments: Vec<OsString>) {
        // Log, Konfiguration und Supervisor erst nach der Meldung „läuft“ an den SCM (in `run`):
        // Dessen Zeitlimit für den Start soll nur Prozessstart und Anmeldung abdecken
        if let Err(error) = run() {
            let message = format!("Dienst konnte nicht mit dem SCM arbeiten: {error}");
            tracing::error!("{message}");
            write_event(EventLevel::Error, &message);
        }
    }

    fn run() -> windows_service::Result<()> {
        let stop = StopSignal::new();
        // Der Handler meldet „wird beendet“ selbst. Nach „gestoppt“ ist das Handle weg, damit ein
        // verspäteter Stopp-Befehl den Zustand nicht zurückdreht.
        let shared: Arc<Mutex<Option<ServiceStatusHandle>>> = Arc::new(Mutex::new(None));
        let handler_stop = stop.clone();
        let handler_shared = Arc::clone(&shared);
        let handle =
            service_control_handler::register(SERVICE_NAME, move |control| match control {
                ServiceControl::Stop | ServiceControl::Shutdown | ServiceControl::Preshutdown => {
                    let guard = handler_shared
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    if let Some(handle) = guard.as_ref() {
                        let _ = handle.set_service_status(stop_pending());
                    }
                    handler_stop.stop();
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            })?;
        *shared.lock().unwrap_or_else(PoisonError::into_inner) = Some(handle);

        let started = handle
            .set_service_status(service_status(
                ScmState::StartPending,
                ServiceControlAccept::empty(),
                1,
                START_WAIT_HINT,
            ))
            .and_then(|()| {
                handle.set_service_status(service_status(
                    ScmState::Running,
                    // Preshutdown gibt beim Herunterfahren mehr Zeit als Shutdown allein
                    ServiceControlAccept::STOP
                        | ServiceControlAccept::SHUTDOWN
                        | ServiceControlAccept::PRESHUTDOWN,
                    0,
                    Duration::ZERO,
                ))
            });
        if let Err(error) = started {
            // Trotzdem „gestoppt“ versuchen, sonst hängt der Dienst für den SCM im Start
            shared.lock().unwrap_or_else(PoisonError::into_inner).take();
            let _ = handle.set_service_status(stopped(ServiceExitCode::ServiceSpecific(1)));
            return Err(error);
        }

        let paths = Paths::detect();
        logging::init(&paths, false);
        // Ohne Konsole ginge die Meldung eines Abbruchs sonst verloren
        std::panic::set_hook(Box::new(|info| tracing::error!("Abbruch: {info}")));
        tracing::info!("Dienst startet (Version {})", product_version());
        let runner = runner_for(paths);
        let outcome = catch_unwind(AssertUnwindSafe(|| Runner::run(runner, &stop)));
        // Ein Absturz endet mit Fehlercode, damit die Wiederherstellung des SCM neu startet
        let exit_code = match outcome {
            Ok(()) => ServiceExitCode::Win32(0),
            Err(_) => {
                let message = "Der Dienst ist unerwartet abgebrochen";
                tracing::error!("{message}");
                write_event(EventLevel::Error, message);
                ServiceExitCode::ServiceSpecific(1)
            }
        };

        // Erst das Handle wegnehmen (ein laufender Handler meldet dann vorher), dann melden
        shared.lock().unwrap_or_else(PoisonError::into_inner).take();
        handle.set_service_status(stopped(exit_code))
    }

    fn stopped(exit_code: ServiceExitCode) -> ServiceStatus {
        ServiceStatus {
            exit_code,
            ..service_status(
                ScmState::Stopped,
                ServiceControlAccept::empty(),
                0,
                Duration::ZERO,
            )
        }
    }

    fn stop_pending() -> ServiceStatus {
        service_status(
            ScmState::StopPending,
            ServiceControlAccept::empty(),
            1,
            STOP_WAIT_HINT,
        )
    }

    fn service_status(
        state: ScmState,
        controls_accepted: ServiceControlAccept,
        checkpoint: u32,
        wait_hint: Duration,
    ) -> ServiceStatus {
        ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint,
            wait_hint,
            process_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::Instant;

    use super::*;

    #[test]
    fn stop_signal_wait_times_out_without_stop() {
        let stop = StopSignal::new();

        let started = Instant::now();
        assert!(!stop.wait(Duration::from_millis(50)));
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert!(!stop.is_stopped());
    }

    #[test]
    fn stop_signal_wakes_waiters_in_other_threads() {
        let stop = StopSignal::new();
        let remote = stop.clone();
        let waiter = thread::spawn(move || remote.wait(Duration::from_secs(10)));

        thread::sleep(Duration::from_millis(20));
        stop.stop();

        assert!(waiter.join().unwrap());
        assert!(stop.is_stopped());
        // Einmal ausgelöst, bleibt es ausgelöst
        assert!(stop.wait(Duration::from_secs(10)));
    }
}
