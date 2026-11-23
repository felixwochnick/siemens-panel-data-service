//! `status [--json]`: Dienst, Zustand, Health, EPLAN-Worker, Versionen, Zertifikat, letzter Fehler,
//! Befunde.
//!
//! Exit-Code 0 auch bei `unconfigured`: Der Befehl berichtet, er prüft nicht.

use std::fmt::Write as _;

use pds_common::Paths;
use pds_common::health::ProbeResult;
use pds_common::names::{product_version, vendor_versions};
use pds_common::ops::{self, ReadIssue, StatusReport};
use pds_common::platform::{ScmInfo, ScmState};
use pds_common::status::{ChildStatus, ServiceState, Status};
use time::{OffsetDateTime, UtcOffset};

use super::config_cmd::finding_line;
use super::eplan_cmd;
use super::{CliError, CliResult, Exit};

pub fn status(paths: &Paths, json: bool) -> CliResult {
    let report = ops::status_report(paths);
    if json {
        let text = serde_json::to_string_pretty(&report)
            .map_err(|error| CliError::new(format!("JSON-Ausgabe fehlgeschlagen: {error}")))?;
        println!("{text}");
    } else {
        print!("{}", render(&report, OffsetDateTime::now_utc()));
    }
    Ok(Exit::Ok)
}

/// Zustand auf Deutsch.
pub fn state_text(state: ServiceState) -> &'static str {
    state.text()
}

/// Textausgabe von `status`. Ein veralteter Status steht als erste Zeile da, weil er alles
/// Folgende relativiert.
pub fn render(report: &StatusReport, now: OffsetDateTime) -> String {
    let mut out = String::new();
    if let Some(status) = report.status.as_ref().filter(|_| report.stale) {
        let seconds = (now - status.heartbeat).whole_seconds();
        let _ = writeln!(
            out,
            "Dienst läuft nicht (letztes Lebenszeichen vor {seconds} s)"
        );
    }
    let mut line = |label: &str, value: &str| {
        let _ = writeln!(out, "{label:<19}{value}");
    };

    line("Dienst:", &service_text(report.service.as_ref()));
    match &report.status {
        Some(status) => line(
            "Zustand:",
            &format!(
                "{} (seit {})",
                state_text(status.state),
                format_time(status.since)
            ),
        ),
        // Nicht lesbar ist etwas anderes als „lief noch nie“: meist fehlen nur die Rechte
        None => match &report.status_error {
            Some(issue) => line("Zustand:", &unreadable_text("Status", issue)),
            None => line(
                "Zustand:",
                "Kein Status vorhanden – der Dienst lief noch nie",
            ),
        },
    }
    let address = match (&report.config_error, report.app_url.as_str()) {
        (Some(issue), _) => unreadable_text("Konfiguration", issue),
        (None, "") => "(kein Hostname konfiguriert)".to_owned(),
        (None, url) => url.to_owned(),
    };
    line("Adresse:", &address);
    if !report.database.is_empty() {
        line("Datenbank:", &report.database);
    }
    line("Health intern:", &probe_text(report.internal.as_ref()));
    line("Health öffentlich:", &probe_text(report.public.as_ref()));
    line("EPLAN-Worker:", &eplan_cmd::summary(&report.eplan));

    match &report.status {
        Some(status) => {
            line("Versionen:", &versions(status));
            if matches!(
                status.state,
                ServiceState::Starting | ServiceState::Running | ServiceState::Backoff
            ) {
                line("App (Node):", &child_text(&status.app));
                line("Proxy (Caddy):", &child_text(&status.proxy));
            }
            if let Some(not_after) = status.certificate_not_after {
                line(
                    "Zertifikat:",
                    &format!("gültig bis {}", format_time(not_after)),
                );
            }
            if let Some(next) = status.next_attempt {
                line("Nächster Versuch:", &format_time(next));
            }
            if let Some(error) = &status.last_error {
                line(
                    "Letzter Fehler:",
                    &format!(
                        "{} ({}): {}",
                        format_time(error.at),
                        error.source,
                        error.message
                    ),
                );
            }
            if !status.findings.is_empty() {
                let _ = writeln!(out, "Befunde:");
                for finding in &status.findings {
                    let _ = writeln!(out, "  {}", finding_line(finding));
                }
            }
        }
        None => {
            let vendor = vendor_versions();
            line(
                "Versionen:",
                &format!(
                    "Produkt {}, Node {}, Caddy {}",
                    product_version(),
                    vendor.node,
                    vendor.caddy
                ),
            );
        }
    }
    out
}

/// `Status nicht lesbar – bitte als Administrator ausführen` bzw. mit dem Grund, wenn es nicht an
/// den Rechten liegt (etwa eine kaputte Datei).
fn unreadable_text(what: &str, issue: &ReadIssue) -> String {
    if issue.access_denied {
        format!("{what} nicht lesbar – bitte als Administrator ausführen")
    } else {
        format!("{what} nicht lesbar: {}", issue.message)
    }
}

fn versions(status: &Status) -> String {
    let or_unknown = |value: &str| {
        if value.is_empty() {
            "unbekannt".to_owned()
        } else {
            value.to_owned()
        }
    };
    format!(
        "Produkt {}, Node {}, Caddy {}",
        or_unknown(&status.product_version),
        or_unknown(&status.node_version),
        or_unknown(&status.caddy_version)
    )
}

pub(super) fn service_text(service: Option<&ScmInfo>) -> String {
    let Some(service) = service else {
        return "nicht abfragbar (nur unter Windows mit Dienststeuerung)".to_owned();
    };
    let state = match service.state {
        ScmState::NotInstalled => return "nicht installiert".to_owned(),
        ScmState::Stopped => "gestoppt",
        ScmState::StartPending => "startet",
        ScmState::Running => "läuft",
        ScmState::StopPending => "wird beendet",
        ScmState::Other => "angehalten oder im Übergang",
    };
    let start = match service.start_type.as_str() {
        "auto" if service.delayed => "automatisch, verzögert",
        "auto" => "automatisch",
        "manual" => "manuell",
        "disabled" => "deaktiviert",
        other => other,
    };
    if start.is_empty() {
        state.to_owned()
    } else {
        format!("{state} (Start: {start})")
    }
}

fn probe_text(probe: Option<&ProbeResult>) -> String {
    match probe {
        None => "nicht geprüft".to_owned(),
        Some(probe) if probe.ok => format!("ok ({})", probe.message),
        Some(probe) => format!("Fehler ({})", probe.message),
    }
}

fn child_text(child: &ChildStatus) -> String {
    let running = match (child.running, child.pid) {
        (true, Some(pid)) => format!("läuft (PID {pid})"),
        (true, None) => "läuft".to_owned(),
        (false, _) => "läuft nicht".to_owned(),
    };
    format!("{running}, {} Neustarts", child.restarts)
}

/// Feste Zeitzone (UTC), damit Ausgaben auf allen Servern gleich lesbar sind.
pub fn format_time(at: OffsetDateTime) -> String {
    let at = at.to_offset(UtcOffset::UTC);
    format!(
        "{:02}.{:02}.{:04} {:02}:{:02}:{:02} UTC",
        at.day(),
        u8::from(at.month()),
        at.year(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

#[cfg(test)]
mod tests {
    use pds_common::eplan::EplanStatus;
    use pds_common::status::ErrorInfo;
    use pds_common::validate::{Finding, Severity};

    use super::*;

    fn at(seconds: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(seconds).unwrap()
    }

    fn report(status: Option<Status>, stale: bool) -> StatusReport {
        StatusReport {
            service: Some(ScmInfo {
                state: ScmState::Running,
                start_type: "auto".into(),
                delayed: true,
                account: "NT SERVICE\\pds".into(),
            }),
            status,
            status_error: None,
            stale,
            internal: None,
            public: None,
            app_url: "https://trainee.example.com".into(),
            database: r"SQLite: C:\ProgramData\EPLAN Panel Data Service\data\pds.db".into(),
            config_error: None,
            eplan: EplanStatus {
                service: Some(ScmInfo {
                    state: ScmState::Running,
                    start_type: "auto".into(),
                    delayed: true,
                    account: r"EXAMPLE\svc-eplan".into(),
                }),
                worker_present: true,
                executable: r"C:\Program Files\EPLAN Panel Data Service\eplan\pds-eplan.exe".into(),
            },
        }
    }

    fn status(state: ServiceState) -> Status {
        Status {
            state,
            since: at(1_800_000_000),
            heartbeat: at(1_800_000_000),
            product_version: "1.2.3".into(),
            node_version: "24.0.0".into(),
            caddy_version: "2.11.9".into(),
            health: None,
            last_error: None,
            next_attempt: None,
            findings: Vec::new(),
            certificate_not_after: None,
            app: ChildStatus::default(),
            proxy: ChildStatus::default(),
        }
    }

    #[test]
    fn all_states_have_german_text() {
        let expected = [
            (ServiceState::Unconfigured, "nicht eingerichtet"),
            (ServiceState::Starting, "startet"),
            (ServiceState::Running, "läuft"),
            (ServiceState::Backoff, "wartet auf erneuten Versuch"),
            (ServiceState::ConfigError, "Konfigurationsfehler"),
            (ServiceState::Stopping, "wird beendet"),
            (ServiceState::Stopped, "gestoppt"),
        ];
        for (state, text) in expected {
            assert_eq!(state_text(state), text);
        }
    }

    #[test]
    fn stale_status_comes_first() {
        let text = render(
            &report(Some(status(ServiceState::Running)), true),
            at(1_800_000_095),
        );

        assert_eq!(
            text.lines().next().unwrap(),
            "Dienst läuft nicht (letztes Lebenszeichen vor 95 s)"
        );
    }

    #[test]
    fn fresh_status_shows_details() {
        let mut status = status(ServiceState::Backoff);
        status.next_attempt = Some(at(1_800_000_030));
        status.certificate_not_after = Some(at(1_900_000_000));
        status.last_error = Some(ErrorInfo {
            at: at(1_800_000_010),
            source: "proxy".into(),
            message: "Port 443 ist bereits belegt".into(),
        });
        status.findings.push(Finding {
            field: "tls".into(),
            code: "certificate_expires_soon".into(),
            message: "Das Zertifikat läuft bald ab".into(),
            severity: Severity::Warning,
        });

        let text = render(&report(Some(status), false), at(1_800_000_012));

        assert!(!text.contains("Dienst läuft nicht"), "{text}");
        assert!(
            text.contains("Dienst:            läuft (Start: automatisch, verzögert)"),
            "{text}"
        );
        assert!(
            text.contains(
                "Zustand:           wartet auf erneuten Versuch (seit 15.01.2027 08:00:00 UTC)"
            ),
            "{text}"
        );
        assert!(
            text.contains("Produkt 1.2.3, Node 24.0.0, Caddy 2.11.9"),
            "{text}"
        );
        assert!(
            text.contains("gültig bis 17.03.2030 17:46:40 UTC"),
            "{text}"
        );
        assert!(
            text.contains("Nächster Versuch:  15.01.2027 08:00:30 UTC"),
            "{text}"
        );
        assert!(
            text.contains("(proxy): Port 443 ist bereits belegt"),
            "{text}"
        );
        assert!(
            text.contains("Warnung: tls: Das Zertifikat läuft bald ab"),
            "{text}"
        );
        assert!(text.contains("Health intern:     nicht geprüft"), "{text}");
        assert!(
            text.contains(
                r"EPLAN-Worker:      läuft (Start: automatisch, verzögert), Konto EXAMPLE\svc-eplan"
            ),
            "{text}"
        );
        assert!(
            text.contains(
                r"Datenbank:         SQLite: C:\ProgramData\EPLAN Panel Data Service\data\pds.db"
            ),
            "{text}"
        );
    }

    #[test]
    fn without_status_and_service() {
        let mut report = report(None, false);
        report.service = None;
        report.app_url.clear();

        let text = render(&report, at(0));

        assert!(text.contains("Kein Status vorhanden"), "{text}");
        assert!(text.contains("nicht abfragbar"), "{text}");
        assert!(text.contains("(kein Hostname konfiguriert)"), "{text}");
        assert!(
            text.contains(&format!("Produkt {}", product_version())),
            "{text}"
        );
    }

    #[test]
    fn unreadable_files_are_not_reported_as_missing() {
        let mut report = report(None, false);
        report.app_url.clear();
        let denied = |file: &str| ReadIssue {
            access_denied: true,
            message: format!(r"C:\ProgramData\EPLAN Panel Data Service\{file}: Zugriff verweigert"),
        };
        report.status_error = Some(denied(r"state\status.json"));
        report.config_error = Some(denied("config.toml"));

        let text = render(&report, at(0));

        assert!(
            text.contains(
                "Zustand:           Status nicht lesbar – bitte als Administrator ausführen"
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "Adresse:           Konfiguration nicht lesbar – bitte als Administrator ausführen"
            ),
            "{text}"
        );
        assert!(!text.contains("lief noch nie"), "{text}");
        assert!(!text.contains("kein Hostname"), "{text}");

        // Kaputt statt gesperrt: der Grund statt des Hinweises auf Administratorrechte
        report.status_error = Some(ReadIssue {
            access_denied: false,
            message: "Die Statusdatei ist beschädigt: EOF".into(),
        });
        let text = render(&report, at(0));
        assert!(
            text.contains("Status nicht lesbar: Die Statusdatei ist beschädigt: EOF"),
            "{text}"
        );
    }

    #[test]
    fn not_installed_service() {
        assert_eq!(
            service_text(Some(&ScmInfo::not_installed())),
            "nicht installiert"
        );
    }

    #[test]
    fn probe_texts() {
        assert_eq!(probe_text(None), "nicht geprüft");
        let ok = ProbeResult {
            ok: true,
            status: Some(200),
            message: "HTTP 200".into(),
        };
        assert_eq!(probe_text(Some(&ok)), "ok (HTTP 200)");
        let failed = ProbeResult {
            ok: false,
            status: None,
            message: "Nicht erreichbar: Verbindung abgelehnt".into(),
        };
        assert_eq!(
            probe_text(Some(&failed)),
            "Fehler (Nicht erreichbar: Verbindung abgelehnt)"
        );
    }
}
