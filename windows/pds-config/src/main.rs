//! `pds-config.exe`: Konfigurationsoberfläche (Tauri 2, nur Windows). Das Manifest
//! verlangt Administratorrechte (`app.manifest`).

// Ohne Konsolenfenster neben der Oberfläche; Debug-Builds behalten es für Ausgaben
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod app;
#[cfg(windows)]
mod commands;

#[cfg(windows)]
fn main() {
    app::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!(
        "pds-config läuft nur unter Windows; unter anderen Systemen bitte die CLI \
         `pds config …` verwenden."
    );
    std::process::exit(1);
}
