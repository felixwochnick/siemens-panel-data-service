//! Health-Abfrage der App: intern direkt bei Node, öffentlich über Caddy und TLS.
//!
//! Beide gehen direkt an den eigenen Server, nie über einen Proxy aus der Umgebung.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use ureq::Agent;

/// Pfad der Bereitschaftsprüfung der App (Datenbank erreichbar und migriert).
const HEALTH_PATH: &str = "/api/health";

/// Ergebnis einer Health-Abfrage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProbeResult {
    pub ok: bool,
    /// HTTP-Status, `None`, wenn keine Antwort kam.
    pub status: Option<u16>,
    /// Deutsche Kurzmeldung (`HTTP 200`, `Nicht erreichbar: …`).
    pub message: String,
}

/// `GET http://127.0.0.1:<port>/api/health`, ohne TLS. Ok heißt Status 2xx.
pub fn probe_internal(port: u16, timeout: Duration) -> ProbeResult {
    let url = format!("http://127.0.0.1:{port}{HEALTH_PATH}");
    let agent: Agent = base_config(timeout).build().into();
    probe(&agent, &url)
}

/// `GET <app_url>/api/health` über Caddy, so wie Clients die App erreichen. Nur unter Windows: TLS
/// über SChannel mit dem Zertifikatspeicher des Computers, damit Zertifikate der Firmen-PKI gelten.
/// Ohne Windows oder ohne Adresse `None`.
pub fn probe_public(app_url: &str, timeout: Duration) -> Option<ProbeResult> {
    if app_url.is_empty() {
        return None;
    }
    #[cfg(windows)]
    {
        use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

        let tls = TlsConfig::builder()
            .provider(TlsProvider::NativeTls)
            .root_certs(RootCerts::PlatformVerifier)
            .build();
        let agent: Agent = base_config(timeout).tls_config(tls).build().into();
        let url = format!("{}{HEALTH_PATH}", app_url.trim_end_matches('/'));
        Some(probe(&agent, &url))
    }
    #[cfg(not(windows))]
    {
        let _ = timeout;
        None
    }
}

fn base_config(timeout: Duration) -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    Agent::config_builder()
        .timeout_global(Some(timeout))
        // Status selbst auswerten statt als Fehler; Umleitungen wären hier ein Befund
        .http_status_as_error(false)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .proxy(None)
}

fn probe(agent: &Agent, url: &str) -> ProbeResult {
    match agent.get(url).call() {
        Ok(response) => {
            let status = response.status().as_u16();
            ProbeResult {
                ok: response.status().is_success(),
                status: Some(status),
                message: format!("HTTP {status}"),
            }
        }
        Err(error) => ProbeResult {
            ok: false,
            status: None,
            message: format!("Nicht erreichbar: {}", describe(&error)),
        },
    }
}

/// Deutsche Beschreibung der häufigen Fälle, sonst der Text von ureq.
fn describe(error: &ureq::Error) -> String {
    match error {
        ureq::Error::Timeout(_) => "Zeitüberschreitung".to_owned(),
        ureq::Error::ConnectionFailed => "Verbindung fehlgeschlagen".to_owned(),
        ureq::Error::HostNotFound => "Hostname nicht auflösbar".to_owned(),
        ureq::Error::Io(io) if io.kind() == std::io::ErrorKind::ConnectionRefused => {
            "Verbindung abgelehnt".to_owned()
        }
        other => other.to_string(),
    }
}
