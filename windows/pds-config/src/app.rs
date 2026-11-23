//! Start der Oberfläche: Tauri mit Dateiauswahl und den Befehlen aus [`crate::commands`].

use std::sync::Arc;

use pds_config::logic::Backend;
use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
use windows::core::HSTRING;

use crate::commands;

pub fn run() {
    let context = tauri::tauri_build_context!();
    let title = context.config().product_name.clone().unwrap_or_default();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Backend::system()))
        .invoke_handler(tauri::generate_handler![
            commands::load_state,
            commands::validate_draft,
            commands::save_draft,
            commands::get_status,
            commands::service_control,
            commands::eplan_install,
            commands::eplan_control,
            commands::tls_import_pfx,
            commands::tls_import_pem,
            commands::tls_import_store,
            commands::tls_list_store,
            commands::db_test,
            commands::db_setup,
            commands::db_script,
            commands::db_backup,
            commands::oidc_test,
            commands::ports_check,
            commands::regenerate_app_secret,
            commands::logs_dir,
            commands::open_log_file,
            commands::open_web_console,
        ])
        .run(context);
    if let Err(error) = result {
        // Ohne Konsole sähe niemand den Fehler
        show_error(
            &title,
            &format!(
                "Die Oberfläche konnte nicht gestartet werden: {error}\n\nIst die Microsoft Edge \
                 WebView2 Runtime installiert? Ohne Oberfläche lässt sich alles auch mit \
                 `pds config …` einrichten."
            ),
        );
        std::process::exit(1);
    }
}

fn show_error(title: &str, text: &str) {
    // SAFETY: Beide Texte leben bis zum Ende des Aufrufs; kein Elternfenster
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(text),
            &HSTRING::from(title),
            MB_OK | MB_ICONERROR,
        );
    }
}
