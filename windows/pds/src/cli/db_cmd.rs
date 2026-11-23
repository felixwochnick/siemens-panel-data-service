//! `db test`, `db setup`, `db script` und `db backup`: Datenbank prüfen, einrichten (SQL Server)
//! und sichern (SQLite) über das Node-Werkzeug.
//!
//! Alle prüfen vorher die Konfiguration (dieselben Befunde wie `config validate`): Ein Fehler in den
//! Datenbankfeldern endet mit Exit 2, ohne dass das Werkzeug läuft. Ein Ergebnis des Werkzeugs mit
//! `ok == false` endet mit Exit 3. Einrichtung und Skript gibt es nur für SQL Server, die Sicherung
//! nur für SQLite (sonst Exit 1 mit Erklärung). Der Admin-Zugang wird nur gelesen, nie gespeichert.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use pds_common::config::{Config, DbKind, Secrets};
use pds_common::ops::{self, OpsError};
use pds_common::tools::{ToolLine, ToolResult};
use pds_common::validate::{self, Finding, Severity, ValidationInput};
use pds_common::{Paths, system_protector};
use serde_json::json;
use time::OffsetDateTime;

use super::config_cmd::{
    SECRET_AS_ARGUMENT, finding_line, load_config, print_json, read_line_secret,
};
use super::{CliError, CliResult, Exit};

// ---------------------------------------------------------------------------------------------
// Gemeinsame Hilfen (auch für `oidc test`)
// ---------------------------------------------------------------------------------------------

/// Konfiguration und geöffnete Secrets. Das Zertifikat bleibt außen vor: Ein Problem damit soll
/// die Prüfung von Datenbank und Anmeldung nicht aufhalten.
pub(super) fn load_settings(paths: &Paths) -> Result<(Config, Secrets), CliError> {
    let config = load_config(paths)?;
    let secrets = config.open_secrets(&*system_protector())?;
    Ok((config, secrets))
}

/// Fehler der Konfiguration an den Feldern mit einem der `prefixes` (ohne `except`). Sie machen
/// einen Aufruf des Werkzeugs sinnlos und erklären besser, was fehlt, als dessen Fehlermeldung.
pub(super) fn blocking_findings(
    paths: &Paths,
    config: &Config,
    secrets: &Secrets,
    prefixes: &[&str],
    except: &[&str],
) -> Vec<Finding> {
    validate::validate(&ValidationInput {
        config,
        secrets,
        certificate: None,
        certificate_key_matches: None,
        now: OffsetDateTime::now_utc(),
        paths,
    })
    .into_iter()
    .filter(|finding| {
        finding.severity == Severity::Error
            && prefixes
                .iter()
                .any(|prefix| finding.field.starts_with(prefix))
            && !except.contains(&finding.field.as_str())
    })
    .collect()
}

/// Meldet blockierende Befunde (Exit 2). Mit `json` in der Form eines Werkzeug-Ergebnisses, damit
/// Skripte nur eine Form lesen müssen; sonst als Liste, auf stderr, wenn stdout frei bleiben muss.
pub(super) fn report_invalid(findings: &[Finding], json: bool, text_to_stderr: bool) -> CliResult {
    let message = "Die Konfiguration hat Fehler, die Prüfung wurde nicht gestartet.";
    if json {
        print_json(&ToolResult {
            ok: false,
            code: "config_invalid".to_owned(),
            message: message.to_owned(),
            steps: Vec::new(),
            details: json!({ "findings": findings }),
        })?;
    } else {
        let mut text = format!("{message}\n");
        for finding in findings {
            text.push_str(&format!("  {}\n", finding_line(finding)));
        }
        text.push_str("Konfiguration ändern mit `pds config set`.\n");
        if text_to_stderr {
            eprint!("{text}");
        } else {
            print!("{text}");
        }
    }
    Ok(Exit::Invalid)
}

/// Ergebnis des Werkzeugs ausgeben: Schritte, dann das Ergebnis; Exit 3, wenn es scheiterte.
pub(super) fn report_tool(result: &ToolResult, json: bool) -> CliResult {
    if json {
        print_json(result)?;
    } else {
        print!("{}", render_tool(result));
    }
    Ok(if result.ok {
        Exit::Ok
    } else {
        Exit::CheckFailed
    })
}

fn render_tool(result: &ToolResult) -> String {
    let mut out = String::new();
    for (index, step) in result.steps.iter().enumerate() {
        // Der gescheiterte letzte Schritt und das Ergebnis nennen meist dasselbe: nur einmal
        let is_last = index + 1 == result.steps.len();
        if is_last && !result.ok && !step.ok && step.message == result.message {
            continue;
        }
        out.push_str(&format!("  {:<8} {}\n", step_label(step), step.message));
    }
    if result.ok {
        out.push_str(&format!("{}\n", result.message));
    } else {
        out.push_str(&format!(
            "Fehlgeschlagen ({}): {}\n",
            result.code, result.message
        ));
    }
    out
}

fn step_label(step: &ToolLine) -> &'static str {
    if step.ok {
        "ok"
    } else if step
        .details
        .get("warning")
        .and_then(|value| value.as_bool())
        == Some(true)
    {
        "Warnung"
    } else {
        "Fehler"
    }
}

// ---------------------------------------------------------------------------------------------
// db test
// ---------------------------------------------------------------------------------------------

pub fn test(paths: &Paths, json: bool) -> CliResult {
    let (config, secrets) = load_settings(paths)?;
    let blocking = blocking_findings(paths, &config, &secrets, &["db."], &[]);
    if !blocking.is_empty() {
        return report_invalid(&blocking, json, false);
    }
    let result = ops::db_test(paths, &config, &secrets)?;
    report_tool(&result, json)
}

// ---------------------------------------------------------------------------------------------
// db backup
// ---------------------------------------------------------------------------------------------

/// Sichert die SQLite-Datenbank nach `file`, auch im laufenden Betrieb.
pub fn backup(paths: &Paths, file: &Path, json: bool) -> CliResult {
    let (config, secrets) = load_settings(paths)?;
    if config.db.kind != DbKind::Sqlite {
        return Err(OpsError::SqliteOnly.into());
    }
    let blocking = blocking_findings(paths, &config, &secrets, &["db."], &[]);
    if !blocking.is_empty() {
        return report_invalid(&blocking, json, false);
    }
    let result = ops::db_backup(paths, &config, file)?;
    report_tool(&result, json)
}

// ---------------------------------------------------------------------------------------------
// db setup
// ---------------------------------------------------------------------------------------------

/// Ein Hinweis: im Textmodus auf stdout, mit `--json` auf stderr, damit stdout nur das JSON trägt.
fn note(json: bool, text: &str) {
    if json {
        eprintln!("{text}");
    } else {
        println!("{text}");
    }
}

/// `password_argument`: Ein Passwort als Argument wird abgelehnt, bevor irgendetwas geschieht.
pub fn setup(
    paths: &Paths,
    admin_user: &str,
    admin_password_stdin: bool,
    password_argument: bool,
    json: bool,
) -> CliResult {
    if password_argument {
        return Err(CliError::new(SECRET_AS_ARGUMENT));
    }
    if admin_user.trim().is_empty() {
        return Err(CliError::new(
            "Der Administrator-Login fehlt: --admin-user <LOGIN>",
        ));
    }
    ops::require_data_dir(paths)?;
    let (config, secrets) = load_settings(paths)?;
    // Vor der Passwortabfrage: Bei SQLite gibt es nichts einzurichten
    if config.db.kind != DbKind::Sqlserver {
        return Err(OpsError::SqlServerOnly("Die Einrichtung der Datenbank").into());
    }
    // Das App-Passwort fehlt zu Recht: Die Einrichtung erzeugt es
    let blocking = blocking_findings(paths, &config, &secrets, &["db."], &["db.password"]);
    if !blocking.is_empty() {
        return report_invalid(&blocking, json, false);
    }

    // Vor allem, was etwas ändert: Ohne Eingabe bleibt alles, wie es ist
    let admin_password = read_line_secret(
        &format!("Passwort für {admin_user}"),
        "--admin-password-stdin",
        admin_password_stdin,
    )?;
    if admin_password.is_empty() {
        return Err(CliError::new("Leeres Passwort für den Administrator-Login"));
    }

    note(
        json,
        "Hinweis: Ein erneuter Lauf setzt das Passwort des Logins neu und trennt offene \
         Verbindungen zur Datenbank.",
    );

    // Ohne gesetztes Datenbankpasswort erzeugt `db_setup` eins und speichert es versiegelt
    let outcome = ops::db_setup(
        paths,
        &config,
        &secrets,
        admin_user,
        &admin_password,
        &*system_protector(),
    )?;
    let exit = report_tool(&outcome.result, json)?;
    if outcome.password_generated {
        // Das Passwort selbst erscheint nie; es bleibt auch bei einem Fehlschlag gespeichert
        note(
            json,
            "Es war kein Datenbankpasswort gesetzt: Ein neues wurde erzeugt und verschlüsselt \
             gespeichert.",
        );
    }
    if outcome.result.ok {
        note(
            json,
            "Die Anwendung übernimmt es mit `pds service restart`.",
        );
    }
    Ok(exit)
}

// ---------------------------------------------------------------------------------------------
// db script
// ---------------------------------------------------------------------------------------------

/// Das SQL-Skript für DBAs. Ohne Datei steht auf stdout nur das Skript (es lässt sich umleiten),
/// Meldungen gehen auf stderr.
pub fn script(paths: &Paths, file: Option<&Path>) -> CliResult {
    let config = load_config(paths)?;
    if config.db.kind != DbKind::Sqlserver {
        return Err(OpsError::SqlServerOnly("Das SQL-Skript").into());
    }
    // Das Skript braucht nur Namen von Datenbank und Login
    let blocking = blocking_findings(
        paths,
        &config,
        &Secrets::default(),
        &["db."],
        &["db.server", "db.port", "db.password"],
    );
    if !blocking.is_empty() {
        return report_invalid(&blocking, false, true);
    }
    let result = ops::db_script(paths, &config)?;
    if !result.ok {
        eprintln!("Fehlgeschlagen ({}): {}", result.code, result.message);
        return Ok(Exit::CheckFailed);
    }
    let script = result
        .details
        .get("script")
        .and_then(|script| script.as_str())
        .ok_or_else(|| CliError::new("Das Werkzeug hat kein Skript geliefert"))?;
    match file {
        Some(file) => {
            fs::write(file, script)
                .map_err(|error| CliError::new(format!("{}: {error}", file.display())))?;
            println!(
                "SQL-Skript nach {} geschrieben (UTF-8). Vor dem Ausführen DB_PASSWORD im Skript \
                 setzen; dasselbe Passwort muss unter db.password eingetragen werden \
                 (`pds config set db.password`).",
                file.display()
            );
        }
        None => {
            let mut stdout = io::stdout().lock();
            stdout
                .write_all(script.as_bytes())
                .and_then(|()| stdout.flush())
                .map_err(|error| CliError::new(format!("Ausgabe nicht möglich: {error}")))?;
        }
    }
    Ok(Exit::Ok)
}
