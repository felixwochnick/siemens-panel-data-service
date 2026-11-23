//! Tauri-Befehle: dünne Hülle um [`logic`]. Jeder läuft in einem eigenen Thread (Speichern wartet
//! bis zu 90 s auf den Dienst), damit Fenster und Statusabfrage weiterlaufen. Argumente kommen aus
//! JS in camelCase (`adminUser` ⇒ `admin_user`), Fehler als `UiError { code, message }`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use pds_common::Secret;
use pds_common::config::Config;
use pds_common::ops::{DbSetupOutcome, StatusReport};
use pds_common::platform::{PortStatus, StoreCert};
use pds_common::tls::CertInfo;
use pds_common::tools::ToolResult;
use pds_common::validate::Finding;
use pds_config::logic::{self, Backend, SaveDraftOutcome, ServiceAction, UiError, UiState};
use tauri::State;
use time::OffsetDateTime;

type Shared<'a> = State<'a, Arc<Backend>>;

/// Führt `task` außerhalb des Hauptthreads aus.
async fn run<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, UiError> + Send + 'static,
) -> Result<T, UiError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| UiError::new("internal_error", format!("Interner Fehler: {error}")))?
}

async fn with<T: Send + 'static>(
    backend: &Shared<'_>,
    task: impl FnOnce(&Backend) -> Result<T, UiError> + Send + 'static,
) -> Result<T, UiError> {
    let backend = Arc::clone(backend.inner());
    run(move || task(&backend)).await
}

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

#[tauri::command]
pub async fn load_state(backend: Shared<'_>) -> Result<UiState, UiError> {
    with(&backend, |backend| Ok(backend.load_state(now()))).await
}

#[tauri::command]
pub async fn validate_draft(backend: Shared<'_>, draft: Config) -> Result<Vec<Finding>, UiError> {
    with(&backend, |backend| Ok(backend.validate_draft(draft, now()))).await
}

#[tauri::command]
pub async fn save_draft(backend: Shared<'_>, draft: Config) -> Result<SaveDraftOutcome, UiError> {
    with(&backend, |backend| backend.save_draft(draft, now())).await
}

#[tauri::command]
pub async fn get_status(backend: Shared<'_>) -> Result<StatusReport, UiError> {
    with(&backend, |backend| Ok(backend.get_status())).await
}

#[tauri::command]
pub async fn service_control(
    backend: Shared<'_>,
    action: ServiceAction,
) -> Result<StatusReport, UiError> {
    with(&backend, move |backend| backend.service_control(action)).await
}

#[tauri::command]
pub async fn tls_import_pfx(
    backend: Shared<'_>,
    path: PathBuf,
    password: String,
    host: String,
) -> Result<CertInfo, UiError> {
    // Gleich in ein Secret: Es wird beim Freigeben überschrieben
    let password = Secret::new(password);
    with(&backend, move |backend| {
        backend.tls_import_pfx(&path, password, &host, now())
    })
    .await
}

#[tauri::command]
pub async fn tls_import_pem(
    backend: Shared<'_>,
    cert_path: PathBuf,
    key_path: PathBuf,
    host: String,
) -> Result<CertInfo, UiError> {
    with(&backend, move |backend| {
        backend.tls_import_pem(&cert_path, &key_path, &host, now())
    })
    .await
}

#[tauri::command]
pub async fn tls_import_store(
    backend: Shared<'_>,
    thumbprint: String,
    host: String,
) -> Result<CertInfo, UiError> {
    with(&backend, move |backend| {
        backend.tls_import_store(&thumbprint, &host, now())
    })
    .await
}

#[tauri::command]
pub async fn tls_list_store() -> Result<Vec<StoreCert>, UiError> {
    run(logic::tls_list_store).await
}

#[tauri::command]
pub async fn db_test(backend: Shared<'_>, draft: Config) -> Result<ToolResult, UiError> {
    with(&backend, |backend| backend.db_test(draft)).await
}

#[tauri::command]
pub async fn db_setup(
    backend: Shared<'_>,
    draft: Config,
    admin_user: String,
    admin_password: String,
) -> Result<DbSetupOutcome, UiError> {
    let admin_password = Secret::new(admin_password);
    with(&backend, move |backend| {
        backend.db_setup(draft, &admin_user, admin_password)
    })
    .await
}

#[tauri::command]
pub async fn db_script(
    backend: Shared<'_>,
    draft: Config,
    path: PathBuf,
) -> Result<ToolResult, UiError> {
    with(&backend, move |backend| backend.db_script(draft, &path)).await
}

#[tauri::command]
pub async fn db_backup(
    backend: Shared<'_>,
    draft: Config,
    path: PathBuf,
) -> Result<ToolResult, UiError> {
    with(&backend, move |backend| backend.db_backup(draft, &path)).await
}

#[tauri::command]
pub async fn oidc_test(
    backend: Shared<'_>,
    draft: Config,
    check_client: bool,
) -> Result<ToolResult, UiError> {
    with(&backend, move |backend| {
        backend.oidc_test(draft, check_client)
    })
    .await
}

#[tauri::command]
pub async fn ports_check(draft: Config) -> Result<Vec<PortStatus>, UiError> {
    run(move || Ok(logic::ports_check(&draft))).await
}

#[tauri::command]
pub async fn regenerate_app_secret(backend: Shared<'_>) -> Result<(), UiError> {
    with(&backend, |backend| backend.regenerate_app_secret()).await
}

/// Startordner der Dateiauswahl für „Logdatei öffnen …“.
#[tauri::command]
pub async fn logs_dir(backend: Shared<'_>) -> Result<PathBuf, UiError> {
    with(&backend, |backend| backend.logs_dir()).await
}

/// Öffnet eine Logdatei im Editor. Kein Explorer: Der liefe als normaler Benutzer, und der
/// geschützte Logordner böte „Fortsetzen“ an, das den Benutzer dauerhaft in die ACL einträgt. Der
/// Editor ist Kind dieses Prozesses und liest mit dessen Adminrechten.
#[tauri::command]
pub async fn open_log_file(backend: Shared<'_>, path: PathBuf) -> Result<(), UiError> {
    with(&backend, move |backend| notepad(&backend.log_file(&path)?)).await
}

/// Öffnet die Web-Konsole (Adresse aus der gespeicherten Konfiguration) im Standardbrowser. Über
/// `explorer.exe`: Es reicht die Adresse an die laufende Shell des angemeldeten Benutzers weiter,
/// der Browser läuft so ohne die Adminrechte dieser Oberfläche und mit dem Profil (und der
/// Entra-Anmeldung) des Benutzers.
#[tauri::command]
pub async fn open_web_console(backend: Shared<'_>) -> Result<(), UiError> {
    with(&backend, |backend| {
        let url = backend.web_console_url()?;
        // Der Exit-Code von explorer.exe sagt nichts aus (meist 1), deshalb nur starten
        Command::new(windows_dir().join("explorer.exe"))
            .arg(url)
            .spawn()
            .map(drop)
            .map_err(|error| {
                UiError::new(
                    "browser_failed",
                    format!("Der Browser ließ sich nicht starten: {error}"),
                )
            })
    })
    .await
}

fn windows_dir() -> PathBuf {
    std::env::var_os("SystemRoot")
        .filter(|value| !value.is_empty())
        .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from)
}

/// Startet den Editor mit vollem Pfad, damit kein `notepad.exe` aus einem anderen Ordner startet.
fn notepad(file: &Path) -> Result<(), UiError> {
    Command::new(windows_dir().join("System32").join("notepad.exe"))
        .arg(file)
        .spawn()
        .map(drop)
        .map_err(|error| {
            UiError::new(
                "editor_failed",
                format!("Der Editor ließ sich nicht starten: {error}"),
            )
        })
}
