//! Kommandozeile `pds`: Befehle, deutsche Hilfe und Exit-Codes.
//!
//! Exit-Codes: 0 OK, 1 Fehler, 2 Validierungsfehler, 3 Prüfung fehlgeschlagen.

use std::fmt;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::error::{ContextKind, ErrorKind};
use clap::{Arg, ArgAction, ArgGroup, CommandFactory, FromArgMatches, Parser, Subcommand};
use pds_common::Paths;
use pds_common::config::ConfigError;
use pds_common::names::product_version;
use pds_common::ops::OpsError;
use pds_common::platform::PlatformError;

pub mod config_cmd;
pub mod db_cmd;
pub mod oidc_cmd;
pub mod ports_cmd;
pub mod run_cmd;
pub mod service_cmd;
pub mod setup_cmd;
pub mod status_cmd;
pub mod tls_cmd;

/// Ergebnis eines Befehls als Exit-Code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Ok = 0,
    Error = 1,
    /// Die Konfiguration hat Fehler (`config validate`).
    Invalid = 2,
    /// Eine Prüfung (Datenbank, OIDC, Ports …) ist fehlgeschlagen.
    CheckFailed = 3,
}

impl From<Exit> for ExitCode {
    fn from(exit: Exit) -> Self {
        ExitCode::from(exit as u8)
    }
}

/// Fehler eines Befehls: deutsche Meldung, Exit-Code 1.
#[derive(Debug)]
pub struct CliError(String);

impl CliError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<OpsError> for CliError {
    fn from(error: OpsError) -> Self {
        Self(error.to_string())
    }
}

impl From<ConfigError> for CliError {
    fn from(error: ConfigError) -> Self {
        Self(error.to_string())
    }
}

impl From<PlatformError> for CliError {
    fn from(error: PlatformError) -> Self {
        Self(error.to_string())
    }
}

pub type CliResult = Result<Exit, CliError>;

// ---------------------------------------------------------------------------------------------
// Befehle
// ---------------------------------------------------------------------------------------------

/// EPLAN Panel Data Service: Dienst und Kommandozeile
#[derive(Debug, Parser)]
#[command(name = "pds", version = product_version())]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Alles im Vordergrund starten (zum Fehlersuchen); Strg+C beendet geordnet
    Run,
    /// Zustand von Dienst und Anwendung anzeigen
    #[command(override_usage = "pds status [--json]")]
    Status {
        /// Ausgabe als JSON (für Skripte)
        #[arg(long)]
        json: bool,
    },
    /// Konfiguration anzeigen, ändern, prüfen, exportieren und importieren
    #[command(subcommand)]
    Config(ConfigCommand),
    /// Dienst starten, stoppen oder neu starten (Windows-Dienststeuerung)
    #[command(subcommand)]
    Service(ServiceCommand),
    /// TLS-Zertifikat importieren und anzeigen
    #[command(subcommand)]
    Tls(TlsCommand),
    /// Datenbank prüfen, einrichten (SQL Server) und sichern (SQLite)
    #[command(subcommand)]
    Db(DbCommand),
    /// Anmeldung (OpenID Connect) prüfen
    #[command(subcommand)]
    Oidc(OidcCommand),
    /// Prüfen, ob die Ports frei sind
    #[command(subcommand)]
    Ports(PortsCommand),
    /// Dienstbetrieb; startet der Dienststeuerungs-Manager (ohne Windows: Vordergrund)
    #[command(hide = true)]
    Daemon,
    /// Einrichtung und Entfernung durch das MSI
    #[command(hide = true, subcommand)]
    Setup(SetupCommand),
}

#[derive(Debug, Subcommand)]
enum ConfigCommand {
    /// Konfiguration anzeigen (Secrets als ***) mit den Befunden der Prüfung
    #[command(override_usage = "pds config show [--json]")]
    Show {
        /// Ausgabe als JSON (für Skripte)
        #[arg(long)]
        json: bool,
    },
    /// Ein Feld setzen, z. B. public.host, db.kind, db.path oder oidc.tenant_id
    ///
    /// Secret-Felder (db.password, oidc.client_secret, tls.acme_eab_hmac, app.secret) nie als
    /// Argument angeben: Der Wert wird verdeckt abgefragt oder mit --stdin als eine Zeile gelesen.
    /// Ein leerer Wert wird abgelehnt; entfernt wird ein Secret nur mit --clear. Die Änderung wird
    /// gespeichert und mit `pds service restart` wirksam.
    #[command(override_usage = "pds config set <FELD> <WERT>\n       \
                          pds config set <SECRET-FELD> [--stdin | --clear]")]
    Set {
        /// Feldpfad, z. B. public.host
        #[arg(value_name = "FELD")]
        field: String,
        /// Neuer Wert (nicht für Secrets)
        #[arg(value_name = "WERT")]
        value: Option<String>,
        /// Secret als eine Zeile von stdin lesen
        #[arg(long)]
        stdin: bool,
        /// Secret entfernen
        #[arg(long, conflicts_with = "stdin")]
        clear: bool,
    },
    /// Konfiguration prüfen (Exit-Code 2 bei Fehlern)
    #[command(override_usage = "pds config validate [--json]")]
    Validate {
        /// Befunde als JSON (für Skripte)
        #[arg(long)]
        json: bool,
    },
    /// Konfiguration als TOML ausgeben oder in eine Datei schreiben (Secrets als ***)
    Export {
        /// Zieldatei; ohne Angabe auf die Standardausgabe
        #[arg(value_name = "DATEI")]
        file: Option<PathBuf>,
    },
    /// Konfiguration aus einer Datei im Exportformat übernehmen
    ///
    /// Die Datei ist eine vollständige Konfiguration im Exportformat (`config export`): Fehlende
    /// Schlüssel erhalten die Standardwerte, fehlende Secrets werden gelöscht. *** behält ein
    /// vorhandenes Secret, Klartext-Secrets werden verschlüsselt gespeichert – die Datei danach
    /// löschen. Wirksam mit `pds service restart`.
    Import {
        /// Datei im Exportformat (TOML)
        #[arg(value_name = "DATEI")]
        file: PathBuf,
    },
    /// App-Secret verwalten
    #[command(name = "app-secret", subcommand)]
    AppSecret(AppSecretCommand),
}

#[derive(Debug, Subcommand)]
enum AppSecretCommand {
    /// Neues App-Secret erzeugen; Sitzungen, MCP-Verbindungen und die Passwörter der
    /// Web-Konsole (EPLAN-API, Netzlaufwerk) werden ungültig
    #[command(override_usage = "pds config app-secret regenerate [--yes]")]
    Regenerate {
        /// Ohne Rückfrage ausführen
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Subcommand)]
enum ServiceCommand {
    /// Dienst starten; mit --wait warten, bis die Anwendung antwortet
    #[command(override_usage = "pds service start [--wait [--timeout <SEKUNDEN>]]")]
    Start(WaitArgs),
    /// Dienst stoppen und warten, bis er steht
    #[command(override_usage = "pds service stop [--timeout <SEKUNDEN>]")]
    Stop {
        /// Ohne Wirkung: stop wartet immer, bis der Dienst steht (für Skripte, die alle drei
        /// Befehle gleich aufrufen)
        #[arg(long)]
        wait: bool,
        /// Höchstens so lange auf das Ende des Dienstes warten (Standard 90, höchstens 3600)
        #[arg(long, value_name = "SEKUNDEN", value_parser = clap::value_parser!(u64).range(1..=3600))]
        timeout: Option<u64>,
    },
    /// Dienst neu starten; übernimmt eine geänderte Konfiguration
    ///
    /// Mit --wait wartet der Befehl, bis der Dienst läuft und die Anwendung antwortet. Sonst
    /// endet er mit Exit-Code 3 und nennt den Grund (Konfigurationsfehler, nicht eingerichtet oder
    /// Zeitüberschreitung). Ein Status von vor dem Neustart zählt nicht.
    #[command(override_usage = "pds service restart [--wait [--timeout <SEKUNDEN>]]")]
    Restart(WaitArgs),
}

/// Warten auf einen gesunden Dienst nach Start oder Neustart.
#[derive(Debug, clap::Args)]
struct WaitArgs {
    /// Warten, bis der Dienst läuft und die Anwendung antwortet (Exit-Code 3 sonst)
    #[arg(long)]
    wait: bool,
    /// Höchstens so lange auf die Anwendung warten (Standard 90, höchstens 3600); gezählt ab dem
    /// Start, beim Neustart kommt das Stoppen (bis zu 60 s) davor hinzu
    #[arg(long, requires = "wait", value_name = "SEKUNDEN", value_parser = clap::value_parser!(u64).range(1..=3600))]
    timeout: Option<u64>,
}

impl WaitArgs {
    fn duration(&self) -> Option<std::time::Duration> {
        self.wait.then(|| service_cmd::timeout(self.timeout))
    }
}

#[derive(Debug, Subcommand)]
enum TlsCommand {
    /// Zertifikat samt Schlüssel importieren (PFX, PEM oder Zertifikatspeicher)
    ///
    /// Das Zertifikat wird geprüft und nur bei Erfolg gespeichert (Exit-Code 2 sonst): nicht
    /// abgelaufen, passt zum Hostnamen aus public.host (wenn gesetzt) und zum Schlüssel. Der
    /// Schlüssel liegt danach nur verschlüsselt im Datenordner. Das PFX-Passwort nie als Argument
    /// angeben: Es wird verdeckt abgefragt oder mit --password-stdin als eine Zeile gelesen.
    /// Wirksam mit `pds service restart`.
    #[command(
        override_usage = "pds tls import --pfx <DATEI> [--password-stdin]\n       \
                          pds tls import --pem <ZERTIFIKAT> <SCHLÜSSEL>\n       \
                          pds tls import --store <FINGERABDRUCK>",
        group(ArgGroup::new("quelle").required(true).args(["pfx", "pem", "store"]))
    )]
    Import {
        /// PFX-Datei (Zertifikat samt Schlüssel)
        #[arg(long, value_name = "DATEI")]
        pfx: Option<PathBuf>,
        /// Zertifikat (mit Kette) und privater Schlüssel als PEM-Dateien
        #[arg(long, num_args = 2, value_names = ["ZERTIFIKAT", "SCHLÜSSEL"])]
        pem: Option<Vec<PathBuf>>,
        /// Zertifikat aus dem Speicher des Computers (nur Windows), per SHA-1-Fingerabdruck
        #[arg(long, value_name = "FINGERABDRUCK")]
        store: Option<String>,
        /// PFX-Passwort als eine Zeile von stdin lesen
        #[arg(long, conflicts_with_all = ["pem", "store"])]
        password_stdin: bool,
        /// Wird abgelehnt: Secrets nie als Argument
        #[arg(long, hide = true, value_name = "PASSWORT")]
        password: Option<String>,
    },
    /// Gespeichertes Zertifikat anzeigen: Aussteller, Namen, Ablauf, passt es zu public.host
    #[command(override_usage = "pds tls show [--json]")]
    Show {
        /// Ausgabe als JSON (für Skripte)
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum DbCommand {
    /// Datenbank mit der gespeicherten Konfiguration prüfen (Exit-Code 3 bei Fehlschlag)
    ///
    /// SQL Server: Verbindung, Rechte und Migrationen. SQLite: Datei öffnen (fehlt sie, wird sie
    /// leer angelegt), beschreiben und die Migrationen zählen.
    #[command(override_usage = "pds db test [--json]")]
    Test {
        /// Ergebnis als JSON (für Skripte)
        #[arg(long)]
        json: bool,
    },
    /// SQLite-Datenbank im laufenden Betrieb sichern (Exit-Code 3 bei Fehlschlag)
    ///
    /// Schreibt eine in sich stimmige Kopie der Datenbankdatei nach <DATEI> und prüft sie; der
    /// Dienst darf dabei laufen. Die Zieldatei darf es noch nicht geben. Die Kopie enthält alle
    /// Daten der Anwendung, also an einem geschützten Ort ablegen. Nur für SQLite; eine
    /// SQL-Server-Datenbank sichert die Datenbankverwaltung.
    #[command(override_usage = "pds db backup <DATEI> [--json]")]
    Backup {
        /// Zieldatei der Sicherung, z. B. D:\Sicherung\pds-20261123.db
        #[arg(value_name = "DATEI")]
        file: PathBuf,
        /// Ergebnis als JSON (für Skripte)
        #[arg(long)]
        json: bool,
    },
    /// Datenbank, Login und Benutzer einrichten (nur SQL Server), mit dem Zugang eines
    /// Administrators
    ///
    /// Führt dieselben Anweisungen aus wie das SQL-Skript (`db script`). Ist kein Datenbankpasswort
    /// gespeichert, wird ein zufälliges erzeugt und verschlüsselt abgelegt. Das Passwort des
    /// Administrators wird nie gespeichert und nie als Argument angegeben: Es wird verdeckt
    /// abgefragt oder mit --admin-password-stdin als eine Zeile gelesen. Ein erneuter Lauf setzt
    /// das Passwort des Logins neu und trennt offene Verbindungen. Exit-Code 3 bei Fehlschlag.
    #[command(
        override_usage = "pds db setup --admin-user <LOGIN> [--admin-password-stdin] [--json]"
    )]
    Setup {
        /// SQL-Login mit sysadmin-Rechten, z. B. sa
        #[arg(long, value_name = "LOGIN")]
        admin_user: String,
        /// Passwort des Administrators als eine Zeile von stdin lesen
        #[arg(long)]
        admin_password_stdin: bool,
        /// Wird abgelehnt: Secrets nie als Argument
        #[arg(long, hide = true, value_name = "PASSWORT")]
        admin_password: Option<String>,
        /// Ergebnis als JSON (für Skripte)
        #[arg(long)]
        json: bool,
    },
    /// SQL-Skript für DBAs erzeugen (nur SQL Server, SQLCMD-Modus); ohne Datei auf die
    /// Standardausgabe
    #[command(override_usage = "pds db script [<DATEI>]")]
    Script {
        /// Zieldatei; ohne Angabe steht nur das Skript auf der Standardausgabe
        #[arg(value_name = "DATEI")]
        file: Option<PathBuf>,
    },
}

#[derive(Debug, Subcommand)]
enum OidcCommand {
    /// OpenID-Discovery des Ausstellers prüfen (Exit-Code 3 bei Fehlschlag)
    ///
    /// Mit --check-client wird zusätzlich Client-ID und Client-Secret geprüft; das gespeicherte
    /// Secret geht dabei an den Aussteller.
    #[command(override_usage = "pds oidc test [--check-client] [--json]")]
    Test {
        /// Client-ID und Client-Secret mitprüfen
        #[arg(long)]
        check_client: bool,
        /// Ergebnis als JSON (für Skripte)
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum PortsCommand {
    /// Prüfen, ob Caddy und die App ihre Ports öffnen können (Exit-Code 3, wenn einer belegt ist)
    ///
    /// Geprüft werden listen.http_port, public.port (nicht bei tls.mode off) und internal.port.
    /// Bei einem belegten Port stehen Besitzer und, wenn es http.sys ist (PID 4), ein Hinweis da.
    #[command(override_usage = "pds ports check [--json]")]
    Check {
        /// Ergebnis als JSON (für Skripte)
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum SetupCommand {
    /// Datenordner, App-Secret, Ereignisquelle und Firewall-Regel einrichten
    Install,
    /// Firewall-Regel und Ereignisquelle entfernen
    #[command(override_usage = "pds setup uninstall [--remove-data]")]
    Uninstall {
        /// Auch den Datenordner löschen (Konfiguration, Zertifikat, Logs)
        #[arg(long)]
        remove_data: bool,
    },
}

// ---------------------------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------------------------

/// Einstieg der EXE.
pub fn run() -> ExitCode {
    let cli = match command()
        .try_get_matches()
        .and_then(|matches| Cli::from_arg_matches(&matches))
    {
        Ok(cli) => cli,
        Err(error) => return clap_exit(&error).into(),
    };
    match dispatch(cli.command) {
        Ok(exit) => exit.into(),
        Err(error) => {
            eprintln!("Fehler: {error}");
            Exit::Error.into()
        }
    }
}

fn dispatch(command: Command) -> CliResult {
    let paths = Paths::detect();
    match command {
        Command::Run => run_cmd::run(&paths),
        Command::Status { json } => status_cmd::status(&paths, json),
        Command::Config(command) => match command {
            ConfigCommand::Show { json } => config_cmd::show(&paths, json),
            ConfigCommand::Set {
                field,
                value,
                stdin,
                clear,
            } => {
                let source = match (stdin, clear) {
                    (_, true) => config_cmd::SecretSource::Clear,
                    (true, false) => config_cmd::SecretSource::Stdin,
                    (false, false) => config_cmd::SecretSource::Prompt,
                };
                config_cmd::set(&paths, &field, value, source)
            }
            ConfigCommand::Validate { json } => config_cmd::validate(&paths, json),
            ConfigCommand::Export { file } => config_cmd::export(&paths, file.as_deref()),
            ConfigCommand::Import { file } => config_cmd::import(&paths, &file),
            ConfigCommand::AppSecret(AppSecretCommand::Regenerate { yes }) => {
                config_cmd::regenerate_app_secret(&paths, yes)
            }
        },
        Command::Service(command) => match command {
            ServiceCommand::Start(args) => service_cmd::start(&paths, args.duration()),
            ServiceCommand::Stop { timeout, .. } => {
                service_cmd::stop(service_cmd::timeout(timeout))
            }
            ServiceCommand::Restart(args) => service_cmd::restart(&paths, args.duration()),
        },
        Command::Tls(command) => match command {
            TlsCommand::Import {
                pfx,
                pem,
                store,
                password_stdin,
                password,
            } => {
                let from = match (pfx, pem, store) {
                    (Some(file), _, _) => tls_cmd::ImportFrom::Pfx {
                        file,
                        password_stdin,
                    },
                    (None, Some(files), _) => {
                        // `num_args = 2` garantiert beide Pfade
                        let [cert, key]: [PathBuf; 2] = files
                            .try_into()
                            .map_err(|_| CliError::new("--pem braucht Zertifikat und Schlüssel"))?;
                        tls_cmd::ImportFrom::Pem { cert, key }
                    }
                    (None, None, Some(thumbprint)) => tls_cmd::ImportFrom::Store { thumbprint },
                    (None, None, None) => {
                        return Err(CliError::new("Quelle fehlt: --pfx, --pem oder --store"));
                    }
                };
                tls_cmd::import(&paths, from, password.is_some())
            }
            TlsCommand::Show { json } => tls_cmd::show(&paths, json),
        },
        Command::Db(command) => match command {
            DbCommand::Test { json } => db_cmd::test(&paths, json),
            DbCommand::Backup { file, json } => db_cmd::backup(&paths, &file, json),
            DbCommand::Setup {
                admin_user,
                admin_password_stdin,
                admin_password,
                json,
            } => db_cmd::setup(
                &paths,
                &admin_user,
                admin_password_stdin,
                admin_password.is_some(),
                json,
            ),
            DbCommand::Script { file } => db_cmd::script(&paths, file.as_deref()),
        },
        Command::Oidc(OidcCommand::Test { check_client, json }) => {
            oidc_cmd::test(&paths, check_client, json)
        }
        Command::Ports(PortsCommand::Check { json }) => ports_cmd::check(&paths, json),
        Command::Daemon => service_cmd::daemon(&paths),
        Command::Setup(SetupCommand::Install) => setup_cmd::install(&paths),
        Command::Setup(SetupCommand::Uninstall { remove_data }) => {
            setup_cmd::uninstall(&paths, remove_data)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Deutsche Hilfe und Fehlermeldungen von clap
// ---------------------------------------------------------------------------------------------

const HELP_TEMPLATE: &str =
    "{before-help}{about-with-newline}\nAufruf: {usage}\n\n{all-args}{after-help}";

/// Der Parser mit deutschen Überschriften und Hilfetexten in allen Unterbefehlen.
pub fn command() -> clap::Command {
    germanize(Cli::command(), true)
}

fn germanize(command: clap::Command, root: bool) -> clap::Command {
    let mut command = command
        .help_template(HELP_TEMPLATE)
        .subcommand_help_heading("Befehle")
        .subcommand_value_name("BEFEHL")
        .disable_help_subcommand(true)
        .disable_help_flag(true)
        .arg(
            Arg::new("help")
                .short('h')
                .long("help")
                .action(ArgAction::Help)
                .help("Hilfe anzeigen"),
        );
    if root {
        command = command.disable_version_flag(true).arg(
            Arg::new("version")
                .short('V')
                .long("version")
                .action(ArgAction::Version)
                .help("Version anzeigen"),
        );
    }
    command
        .mut_args(|arg| {
            let heading = if arg.is_positional() {
                "Argumente"
            } else {
                "Optionen"
            };
            arg.help_heading(heading)
        })
        .mut_subcommands(|sub| germanize(sub, false))
}

/// Gibt Hilfe, Version oder eine deutsche Fehlermeldung aus und liefert den Exit-Code.
fn clap_exit(error: &clap::Error) -> Exit {
    match error.kind() {
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
            let _ = error.print();
            Exit::Ok
        }
        ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            let _ = error.print();
            Exit::Error
        }
        _ => {
            eprintln!("Fehler: {}", german_message(error));
            Exit::Error
        }
    }
}

fn german_message(error: &clap::Error) -> String {
    let context = |kind| error.get(kind).map(ToString::to_string).unwrap_or_default();
    let mut message = match error.kind() {
        ErrorKind::InvalidSubcommand => {
            format!(
                "Unbekannter Befehl: {}",
                context(ContextKind::InvalidSubcommand)
            )
        }
        ErrorKind::UnknownArgument => {
            // Nur Optionsnamen wiederholen: Ein überzähliges Argument kann ein Secret sein
            let argument = context(ContextKind::InvalidArg);
            if looks_like_option(&argument) {
                format!("Unbekannte Option: {argument}")
            } else {
                "Unerwartetes Argument".to_owned()
            }
        }
        ErrorKind::MissingRequiredArgument => {
            format!("Angabe fehlt: {}", context(ContextKind::InvalidArg))
        }
        ErrorKind::MissingSubcommand => "Befehl fehlt".to_owned(),
        ErrorKind::ArgumentConflict => format!(
            "{} lässt sich nicht mit {} kombinieren",
            context(ContextKind::InvalidArg),
            context(ContextKind::PriorArg)
        ),
        ErrorKind::InvalidValue | ErrorKind::ValueValidation => {
            format!("Ungültiger Wert für {}", context(ContextKind::InvalidArg))
        }
        ErrorKind::TooManyValues | ErrorKind::TooFewValues | ErrorKind::WrongNumberOfValues => {
            format!(
                "Falsche Anzahl von Werten für {}",
                context(ContextKind::InvalidArg)
            )
        }
        ErrorKind::InvalidUtf8 => "Argumente müssen gültiger UTF-8-Text sein".to_owned(),
        _ => "Ungültiger Aufruf".to_owned(),
    };
    if let Some(suggestion) = error.get(ContextKind::SuggestedSubcommand) {
        message.push_str(&format!(" – gemeint ist vielleicht: {suggestion}"));
    }
    if let Some(usage) = error.get(ContextKind::Usage) {
        let usage = usage.to_string();
        let usage = usage.strip_prefix("Usage: ").unwrap_or(&usage);
        message.push_str(&format!("\n\nAufruf: {usage}"));
    }
    message.push_str("\nHilfe mit --help");
    message
}

fn looks_like_option(argument: &str) -> bool {
    argument.strip_prefix("--").is_some_and(|name| {
        !name.is_empty()
            && name.len() <= 32
            && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        let mut argv = vec!["pds"];
        argv.extend_from_slice(args);
        command()
            .try_get_matches_from(argv)
            .and_then(|matches| Cli::from_arg_matches(&matches))
    }

    #[test]
    fn parser_is_consistent() {
        command().debug_assert();
    }

    #[test]
    fn secret_value_is_parsed_so_the_command_can_reject_it() {
        let cli = parse(&["config", "set", "db.password", "geheim"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Config(ConfigCommand::Set { value: Some(_), .. })
        ));
    }

    #[test]
    fn surplus_argument_is_not_echoed() {
        let error = parse(&["config", "set", "db.password", "a", "geheim"]).unwrap_err();
        let message = german_message(&error);

        assert!(message.starts_with("Unerwartetes Argument"), "{message}");
        assert!(!message.contains("geheim"), "{message}");
    }

    #[test]
    fn unknown_option_is_named() {
        let error = parse(&["status", "--jsno"]).unwrap_err();

        assert!(
            german_message(&error).starts_with("Unbekannte Option: --jsno"),
            "{}",
            german_message(&error)
        );
    }

    #[test]
    fn password_arguments_are_parsed_so_the_commands_can_reject_them() {
        let cli = parse(&["tls", "import", "--pfx", "a.pfx", "--password", "geheim"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Tls(TlsCommand::Import {
                password: Some(_),
                ..
            })
        ));
        let cli = parse(&[
            "db",
            "setup",
            "--admin-user",
            "sa",
            "--admin-password",
            "geheim",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Command::Db(DbCommand::Setup {
                admin_password: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn tls_import_takes_one_source() {
        let cli = parse(&["tls", "import", "--pem", "zert.pem", "schluessel.pem"]).unwrap();
        let Command::Tls(TlsCommand::Import {
            pem: Some(files), ..
        }) = cli.command
        else {
            panic!("kein PEM-Import");
        };
        assert_eq!(files.len(), 2);

        assert!(parse(&["tls", "import"]).is_err());
        assert!(parse(&["tls", "import", "--pem", "nur-eins.pem"]).is_err());
        assert!(parse(&["tls", "import", "--pfx", "a", "--pem", "b", "c"]).is_err());
        assert!(parse(&["tls", "import", "--store", "AB", "--password-stdin"]).is_err());
    }

    #[test]
    fn service_timeout_needs_wait_but_not_for_stop() {
        assert!(parse(&["service", "restart", "--wait", "--timeout", "30"]).is_ok());
        assert!(parse(&["service", "start", "--timeout", "30"]).is_err());
        assert!(parse(&["service", "restart", "--timeout", "30"]).is_err());
        assert!(parse(&["service", "restart", "--wait", "--timeout", "0"]).is_err());
        assert!(parse(&["service", "restart", "--wait", "--timeout", "3600"]).is_ok());
        assert!(parse(&["service", "restart", "--wait", "--timeout", "3601"]).is_err());
        assert!(parse(&["service", "stop", "--timeout", "3601"]).is_err());
        assert!(parse(&["service", "stop", "--timeout", "30"]).is_ok());
        assert!(parse(&["service", "stop", "--wait"]).is_ok());
    }

    #[test]
    fn help_is_german() {
        let help = command().render_help().to_string();

        assert!(help.contains("Aufruf:"), "{help}");
        assert!(help.contains("Befehle:"), "{help}");
        assert!(help.contains("Hilfe anzeigen"), "{help}");
        assert!(!help.contains("Usage"), "{help}");
        assert!(!help.contains("Print help"), "{help}");
    }

    #[test]
    fn subcommand_help_is_german() {
        let mut command = command();
        let config = command.find_subcommand_mut("config").unwrap();
        let set = config.find_subcommand_mut("set").unwrap();
        let help = set.render_long_help().to_string();

        assert!(help.contains("Argumente:"), "{help}");
        assert!(help.contains("Optionen:"), "{help}");
        assert!(help.contains("<FELD>"), "{help}");
        assert!(!help.contains("Arguments:"), "{help}");
        assert!(!help.contains("[OPTIONS]"), "{help}");
    }
}
