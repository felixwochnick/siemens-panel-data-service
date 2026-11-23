//! Maskierte Sicht auf die Konfiguration für Anzeige, Export und Import.

use super::model::{Config, ConfigError, Sealed, SecretField, seal_secret};
use super::store::parse;
use crate::protect::Protector;
use crate::secret::Secret;

/// Platzhalter für ein gesetztes Secret. Beim Import heißt er "unverändert lassen".
pub const MASK: &str = "***";

/// Kopie, in der gesetzte Secrets `***` und leere `""` sind.
pub fn masked(cfg: &Config) -> Config {
    let mut view = cfg.clone();
    for field in SecretField::ALL {
        let value = if cfg.sealed(field).is_empty() {
            ""
        } else {
            MASK
        };
        *view.sealed_mut(field) = Sealed(value.to_owned());
    }
    view
}

/// Übernimmt `incoming` und löst die Secrets auf: `***` behält den Wert aus `existing`,
/// `""` löscht, ein mit dem eigenen Schema versiegelter Wert bleibt, alles andere gilt als
/// Klartext und wird versiegelt. (Ein echtes Passwort `***` ist damit nicht möglich.)
pub fn merge_masked(
    existing: &Config,
    incoming: Config,
    protector: &dyn Protector,
) -> Result<Config, ConfigError> {
    let mut merged = incoming;
    for field in SecretField::ALL {
        // Der Wert wandert heraus, damit kein Klartext im Modell zurückbleibt.
        let current = std::mem::take(merged.sealed_mut(field));
        let resolved = if current.is_empty() {
            current
        } else if current.0 == MASK {
            existing.sealed(field).clone()
        } else if current.is_sealed(protector.scheme()) {
            current
        } else {
            seal_secret(&Secret::new(current.0), protector)?
        };
        *merged.sealed_mut(field) = resolved;
    }
    Ok(merged)
}

/// Konfiguration als TOML mit maskierten Secrets (`config show --json` ausgenommen).
pub fn export_toml(cfg: &Config) -> String {
    toml::to_string_pretty(&masked(cfg)).expect("Konfiguration ist immer als TOML darstellbar")
}

/// Liest eine vollständige oder teilweise Datei (wie `export_toml`) und löst die Secrets
/// gegen `existing` auf.
pub fn import_toml(
    existing: &Config,
    text: &str,
    protector: &dyn Protector,
) -> Result<Config, ConfigError> {
    merge_masked(existing, parse(text)?, protector)
}
