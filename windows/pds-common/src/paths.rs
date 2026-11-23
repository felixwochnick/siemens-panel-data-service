//! Orte von Installation und Daten.

use std::ffi::OsString;
use std::path::PathBuf;

/// Per Umgebung überschreibbar (Tests, Entwicklung); gesetzt und nicht leer gewinnt.
const ENV_INSTALL_DIR: &str = "PDS_INSTALL_DIR";
const ENV_DATA_DIR: &str = "PDS_DATA_DIR";

/// Installationsordner (nur lesen) und Datenordner (Konfiguration, Zustand, Logs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub install_dir: PathBuf,
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn new(install_dir: impl Into<PathBuf>, data_dir: impl Into<PathBuf>) -> Self {
        Self {
            install_dir: install_dir.into(),
            data_dir: data_dir.into(),
        }
    }

    /// Ermittelt die Ordner aus Umgebung und Ort der laufenden EXE.
    pub fn detect() -> Self {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."));
        Self::detect_with(|name| std::env::var_os(name), exe_dir)
    }

    // Umgebung als Parameter, damit Tests nichts im Prozess verändern müssen.
    fn detect_with(env: impl Fn(&str) -> Option<OsString>, exe_dir: PathBuf) -> Self {
        let non_empty = |name: &str| env(name).filter(|value| !value.is_empty());

        let install_dir = non_empty(ENV_INSTALL_DIR)
            .map(PathBuf::from)
            .unwrap_or_else(|| exe_dir.clone());
        let data_dir = non_empty(ENV_DATA_DIR)
            .map(PathBuf::from)
            .unwrap_or_else(|| default_data_dir(&env, &exe_dir));
        Self::new(install_dir, data_dir)
    }

    pub fn config_file(&self) -> PathBuf {
        self.data_dir.join("config.toml")
    }

    pub fn tls_dir(&self) -> PathBuf {
        self.data_dir.join("tls")
    }

    pub fn tls_cert_file(&self) -> PathBuf {
        self.tls_dir().join("certificate.pem")
    }

    pub fn tls_key_file(&self) -> PathBuf {
        self.tls_dir().join("key.dpapi")
    }

    pub fn state_dir(&self) -> PathBuf {
        self.data_dir.join("state")
    }

    pub fn status_file(&self) -> PathBuf {
        self.state_dir().join("status.json")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }

    /// Speicher von Caddy (ACME-Konten, Zertifikate, interne CA).
    pub fn caddy_dir(&self) -> PathBuf {
        self.data_dir.join("caddy")
    }

    /// Ordner der SQLite-Datenbank (Dienstkonto: Ändern, für die WAL-Dateien daneben).
    pub fn sqlite_dir(&self) -> PathBuf {
        self.data_dir.join("data")
    }

    /// SQLite-Datei, wenn `db.path` leer ist.
    pub fn default_sqlite_file(&self) -> PathBuf {
        self.sqlite_dir().join("pds.db")
    }

    /// Hochgeladene Projekte (`uploads\<projektId>\…`): die App schreibt, der Worker liest.
    pub fn uploads_dir(&self) -> PathBuf {
        self.data_dir.join("uploads")
    }

    /// Arbeitsordner der Analysen (`work\<analyseId>\…`): App und Worker ändern.
    pub fn work_dir(&self) -> PathBuf {
        self.data_dir.join("work")
    }

    pub fn node_exe(&self) -> PathBuf {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        self.install_dir.join("node").join(name)
    }

    pub fn caddy_exe(&self) -> PathBuf {
        let name = if cfg!(windows) { "caddy.exe" } else { "caddy" };
        self.install_dir.join(name)
    }

    pub fn app_entry(&self) -> PathBuf {
        self.install_dir.join("app").join("pds-entry.mjs")
    }

    pub fn tools_script(&self) -> PathBuf {
        self.install_dir.join("tools").join("pds-tools.mjs")
    }

    /// Programm des EPLAN-Workers (.NET Framework, nur Windows); fehlt in einem MSI, das ohne
    /// EPLAN-DLLs gebaut wurde.
    pub fn eplan_exe(&self) -> PathBuf {
        self.install_dir.join("eplan").join("pds-eplan.exe")
    }
}

#[cfg(windows)]
fn default_data_dir(
    env: &impl Fn(&str) -> Option<OsString>,
    _exe_dir: &std::path::Path,
) -> PathBuf {
    let program_data = env("ProgramData")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    program_data.join(crate::names::PRODUCT_DIR_NAME)
}

// Ohne Windows gibt es kein %ProgramData%: Die Daten liegen neben der EXE.
#[cfg(not(windows))]
fn default_data_dir(
    _env: &impl Fn(&str) -> Option<OsString>,
    exe_dir: &std::path::Path,
) -> PathBuf {
    exe_dir.join("data")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;

    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), OsString::from(value)))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn env_overrides_win() {
        let env = env_of(&[
            ("PDS_INSTALL_DIR", "/opt/install"),
            ("PDS_DATA_DIR", "/var/data"),
        ]);
        let paths = Paths::detect_with(env, PathBuf::from("/irgendwo/bin"));
        assert_eq!(paths.install_dir, Path::new("/opt/install"));
        assert_eq!(paths.data_dir, Path::new("/var/data"));
    }

    #[test]
    fn empty_env_is_ignored() {
        let env = env_of(&[("PDS_INSTALL_DIR", ""), ("PDS_DATA_DIR", "")]);
        let paths = Paths::detect_with(env, PathBuf::from("/irgendwo/bin"));
        assert_eq!(paths.install_dir, Path::new("/irgendwo/bin"));
    }

    #[cfg(not(windows))]
    #[test]
    fn defaults_next_to_exe_without_windows() {
        let paths = Paths::detect_with(env_of(&[]), PathBuf::from("/irgendwo/bin"));
        assert_eq!(paths.install_dir, Path::new("/irgendwo/bin"));
        assert_eq!(paths.data_dir, Path::new("/irgendwo/bin/data"));
    }

    #[test]
    fn data_dir_override_keeps_exe_dir_as_install_dir() {
        let env = env_of(&[("PDS_DATA_DIR", "/var/data")]);
        let paths = Paths::detect_with(env, PathBuf::from("/irgendwo/bin"));
        assert_eq!(paths.install_dir, Path::new("/irgendwo/bin"));
        assert_eq!(paths.data_dir, Path::new("/var/data"));
    }

    #[test]
    fn detect_uses_real_environment_and_exe() {
        // Ohne Überschreibung zeigt `detect` auf einen Ordner der laufenden EXE
        let paths = Paths::detect();
        assert!(!paths.install_dir.as_os_str().is_empty());
        assert!(!paths.data_dir.as_os_str().is_empty());
    }

    #[test]
    fn derived_paths() {
        let paths = Paths::new("/inst", "/data");
        assert_eq!(paths.config_file(), Path::new("/data/config.toml"));
        assert_eq!(paths.tls_dir(), Path::new("/data/tls"));
        assert_eq!(
            paths.tls_cert_file(),
            Path::new("/data/tls/certificate.pem")
        );
        assert_eq!(paths.tls_key_file(), Path::new("/data/tls/key.dpapi"));
        assert_eq!(paths.state_dir(), Path::new("/data/state"));
        assert_eq!(paths.status_file(), Path::new("/data/state/status.json"));
        assert_eq!(paths.logs_dir(), Path::new("/data/logs"));
        assert_eq!(paths.caddy_dir(), Path::new("/data/caddy"));
        assert_eq!(paths.sqlite_dir(), Path::new("/data/data"));
        assert_eq!(paths.default_sqlite_file(), Path::new("/data/data/pds.db"));
        assert_eq!(paths.uploads_dir(), Path::new("/data/uploads"));
        assert_eq!(paths.work_dir(), Path::new("/data/work"));
        assert_eq!(paths.eplan_exe(), Path::new("/inst/eplan/pds-eplan.exe"));
        assert_eq!(paths.app_entry(), Path::new("/inst/app/pds-entry.mjs"));
        assert_eq!(paths.tools_script(), Path::new("/inst/tools/pds-tools.mjs"));
    }

    #[cfg(not(windows))]
    #[test]
    fn executables_without_windows_have_no_suffix() {
        let paths = Paths::new("/inst", "/data");
        assert_eq!(paths.node_exe(), Path::new("/inst/node/node"));
        assert_eq!(paths.caddy_exe(), Path::new("/inst/caddy"));
    }

    #[cfg(windows)]
    #[test]
    fn executables_on_windows_have_exe_suffix() {
        let paths = Paths::new(r"C:\inst", r"C:\data");
        assert_eq!(paths.node_exe(), Path::new(r"C:\inst\node\node.exe"));
        assert_eq!(paths.caddy_exe(), Path::new(r"C:\inst\caddy.exe"));
    }
}
