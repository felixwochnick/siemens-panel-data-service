//! Lesen und atomares Schreiben von `config.toml`.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::model::{Config, ConfigError, SCHEMA_VERSION, SecretField};

/// Liest die Konfiguration. Eine fehlende Datei ergibt die Standardwerte, damit der Dienst
/// vor der ersten Einrichtung startet und "nicht konfiguriert" melden kann.
pub fn load(path: &Path) -> Result<Config, ConfigError> {
    match fs::read_to_string(path) {
        Ok(text) => parse(&text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Config::default()),
        Err(error) => Err(ConfigError::Unreadable(format!(
            "{}: {error}",
            path.display()
        ))),
    }
}

/// Parst TOML-Text; gemeinsam für `load` und `import_toml`.
pub fn parse(text: &str) -> Result<Config, ConfigError> {
    // Die Version vorab prüfen: Eine neuere Datei darf Felder haben, die wir nicht kennen,
    // und soll dann als "andere Version" gemeldet werden statt als unbekanntes Feld.
    #[derive(Deserialize)]
    struct Probe {
        schema: Option<u32>,
    }
    let probe: Probe = toml::from_str(text).map_err(|error| unreadable(text, &error))?;
    if let Some(schema) = probe.schema
        && schema != SCHEMA_VERSION
    {
        return Err(ConfigError::UnsupportedSchema(schema));
    }
    toml::from_str(text).map_err(|error| unreadable(text, &error))
}

// Nur Meldung und Position, nicht der Zeilenauszug der TOML-Fehler: Die Zeile könnte ein von
// Hand eingetragenes Secret enthalten.
fn unreadable(text: &str, error: &toml::de::Error) -> ConfigError {
    let position = error.span().map(|span| {
        let before = &text[..span.start.min(text.len())];
        let line = before.matches('\n').count() + 1;
        let column = before
            .rsplit('\n')
            .next()
            .map_or(0, |last| last.chars().count())
            + 1;
        format!("Zeile {line}, Spalte {column}: ")
    });
    ConfigError::Unreadable(format!(
        "{}{}",
        position.unwrap_or_default(),
        without_value(error.message())
    ))
}

// serde nennt bei falschem Typ den Wert ("invalid type: integer `12345`, expected a string").
// Bei einem Secret ohne Anführungszeichen wäre das das Secret, also nur die Erwartung behalten.
fn without_value(message: &str) -> String {
    let has_value = ["invalid type: ", "invalid value: "]
        .iter()
        .any(|prefix| message.starts_with(prefix));
    match message.rsplit_once(", expected ") {
        Some((_, expected)) if has_value => format!("ungültiger Wert, erwartet {expected}"),
        _ => message.to_owned(),
    }
}

/// Schreibt die Konfiguration atomar (Temp-Datei, dann `rename`), damit ein Absturz nie eine
/// halbe Datei hinterlässt. Verweigert die Datei, wenn ein Secret nicht versiegelt ist.
pub fn save(path: &Path, cfg: &Config) -> Result<(), ConfigError> {
    for field in SecretField::ALL {
        let sealed = cfg.sealed(field);
        if !sealed.is_empty() && !sealed.has_known_scheme() {
            return Err(ConfigError::UnsealedSecret(field.path()));
        }
    }
    let text =
        toml::to_string_pretty(cfg).map_err(|error| ConfigError::Write(error.to_string()))?;
    write_atomic(path, text.as_bytes())
        .map_err(|error| ConfigError::Write(format!("{}: {error}", path.display())))
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let temp = temp_path(path);
    let result = write_then_rename(&temp, path, bytes);
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_then_rename(temp: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temp, path)
}

// Im selben Ordner (sonst wäre `rename` nicht atomar), mit PID gegen gleichzeitige Schreiber.
fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.{}.tmp", std::process::id()))
}
