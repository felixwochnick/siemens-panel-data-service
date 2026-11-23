//! `ports check [--json]`: Können Caddy und die App ihre Ports öffnen? Ein Port, den der Dienst
//! selbst hält, ist in Ordnung; sonst nennt die Ausgabe den Besitzer und bei http.sys einen Hinweis.

use pds_common::Paths;
use pds_common::config::{Config, TlsMode};
use pds_common::platform::{PortStatus, ports};
use pds_common::status::{self, Status};
use serde::Serialize;
use time::OffsetDateTime;

use super::config_cmd::{load_config, print_json};
use super::{CliResult, Exit};

/// Wozu der Port dient.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Role {
    /// Caddy, unverschlüsselt (`listen.http_port`).
    Http,
    /// Caddy, HTTPS (`public.port`).
    Public,
    /// Node, nur auf 127.0.0.1 (`internal.port`).
    Internal,
}

impl Role {
    fn label(self) -> &'static str {
        match self {
            Self::Http => "HTTP, Caddy (listen.http_port)",
            Self::Public => "HTTPS, Caddy (public.port)",
            Self::Internal => "App, nur lokal (internal.port)",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortLine {
    port: u16,
    role: Role,
    free: bool,
    owner_pid: Option<u32>,
    owner_name: Option<String>,
    http_sys: bool,
    /// Der Port gehört dem laufenden Dienst (Caddy bzw. Node): erwartet, kein Fehler.
    owned_by_service: bool,
}

impl PortLine {
    fn acceptable(&self) -> bool {
        self.free || self.owned_by_service
    }
}

#[derive(Debug, Serialize)]
struct PortsReport {
    ok: bool,
    ports: Vec<PortLine>,
}

pub fn check(paths: &Paths, json: bool) -> CliResult {
    let config = load_config(paths)?;
    let wanted = wanted_ports(&config);
    let numbers: Vec<u16> = wanted.iter().map(|(_, port)| *port).collect();
    let statuses = ports::check(&numbers);
    // Nur ein frischer Status sagt, welche Prozesse zum Dienst gehören
    let status = status::read(&paths.status_file()).ok().flatten();
    let report = build_report(
        &wanted,
        statuses,
        status.as_ref(),
        OffsetDateTime::now_utc(),
    );

    if json {
        print_json(&report)?;
    } else {
        print!("{}", render(&report));
    }
    Ok(if report.ok {
        Exit::Ok
    } else {
        Exit::CheckFailed
    })
}

/// Die Ports, die belegt werden sollen, je einmal; bei `off` ohne `public.port`, weil dort nichts
/// auf ihm lauscht.
fn wanted_ports(config: &Config) -> Vec<(Role, u16)> {
    let mut wanted = vec![(Role::Http, config.listen.http_port)];
    if config.tls.mode != TlsMode::Off {
        wanted.push((Role::Public, config.public.port));
    }
    wanted.push((Role::Internal, config.internal.port));
    let mut seen: Vec<u16> = Vec::new();
    wanted.retain(|(_, port)| {
        let first = !seen.contains(port);
        seen.push(*port);
        first
    });
    wanted
}

fn build_report(
    wanted: &[(Role, u16)],
    statuses: Vec<PortStatus>,
    status: Option<&Status>,
    now: OffsetDateTime,
) -> PortsReport {
    let status = status.filter(|status| !status::is_stale(status, now));
    let ports: Vec<PortLine> = wanted
        .iter()
        .zip(statuses)
        .map(|(&(role, _), port)| PortLine {
            owned_by_service: !port.free && owned_by_service(role, port.owner_pid, status),
            port: port.port,
            role,
            free: port.free,
            owner_pid: port.owner_pid,
            owner_name: port.owner_name,
            http_sys: port.http_sys,
        })
        .collect();
    PortsReport {
        ok: ports.iter().all(PortLine::acceptable),
        ports,
    }
}

/// Hält der Prozess, den der Dienst gemeldet hat (Caddy für die öffentlichen Ports, Node für den
/// internen), den Port?
fn owned_by_service(role: Role, owner_pid: Option<u32>, status: Option<&Status>) -> bool {
    let (Some(pid), Some(status)) = (owner_pid, status) else {
        return false;
    };
    let child = match role {
        Role::Http | Role::Public => &status.proxy,
        Role::Internal => &status.app,
    };
    child.running && child.pid == Some(pid)
}

fn render(report: &PortsReport) -> String {
    let mut out = String::from("Ports prüfen:\n");
    for line in &report.ports {
        out.push_str(&format!(
            "  {:>5}  {:<31} {}\n",
            line.port,
            line.role.label(),
            state_text(line)
        ));
    }
    if report
        .ports
        .iter()
        .any(|line| line.http_sys && !line.owned_by_service)
    {
        out.push_str(
            "\nHinweis: http.sys (Windows-Kernel, PID 4) hält einen Port. Meist ist es IIS, WinRM \
             oder eine URL-Reservierung. Mit `netsh http show servicestate` und `netsh http show \
             urlacl` nachsehen, den Port freigeben oder in der Konfiguration einen anderen \
             wählen.\n",
        );
    }
    out.push_str(if report.ok {
        "\nAlle Ports sind verfügbar.\n"
    } else {
        "\nMindestens ein Port ist belegt: Caddy bzw. die App können ihn nicht öffnen.\n"
    });
    out
}

fn state_text(line: &PortLine) -> String {
    if line.free {
        return "frei".to_owned();
    }
    let owner = match (&line.owner_name, line.owner_pid) {
        (Some(name), Some(pid)) => format!("{name} (PID {pid})"),
        (None, Some(pid)) => format!("PID {pid}"),
        (Some(name), None) => name.clone(),
        (None, None) => "unbekanntem Prozess (Besitzer nicht ermittelbar)".to_owned(),
    };
    if line.owned_by_service {
        format!("belegt vom Dienst selbst: {owner} – in Ordnung")
    } else if line.http_sys {
        format!("belegt von http.sys: {owner}")
    } else {
        format!("belegt von {owner}")
    }
}

#[cfg(test)]
mod tests {
    use pds_common::status::{ChildStatus, ServiceState};

    use super::*;

    fn port(port: u16, free: bool, pid: Option<u32>) -> PortStatus {
        PortStatus {
            port,
            free,
            owner_pid: pid,
            owner_name: pid.map(|_| "caddy.exe".to_owned()),
            http_sys: pid == Some(4),
        }
    }

    fn running(proxy_pid: u32, app_pid: u32) -> Status {
        let now = OffsetDateTime::now_utc();
        Status {
            state: ServiceState::Running,
            since: now,
            heartbeat: now,
            product_version: String::new(),
            node_version: String::new(),
            caddy_version: String::new(),
            health: None,
            last_error: None,
            next_attempt: None,
            findings: Vec::new(),
            certificate_not_after: None,
            app: ChildStatus {
                pid: Some(app_pid),
                running: true,
                restarts: 0,
            },
            proxy: ChildStatus {
                pid: Some(proxy_pid),
                running: true,
                restarts: 0,
            },
        }
    }

    #[test]
    fn wanted_ports_follow_tls_mode_and_drop_duplicates() {
        let mut config = Config::default();
        assert_eq!(
            wanted_ports(&config),
            [
                (Role::Http, 80),
                (Role::Public, 443),
                (Role::Internal, 3000)
            ]
        );

        config.tls.mode = TlsMode::Off;
        assert_eq!(
            wanted_ports(&config),
            [(Role::Http, 80), (Role::Internal, 3000)]
        );

        config.tls.mode = TlsMode::Internal;
        config.public.port = 80;
        assert_eq!(
            wanted_ports(&config),
            [(Role::Http, 80), (Role::Internal, 3000)],
            "ein Port nur einmal"
        );
    }

    #[test]
    fn busy_foreign_port_fails_the_check() {
        let wanted = [(Role::Http, 80), (Role::Public, 443)];

        let report = build_report(
            &wanted,
            vec![port(80, true, None), port(443, false, Some(4))],
            None,
            OffsetDateTime::now_utc(),
        );

        assert!(!report.ok);
        assert!(report.ports[1].http_sys);
        let text = render(&report);
        assert!(text.contains("belegt von http.sys"), "{text}");
        assert!(text.contains("netsh http show"), "{text}");
    }

    #[test]
    fn unknown_owner_is_said_plainly() {
        let report = build_report(
            &[(Role::Http, 80)],
            vec![port(80, false, None)],
            None,
            OffsetDateTime::now_utc(),
        );

        assert!(!report.ok);
        assert!(
            render(&report).contains("belegt von unbekanntem Prozess"),
            "{}",
            render(&report)
        );
    }

    #[test]
    fn ports_held_by_the_running_service_are_fine() {
        let wanted = [
            (Role::Http, 80),
            (Role::Public, 443),
            (Role::Internal, 3000),
        ];
        let status = running(1234, 5678);

        let report = build_report(
            &wanted,
            vec![
                port(80, false, Some(1234)),
                port(443, false, Some(1234)),
                port(3000, false, Some(5678)),
            ],
            Some(&status),
            OffsetDateTime::now_utc(),
        );

        assert!(report.ok, "{report:?}");
        assert!(report.ports.iter().all(|line| line.owned_by_service));
        assert!(render(&report).contains("in Ordnung"));
    }

    #[test]
    fn a_foreign_process_on_the_service_port_is_not_fine() {
        let wanted = [(Role::Http, 80)];
        let status = running(1234, 5678);

        // PID des Node-Prozesses auf einem Caddy-Port zählt nicht, ebenso eine fremde PID
        for pid in [5678, 999] {
            let report = build_report(
                &wanted,
                vec![port(80, false, Some(pid))],
                Some(&status),
                OffsetDateTime::now_utc(),
            );
            assert!(!report.ok, "PID {pid}");
        }
    }

    #[test]
    fn a_stale_status_does_not_vouch_for_a_port() {
        let wanted = [(Role::Http, 80)];
        let mut status = running(1234, 5678);
        status.heartbeat = OffsetDateTime::now_utc() - time::Duration::minutes(5);

        let report = build_report(
            &wanted,
            vec![port(80, false, Some(1234))],
            Some(&status),
            OffsetDateTime::now_utc(),
        );

        assert!(
            !report.ok,
            "der Dienst läuft nicht mehr, die PID kann fremd sein"
        );
    }
}
