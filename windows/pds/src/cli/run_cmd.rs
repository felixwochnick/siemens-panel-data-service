//! `run`: der Dienst im Vordergrund mit Log auf der Konsole, zum Fehlersuchen. Strg+C und SIGTERM
//! beenden ihn geordnet (Node bekommt Zeit für laufende Anfragen, dann Caddy).

use pds_common::Paths;
use pds_common::platform::{ScmState, scm};

use super::{CliError, CliResult, Exit};
use crate::daemon::{StopSignal, run_foreground};
use crate::logging;

pub fn run(paths: &Paths) -> CliResult {
    // Zwei Supervisor gegeneinander: gleiche Ports, gleiche Statusdatei
    if let Ok(info) = scm::query()
        && matches!(info.state, ScmState::Running | ScmState::StartPending)
    {
        return Err(CliError::new(
            "Der Windows-Dienst läuft bereits. Zum Fehlersuchen im Vordergrund ihn zuerst mit \
             `pds service stop` anhalten.",
        ));
    }
    foreground(paths)
}

/// Dienst im Vordergrund bis Strg+C bzw. SIGTERM; auch der versteckte `daemon` ohne Windows.
pub fn foreground(paths: &Paths) -> CliResult {
    logging::init(paths, true);
    let stop = StopSignal::new();
    let handler = stop.clone();
    ctrlc::set_handler(move || handler.stop())
        .map_err(|error| CliError::new(format!("Beenden per Signal nicht einrichtbar: {error}")))?;
    run_foreground(stop);
    Ok(Exit::Ok)
}
