//! `eplan install|uninstall|status|start|stop|restart`: der Worker-Dienst `pds-eplan`, der EPLAN
//! unter einem lizenzierten Benutzerkonto ausführt.
//!
//! Das Passwort des Kontos wird verdeckt abgefragt oder mit `--password-stdin` als eine Zeile
//! gelesen, nie als Argument angenommen und nie ausgegeben.

use std::fmt::Write as _;

use pds_common::Paths;
use pds_common::eplan::{self, Account, Control, EplanError, EplanStatus, SystemHost};
use pds_common::platform::ScmState;

use super::config_cmd::{SECRET_AS_ARGUMENT, print_json, read_line_secret};
use super::status_cmd::service_text;
use super::{CliError, CliResult, Exit};

/// `password_argument`: Ein Passwort als Argument wird abgelehnt, bevor irgendetwas geschieht.
pub fn install(
    paths: &Paths,
    user: &str,
    password_stdin: bool,
    password_argument: bool,
) -> CliResult {
    if password_argument {
        return Err(CliError::new(SECRET_AS_ARGUMENT));
    }
    // Vor der Passworteingabe: Niemand tippt umsonst
    let account = Account::parse(user)?;
    if !paths.eplan_exe().is_file() {
        return Err(EplanError::WorkerMissing(paths.eplan_exe()).into());
    }
    let password = read_line_secret(
        &format!("Passwort für {account}"),
        "--password-stdin",
        password_stdin,
    )?;

    println!("EPLAN-Worker wird unter {account} eingerichtet …");
    match eplan::install(&SystemHost, paths, &account, &password) {
        Ok(outcome) => {
            println!(
                "{}",
                if outcome.created {
                    format!("Dienst pds-eplan angelegt (Konto {}).", outcome.account)
                } else {
                    format!(
                        "Konto und Passwort von pds-eplan geändert ({}).",
                        outcome.account
                    )
                }
            );
            for warning in &outcome.warnings {
                eprintln!("Warnung: {warning}");
            }
            if outcome.started {
                println!("Dienst gestartet. Zustand mit `pds eplan status` prüfen.");
                Ok(Exit::Ok)
            } else {
                Ok(Exit::Error)
            }
        }
        // Falsches Passwort, gesperrtes Konto …: Am Dienst hat sich nichts geändert
        Err(error @ EplanError::LogonFailed { .. }) => {
            eprintln!("Fehler: {error}");
            Ok(Exit::CheckFailed)
        }
        Err(error) => Err(error.into()),
    }
}

pub fn uninstall(paths: &Paths) -> CliResult {
    let outcome = eplan::uninstall(&SystemHost, paths)?;
    if outcome.removed {
        println!("Dienst pds-eplan gestoppt und entfernt.");
    } else {
        println!("Der EPLAN-Worker war nicht eingerichtet.");
    }
    for warning in &outcome.warnings {
        eprintln!("Warnung: {warning}");
    }
    Ok(Exit::Ok)
}

pub fn status(paths: &Paths, json: bool) -> CliResult {
    let status = eplan::status(&SystemHost, paths);
    if json {
        print_json(&status)?;
    } else {
        print!("{}", render(&status));
    }
    Ok(Exit::Ok)
}

pub fn control(action: Control) -> CliResult {
    eplan::control(&SystemHost, action)?;
    println!(
        "{}",
        match action {
            Control::Start => "EPLAN-Worker wird gestartet. Zustand mit `pds eplan status` prüfen.",
            Control::Stop => "EPLAN-Worker gestoppt.",
            Control::Restart =>
                "EPLAN-Worker neu gestartet. Zustand mit `pds eplan status` prüfen.",
        }
    );
    Ok(Exit::Ok)
}

/// Textausgabe von `eplan status`.
pub fn render(status: &EplanStatus) -> String {
    let mut out = String::new();
    let mut line = |label: &str, value: &str| {
        let _ = writeln!(out, "{label:<11}{value}");
    };
    line("Worker:", &summary(status));
    if let Some(service) = status.service.as_ref().filter(|_| status.installed()) {
        line("Konto:", &service.account);
    }
    line(
        "Programm:",
        &if status.worker_present {
            status.executable.clone()
        } else {
            format!("{} (fehlt)", status.executable)
        },
    );
    out
}

/// Eine Zeile für `status` und `eplan status`: Zustand samt Start und Konto, oder was fehlt.
pub fn summary(status: &EplanStatus) -> String {
    if !status.worker_present {
        return "fehlt in dieser Installation (MSI ohne EPLAN-Worker gebaut)".to_owned();
    }
    match &status.service {
        Some(service) if service.state == ScmState::NotInstalled => {
            "nicht eingerichtet – pds eplan install --user <konto>".to_owned()
        }
        Some(service) => format!("{}, Konto {}", service_text(Some(service)), service.account),
        None => service_text(None),
    }
}

impl From<EplanError> for CliError {
    fn from(error: EplanError) -> Self {
        Self::new(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use pds_common::platform::ScmInfo;

    use super::*;

    fn status(state: ScmState, present: bool) -> EplanStatus {
        EplanStatus {
            service: Some(ScmInfo {
                state,
                start_type: "auto".into(),
                delayed: true,
                account: r"EXAMPLE\svc-eplan".into(),
            }),
            worker_present: present,
            executable: r"C:\Program Files\EPLAN Panel Data Service\eplan\pds-eplan.exe".into(),
        }
    }

    #[test]
    fn summary_names_state_start_and_account() {
        assert_eq!(
            summary(&status(ScmState::Running, true)),
            r"läuft (Start: automatisch, verzögert), Konto EXAMPLE\svc-eplan"
        );
        assert_eq!(
            summary(&status(ScmState::NotInstalled, true)),
            "nicht eingerichtet – pds eplan install --user <konto>"
        );
        assert!(summary(&status(ScmState::NotInstalled, false)).starts_with("fehlt"));
        let mut unknown = status(ScmState::Running, true);
        unknown.service = None;
        assert!(summary(&unknown).starts_with("nicht abfragbar"));
    }

    #[test]
    fn render_shows_account_only_when_installed() {
        let text = render(&status(ScmState::Stopped, true));
        assert!(text.contains(r"Konto:     EXAMPLE\svc-eplan"), "{text}");
        assert!(text.contains(r"Programm:  C:\Program Files"), "{text}");

        let text = render(&status(ScmState::NotInstalled, false));
        assert!(!text.contains("Konto:"), "{text}");
        assert!(text.contains("pds-eplan.exe (fehlt)"), "{text}");
    }
}
