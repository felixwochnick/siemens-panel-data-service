//! `oidc test [--check-client] [--json]`: OpenID-Discovery des Ausstellers prüfen, mit
//! `--check-client` auch Client-ID und -Secret. Exit 3, wenn die Prüfung scheitert; Exit 2, wenn
//! die Konfiguration der Anmeldung Fehler hat.

use pds_common::{Paths, ops};

use super::CliResult;
use super::db_cmd::{blocking_findings, load_settings, report_invalid, report_tool};

pub fn test(paths: &Paths, check_client: bool, json: bool) -> CliResult {
    let (config, secrets) = load_settings(paths)?;
    // Das Client-Secret braucht nur die Clientprüfung
    let except: &[&str] = if check_client {
        &[]
    } else {
        &["oidc.client_secret"]
    };
    let blocking = blocking_findings(paths, &config, &secrets, &["oidc.", "proxy."], except);
    if !blocking.is_empty() {
        return report_invalid(&blocking, json, false);
    }
    let result = ops::oidc_test(paths, &config, &secrets, check_client)?;
    report_tool(&result, json)
}
