//! `config show|set|validate|export|import|app-secret regenerate`.
//!
//! Alle Befehle speichern nur; wirksam wird eine Änderung mit `service restart`.

use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::Path;

use pds_common::config::fields::{FIELDS, FieldError, get_field, set_field};
use pds_common::config::masking::{MASK, export_toml, import_toml, masked};
use pds_common::config::store::parse;
use pds_common::config::{self, Config, ConfigError, SecretField};
use pds_common::ops;
use pds_common::validate::{Finding, Severity, has_errors};
use pds_common::{Paths, Protector, Secret, system_protector};
use serde::Serialize;
use time::OffsetDateTime;

use super::{CliError, CliResult, Exit};

pub const SECRET_AS_ARGUMENT: &str =
    "Secrets nie als Argument übergeben – Wert wird abgefragt oder mit --stdin gelesen";
const APPLY_HINT: &str = "Wirksam nach `pds service restart`.";
const EXPORT_HEADER: &str = "# EPLAN Panel Data Service – Konfiguration\n\
# Secrets stehen als \"***\" und bleiben beim Import unverändert.\n\n";

// ---------------------------------------------------------------------------------------------
// show und validate
// ---------------------------------------------------------------------------------------------

/// JSON von `config show`: die maskierte Konfiguration, dazu die Befunde.
#[derive(Serialize)]
struct ShowJson<'a> {
    #[serde(flatten)]
    config: &'a Config,
    findings: &'a [Finding],
}

pub fn show(paths: &Paths, json: bool) -> CliResult {
    let config = load_config(paths)?;
    let findings = current_findings(paths);
    if json {
        let view = masked(&config);
        print_json(&ShowJson {
            config: &view,
            findings: &findings,
        })?;
    } else {
        for field in FIELDS {
            let value = get_field(&config, field.path).unwrap_or_default();
            let value = if value.is_empty() {
                "\"\"".to_owned()
            } else {
                value
            };
            println!("{} = {value}", field.path);
        }
        println!();
        print_findings(&findings);
    }
    Ok(Exit::Ok)
}

pub fn validate(paths: &Paths, json: bool) -> CliResult {
    let findings = current_findings(paths);
    if json {
        print_json(&findings)?;
    } else {
        print_findings(&findings);
    }
    Ok(if has_errors(&findings) {
        Exit::Invalid
    } else {
        Exit::Ok
    })
}

fn current_findings(paths: &Paths) -> Vec<Finding> {
    ops::check(paths, &*system_protector(), OffsetDateTime::now_utc()).findings
}

/// Befunde als Liste mit Zusammenfassung.
pub fn print_findings(findings: &[Finding]) {
    if findings.is_empty() {
        println!("Die Konfiguration ist gültig.");
        return;
    }
    println!("Befunde:");
    for finding in findings {
        println!("  {}", finding_line(finding));
    }
    let errors = findings
        .iter()
        .filter(|finding| finding.severity == Severity::Error)
        .count();
    let warnings = findings.len() - errors;
    let warning_word = if warnings == 1 {
        "Warnung"
    } else {
        "Warnungen"
    };
    println!("{errors} Fehler, {warnings} {warning_word}");
}

pub fn finding_line(finding: &Finding) -> String {
    let severity = match finding.severity {
        Severity::Error => "Fehler: ",
        Severity::Warning => "Warnung:",
    };
    format!(
        "{severity} {}: {} ({})",
        finding.field, finding.message, finding.code
    )
}

// ---------------------------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------------------------

/// Woher `config set` den Wert eines Secret-Feldes nimmt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretSource {
    /// Verdeckte Abfrage am Terminal.
    Prompt,
    /// Eine Zeile von stdin (`--stdin`).
    Stdin,
    /// Secret entfernen (`--clear`); der einzige Weg dazu.
    Clear,
}

const EMPTY_SECRET: &str = "Leerer Wert – zum Entfernen --clear verwenden";

pub fn set(paths: &Paths, field: &str, value: Option<String>, source: SecretSource) -> CliResult {
    if let Some(secret_field) = SecretField::from_path(field) {
        // Vor allem anderen: Der Wert steht schon in Argumentliste und Verlauf, nicht noch speichern
        if value.is_some() {
            return Err(CliError::new(SECRET_AS_ARGUMENT));
        }
        // Datenordner und Datei vor der Eingabe prüfen: Niemand tippt umsonst, nichts wird verbraucht
        ops::require_data_dir(paths)?;
        let mut config = load_config(paths)?;
        let secret = match source {
            SecretSource::Clear => None,
            SecretSource::Stdin | SecretSource::Prompt => Some(read_secret(field, source)?),
        };
        config.seal(secret_field, secret.as_ref(), &*system_protector())?;
        print_save_warnings(&ops::save_config(paths, &config)?);
        if secret.is_some() {
            println!("{field} verschlüsselt gespeichert.");
        } else {
            println!("{field} gelöscht.");
        }
    } else {
        if !FIELDS.iter().any(|known| known.path == field) {
            return Err(CliError::new(format!(
                "Unbekanntes Feld: {field}. Alle Felder zeigt `pds config show`."
            )));
        }
        match source {
            SecretSource::Prompt => {}
            SecretSource::Stdin => {
                return Err(CliError::new("--stdin gilt nur für Secret-Felder"));
            }
            SecretSource::Clear => {
                return Err(CliError::new("--clear gilt nur für Secret-Felder"));
            }
        }
        let Some(value) = value else {
            return Err(CliError::new(format!(
                "Wert fehlt: pds config set {field} <WERT>"
            )));
        };
        ops::require_data_dir(paths)?;
        let mut config = load_config(paths)?;
        set_field(&mut config, field, &value).map_err(|error| field_error(field, &error))?;
        print_save_warnings(&ops::save_config(paths, &config)?);
        println!("{field} = {value} gespeichert.");
    }
    println!("{APPLY_HINT}");
    Ok(Exit::Ok)
}

fn field_error(field: &str, error: &FieldError) -> CliError {
    match error {
        FieldError::InvalidValue { expected } => {
            CliError::new(format!("Ungültiger Wert für {field}, erwartet: {expected}"))
        }
        other => CliError::new(format!("{field}: {other}")),
    }
}

/// Secret mit `--stdin` als eine Zeile, sonst verdeckt vom Terminal. Nie leer: Ein leerer Wert
/// oder fehlende Eingabe (Erzeuger in der Pipe gescheitert) darf kein Secret löschen.
fn read_secret(field: &str, source: SecretSource) -> Result<Secret, CliError> {
    let secret = read_line_secret(
        &format!("Wert für {field}"),
        "--stdin",
        source == SecretSource::Stdin,
    )?;
    if secret.is_empty() {
        return Err(CliError::new(EMPTY_SECRET));
    }
    Ok(secret)
}

/// Eine Zeile Secret: von stdin (`from_stdin`) oder verdeckt vom Terminal. Das Ergebnis kann leer
/// sein; ob das erlaubt ist, entscheidet der Aufrufer. `stdin_flag` nennt die Option, die der
/// Hinweis ohne Terminal empfiehlt.
pub(super) fn read_line_secret(
    prompt: &str,
    stdin_flag: &str,
    from_stdin: bool,
) -> Result<Secret, CliError> {
    let value = if from_stdin {
        let mut line = String::with_capacity(1024);
        let read = io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|error| CliError::new(format!("stdin nicht lesbar: {error}")))?;
        if read == 0 {
            return Err(CliError::new("Keine Eingabe auf stdin"));
        }
        strip_line_ending(line)
    } else {
        if !io::stdin().is_terminal() {
            return Err(CliError::new(format!(
                "Kein Terminal für die verdeckte Eingabe – den Wert mit {stdin_flag} übergeben"
            )));
        }
        rpassword::prompt_password(format!("{prompt} (Eingabe verdeckt): "))
            .map_err(|error| CliError::new(format!("Eingabe nicht lesbar: {error}")))?
    };
    Ok(Secret::new(value))
}

/// Entfernt genau ein Zeilenende (`\n` oder `\r\n`); Leerzeichen gehören zum Secret.
fn strip_line_ending(mut line: String) -> String {
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    line
}

// ---------------------------------------------------------------------------------------------
// export und import
// ---------------------------------------------------------------------------------------------

pub fn export(paths: &Paths, file: Option<&Path>) -> CliResult {
    let config = load_config(paths)?;
    let text = format!("{EXPORT_HEADER}{}", export_toml(&config));
    match file {
        Some(file) => {
            fs::write(file, text)
                .map_err(|error| CliError::new(format!("{}: {error}", file.display())))?;
            println!("Konfiguration nach {} exportiert.", file.display());
        }
        None => print!("{text}"),
    }
    Ok(Exit::Ok)
}

pub fn import(paths: &Paths, file: &Path) -> CliResult {
    let text = fs::read_to_string(file)
        .map_err(|error| CliError::new(format!("{}: {error}", file.display())))?;
    let protector = system_protector();
    // Vorab, damit eine kaputte Datei nichts verändert und der Hinweis stimmt
    let incoming = parse(&text).map_err(|error| import_error(file, &error))?;
    let plaintext = has_plaintext_secret(&incoming, &*protector);

    ops::require_data_dir(paths)?;
    let existing = match config::load(&paths.config_file()) {
        Ok(existing) => existing,
        Err(error) => {
            eprintln!(
                "Hinweis: Die vorhandene Konfiguration ist nicht lesbar ({error}); *** übernimmt \
                 daher keine Secrets."
            );
            Config::default()
        }
    };
    let imported =
        import_toml(&existing, &text, &*protector).map_err(|error| import_error(file, &error))?;
    print_save_warnings(&ops::save_config(paths, &imported)?);

    println!("Konfiguration aus {} importiert.", file.display());
    if plaintext {
        println!(
            "Die Datei enthält Secrets im Klartext; sie sind jetzt verschlüsselt gespeichert. \
             Bitte die Datei jetzt löschen: {}",
            file.display()
        );
    }
    let errors = current_findings(paths)
        .iter()
        .filter(|finding| finding.severity == Severity::Error)
        .count();
    if errors > 0 {
        println!("Hinweis: Die Konfiguration hat noch {errors} Fehler (`pds config validate`).");
    }
    println!("{APPLY_HINT}");
    Ok(Exit::Ok)
}

fn import_error(file: &Path, error: &ConfigError) -> CliError {
    CliError::new(format!(
        "{} lässt sich nicht importieren: {error}",
        file.display()
    ))
}

/// Wie `merge_masked` entscheidet: weder leer noch `***` noch mit dem eigenen Schema versiegelt.
fn has_plaintext_secret(incoming: &Config, protector: &dyn Protector) -> bool {
    SecretField::ALL.into_iter().any(|field| {
        let value = incoming.sealed(field);
        !value.is_empty() && value.0 != MASK && !value.is_sealed(protector.scheme())
    })
}

// ---------------------------------------------------------------------------------------------
// app-secret regenerate
// ---------------------------------------------------------------------------------------------

// Die Passwörter der Controller-Einstellungen sind mit einem Schlüssel aus dem App-Secret verschlüsselt
const REGENERATE_WARNING: &str = "Achtung: Ein neues App-Secret macht alle Sitzungen und \
                                  MCP-Verbindungen ungültig; alle müssen sich neu anmelden. Die \
                                  Passwörter für EPLAN-API und Netzlaufwerk sind danach nicht mehr \
                                  lesbar und müssen in der Web-Konsole neu eingegeben werden.";

pub fn regenerate_app_secret(paths: &Paths, yes: bool) -> CliResult {
    if !yes && !confirm()? {
        return Err(CliError::new(
            "Abgebrochen, das App-Secret ist unverändert.",
        ));
    }
    ops::regenerate_app_secret(paths, &*system_protector())?;
    println!("Neues App-Secret gespeichert. {APPLY_HINT}");
    Ok(Exit::Ok)
}

/// Rückfrage am Terminal; ohne Terminal muss `--yes` angegeben werden.
fn confirm() -> Result<bool, CliError> {
    if !io::stdin().is_terminal() {
        return Err(CliError::new(format!(
            "{REGENERATE_WARNING} Zum Bestätigen --yes angeben."
        )));
    }
    eprint!("{REGENERATE_WARNING} Fortfahren? [j/N] ");
    let _ = io::stderr().flush();
    let mut answer = String::new();
    io::stdin()
        .lock()
        .read_line(&mut answer)
        .map_err(|error| CliError::new(format!("Eingabe nicht lesbar: {error}")))?;
    Ok(matches!(
        answer.trim().to_lowercase().as_str(),
        "j" | "ja" | "y" | "yes"
    ))
}

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

/// Warnungen beim Speichern (etwa: Firewall-Regel nicht angelegt) gehen auf stderr; gespeichert ist
/// die Konfiguration trotzdem.
pub(super) fn print_save_warnings(outcome: &ops::SaveOutcome) {
    for warning in &outcome.warnings {
        eprintln!("Warnung: {warning}");
    }
}

pub(super) fn load_config(paths: &Paths) -> Result<Config, CliError> {
    config::load(&paths.config_file()).map_err(|error| {
        CliError::new(format!(
            "{error} – als Administrator ausführen bzw. die Datei mit \
             `pds config import <datei>` ersetzen"
        ))
    })
}

pub(super) fn print_json(value: &impl Serialize) -> Result<(), CliError> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| CliError::new(format!("JSON-Ausgabe fehlgeschlagen: {error}")))?;
    println!("{text}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_exactly_one_line_ending() {
        assert_eq!(strip_line_ending("abc\n".into()), "abc");
        assert_eq!(strip_line_ending("abc\r\n".into()), "abc");
        assert_eq!(strip_line_ending(" a b \n".into()), " a b ");
        assert_eq!(strip_line_ending("abc\n\n".into()), "abc\n");
        assert_eq!(strip_line_ending("abc".into()), "abc");
        assert_eq!(strip_line_ending(String::new()), "");
    }

    #[test]
    fn plaintext_detection_follows_merge_rules() {
        let protector = system_protector();
        let mut config = Config::default();
        assert!(!has_plaintext_secret(&config, &*protector));

        config.db.password.0 = MASK.to_owned();
        assert!(!has_plaintext_secret(&config, &*protector));

        config
            .seal(
                SecretField::DbPassword,
                Some(&Secret::new("x")),
                &*protector,
            )
            .unwrap();
        assert!(!has_plaintext_secret(&config, &*protector));

        config.oidc.client_secret.0 = "klartext".to_owned();
        assert!(has_plaintext_secret(&config, &*protector));
    }

    #[test]
    fn finding_line_names_field_and_code() {
        let line = finding_line(&Finding {
            field: "db.server".into(),
            code: "required".into(),
            message: "Datenbankserver fehlt".into(),
            severity: Severity::Error,
        });

        assert_eq!(line, "Fehler:  db.server: Datenbankserver fehlt (required)");
    }
}
