//! Log des Dienstes: `logs\service.log`, rotierend (10 MB × 5), im Vordergrund auch auf stderr.
//!
//! Nie Secrets oder Umgebungswerte loggen; die Meldungen sind deutsch und für Admins gedacht.

use std::io;
use std::path::Path;
use std::sync::Mutex;

use pds_common::Paths;
use file_rotate::compression::Compression;
use file_rotate::suffix::AppendCount;
use file_rotate::{ContentLimit, FileRotate};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt;
use tracing_subscriber::prelude::*;

/// Höchstgröße einer Logdatei, danach wird rotiert.
pub const MAX_LOG_BYTES: usize = 10 * 1024 * 1024;
/// Dateien je Log: die aktuelle und vier ältere (`.1` … `.4`).
pub const LOG_FILES: usize = 5;

/// Rotierende Logdatei. Der Ordner muss existieren: Unter Windows legt ihn `setup install` mit
/// passenden Rechten an, hier entstünde er mit geerbten.
pub fn rotating_file(path: &Path) -> io::Result<FileRotate<AppendCount>> {
    let dir = path.parent().unwrap_or(Path::new("."));
    if !dir.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Logordner {} fehlt", dir.display()),
        ));
    }
    // Rotiert erst nach der Zeile, die die Grenze überschreitet: keine zerteilten Zeilen
    Ok(FileRotate::new(
        path,
        AppendCount::new(LOG_FILES - 1),
        ContentLimit::BytesSurpassed(MAX_LOG_BYTES),
        Compression::None,
        None,
    ))
}

/// Richtet das Log ein (einmal je Prozess, weitere Aufrufe tun nichts). Lässt sich die Datei nicht
/// öffnen, geht es ohne weiter: Ein fehlendes Log darf den Dienst nicht aufhalten.
pub fn init(paths: &Paths, foreground: bool) {
    // Ohne Windows gibt es keine Installation, die den Ordner anlegt
    if cfg!(not(windows)) {
        let _ = std::fs::create_dir_all(paths.logs_dir());
    }
    let file = match rotating_file(&paths.logs_dir().join("service.log")) {
        Ok(file) => Some(file),
        Err(error) => {
            eprintln!("Hinweis: Logdatei nicht verfügbar ({error}), Ausgabe nur auf stderr");
            None
        }
    };
    let file_layer = file.map(|file| {
        fmt::layer()
            .with_target(false)
            .with_writer(Mutex::new(file))
    });
    // Im Dienst gibt es keine Konsole; ohne Datei bleibt stderr der einzige Weg (Ereignisprotokoll
    // und MSI-Log fangen ihn ggf. auf)
    let stderr_layer = (foreground || file_layer.is_none())
        .then(|| fmt::layer().with_target(false).with_writer(io::stderr));
    let _ = tracing_subscriber::registry()
        .with(LevelFilter::INFO)
        .with(file_layer)
        .with(stderr_layer)
        .try_init();
}
