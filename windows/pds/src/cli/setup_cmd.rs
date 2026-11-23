//! `setup install` und `setup uninstall [--remove-data]`: Aufrufe des MSI (als SYSTEM).
//!
//! Den Worker-Dienst `pds-eplan` legt das MSI nicht an (sein Konto kennt erst `pds eplan install`),
//! es stoppt ihn nur vor dem Ersetzen der Dateien. `setup install` startet ihn nach einem Update
//! wieder und behält dabei die Ordnerrechte seines Kontos; `setup uninstall` (nur bei der
//! Deinstallation, nicht beim Update) entfernt ihn.
//!
//! Ohne Windows nur Datenordner und App-Secret bzw. das Löschen der Daten.

use std::fs;
use std::io;

use pds_common::config::ConfigError;
#[cfg(windows)]
use pds_common::eplan::{self, SystemHost};
use pds_common::names::product_version;
use pds_common::ops::{self, OpsError};
use pds_common::platform::{self, EventLevel, PlatformError, SecureOutcome, eventlog};
use pds_common::{Paths, system_protector};

use super::{CliError, CliResult, Exit};
use crate::logging;

pub fn install(paths: &Paths) -> CliResult {
    let outcome = platform::secure_data_dir(paths).map_err(|error| {
        let hint = match error {
            PlatformError::AccountNotFound => {
                " `setup install` läuft erst nach der Dienstinstallation durch das MSI."
            }
            _ => "",
        };
        CliError::new(format!(
            "Datenordner {} konnte nicht eingerichtet werden: {error}{hint}",
            paths.data_dir.display()
        ))
    })?;
    // Erst jetzt: Der Logordner existiert und hat seine Rechte
    logging::init(paths, true);
    tracing::info!(
        "Einrichtung von Version {} in {}",
        product_version(),
        paths.data_dir.display()
    );
    let result = install_steps(paths, &outcome);
    match &result {
        Ok(_) => tracing::info!("Einrichtung abgeschlossen"),
        Err(error) => tracing::error!("Einrichtung fehlgeschlagen: {error}"),
    }
    result
}

/// Alles nach dem Datenordner; Fehler landen so auch im Log.
fn install_steps(paths: &Paths, secured: &SecureOutcome) -> CliResult {
    // Zuerst, damit der Hinweis auch bei einem späteren Fehler nicht verloren geht; ohne
    // registrierte Quelle schreibt Windows den Eintrag trotzdem ins Anwendungsprotokoll
    for moved in &secured.moved_aside {
        warn(&format!(
            "Vorhandener Ordner hatte unsichere Rechte und wurde nach {} verschoben; der Inhalt \
             bleibt dort erhalten",
            moved.display()
        ));
    }
    if let Some(message) = removed_aces_message(&secured.removed_aces) {
        warn(&message);
    }
    for message in &secured.warnings {
        warn(message);
    }
    if let Some(account) = &secured.worker {
        tracing::info!("EPLAN-Worker ({account}) behält seine Rechte im Datenordner");
    }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()
            .map_err(|error| CliError::new(format!("Pfad der EXE unbekannt: {error}")))?;
        eventlog::register_source(&exe)?;
        tracing::info!("Ereignisquelle registriert");
        // Das MSI hat den Worker vor dem Ersetzen der Dateien gestoppt; er braucht weder App-Secret
        // noch Firewall, also gleich wieder starten
        match eplan::start_after_update(&SystemHost) {
            Ok(true) => tracing::info!("EPLAN-Worker gestartet"),
            Ok(false) => tracing::info!("EPLAN-Worker nicht eingerichtet oder deaktiviert"),
            Err(error) => warn(&format!(
                "EPLAN-Worker ließ sich nicht starten: {error} – Zustand mit `pds eplan status` \
                 prüfen"
            )),
        }
    }

    // Eine von Hand kaputt gemachte Konfiguration darf ein Update nicht scheitern lassen: Sie
    // bleibt unverändert, ebenso App-Secret und Firewall-Regel
    match ops::ensure_app_secret(paths, &*system_protector()) {
        Ok(true) => tracing::info!("App-Secret erzeugt"),
        Ok(false) => tracing::info!("App-Secret vorhanden"),
        Err(OpsError::Config(
            error @ (ConfigError::Unreadable(_)
            | ConfigError::UnsupportedSchema(_)
            | ConfigError::UnsealedSecret(_)),
        )) => {
            warn(&format!(
                "{error} – App-Secret und Firewall-Regel bleiben unverändert; reparieren mit \
                 `pds config import <datei>`"
            ));
            return Ok(Exit::Ok);
        }
        Err(error) => return Err(error.into()),
    }

    #[cfg(windows)]
    {
        let config = pds_common::config::load(&paths.config_file())?;
        match ops::firewall_step(&config, &paths.caddy_exe(), platform::firewall::ensure_rule) {
            Ok(ports) => tracing::info!("Firewall-Regel für TCP {ports:?} eingerichtet"),
            Err(message) => warn(&message),
        }
        // Ein eigener SQLite-Ordner (oder eine hineinkopierte Datenbank) bekommt seine Rechte auch
        // bei Update und Reparatur
        match ops::sqlite_dir_step(&config, paths, platform::prepare_sqlite_dir) {
            Ok(outcome) => log_sqlite_dir(&outcome),
            Err(message) => warn(&message),
        }
    }
    Ok(Exit::Ok)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn log_sqlite_dir(outcome: &platform::SqliteDirOutcome) {
    if let Some(dir) = &outcome.created {
        tracing::info!("Ordner {} für die SQLite-Datenbank angelegt", dir.display());
    }
    for path in &outcome.granted {
        tracing::info!("Dienstkonto bekommt Ändern auf {}", path.display());
    }
}

/// Meldung zu Berechtigungen, die beim erneuten Setzen der Rechte weggefallen sind (etwa Lesen für
/// ein Sicherungskonto, das ein Admin ergänzt hatte); `None`, wenn keine.
fn removed_aces_message(removed: &[String]) -> Option<String> {
    (!removed.is_empty()).then(|| {
        format!(
            "Zusätzliche Berechtigungen am Datenordner entfernt: {}. Der Datenordner erlaubt nur \
             SYSTEM, Administratoren und dem Dienstkonto Zugriff.",
            removed.join("; ")
        )
    })
}

/// Warnung in Log und Ereignisprotokoll.
fn warn(message: &str) {
    tracing::warn!("{message}");
    if let Err(error) = eventlog::write(EventLevel::Warning, message) {
        tracing::warn!("Ereignisprotokoll nicht beschreibbar: {error}");
    }
}

/// Entfernt EPLAN-Worker, Firewall-Regel und Ereignisquelle, mit `remove_data` auch den
/// Datenordner. Versucht jeden Schritt und meldet alle Fehler gesammelt (Exit 1). Kein Log in den
/// Datenordner: Eine offene Logdatei verhinderte unter Windows das Löschen.
pub fn uninstall(paths: &Paths, remove_data: bool) -> CliResult {
    let mut failures: Vec<String> = Vec::new();

    #[cfg(windows)]
    {
        // Zuerst: Der Worker hält Dateien im Installationsordner offen. Nur stoppen und entfernen;
        // die Rechte im Datenordner neu zu setzen ginge nicht mehr, das MSI hat `pds` samt Konto
        // schon entfernt
        match eplan::remove(&SystemHost) {
            Ok(true) => println!("EPLAN-Worker (pds-eplan) entfernt."),
            Ok(false) => {}
            Err(error) => failures.push(format!("EPLAN-Worker nicht entfernt: {error}")),
        }
        match platform::firewall::remove_rule() {
            Ok(()) => println!("Firewall-Regel entfernt."),
            Err(error) => failures.push(format!("Firewall-Regel nicht entfernt: {error}")),
        }
        match eventlog::deregister_source() {
            Ok(()) => println!("Ereignisquelle entfernt."),
            Err(error) => failures.push(format!("Ereignisquelle nicht entfernt: {error}")),
        }
    }

    if remove_data {
        // `remove_dir_all` folgt Junctions und symbolischen Links nicht, sondern entfernt nur den
        // Verweis: Ein präparierter Datenordner kann so nichts außerhalb löschen lassen
        match fs::remove_dir_all(&paths.data_dir) {
            Ok(()) => println!("Datenordner {} entfernt.", paths.data_dir.display()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                println!(
                    "Datenordner {} war nicht vorhanden.",
                    paths.data_dir.display()
                );
            }
            Err(error) => failures.push(format!(
                "Datenordner {} nicht entfernt: {error}",
                paths.data_dir.display()
            )),
        }
    }

    if failures.is_empty() {
        Ok(Exit::Ok)
    } else {
        Err(CliError::new(failures.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removed_aces_message_lists_principals() {
        assert_eq!(removed_aces_message(&[]), None);
        let message = removed_aces_message(&[
            r"VORDEFINIERT\Benutzer (S-1-5-32-545)".to_owned(),
            r"config.toml: VORDEFINIERT\Benutzer (S-1-5-32-545)".to_owned(),
        ])
        .unwrap();
        assert!(
            message.starts_with(
                "Zusätzliche Berechtigungen am Datenordner entfernt: VORDEFINIERT\\Benutzer \
                 (S-1-5-32-545); config.toml: VORDEFINIERT\\Benutzer (S-1-5-32-545)."
            ),
            "{message}"
        );
    }
}
