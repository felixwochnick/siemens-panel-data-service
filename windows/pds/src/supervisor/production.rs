//! Die Bausteine des Supervisors im Betrieb: Statusdatei samt Ereignisprotokoll, Health-Abfrage bei
//! Node, Logdateien der Kinder. Dienst (`daemon`) und Vordergrundbetrieb (`run`) bauen den
//! Supervisor gleich über [`build_production`].

use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

use pds_common::names::vendor_versions;
use pds_common::ops;
use pds_common::platform::{EventLevel, eventlog};
use pds_common::status::{self, ServiceState, Status};
use pds_common::validate::Severity;
use pds_common::{Paths, health, system_protector};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::planner::ConfigPlanner;
use super::runtime::{HealthProbe, LogSinks, StatusSink, Supervisor, SupervisorOptions};
use crate::logging;

/// Wartezeit je Health-Abfrage.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Ab so vielen Tagen Restlaufzeit warnt der Dienst einmal je Start vor dem Zertifikatsablauf.
const CERTIFICATE_WARNING_DAYS: i64 = 30;
/// So viele Befunde nennt der Eintrag zu `unconfigured`; alle zeigen UI und `config validate`.
const MAX_LISTED_FINDINGS: usize = 5;

/// Der Supervisor, wie Dienst und Vordergrundbetrieb ihn brauchen.
pub fn build_production(paths: &Paths, options: SupervisorOptions) -> Supervisor {
    let vendor = vendor_versions();
    Supervisor::new(
        ConfigPlanner::new(paths.clone(), system_protector()),
        InternalProbe::new(PROBE_TIMEOUT),
        FileStatusSink::new(paths.clone()),
        LogSinks::production(paths),
        (vendor.node, vendor.caddy),
        options,
    )
}

impl LogSinks {
    /// `logs\app.log` und `logs\caddy.log`, rotierend wie `service.log`.
    pub fn production(paths: &Paths) -> Self {
        Self {
            app: open_log(&paths.logs_dir().join("app.log")),
            proxy: open_log(&paths.logs_dir().join("caddy.log")),
        }
    }
}

// Ohne Logdatei laufen die Kinder trotzdem; ihre Ausgabe geht dann verloren
fn open_log(path: &Path) -> Box<dyn Write + Send> {
    match logging::rotating_file(path) {
        Ok(file) => Box::new(file),
        Err(error) => {
            tracing::warn!("{error}: Ausgabe für {} wird verworfen", path.display());
            Box::new(io::sink())
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------

/// Fragt Node direkt (`health::probe_internal`). Den Port nimmt sie aus der Adresse des Plans.
pub struct InternalProbe {
    timeout: Duration,
}

impl InternalProbe {
    pub fn new(timeout: Duration) -> Self {
        Self { timeout }
    }
}

impl HealthProbe for InternalProbe {
    fn check(&mut self, url: &str) -> Result<(), String> {
        let port = internal_port(url).ok_or_else(|| format!("Ungültige Health-Adresse {url}"))?;
        let result = health::probe_internal(port, self.timeout);
        if result.ok {
            Ok(())
        } else {
            Err(result.message)
        }
    }
}

/// Port aus `http://127.0.0.1:<port>/…`; andere Adressen fragt die Abfrage nicht.
fn internal_port(url: &str) -> Option<u16> {
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    let port = rest.split('/').next()?;
    port.parse().ok().filter(|port| *port != 0)
}

// ---------------------------------------------------------------------------------------------
// Status und Ereignisprotokoll
// ---------------------------------------------------------------------------------------------

/// Schreibt `state\status.json` und meldet Zustandswechsel an Log und Ereignisprotokoll.
pub struct FileStatusSink {
    paths: Paths,
    notices: Notices,
    /// Letzter Schreibversuch gescheitert: nur den ersten Fehler einer Serie melden.
    write_failed: bool,
}

impl FileStatusSink {
    pub fn new(paths: Paths) -> Self {
        Self {
            paths,
            notices: Notices::default(),
            write_failed: false,
        }
    }

    fn write(&mut self, status: &Status) {
        // Unter Windows nie selbst einen fehlenden Datenordner anlegen (geerbte, schwache Rechte)
        let result = ops::require_data_dir(&self.paths)
            .map_err(|error| error.to_string())
            .and_then(|()| {
                status::write(&self.paths.status_file(), status).map_err(|error| error.to_string())
            });
        match result {
            Ok(()) => self.write_failed = false,
            Err(error) if !self.write_failed => {
                self.write_failed = true;
                report(&Notice {
                    level: EventLevel::Warning,
                    summary: format!("Status konnte nicht geschrieben werden: {error}"),
                    details: Vec::new(),
                });
            }
            Err(_) => {}
        }
    }
}

impl StatusSink for FileStatusSink {
    fn publish(&mut self, status: &Status) {
        self.write(status);
        for notice in self.notices.next(status, OffsetDateTime::now_utc()) {
            report(&notice);
        }
    }
}

/// Ein Eintrag für Log und Ereignisprotokoll. Enthält nie Secrets: Befunde nennen keine Werte,
/// Meldungen der Kinder sind geschwärzt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Notice {
    pub level: EventLevel,
    pub summary: String,
    pub details: Vec<String>,
}

impl Notice {
    /// Im Ereignisprotokoll gut lesbar untereinander.
    fn event_text(&self) -> String {
        if self.details.is_empty() {
            self.summary.clone()
        } else {
            format!("{}:\n{}", self.summary, self.details.join("\n"))
        }
    }

    /// Im Log eine Zeile je Ereignis, damit es auswertbar bleibt.
    fn log_text(&self) -> String {
        if self.details.is_empty() {
            self.summary.clone()
        } else {
            format!("{}: {}", self.summary, self.details.join("; "))
        }
    }
}

fn report(notice: &Notice) {
    let text = notice.log_text();
    match notice.level {
        EventLevel::Info => tracing::info!("{text}"),
        EventLevel::Warning => tracing::warn!("{text}"),
        EventLevel::Error => tracing::error!("{text}"),
    }
    // Ohne Windows tut das nichts
    if let Err(error) = eventlog::write(notice.level, &notice.event_text()) {
        tracing::warn!("Ereignisprotokoll nicht beschreibbar: {error}");
    }
}

/// Entscheidet, welche Status einen Eintrag wert sind. Derselbe Zustand mit derselben Meldung wird
/// nicht zweimal hintereinander gemeldet (Heartbeats, wiederholte gleiche Fehler im Backoff).
#[derive(Debug, Default)]
pub(crate) struct Notices {
    last: Option<(ServiceState, String)>,
    certificate_warned: bool,
}

impl Notices {
    pub fn next(&mut self, status: &Status, now: OffsetDateTime) -> Vec<Notice> {
        let mut notices = Vec::new();
        if let Some((message, notice)) = state_notice(status) {
            let key = (status.state, message);
            if self.last.as_ref() != Some(&key) {
                self.last = Some(key);
                notices.push(notice);
            }
        }
        // Einmal je Dienststart reicht; die UI zeigt den Ablauf dauerhaft
        if !self.certificate_warned
            && let Some(not_after) = status.certificate_not_after
            && not_after - now <= time::Duration::days(CERTIFICATE_WARNING_DAYS)
        {
            self.certificate_warned = true;
            let summary = if not_after <= now {
                format!(
                    "Das TLS-Zertifikat ist am {} abgelaufen",
                    utc_date(not_after)
                )
            } else {
                format!(
                    "Das TLS-Zertifikat läuft am {} ab; bitte rechtzeitig ein neues importieren",
                    utc_date(not_after)
                )
            };
            notices.push(Notice {
                level: EventLevel::Warning,
                summary,
                details: Vec::new(),
            });
        }
        notices
    }
}

/// Der Eintrag zum Zustand und die Meldung, nach der doppelte Einträge erkannt werden (ohne den
/// nächsten Versuch, sonst wäre jeder Backoff neu).
fn state_notice(status: &Status) -> Option<(String, Notice)> {
    let error = status
        .last_error
        .as_ref()
        .map(|error| error.message.as_str())
        .unwrap_or_default();
    let (level, summary, details) = match status.state {
        ServiceState::Running => (
            EventLevel::Info,
            "Dienst läuft: Anwendung und Proxy sind bereit".to_owned(),
            Vec::new(),
        ),
        ServiceState::Stopped => (EventLevel::Info, "Dienst beendet".to_owned(), Vec::new()),
        ServiceState::Backoff => {
            let next = status
                .next_attempt
                .map(|at| format!("; nächster Versuch um {}", utc_time(at)))
                .unwrap_or_default();
            (
                EventLevel::Warning,
                format!("Neustart nach Fehler: {error}{next}"),
                Vec::new(),
            )
        }
        ServiceState::ConfigError => (
            EventLevel::Error,
            format!(
                "Die Anwendung lehnt ihre Konfiguration ab: {error}. Kein Neustart, bis die \
                 Konfiguration gespeichert oder der Dienst neu gestartet wird"
            ),
            Vec::new(),
        ),
        ServiceState::Unconfigured => {
            let errors: Vec<String> = status
                .findings
                .iter()
                .filter(|finding| finding.severity == Severity::Error)
                .map(|finding| format!("{}: {}", finding.field, finding.message))
                .collect();
            let mut details: Vec<String> =
                errors.iter().take(MAX_LISTED_FINDINGS).cloned().collect();
            if errors.len() > MAX_LISTED_FINDINGS {
                details.push(format!(
                    "… und {} weitere",
                    errors.len() - MAX_LISTED_FINDINGS
                ));
            }
            (
                EventLevel::Error,
                format!(
                    "Dienst nicht eingerichtet – {} Fehler in der Konfiguration",
                    errors.len()
                ),
                details,
            )
        }
        ServiceState::Starting | ServiceState::Stopping => return None,
    };
    let message = match status.state {
        ServiceState::Backoff | ServiceState::ConfigError => error.to_owned(),
        _ => format!("{summary}\n{}", details.join("\n")),
    };
    Some((
        message,
        Notice {
            level,
            summary,
            details,
        },
    ))
}

/// Datum in UTC (`TT.MM.JJJJ (UTC)`), unabhängig von der Zeitzone des Servers.
fn utc_date(at: OffsetDateTime) -> String {
    let date = at.to_offset(time::UtcOffset::UTC).date();
    format!(
        "{:02}.{:02}.{:04} (UTC)",
        date.day(),
        u8::from(date.month()),
        date.year()
    )
}

/// Zeitpunkt in UTC, sekundengenau (RFC 3339).
fn utc_time(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    at.replace_nanosecond(0)
        .unwrap_or(at)
        .format(&Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use pds_common::status::{ChildStatus, ErrorInfo};
    use pds_common::validate::Finding;
    use time::{Date, Month, Time, UtcOffset};

    use super::*;

    fn at(year: i32, month: Month, day: u8, time: Time, offset: UtcOffset) -> OffsetDateTime {
        Date::from_calendar_date(year, month, day)
            .unwrap()
            .with_time(time)
            .assume_offset(offset)
    }

    /// 2026-11-20 10:00:00 UTC
    fn now() -> OffsetDateTime {
        at(
            2026,
            Month::November,
            20,
            Time::from_hms(10, 0, 0).unwrap(),
            UtcOffset::UTC,
        )
    }

    fn status(state: ServiceState) -> Status {
        Status {
            state,
            since: now(),
            heartbeat: now(),
            product_version: "0.1.0".to_owned(),
            node_version: "24.0.0".to_owned(),
            caddy_version: "2.11.0".to_owned(),
            health: None,
            last_error: None,
            next_attempt: None,
            findings: Vec::new(),
            certificate_not_after: None,
            app: ChildStatus::default(),
            proxy: ChildStatus::default(),
        }
    }

    fn backoff(message: &str, next_attempt: OffsetDateTime) -> Status {
        Status {
            last_error: Some(ErrorInfo {
                at: now(),
                source: "app".to_owned(),
                message: message.to_owned(),
            }),
            next_attempt: Some(next_attempt),
            ..status(ServiceState::Backoff)
        }
    }

    fn levels(notices: &[Notice]) -> Vec<EventLevel> {
        notices.iter().map(|notice| notice.level).collect()
    }

    #[test]
    fn running_and_stopped_are_info_once() {
        let mut notices = Notices::default();

        assert!(
            notices
                .next(&status(ServiceState::Starting), now())
                .is_empty()
        );
        let running = notices.next(&status(ServiceState::Running), now());
        assert_eq!(levels(&running), [EventLevel::Info]);
        // Heartbeat mit unverändertem Zustand
        assert!(
            notices
                .next(&status(ServiceState::Running), now())
                .is_empty()
        );
        assert!(
            notices
                .next(&status(ServiceState::Stopping), now())
                .is_empty()
        );
        let stopped = notices.next(&status(ServiceState::Stopped), now());
        assert_eq!(levels(&stopped), [EventLevel::Info]);
        assert_eq!(stopped[0].summary, "Dienst beendet");
    }

    #[test]
    fn backoff_warns_once_per_message() {
        let mut notices = Notices::default();
        let later = now() + time::Duration::seconds(4);

        let first = notices.next(&backoff("Datenbank nicht bereit", later), now());
        assert_eq!(levels(&first), [EventLevel::Warning]);
        assert!(first[0].summary.contains("Datenbank nicht bereit"));
        assert!(
            first[0].summary.contains("2026-11-20T10:00:04Z"),
            "{}",
            first[0].summary
        );
        // Derselbe Fehler beim nächsten Versuch: kein neuer Eintrag
        let again = backoff("Datenbank nicht bereit", later + time::Duration::seconds(8));
        assert!(notices.next(&again, now()).is_empty());
        assert!(
            notices
                .next(&status(ServiceState::Starting), now())
                .is_empty()
        );
        assert!(notices.next(&again, now()).is_empty());
        // Eine andere Meldung schon
        let other = notices.next(&backoff("Port 443 ist bereits belegt", later), now());
        assert_eq!(levels(&other), [EventLevel::Warning]);
        // Nach `running` gilt derselbe Fehler wieder als neu
        assert_eq!(notices.next(&status(ServiceState::Running), now()).len(), 1);
        assert_eq!(notices.next(&again, now()).len(), 1);
    }

    #[test]
    fn config_error_is_an_error_with_the_message() {
        let mut notices = Notices::default();
        let failed = Status {
            last_error: Some(ErrorInfo {
                at: now(),
                source: "app".to_owned(),
                message: "NUXT_DATABASE_URL fehlt".to_owned(),
            }),
            ..status(ServiceState::ConfigError)
        };

        let notice = notices.next(&failed, now());

        assert_eq!(levels(&notice), [EventLevel::Error]);
        assert!(notice[0].summary.contains("NUXT_DATABASE_URL fehlt"));
        assert!(notices.next(&failed, now()).is_empty());
    }

    #[test]
    fn unconfigured_lists_the_first_errors() {
        let mut findings: Vec<Finding> = (0..7)
            .map(|index| Finding {
                field: format!("feld{index}"),
                code: "required".to_owned(),
                message: "Pflichtfeld".to_owned(),
                severity: Severity::Error,
            })
            .collect();
        findings.insert(
            0,
            Finding {
                field: "tls".to_owned(),
                code: "certificate_expires_soon".to_owned(),
                message: "Warnung".to_owned(),
                severity: Severity::Warning,
            },
        );
        let unconfigured = Status {
            findings,
            ..status(ServiceState::Unconfigured)
        };

        let notice = Notices::default().next(&unconfigured, now()).remove(0);

        assert_eq!(notice.level, EventLevel::Error);
        assert_eq!(
            notice.summary,
            "Dienst nicht eingerichtet – 7 Fehler in der Konfiguration"
        );
        assert_eq!(notice.details.len(), 6);
        assert_eq!(notice.details[0], "feld0: Pflichtfeld");
        assert_eq!(notice.details[5], "… und 2 weitere");
        assert!(notice.event_text().contains(":\nfeld0: Pflichtfeld\nfeld1"));
        assert!(notice.log_text().contains(": feld0: Pflichtfeld; feld1"));
    }

    #[test]
    fn certificate_warning_once_within_thirty_days() {
        let with_certificate = |days: i64| Status {
            certificate_not_after: Some(now() + time::Duration::days(days)),
            ..status(ServiceState::Starting)
        };
        let mut notices = Notices::default();

        assert!(notices.next(&with_certificate(31), now()).is_empty());
        let warning = notices.next(&with_certificate(10), now());
        assert_eq!(levels(&warning), [EventLevel::Warning]);
        assert!(
            warning[0].summary.contains("30.11.2026 (UTC)"),
            "{}",
            warning[0].summary
        );
        assert!(
            notices.next(&with_certificate(10), now()).is_empty(),
            "einmal je Start"
        );

        let expired = Notices::default().next(&with_certificate(-1), now());
        assert!(expired[0].summary.contains("abgelaufen"));
    }

    #[test]
    fn internal_port_from_health_url() {
        assert_eq!(
            internal_port("http://127.0.0.1:3000/api/health"),
            Some(3000)
        );
        assert_eq!(internal_port("http://127.0.0.1:65535"), Some(65535));
        assert_eq!(internal_port("http://127.0.0.1:0/api/health"), None);
        assert_eq!(internal_port("http://localhost:3000/api/health"), None);
        assert_eq!(internal_port("https://127.0.0.1:3000/api/health"), None);
        assert_eq!(internal_port("http://127.0.0.1:x/api/health"), None);
    }

    /// Beantwortet eine Anfrage mit `status` und gibt die Anfragezeile zurück.
    fn serve_once(status: &'static str) -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let text = String::from_utf8_lossy(&request).into_owned();
            text.lines().next().unwrap_or_default().to_owned()
        });
        (port, server)
    }

    #[test]
    fn internal_probe_asks_node() {
        let mut probe = InternalProbe::new(Duration::from_secs(5));

        let (port, server) = serve_once("200 OK");
        let url = format!("http://127.0.0.1:{port}/api/health");
        assert_eq!(probe.check(&url), Ok(()));
        assert_eq!(server.join().unwrap(), "GET /api/health HTTP/1.1");

        let (port, server) = serve_once("503 Service Unavailable");
        let url = format!("http://127.0.0.1:{port}/api/health");
        assert_eq!(probe.check(&url), Err("HTTP 503".to_owned()));
        server.join().unwrap();

        assert!(probe.check("http://localhost/api/health").is_err());
    }

    #[test]
    fn times_are_formatted_in_utc() {
        let time = Time::from_hms_milli(0, 30, 15, 123).unwrap();
        let local = at(
            2026,
            Month::March,
            1,
            time,
            UtcOffset::from_hms(2, 0, 0).unwrap(),
        );
        assert_eq!(utc_date(local), "28.02.2026 (UTC)");
        assert_eq!(utc_time(local), "2026-02-28T22:30:15Z");
    }
}
