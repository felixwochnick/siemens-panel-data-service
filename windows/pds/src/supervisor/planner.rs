//! Aus der Konfiguration wird ein Startplan: was als Node und als Caddy läuft, mit welcher
//! Umgebung, welcher Caddy-Konfiguration und welchen Secrets zum Schwärzen.

use std::ffi::OsString;

use pds_common::config::TlsMode;
use pds_common::names::product_version;
use pds_common::ops::{self, Checked, OpsError};
use pds_common::tls::{self, TlsError};
use pds_common::validate::{Finding, has_errors};
use pds_common::{Paths, Protector, render};
use time::OffsetDateTime;

use super::process::ChildSpec;
use super::{ChildKind, Redactor};

/// Alles, was der Supervisor zum Starten braucht.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub app: ChildSpec,
    pub proxy: ChildSpec,
    /// Adresse der Health-Abfrage (`http://127.0.0.1:<port>/api/health`).
    pub health_url: String,
    /// Kennt alle Secrets samt ihren abgeleiteten Formen.
    pub redactor: Redactor,
    /// Ablauf des eigenen Zertifikats, nur im Modus `certificate`.
    pub certificate_not_after: Option<OffsetDateTime>,
    /// Warnungen der Prüfung; sie hindern den Start nicht, gehören aber in den Status.
    pub findings: Vec<Finding>,
}

/// Erstellt den Startplan. `Err` mit den Befunden, wenn nicht gestartet werden kann.
pub trait LaunchPlanner: Send {
    fn plan(&mut self) -> Result<LaunchPlan, Vec<Finding>>;
}

/// Plant aus `config.toml`, den Secrets und dem gespeicherten Zertifikat.
pub struct ConfigPlanner {
    paths: Paths,
    protector: Box<dyn Protector>,
}

impl ConfigPlanner {
    pub fn new(paths: Paths, protector: Box<dyn Protector>) -> Self {
        Self { paths, protector }
    }
}

impl LaunchPlanner for ConfigPlanner {
    fn plan(&mut self) -> Result<LaunchPlan, Vec<Finding>> {
        let now = OffsetDateTime::now_utc();
        // Eine unlesbare Konfiguration ergibt genau einen Befund (`config_unreadable`)
        let Checked { loaded, findings } = ops::check(&self.paths, &*self.protector, now);
        let loaded = match loaded {
            Some(loaded) if !has_errors(&findings) => loaded,
            _ => return Err(findings),
        };
        let config = &loaded.config;
        let secrets = &loaded.secrets;

        // Den Schlüssel braucht nur der Modus `certificate`; die Prüfung hat ihn dort schon gelesen
        let material = if config.tls.mode == TlsMode::Certificate {
            match tls::load(&self.paths, &*self.protector) {
                Ok(Some(material)) => Some(material),
                Ok(None) => return Err(vec![tls_finding(TlsError::NoCertificate)]),
                Err(error) => return Err(vec![tls_finding(error)]),
            }
        } else {
            None
        };
        let certificate_not_after = match config.tls.mode {
            TlsMode::Certificate => loaded.certificate.as_ref().map(|info| info.not_after),
            _ => None,
        };

        // Die App startet für das Netzlaufwerk PowerShell und `net.exe`: mehr Basis als Caddy
        let mut app_env = ops::app_base_env();
        app_env.extend(render::app_env(
            config,
            secrets,
            &self.paths,
            product_version(),
        ));
        let app = ChildSpec {
            kind: ChildKind::App,
            program: self.paths.node_exe(),
            // `--use-system-ca`: Node vertraut dem Zertifikatspeicher von Windows (Firmen-PKI)
            args: vec![
                OsString::from("--use-system-ca"),
                self.paths.app_entry().into_os_string(),
            ],
            env: app_env,
            cwd: self.paths.install_dir.join("app"),
            stdin_payload: None,
            keep_stdin_open: true,
        };

        let mut proxy_env = ops::base_env();
        proxy_env.extend(render::proxy_env(config, &self.paths));
        // Caddy schreibt nur in seinen Ordner im Datenbereich; der Installationsordner ist für
        // das Dienstkonto schreibgeschützt. Fehlt `caddy\`, meldet Caddy das selbst, statt dass
        // schon der Start mit einem unklaren Fehler scheitert.
        let caddy_dir = self.paths.caddy_dir();
        let proxy_cwd = if caddy_dir.is_dir() {
            caddy_dir
        } else {
            self.paths.install_dir.clone()
        };
        let proxy = ChildSpec {
            kind: ChildKind::Proxy,
            program: self.paths.caddy_exe(),
            // Ohne `--adapter`: JSON ist Caddys eigenes Format, einen Adapter `json` gibt es nicht
            args: ["run", "--config", "-"].map(OsString::from).to_vec(),
            env: proxy_env,
            cwd: proxy_cwd,
            stdin_payload: Some(render::caddy_json(
                config,
                &self.paths,
                material.as_ref(),
                secrets.acme_eab_hmac.as_ref(),
            )),
            keep_stdin_open: false,
        };

        let redactor = Redactor::new(render::secret_values(config, secrets, material.as_ref()));
        Ok(LaunchPlan {
            app,
            proxy,
            health_url: format!("http://127.0.0.1:{}/api/health", config.internal.port),
            redactor,
            certificate_not_after,
            findings,
        })
    }
}

fn tls_finding(error: TlsError) -> Finding {
    ops::load_error_finding(&OpsError::Tls(error))
}
