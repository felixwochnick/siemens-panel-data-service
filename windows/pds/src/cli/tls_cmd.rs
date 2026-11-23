//! `tls import` und `tls show`: Zertifikat samt Schlüssel importieren und anzeigen.
//!
//! Der Import speichert nur; wirksam wird das Zertifikat mit `service restart`. Gespeichert wird
//! es erst, wenn die Prüfung (Ablauf, Hostname, Schlüssel) besteht. Der Schlüssel verlässt den
//! Speicher nie im Klartext.

use std::fs;
use std::path::{Path, PathBuf};

use pds_common::config::{self, Config, TlsMode};
use pds_common::ops::{self, OpsError, TlsSource};
use pds_common::platform::cert_store::normalize_thumbprint;
use pds_common::tls::{self, CertInfo};
use pds_common::validate::Finding;
use pds_common::{Paths, Secret, system_protector};
use serde::Serialize;
use time::OffsetDateTime;

use super::config_cmd::{
    SECRET_AS_ARGUMENT, finding_line, load_config, print_json, read_line_secret,
};
use super::status_cmd::format_time;
use super::{CliError, CliResult, Exit};

/// Woher `tls import` das Zertifikat nimmt.
#[derive(Debug)]
pub enum ImportFrom {
    /// PFX-Datei; das Passwort von stdin oder verdeckt vom Terminal.
    Pfx {
        file: PathBuf,
        password_stdin: bool,
    },
    Pem {
        cert: PathBuf,
        key: PathBuf,
    },
    /// Fingerabdruck eines Zertifikats in `LocalMachine\My`.
    Store {
        thumbprint: String,
    },
}

/// `password_argument`: Ein Passwort als Argument wird abgelehnt, bevor irgendetwas geschieht
/// (es steht dann schon in Argumentliste und Verlauf).
pub fn import(paths: &Paths, from: ImportFrom, password_argument: bool) -> CliResult {
    if password_argument {
        return Err(CliError::new(SECRET_AS_ARGUMENT));
    }
    // Vor Eingaben und Prüfungen: Niemand tippt umsonst, nichts wird verbraucht
    ops::require_data_dir(paths)?;
    let config = load_config(paths)?;
    let source = read_source(from)?;

    let protector = system_protector();
    let now = OffsetDateTime::now_utc();
    match ops::import_tls(paths, &config, source, &*protector, now) {
        Ok(info) => {
            print_imported(paths, &config, &info, now);
            Ok(Exit::Ok)
        }
        Err(OpsError::Rejected(findings)) => {
            eprintln!("Das Zertifikat wurde nicht importiert, die vorhandene Ablage bleibt:");
            for finding in &findings {
                eprintln!("  {}", finding_line(finding));
            }
            Ok(Exit::Invalid)
        }
        Err(error) => Err(error.into()),
    }
}

/// Liest Dateien und Passwort. Die Dateien zuerst: Fehlt eine, wird gar nicht erst nach dem
/// Passwort gefragt.
fn read_source(from: ImportFrom) -> Result<TlsSource, CliError> {
    match from {
        ImportFrom::Pfx {
            file,
            password_stdin,
        } => {
            let bytes = fs::read(&file).map_err(|error| file_error(&file, &error))?;
            // Ein leeres Passwort ist bei PFX möglich (OpenSSL erlaubt es); stimmt es nicht,
            // sagt der Import das
            let password = read_line_secret("PFX-Passwort", "--password-stdin", password_stdin)?;
            Ok(TlsSource::Pfx { bytes, password })
        }
        ImportFrom::Pem { cert, key } => {
            let cert = fs::read_to_string(&cert).map_err(|error| file_error(&cert, &error))?;
            let key = fs::read_to_string(&key).map_err(|error| file_error(&key, &error))?;
            Ok(TlsSource::Pem {
                cert,
                key: Secret::new(key),
            })
        }
        ImportFrom::Store { thumbprint } => {
            if cfg!(not(windows)) {
                return Err(CliError::new(
                    "--store gibt es nur unter Windows (Zertifikatspeicher des Computers); hier \
                     bitte --pfx oder --pem verwenden",
                ));
            }
            let thumbprint = normalize_thumbprint(&thumbprint).ok_or_else(|| {
                CliError::new(
                    "Der Fingerabdruck ist ungültig: erwartet werden 40 Hexadezimalzeichen",
                )
            })?;
            Ok(TlsSource::Store { thumbprint })
        }
    }
}

fn file_error(file: &Path, error: &std::io::Error) -> CliError {
    CliError::new(format!("{}: {error}", file.display()))
}

fn print_imported(paths: &Paths, config: &Config, info: &CertInfo, now: OffsetDateTime) {
    println!("Zertifikat importiert, der Schlüssel ist verschlüsselt gespeichert.");
    print!("{}", certificate_lines(info, now));
    // Nur Warnungen können noch übrig sein (Fehler hätten den Import abgelehnt)
    for finding in ops::certificate_findings(config, paths, info, Some(true), now) {
        println!("{}", finding_line(&finding));
    }
    if config.tls.mode != TlsMode::Certificate {
        println!(
            "Hinweis: Der TLS-Modus ist „{}“, das Zertifikat wird erst im Modus certificate \
             verwendet (`pds config set tls.mode certificate`).",
            config.tls.mode.as_str()
        );
    }
    println!("Wirksam nach `pds service restart`.");
}

/// Die Angaben zum Zertifikat, je eine Zeile.
fn certificate_lines(info: &CertInfo, now: OffsetDateTime) -> String {
    let remaining = match (info.not_after - now).whole_days() {
        days if days < 0 => " (abgelaufen)".to_owned(),
        1 => " (noch 1 Tag)".to_owned(),
        days => format!(" (noch {days} Tage)"),
    };
    let names = if info.dns_names.is_empty() {
        "keine".to_owned()
    } else {
        info.dns_names.join(", ")
    };
    format!(
        "Betreff:           {}\nAussteller:        {}\nNamen (SAN):       {names}\n\
         Gültig ab:         {}\nGültig bis:        {}{remaining}\nFingerabdruck:     {}\n",
        info.subject,
        info.issuer,
        format_time(info.not_before),
        format_time(info.not_after),
        info.thumbprint_sha1
    )
}

// ---------------------------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------------------------

/// JSON von `tls show`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShowJson<'a> {
    certificate: Option<&'a CertInfo>,
    /// Passt der gespeicherte Schlüssel zum Zertifikat? `null`, wenn nicht prüfbar.
    key_matches: Option<bool>,
    findings: &'a [Finding],
}

pub fn show(paths: &Paths, json: bool) -> CliResult {
    let protector = system_protector();
    let now = OffsetDateTime::now_utc();
    let config = match config::load(&paths.config_file()) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Hinweis: {error}; der Hostname wird nicht geprüft.");
            Config::default()
        }
    };
    let Some(info) = tls::load_info(paths).map_err(|error| CliError::new(error.to_string()))?
    else {
        if json {
            print_json(&ShowJson {
                certificate: None,
                key_matches: None,
                findings: &[],
            })?;
        } else {
            println!("Kein Zertifikat hinterlegt. Importieren mit `pds tls import`.");
        }
        return Ok(Exit::Ok);
    };

    let key = tls::load(paths, &*protector)
        .map_err(|error| error.to_string())
        .and_then(|material| material.ok_or_else(|| "Schlüssel fehlt".to_owned()))
        .and_then(|material| tls::key_matches(&material).map_err(|error| error.to_string()));
    let key_matches = key.as_ref().ok().copied();
    let findings = ops::certificate_findings(&config, paths, &info, key_matches, now);

    if json {
        print_json(&ShowJson {
            certificate: Some(&info),
            key_matches,
            findings: &findings,
        })?;
        return Ok(Exit::Ok);
    }

    print!("{}", certificate_lines(&info, now));
    let host = config.public.host.trim();
    let host_text = if host.is_empty() {
        "kein Hostname konfiguriert (public.host)".to_owned()
    } else if tls::hostname_matches(&info, host) {
        format!("{host}: passt")
    } else {
        format!("{host}: passt nicht")
    };
    println!("{:<19}{host_text}", "Hostname:");
    let key_text = match &key {
        Ok(true) => "passt zum Zertifikat".to_owned(),
        Ok(false) => "passt nicht zum Zertifikat".to_owned(),
        Err(reason) => format!("nicht prüfbar: {reason}"),
    };
    println!("{:<19}{key_text}", "Schlüssel:");
    if !findings.is_empty() {
        println!("Befunde:");
        for finding in &findings {
            println!("  {}", finding_line(finding));
        }
    }
    Ok(Exit::Ok)
}
