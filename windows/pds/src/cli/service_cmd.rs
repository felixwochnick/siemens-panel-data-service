//! `service start|stop|restart` über den SCM und der versteckte Dienstbetrieb `daemon`.
//!
//! Mit `--wait` warten Start und Neustart, bis der Dienst läuft und die Anwendung antwortet
//! (Exit 3, wenn nicht): So lassen sich Änderungen in Skripten übernehmen und prüfen.

use std::time::Duration;

use pds_common::Paths;
use pds_common::ops::{self, ApplyOutcome};
use pds_common::platform::{ScmState, scm};
use time::OffsetDateTime;

#[cfg(windows)]
use super::CliError;
use super::{CliResult, Exit};

/// So lange wartet `--wait` und `stop` ohne `--timeout`.
const DEFAULT_TIMEOUT_SECONDS: u64 = 90;

/// Wartezeit aus `--timeout`.
pub fn timeout(seconds: Option<u64>) -> Duration {
    Duration::from_secs(seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS))
}

/// `wait`: so lange auf einen gesunden Dienst warten; `None` = nicht warten.
pub fn start(paths: &Paths, wait: Option<Duration>) -> CliResult {
    // Läuft der Dienst schon, ist sein Status älter als diese Anforderung und doch der richtige
    let already_running = matches!(scm::query(), Ok(info) if info.state == ScmState::Running);
    let requested = if already_running {
        OffsetDateTime::UNIX_EPOCH
    } else {
        OffsetDateTime::now_utc()
    };
    scm::start()?;
    match wait {
        None => {
            println!("Dienst wird gestartet. Zustand mit `pds status` prüfen.");
            Ok(Exit::Ok)
        }
        Some(timeout) => {
            println!("Dienst wird gestartet, warte auf die Anwendung …");
            Ok(report(&ops::wait_for_running(paths, requested, timeout)))
        }
    }
}

/// Stoppt und wartet immer, bis der Dienst steht, höchstens `timeout`.
pub fn stop(timeout: Duration) -> CliResult {
    scm::stop(timeout)?;
    println!("Dienst gestoppt.");
    Ok(Exit::Ok)
}

pub fn restart(paths: &Paths, wait: Option<Duration>) -> CliResult {
    match wait {
        None => {
            scm::restart(ops::STOP_TIMEOUT)?;
            println!("Dienst neu gestartet. Zustand mit `pds status` prüfen.");
            Ok(Exit::Ok)
        }
        Some(timeout) => {
            println!("Dienst wird neu gestartet, warte auf die Anwendung …");
            Ok(report(&ops::apply(paths, timeout)?))
        }
    }
}

/// Ergebnis des Wartens: Bestätigung (Exit 0) oder der Grund auf stderr (Exit 3).
fn report(outcome: &ApplyOutcome) -> Exit {
    if outcome.ok {
        println!("{} ({} s)", outcome.message, outcome.waited_seconds);
        Exit::Ok
    } else {
        eprintln!(
            "Der Dienst ist nicht bereit: {}\nMehr zeigen `pds status` und die Logs \
             im Datenordner.",
            outcome.message
        );
        Exit::CheckFailed
    }
}

/// Windows: Übergabe an den SCM, der die EXE mit `daemon` startet.
#[cfg(windows)]
pub fn daemon(_paths: &Paths) -> CliResult {
    crate::daemon::run_service().map_err(|error| CliError::new(error.to_string()))?;
    Ok(Exit::Ok)
}

/// Ohne Windows im Vordergrund; Strg+C, SIGTERM und SIGHUP beenden geordnet.
#[cfg(not(windows))]
pub fn daemon(paths: &Paths) -> CliResult {
    super::run_cmd::foreground(paths)
}
