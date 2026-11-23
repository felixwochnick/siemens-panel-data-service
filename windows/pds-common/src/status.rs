//! Status des Dienstes (`state\status.json`) für UI und CLI.
//!
//! Der Dienst schreibt den Status bei jeder Änderung und zusätzlich alle [`HEARTBEAT_INTERVAL`] als
//! Lebenszeichen. UI und CLI lesen ihn nur. Stürzt der Dienst ab oder wird er hart beendet, steht
//! dort weiter `running`; [`is_stale`] erkennt das am alten Heartbeat, damit die Anzeige
//! "Dienst läuft nicht" zeigen kann. Der Status enthält nie ein Secret.

use std::fs;
use std::io;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::OffsetDateTime;
use ts_rs::TS;

use crate::config::store::write_atomic;
use crate::validate::Finding;

/// So oft schreibt der Dienst den Heartbeat.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

/// Ab diesem Alter gilt der Heartbeat als veraltet: drei verpasste Schläge, damit ein einzelner
/// langsamer Schreibvorgang (Virenscanner, Last) keinen Fehlalarm auslöst.
const STALE_AFTER: time::Duration = time::Duration::seconds(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ServiceState {
    /// Keine gültige Konfiguration; der Dienst läuft, startet aber keine Kindprozesse.
    Unconfigured,
    Starting,
    Running,
    /// Ein Kindprozess ist beendet und wird nach einer Wartezeit neu gestartet.
    Backoff,
    /// Die App lehnt ihre Konfiguration ab; kein automatischer Neustart.
    ConfigError,
    Stopping,
    Stopped,
}

impl ServiceState {
    /// Zustand auf Deutsch für CLI und UI.
    pub fn text(self) -> &'static str {
        match self {
            Self::Unconfigured => "nicht eingerichtet",
            Self::Starting => "startet",
            Self::Running => "läuft",
            Self::Backoff => "wartet auf erneuten Versuch",
            Self::ConfigError => "Konfigurationsfehler",
            Self::Stopping => "wird beendet",
            Self::Stopped => "gestoppt",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChildStatus {
    pub pid: Option<u32>,
    pub running: bool,
    /// Neustarts seit dem Start des Dienstes.
    pub restarts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HealthStatus {
    pub ok: bool,
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub checked_at: OffsetDateTime,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ErrorInfo {
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub at: OffsetDateTime,
    /// Woher der Fehler kommt: `app`, `proxy` oder `service`.
    pub source: String,
    /// Deutsche Meldung für Admins, bereits ohne Secrets.
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Status {
    pub state: ServiceState,
    /// Seit wann der Dienst in diesem Zustand ist.
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub since: OffsetDateTime,
    /// Letztes Lebenszeichen des Dienstes, siehe `is_stale`.
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub heartbeat: OffsetDateTime,
    pub product_version: String,
    pub node_version: String,
    pub caddy_version: String,
    pub health: Option<HealthStatus>,
    pub last_error: Option<ErrorInfo>,
    /// Zeitpunkt des nächsten Neustartversuchs, nur im Zustand `backoff`.
    // `default`: Mit `with` fehlt sonst der Rückfall auf `None`, und eine Datei ohne den
    // Schlüssel gälte als beschädigt.
    #[serde(default, with = "time::serde::rfc3339::option")]
    #[ts(type = "string | null")]
    pub next_attempt: Option<OffsetDateTime>,
    /// Befunde der letzten Konfigurationsprüfung.
    pub findings: Vec<Finding>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    #[ts(type = "string | null")]
    pub certificate_not_after: Option<OffsetDateTime>,
    pub app: ChildStatus,
    pub proxy: ChildStatus,
}

#[derive(Debug, Error)]
pub enum StatusError {
    #[error("Die Statusdatei konnte nicht gelesen werden: {0}")]
    Io(String),
    #[error("Die Statusdatei ist beschädigt: {0}")]
    Corrupt(String),
}

/// Schreibt den Status atomar. UI und CLI lesen mitten im Schreiben nie eine halbe Datei.
pub fn write(path: &Path, status: &Status) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(status)?;
    write_atomic(path, &json)
}

/// Liest den Status. Eine fehlende Datei ist `None` (der Dienst lief noch nie), eine kaputte ein
/// Fehler; beides führt nie zu einer Panik.
pub fn read(path: &Path) -> Result<Option<Status>, StatusError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(StatusError::Io(format!("{}: {error}", path.display()))),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| StatusError::Corrupt(error.to_string()))
}

/// Ist der Heartbeat älter als 30 s? Dann läuft der Dienst nicht mehr, egal was `state` sagt.
/// Ein Heartbeat in der Zukunft (Uhrsprung rückwärts) gilt als frisch.
pub fn is_stale(status: &Status, now: OffsetDateTime) -> bool {
    now - status.heartbeat > STALE_AFTER
}
