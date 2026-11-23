//! Windows-Plattform: DPAPI, Job Object, Dienststeuerung, Ereignisprotokoll, Ports, ACL, Firewall
//! und Zertifikatspeicher. Läuft nur unter Windows (CI auf windows-2022).
//!
//! Tests, die den Rechner verändern (HKLM, Firewall, `LocalMachine\My`) und Administratorrechte
//! brauchen, sind mit `#[ignore]` markiert. Auf dem kurzlebigen CI-Runner laufen sie mit
//! `cargo test -- --include-ignored`, vor der Installation des MSI.
#![cfg(windows)]

use std::fs;
use std::process::{Child, Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use pds_common::names::{EVENT_SOURCE, FIREWALL_RULE_NAME, SERVICE_ACCOUNT};
use pds_common::platform::{
    DpapiProtector, EventLevel, JobObject, PlatformError, ScmState, cert_store, eventlog, firewall,
    ports, prepare_sqlite_dir_for_sid, scm, secure_data_dir, secure_data_dir_for_sid,
};
use pds_common::{Paths, Protector, tls};
use tempfile::TempDir;

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

/// Läuft rund 30 s und braucht kein Netz.
fn ping() -> Child {
    Command::new("ping")
        .args(["-n", "30", "127.0.0.1"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn ends_within(child: &mut Child, limit: Duration) -> bool {
    let start = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            return true;
        }
        if start.elapsed() > limit {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Windows PowerShell 5.1. Ohne den geerbten `PSModulePath`: Läuft `cargo test` unter pwsh 7, zeigt
/// er auf dessen Module, und 5.1 lädt dann weder `Get-Acl` noch das Laufwerk `Cert:`.
fn powershell(script: &str) -> Output {
    Command::new("powershell")
        .env_remove("PSModulePath")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn powershell_text(script: &str) -> String {
    let output = powershell(script);
    assert!(
        output.status.success(),
        "PowerShell fehlgeschlagen: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn sddl(path: &std::path::Path) -> String {
    let literal = path.display().to_string().replace('\'', "''");
    powershell_text(&format!("(Get-Acl -LiteralPath '{literal}').Sddl"))
}

/// Läuft der Test mit Administratorrechten (erhöht)?
fn is_elevated() -> bool {
    powershell_text(
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())\
         .IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ) == "True"
}

/// Alle Einträge der DACL aus einem SDDL-Text, geerbte eingeschlossen.
fn all_aces(sddl: &str) -> Vec<String> {
    let dacl = sddl.split_once("D:").map_or("", |(_, dacl)| dacl);
    dacl.split('(')
        .skip(1)
        .filter_map(|ace| ace.split(')').next())
        .map(|ace| format!("({ace})"))
        .collect()
}

/// Explizite (nicht geerbte) Einträge der DACL aus einem SDDL-Text.
fn explicit_aces(sddl: &str) -> Vec<String> {
    all_aces(sddl)
        .into_iter()
        .filter(|ace| !ace.split(';').nth(1).unwrap_or_default().contains("ID"))
        .collect()
}

/// Ruft `icacls` auf; Konten werden sprachunabhängig per SID angegeben (`*S-1-…`). `icacls`
/// schaltet die nötigen Privilegien (etwa für `/setowner`) selbst ein.
fn icacls(path: &std::path::Path, args: &[&str]) {
    let output = Command::new("icacls")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "icacls {args:?}: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

/// Gibt Benutzer (S-1-5-32-545) Vollzugriff als expliziten Eintrag.
fn grant_users(path: &std::path::Path, inherit: bool) {
    let permission = if inherit {
        "*S-1-5-32-545:(OI)(CI)F"
    } else {
        "*S-1-5-32-545:F"
    };
    icacls(path, &["/grant", permission]);
}

/// Legt eine Junction an; das darf jeder Benutzer.
fn junction(link: &std::path::Path, target: &std::path::Path) {
    let link = link.display().to_string().replace('\'', "''");
    let target = target.display().to_string().replace('\'', "''");
    powershell_text(&format!(
        "New-Item -ItemType Junction -Path '{link}' -Target '{target}' | Out-Null"
    ));
}

/// Netzwerkdienst als Ersatz für das Dienstkonto; SDDL-Kürzel `NS`.
const STAND_IN_SID: &str = "S-1-5-20";

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
    listener.local_addr().unwrap().port()
}

// ---------------------------------------------------------------------------------------------
// DPAPI
// ---------------------------------------------------------------------------------------------

#[test]
fn dpapi_roundtrip() {
    let protector = DpapiProtector;
    let plain = "p@ss'wört% #?/:".as_bytes();

    let blob = protector.protect(plain).unwrap();

    assert_eq!(protector.scheme(), "dpapi");
    assert_ne!(blob.as_slice(), plain);
    assert!(
        !blob.windows(4).any(|w| w == b"p@ss"),
        "Klartext im Ergebnis"
    );
    assert_eq!(protector.unprotect(&blob).unwrap().as_slice(), plain);
    // Leere Secrets gehen auch
    let empty = protector.protect(b"").unwrap();
    assert!(protector.unprotect(&empty).unwrap().is_empty());
}

#[test]
fn dpapi_rejects_garbage() {
    let protector = DpapiProtector;
    assert!(protector.unprotect(b"garbage").is_err());
    assert!(protector.unprotect(b"").is_err());

    // Ein verändertes Byte macht den Blob unbrauchbar
    let mut blob = protector.protect(b"geheim").unwrap();
    let last = blob.len() - 1;
    blob[last] ^= 0xff;
    let error = protector.unprotect(&blob).unwrap_err();
    assert!(
        !error.to_string().contains("geheim"),
        "kein Klartext im Fehler"
    );
}

#[test]
fn system_protector_is_dpapi() {
    let protector = pds_common::system_protector();
    assert_eq!(protector.scheme(), "dpapi");
    let blob = protector.protect(b"x").unwrap();
    assert_eq!(DpapiProtector.unprotect(&blob).unwrap().as_slice(), b"x");
}

// ---------------------------------------------------------------------------------------------
// Job Object
// ---------------------------------------------------------------------------------------------

#[test]
fn job_kills_children_on_drop() {
    let job = JobObject::new_kill_on_close().unwrap();
    let mut child = ping();
    job.assign(&child).unwrap();
    assert!(child.try_wait().unwrap().is_none(), "Kind läuft noch nicht");

    drop(job);

    let ended = ends_within(&mut child, Duration::from_secs(2));
    if !ended {
        child.kill().ok();
    }
    assert!(
        ended,
        "Kind läuft nach dem Schließen des Job Objects weiter"
    );
}

#[test]
fn job_terminate_kills_assigned_children() {
    let job = JobObject::new_kill_on_close().unwrap();
    let mut first = ping();
    let mut second = ping();
    job.assign(&first).unwrap();
    job.assign(&second).unwrap();

    job.terminate().unwrap();

    assert!(ends_within(&mut first, Duration::from_secs(2)));
    assert!(ends_within(&mut second, Duration::from_secs(2)));
    // Das Job Object bleibt benutzbar
    let mut third = ping();
    job.assign(&third).unwrap();
    drop(job);
    assert!(ends_within(&mut third, Duration::from_secs(2)));
}

#[test]
fn job_is_send_and_sync() {
    fn check<T: Send + Sync>() {}
    check::<JobObject>();
}

// ---------------------------------------------------------------------------------------------
// Dienststeuerung
// ---------------------------------------------------------------------------------------------

#[test]
fn scm_query_works_with_or_without_service() {
    let info = scm::query().unwrap();
    if info.state == ScmState::NotInstalled {
        assert!(info.account.is_empty());
        assert!(info.start_type.is_empty());
        assert!(!info.delayed);
        // Ohne Dienst gibt es einen klaren Fehler statt eines Hängers
        assert_eq!(scm::start(), Err(PlatformError::ServiceNotInstalled));
        assert_eq!(
            scm::stop(Duration::from_secs(1)),
            Err(PlatformError::ServiceNotInstalled)
        );
        assert_eq!(
            scm::restart(Duration::from_secs(1)),
            Err(PlatformError::ServiceNotInstalled)
        );
    } else {
        // Nach der Installation durch das MSI
        assert_eq!(info.start_type, "auto");
        assert!(info.delayed);
        assert!(
            info.account.eq_ignore_ascii_case(SERVICE_ACCOUNT),
            "{info:?}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Ereignisprotokoll
// ---------------------------------------------------------------------------------------------

#[test]
fn eventlog_write_does_not_fail_without_registered_source() {
    // Ohne registrierte Quelle schreibt Windows trotzdem ins Anwendungsprotokoll
    eventlog::write(EventLevel::Info, "Test: Information").unwrap();
    eventlog::write(EventLevel::Warning, "Test: Warnung mit %1 und Umlauten äöü").unwrap();
    eventlog::write(EventLevel::Error, &"x".repeat(40_000)).unwrap();
}

#[test]
#[ignore = "ändert HKLM und braucht Administratorrechte; CI: --include-ignored"]
fn eventlog_register_and_deregister_source() {
    let key =
        format!(r"HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\{EVENT_SOURCE}");
    let exe = std::env::current_exe().unwrap();

    eventlog::register_source(&exe).unwrap();
    eventlog::register_source(&exe).unwrap();

    let message_file = powershell_text(&format!(
        "(Get-Item -LiteralPath '{key}').GetValue('EventMessageFile', $null, 'DoNotExpandEnvironmentNames')"
    ));
    assert_eq!(
        message_file,
        r"%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\EventLogMessages.dll"
    );
    let kind = powershell_text(&format!(
        "(Get-Item -LiteralPath '{key}').GetValueKind('EventMessageFile')"
    ));
    assert_eq!(kind, "ExpandString");
    let types = powershell_text(&format!(
        "(Get-ItemProperty -LiteralPath '{key}').TypesSupported"
    ));
    assert_eq!(types, "7");

    // Eindeutiger Text, weil andere Tests parallel in dieselbe Quelle schreiben
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let marker = format!("Registrierungstest {} {nanos}", std::process::id());
    eventlog::write(EventLevel::Warning, &marker).unwrap();
    // Die Nachricht kommt über `%1` der Nachrichten-DLL unverändert heraus
    let event_id = powershell_text(&format!(
        "(Get-EventLog -LogName Application -Source {EVENT_SOURCE} -Newest 50 | \
         Where-Object {{ $_.Message -eq '{marker}' }} | Select-Object -First 1).EventID"
    ));
    assert_eq!(
        event_id, "2",
        "Ereignis mit {marker:?} fehlt oder falsche ID"
    );

    eventlog::deregister_source().unwrap();
    eventlog::deregister_source().unwrap();
    let exists = powershell_text(&format!("Test-Path -LiteralPath '{key}'"));
    assert_eq!(exists, "False");
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

#[test]
fn ports_detects_http_sys() {
    // HttpListener reserviert den Port über http.sys; der Listener gehört dann PID 4
    let port = free_port();
    let script = format!(
        "$l = New-Object System.Net.HttpListener; $l.Prefixes.Add('http://localhost:{port}/'); \
         $l.Start(); Start-Sleep -Seconds 30"
    );
    let mut listener = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let start = Instant::now();
    let status = loop {
        let status = ports::check(&[port]).remove(0);
        if !status.free || start.elapsed() > Duration::from_secs(20) {
            break status;
        }
        if listener.try_wait().unwrap().is_some() {
            break status;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    listener.kill().ok();
    let output = listener.wait_with_output().unwrap();

    assert!(
        !status.free,
        "Port nicht belegt; PowerShell: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(status.http_sys, "{status:?}");
    assert_eq!(status.owner_pid, Some(4));
    assert_eq!(status.owner_name.as_deref(), Some("System (http.sys)"));
}

#[test]
fn ports_detects_ipv6_listener() {
    // Unter Windows lauscht ein IPv6-Socket nur auf IPv6; er steht also nur in der IPv6-Tabelle
    let listener = std::net::TcpListener::bind(("::", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();

    let status = ports::check(&[port]).remove(0);

    assert!(!status.free, "{status:?}");
    assert_eq!(status.owner_pid, Some(std::process::id()));
}

// ---------------------------------------------------------------------------------------------
// ACL
// ---------------------------------------------------------------------------------------------

/// Einträge des Datenordners und von `tls` mit dem Ersatzkonto (`NS`): Lesen für das Konto.
const ROOT_ACES: [&str; 3] = [
    "(A;OICI;FA;;;SY)",
    "(A;OICI;FA;;;BA)",
    "(A;OICI;0x1200a9;;;NS)",
];

/// Einträge von `state`, `logs`, `caddy` und `data`: Ändern für das Konto.
const WRITABLE_ACES: [&str; 3] = [
    "(A;OICI;FA;;;SY)",
    "(A;OICI;FA;;;BA)",
    "(A;OICI;0x1301bf;;;NS)",
];

fn data_paths(dir: &TempDir) -> Paths {
    Paths::new(dir.path().join("inst"), dir.path().join("daten"))
}

/// Ordner mit Besitzer Administratoren anzulegen, geht nur erhöht (CI-Runner ist Administrator).
fn skip_unless_elevated() -> bool {
    let skip = !is_elevated();
    if skip {
        eprintln!("übersprungen: braucht Administratorrechte");
    }
    skip
}

fn is_reparse_point(path: &std::path::Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_REPARSE_POINT
    fs::symlink_metadata(path).unwrap().file_attributes() & 0x400 != 0
}

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn aside_name(path: &std::path::Path) -> String {
    path.file_name().unwrap().to_string_lossy().into_owned()
}

/// Ein Ordner mit Besitzer Administratoren und geschützter DACL aus genau diesen Einträgen, ohne
/// geerbte Reste.
fn assert_protected(path: &std::path::Path, aces: [&str; 3]) {
    let text = sddl(path);
    assert!(text.starts_with("O:BA"), "{text}");
    assert!(text.contains("D:P"), "geschützt: {text}");
    // Reihenfolge egal: Get-Acl liefert die DACL in der kanonischen Ordnung von .NET (u. a. nach
    // SID sortiert), nicht in der gespeicherten; unter Erlauben-Einträgen bedeutet sie nichts
    let mut actual = all_aces(&text);
    actual.sort();
    let mut expected = aces.map(str::to_owned).to_vec();
    expected.sort();
    assert_eq!(actual, expected, "{text}");
}

/// Der eingerichtete Baum: Datenordner und `tls` geschützt mit Lesen für das Konto, `state`,
/// `logs`, `caddy` und `data` (SQLite) geschützt mit Ändern. Kein Unterordner erbt etwas, Besitzer
/// überall Administratoren.
fn assert_secured_tree(paths: &Paths) {
    assert_protected(&paths.data_dir, ROOT_ACES);
    assert_protected(&paths.tls_dir(), ROOT_ACES);
    for writable in [
        paths.state_dir(),
        paths.logs_dir(),
        paths.caddy_dir(),
        paths.sqlite_dir(),
    ] {
        assert_protected(&writable, WRITABLE_ACES);
    }
}

#[test]
fn secure_data_dir_with_service_account() {
    let dir = TempDir::new().unwrap();
    let paths = data_paths(&dir);

    match secure_data_dir(&paths) {
        Err(PlatformError::AccountNotFound) => {
            // Ohne installierten Dienst gibt es das Dienstkonto nicht, und ohne SID entsteht nichts;
            // die echte Prüfung macht der Smoke-Test nach der Installation.
            eprintln!("übersprungen: Dienstkonto {SERVICE_ACCOUNT} fehlt");
            assert!(!paths.data_dir.exists(), "ohne Dienstkonto kein Ordner");
            return;
        }
        _ if !is_elevated() => {
            eprintln!("übersprungen: braucht Administratorrechte");
            return;
        }
        other => assert!(other.unwrap().moved_aside.is_empty()),
    }
    // Die volle Dienst-SID (kein SDDL-Kürzel) wird beim zweiten Lauf als eigene erkannt
    let again = secure_data_dir(&paths).unwrap();
    assert!(again.moved_aside.is_empty(), "{again:?}");

    let data = sddl(&paths.data_dir);
    assert!(data.starts_with("O:BA"), "{data}");
    assert!(data.contains("D:P"), "geschützt: {data}");
    assert!(data.contains("(A;OICI;FA;;;SY)"), "{data}");
    assert!(data.contains("(A;OICI;FA;;;BA)"), "{data}");
    assert!(data.contains("(A;OICI;0x1200a9;;;S-1-5-80-"), "{data}");
    assert!(!data.contains("0x1301bf"), "kein Schreibrecht oben: {data}");
    for writable in [
        paths.state_dir(),
        paths.logs_dir(),
        paths.caddy_dir(),
        paths.sqlite_dir(),
    ] {
        let text = sddl(&writable);
        assert!(text.contains("(A;OICI;0x1301bf;;;S-1-5-80-"), "{text}");
    }
}

#[test]
fn secure_data_dir_creates_fresh_tree_with_final_acl() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let paths = data_paths(&dir);

    let outcome = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();

    assert!(outcome.moved_aside.is_empty(), "{outcome:?}");
    assert_secured_tree(&paths);
    assert_eq!(
        names(&paths.data_dir),
        ["caddy", "data", "logs", "state", "tls"]
    );
    // Idempotent: Der zweite Lauf übernimmt den eigenen Ordner
    let again = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();
    assert!(again.moved_aside.is_empty(), "{again:?}");
    assert_secured_tree(&paths);
}

#[test]
fn secure_data_dir_keeps_trusted_dir_and_config() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let paths = data_paths(&dir);
    secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();
    fs::write(paths.config_file(), "schema = 1\n").unwrap();

    let outcome = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();

    assert!(outcome.moved_aside.is_empty(), "{outcome:?}");
    assert_eq!(
        fs::read_to_string(paths.config_file()).unwrap(),
        "schema = 1\n"
    );
    assert_secured_tree(&paths);
    let config = sddl(&paths.config_file());
    assert!(explicit_aces(&config).is_empty(), "{config}");
    assert!(config.contains("(A;ID;0x1200a9;;;NS)"), "{config}");
}

#[test]
fn secure_data_dir_removes_extra_aces_from_trusted_dir() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let paths = data_paths(&dir);
    secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();
    fs::write(paths.config_file(), "schema = 1\n").unwrap();
    // Etwa ein Admin gibt einem Sicherungskonto Lesen; icacls verteilt das auch auf config.toml
    icacls(&paths.data_dir, &["/grant", "*S-1-5-32-545:(OI)(CI)R"]);
    let before = sddl(&paths.data_dir);
    assert!(before.contains("D:P"), "Vorbedingung geschützt: {before}");
    assert!(before.contains(";;;BU)"), "Vorbedingung: {before}");
    let config_before = sddl(&paths.config_file());
    assert!(
        config_before.contains(";;;BU)"),
        "Vorbedingung: {config_before}"
    );

    let outcome = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();

    // Behalten samt Konfiguration, nur ohne den zusätzlichen Eintrag
    assert!(outcome.moved_aside.is_empty(), "{outcome:?}");
    assert_eq!(
        fs::read_to_string(paths.config_file()).unwrap(),
        "schema = 1\n"
    );
    assert_secured_tree(&paths);
    let config = sddl(&paths.config_file());
    assert!(!config.contains(";;;BU)"), "{config}");
    assert!(explicit_aces(&config).is_empty(), "{config}");
    assert!(config.contains("(A;ID;0x1200a9;;;NS)"), "{config}");
    // Gemeldet für den Datenordner und für die geerbte Kopie in config.toml
    let removed = &outcome.removed_aces;
    assert!(
        removed
            .iter()
            .any(|entry| !entry.contains(": ") && entry.contains("(S-1-5-32-545)")),
        "{removed:?}"
    );
    assert!(
        removed
            .iter()
            .any(|entry| entry.starts_with("config.toml: ") && entry.contains("(S-1-5-32-545)")),
        "{removed:?}"
    );
    // Danach ist nichts mehr zu entfernen
    let again = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();
    assert!(
        again.removed_aces.is_empty() && again.moved_aside.is_empty(),
        "{again:?}"
    );
}

#[test]
fn secure_data_dir_moves_unprotected_dir_aside() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let paths = data_paths(&dir);
    secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();
    fs::write(paths.config_file(), "schema = 1\n").unwrap();
    // Besitzer bleibt Administratoren, aber die DACL erbt wieder vom Elternordner
    icacls(&paths.data_dir, &["/inheritance:e"]);
    let unprotected = sddl(&paths.data_dir);
    assert!(
        unprotected.starts_with("O:BA") && !unprotected.contains("D:P"),
        "Vorbedingung: {unprotected}"
    );

    let outcome = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();

    assert_eq!(outcome.moved_aside.len(), 1, "{outcome:?}");
    assert!(outcome.removed_aces.is_empty(), "{outcome:?}");
    let aside = &outcome.moved_aside[0];
    assert!(aside_name(aside).starts_with("daten (unsicher "));
    assert!(aside.join("config.toml").is_file());
    assert!(!paths.config_file().exists());
    assert_secured_tree(&paths);
}

#[test]
fn secure_data_dir_moves_foreign_dir_aside() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let paths = data_paths(&dir);
    // Vorher angelegt, wie es ein Benutzer ohne Administratorrechte unter ProgramData könnte
    fs::create_dir_all(&paths.data_dir).unwrap();
    fs::write(paths.data_dir.join("boese.txt"), "x").unwrap();
    grant_users(&paths.data_dir, true);
    icacls(&paths.data_dir, &["/setowner", "*S-1-5-32-545", "/T", "/C"]);
    let foreign = sddl(&paths.data_dir);
    assert!(foreign.starts_with("O:BU"), "Vorbedingung: {foreign}");

    let outcome = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();

    assert_eq!(outcome.moved_aside.len(), 1, "{outcome:?}");
    let aside = &outcome.moved_aside[0];
    let name = aside_name(aside);
    assert!(
        name.starts_with("daten (unsicher ") && name.ends_with(')'),
        "{name}"
    );
    assert_eq!(aside.parent(), paths.data_dir.parent());
    // Der alte Ordner ist unverändert beiseite gelegt, mit der Datei des Angreifers
    assert_eq!(names(aside), ["boese.txt"]);
    assert_eq!(sddl(aside), foreign);
    // Der neue ist sauber und enthält nur die eigenen Unterordner
    assert_eq!(
        names(&paths.data_dir),
        ["caddy", "data", "logs", "state", "tls"]
    );
    assert_secured_tree(&paths);
}

#[test]
fn secure_data_dir_moves_junction_aside_without_touching_target() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let target = dir.path().join("ziel");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("inhalt.txt"), "x").unwrap();
    let paths = data_paths(&dir);
    junction(&paths.data_dir, &target);
    // Vergleichswert erst nach allen Vorbereitungen
    let before = sddl(&target);

    let outcome = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();

    assert_eq!(outcome.moved_aside.len(), 1, "{outcome:?}");
    let aside = &outcome.moved_aside[0];
    assert!(aside_name(aside).starts_with("daten (unsicher "));
    // Umbenannt wurde der Verweis selbst; sein Ziel ist unberührt
    assert!(is_reparse_point(aside));
    assert_eq!(sddl(&target), before);
    assert_eq!(names(&target), ["inhalt.txt"]);
    assert!(!is_reparse_point(&paths.data_dir));
    assert_eq!(
        names(&paths.data_dir),
        ["caddy", "data", "logs", "state", "tls"]
    );
    assert_secured_tree(&paths);
}

#[test]
fn secure_data_dir_replaces_junction_subdir() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let target = dir.path().join("ziel");
    fs::create_dir_all(&target).unwrap();
    let paths = data_paths(&dir);
    secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();
    // Etwa ein kompromittierter Dienst ersetzt `state` durch einen Verweis
    fs::remove_dir(paths.state_dir()).unwrap();
    junction(&paths.state_dir(), &target);
    let before = sddl(&target);

    let outcome = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();

    assert_eq!(outcome.moved_aside.len(), 1, "{outcome:?}");
    let aside = &outcome.moved_aside[0];
    assert!(
        aside_name(aside).starts_with("state (unsicher "),
        "{aside:?}"
    );
    assert_eq!(aside.parent(), Some(paths.data_dir.as_path()));
    assert!(is_reparse_point(aside));
    assert!(!is_reparse_point(&paths.state_dir()));
    assert!(paths.state_dir().is_dir());
    assert_eq!(sddl(&target), before);
    assert!(names(&target).is_empty(), "Ziel bleibt leer");
    assert_secured_tree(&paths);
}

#[test]
fn secure_data_dir_replaces_logs_junction_without_touching_target_tree() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    // Ziel mit Inhalt: Eine Verteilung vererbbarer Einträge über den Verweis müsste hier ankommen
    let target = dir.path().join("ziel");
    let nested = target.join("tief");
    let file = nested.join("datei.txt");
    fs::create_dir_all(&nested).unwrap();
    fs::write(&file, "x").unwrap();
    let paths = data_paths(&dir);
    secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();
    // Der Dienst darf `logs` leeren und löschen; an seine Stelle tritt ein Verweis
    fs::remove_dir(paths.logs_dir()).unwrap();
    junction(&paths.logs_dir(), &target);
    let link_before = sddl(&paths.logs_dir());
    let before = [sddl(&target), sddl(&nested), sddl(&file)];

    let outcome = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();

    assert_eq!(outcome.moved_aside.len(), 1, "{outcome:?}");
    let aside = &outcome.moved_aside[0];
    assert!(
        aside_name(aside).starts_with("logs (unsicher "),
        "{aside:?}"
    );
    assert_eq!(aside.parent(), Some(paths.data_dir.as_path()));
    // Der Verweis selbst wurde umbenannt und nicht angefasst, sein Ziel samt Inhalt auch nicht
    assert!(is_reparse_point(aside));
    assert_eq!(sddl(aside), link_before);
    assert_eq!([sddl(&target), sddl(&nested), sddl(&file)], before);
    for text in &before {
        assert!(!text.contains("0x1301bf"), "Ändern am Ziel: {text}");
    }
    assert_eq!(names(&target), ["tief"]);
    // `logs` ist wieder ein echter, geschützter Ordner mit Ändern für das Konto
    assert!(!is_reparse_point(&paths.logs_dir()));
    assert!(names(&paths.logs_dir()).is_empty());
    assert_secured_tree(&paths);
}

#[test]
fn secure_data_dir_for_sid_rejects_malformed_sid() {
    let dir = TempDir::new().unwrap();
    let paths = data_paths(&dir);

    let error = secure_data_dir_for_sid(&paths, "S-1-5-20)(A;OICI;FA;;;WD").unwrap_err();

    assert_eq!(error.code(), "platform_os_error");
    assert!(!paths.data_dir.exists());
}

// ---------------------------------------------------------------------------------------------
// Firewall
// ---------------------------------------------------------------------------------------------

#[test]
#[ignore = "ändert die Firewall und braucht Administratorrechte; CI: --include-ignored"]
fn firewall_rule_is_created_and_replaced() {
    let caddy = std::path::Path::new(r"C:\Program Files\EPLAN Panel Data Service\caddy.exe");
    let filter = format!("Get-NetFirewallRule -DisplayName '{FIREWALL_RULE_NAME}'");

    firewall::ensure_rule(caddy, &[80, 443]).unwrap();
    // Ersetzen statt Anhängen, auch mit doppelten Ports
    firewall::ensure_rule(caddy, &[8080, 8443, 8080]).unwrap();

    let count = powershell_text(&format!("@({filter} -ErrorAction SilentlyContinue).Count"));
    assert_eq!(count, "1");
    let ports = powershell_text(&format!(
        "({filter} | Get-NetFirewallPortFilter).LocalPort -join ','"
    ));
    assert_eq!(ports, "8080,8443");
    let program = powershell_text(&format!(
        "({filter} | Get-NetFirewallApplicationFilter).Program"
    ));
    assert!(
        program.eq_ignore_ascii_case(&caddy.display().to_string()),
        "{program}"
    );
    let direction = powershell_text(&format!("({filter}).Direction"));
    assert_eq!(direction, "Inbound");
    let action = powershell_text(&format!("({filter}).Action"));
    assert_eq!(action, "Allow");

    firewall::remove_rule().unwrap();
    firewall::remove_rule().unwrap();
    let count = powershell_text(&format!("@({filter} -ErrorAction SilentlyContinue).Count"));
    assert_eq!(count, "0");
}

// ---------------------------------------------------------------------------------------------
// Zertifikatspeicher
// ---------------------------------------------------------------------------------------------

#[test]
fn cert_store_list_reads_local_machine_my() {
    for cert in cert_store::list().unwrap() {
        assert_eq!(cert.thumbprint.len(), 40, "{cert:?}");
        assert!(
            cert.thumbprint
                .chars()
                .all(|c| c.is_ascii_digit() || ('A'..='F').contains(&c)),
            "{cert:?}"
        );
    }
}

#[test]
fn cert_store_export_rejects_unknown_and_invalid_thumbprints() {
    let missing = cert_store::export(&"00".repeat(20)).unwrap_err();
    assert_eq!(missing, PlatformError::CertificateNotFound);
    let invalid = cert_store::export("kein-fingerabdruck").unwrap_err();
    assert_eq!(invalid, PlatformError::InvalidThumbprint);
}

/// Die Tests mit eigenem Zertifikat laufen nacheinander: Zwei gleichzeitige
/// `New-SelfSignedCertificate` in `LocalMachine\My` scheiterten in der CI einmal mit
/// CRYPT_E_NOT_FOUND (0x80092004).
static STORE: Mutex<()> = Mutex::new(());

/// Legt ein selbstsigniertes Zertifikat in `LocalMachine\My` an und gibt den Fingerabdruck zurück.
/// Ein zweiter Versuch fängt sporadische Fehler der Schlüsselablage ab; der Test prüft den Export.
fn new_store_cert(dns_name: &str, export_policy: &str) -> String {
    let script = format!(
        "(New-SelfSignedCertificate -CertStoreLocation Cert:\\LocalMachine\\My \
         -DnsName '{dns_name}' -KeyExportPolicy {export_policy} -KeyAlgorithm RSA -KeyLength 2048 \
         -NotAfter (Get-Date).AddDays(30)).Thumbprint"
    );
    let first = powershell(&script);
    if first.status.success() {
        return String::from_utf8_lossy(&first.stdout).trim().to_owned();
    }
    eprintln!(
        "New-SelfSignedCertificate, erster Versuch: {}",
        String::from_utf8_lossy(&first.stderr)
    );
    powershell_text(&script)
}

fn remove_store_cert(thumbprint: &str) {
    powershell(&format!(
        "Remove-Item -LiteralPath Cert:\\LocalMachine\\My\\{thumbprint} -DeleteKey"
    ));
}

#[test]
#[ignore = "ändert LocalMachine\\My und braucht Administratorrechte; CI: --include-ignored"]
fn cert_store_exports_exportable_key() {
    let _store = STORE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let thumbprint = new_store_cert("export.lpd-test.localhost", "Exportable");

    let listed = cert_store::list().unwrap();
    let exported = cert_store::export(&thumbprint.to_lowercase());
    remove_store_cert(&thumbprint);

    let entry = listed
        .iter()
        .find(|cert| cert.thumbprint == thumbprint)
        .expect("Zertifikat fehlt in der Liste");
    assert!(entry.has_private_key);
    assert_eq!(entry.subject, "export.lpd-test.localhost");

    let material = exported.unwrap();
    assert!(tls::key_matches(&material).unwrap());
    let info = tls::inspect(&material.chain_pem).unwrap();
    assert_eq!(info.thumbprint_sha1, thumbprint);
    assert_eq!(info.dns_names, ["export.lpd-test.localhost"]);
    assert!(material.key_pem.expose().contains("BEGIN PRIVATE KEY"));
}

#[test]
#[ignore = "ändert LocalMachine\\My und braucht Administratorrechte; CI: --include-ignored"]
fn cert_store_reports_non_exportable_key() {
    let _store = STORE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let thumbprint = new_store_cert("locked.lpd-test.localhost", "NonExportable");

    let exported = cert_store::export(&thumbprint);
    remove_store_cert(&thumbprint);

    let error = exported.unwrap_err();
    assert_eq!(error, PlatformError::NotExportable);
    assert_eq!(error.code(), "certificate_not_exportable");
}

// ---------------------------------------------------------------------------------------------
// SQLite-Ordner
// ---------------------------------------------------------------------------------------------

/// Der eigene Ordner unter einem Testordner, mit Datei.
fn custom_sqlite(dir: &TempDir) -> std::path::PathBuf {
    dir.path().join("eigene").join("db").join("pds.db")
}

/// Ein Testordner außerhalb von `C:\Users`: Unter einem Benutzerprofil (dort liegt TEMP) lehnt die
/// Prüfung jede eigene Datenbank ab.
fn outside_profiles() -> TempDir {
    let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_owned());
    tempfile::Builder::new()
        .prefix("pds-sqlite-")
        .tempdir_in(format!(r"{system}\"))
        .unwrap()
}

#[test]
fn prepare_sqlite_creates_a_missing_custom_dir_protected() {
    if skip_unless_elevated() {
        return;
    }
    let dir = outside_profiles();
    let paths = data_paths(&dir);
    let file = custom_sqlite(&dir);

    let outcome = prepare_sqlite_dir_for_sid(&paths, &file, STAND_IN_SID).unwrap();

    let folder = file.parent().unwrap();
    assert_eq!(outcome.created.as_deref(), Some(folder));
    assert!(outcome.granted.is_empty(), "{outcome:?}");
    assert_protected(folder, WRITABLE_ACES);
    // Idempotent: Der Eintrag ist schon da
    let again = prepare_sqlite_dir_for_sid(&paths, &file, STAND_IN_SID).unwrap();
    assert_eq!(again.created, None);
    assert!(again.granted.is_empty(), "{again:?}");
}

#[test]
fn prepare_sqlite_adds_modify_to_an_existing_dir_and_files() {
    if skip_unless_elevated() {
        return;
    }
    let dir = outside_profiles();
    let paths = data_paths(&dir);
    let file = custom_sqlite(&dir);
    let folder = file.parent().unwrap().to_owned();
    fs::create_dir_all(&folder).unwrap();
    // Eine hineinverschobene Datenbank samt WAL (ohne den Eintrag, den neue Dateien erben würden)
    fs::write(&file, "x").unwrap();
    fs::write(folder.join("pds.db-wal"), "x").unwrap();
    let before = explicit_aces(&sddl(&folder));

    let outcome = prepare_sqlite_dir_for_sid(&paths, &file, STAND_IN_SID).unwrap();

    assert_eq!(outcome.created, None);
    assert_eq!(
        outcome.granted,
        [folder.clone(), file.clone(), folder.join("pds.db-wal")]
    );
    // Der Ordner behält seine Einträge und Vererbung, dazu Ändern für das Konto
    let after = sddl(&folder);
    assert!(after.contains("(A;OICI;0x1301bf;;;NS)"), "{after}");
    assert!(!after.contains("D:P"), "Vererbung bleibt: {after}");
    for ace in before {
        assert!(after.contains(&ace), "{ace} fehlt: {after}");
    }
    assert!(
        sddl(&file).contains("(A;;0x1301bf;;;NS)"),
        "{}",
        sddl(&file)
    );
    // Idempotent
    let again = prepare_sqlite_dir_for_sid(&paths, &file, STAND_IN_SID).unwrap();
    assert!(again.granted.is_empty(), "{again:?}");
}

#[test]
fn prepare_sqlite_refuses_a_junction() {
    if skip_unless_elevated() {
        return;
    }
    let dir = outside_profiles();
    let paths = data_paths(&dir);
    let target = dir.path().join("ziel");
    fs::create_dir_all(&target).unwrap();
    let file = custom_sqlite(&dir);
    fs::create_dir_all(file.parent().unwrap().parent().unwrap()).unwrap();
    junction(file.parent().unwrap(), &target);
    let before = sddl(&target);

    let error = prepare_sqlite_dir_for_sid(&paths, &file, STAND_IN_SID).unwrap_err();

    assert!(error.to_string().contains("Verweis"), "{error}");
    assert_eq!(sddl(&target), before, "Ziel unberührt");
}

#[test]
fn prepare_sqlite_creates_the_default_dir_like_the_others() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let paths = data_paths(&dir);
    secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();
    fs::remove_dir(paths.sqlite_dir()).unwrap();

    let outcome =
        prepare_sqlite_dir_for_sid(&paths, &paths.default_sqlite_file(), STAND_IN_SID).unwrap();

    assert_eq!(outcome.created, Some(paths.sqlite_dir()));
    assert_secured_tree(&paths);
}

#[test]
fn drive_kind_of_the_system_drive_is_local() {
    let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_owned());
    let path = std::path::PathBuf::from(format!(r"{system}\PDS\pds.db"));
    assert_eq!(
        pds_common::platform::drive_kind(&path),
        pds_common::platform::DriveKind::Local
    );
    assert_eq!(
        pds_common::platform::drive_kind(std::path::Path::new(r"relativ\pds.db")),
        pds_common::platform::DriveKind::Unknown
    );
}

// Ein Verweis mitten im Pfad: Geprüft wird, wohin er führt, und dort wird nichts geändert
#[test]
fn prepare_sqlite_resolves_junctions_in_the_middle() {
    if skip_unless_elevated() {
        return;
    }
    let dir = outside_profiles();
    let paths = data_paths(&dir);
    let windows = std::path::PathBuf::from(
        std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned()),
    );
    let link = dir.path().join("link");
    junction(&link, &windows);
    let system32 = windows.join("System32");
    let before = sddl(&system32);

    // Vorhandener Ordner hinter dem Verweis
    let file = link.join("System32").join("pds.db");
    let error = prepare_sqlite_dir_for_sid(&paths, &file, STAND_IN_SID).unwrap_err();
    assert!(error.to_string().contains("tatsächlich"), "{error}");
    assert_eq!(sddl(&system32), before, "System32 unverändert");

    // Fehlender Ordner hinter dem Verweis: wird gar nicht erst angelegt
    let name = format!("pds-test-{}", std::process::id());
    let error = prepare_sqlite_dir_for_sid(&paths, &link.join(&name).join("pds.db"), STAND_IN_SID)
        .unwrap_err();
    assert!(error.to_string().contains("tatsächlich"), "{error}");
    assert!(!windows.join(&name).exists());
}

// Ein Kurzname (8.3) führt in den Programmordner
#[test]
fn prepare_sqlite_resolves_short_names() {
    if skip_unless_elevated() {
        return;
    }
    let dir = outside_profiles();
    let paths = data_paths(&dir);
    let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_owned());
    let name = format!("pds-test-{}", std::process::id());
    let file = std::path::PathBuf::from(format!(r"{system}\PROGRA~1\{name}\pds.db"));

    let error = prepare_sqlite_dir_for_sid(&paths, &file, STAND_IN_SID).unwrap_err();

    // Mit 8.3-Namen löst Windows PROGRA~1 auf, sonst lehnt schon die Form den Kurznamen ab
    assert!(error.to_string().contains("tatsächlich"), "{error}");
    let program_files = std::path::PathBuf::from(format!(r"{system}\Program Files"));
    assert!(!program_files.join(&name).exists());
}

// Ist data\ ein Verweis, bleibt er, wie er ist: Beiseite gelegt, liefe der Dienst mit leerer Datenbank
#[test]
fn secure_data_dir_refuses_a_junction_as_sqlite_dir() {
    if skip_unless_elevated() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let paths = data_paths(&dir);
    secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap();
    let target = dir.path().join("ziel");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("pds.db"), "x").unwrap();
    fs::remove_dir(paths.sqlite_dir()).unwrap();
    junction(&paths.sqlite_dir(), &target);
    let before = sddl(&target);

    let error = secure_data_dir_for_sid(&paths, STAND_IN_SID).unwrap_err();

    assert!(
        error.to_string().contains("nicht beiseite gelegt"),
        "{error}"
    );
    assert!(is_reparse_point(&paths.sqlite_dir()), "Verweis bleibt");
    assert_eq!(names(&target), ["pds.db"]);
    assert_eq!(sddl(&target), before, "Ziel unberührt");
    assert!(
        !names(&paths.data_dir)
            .iter()
            .any(|name| name.contains("unsicher")),
        "{:?}",
        names(&paths.data_dir)
    );
}
