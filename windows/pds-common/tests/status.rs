//! Dienststatus: Rundlauf, Veralterung (Heartbeat) und Verhalten bei fehlender oder kaputter Datei.

use std::fs;
use std::time::Duration;

use pds_common::status::{
    ChildStatus, ErrorInfo, HEARTBEAT_INTERVAL, HealthStatus, ServiceState, Status, StatusError,
    is_stale, read, write,
};
use pds_common::validate::{Finding, Severity};
use tempfile::TempDir;
use time::OffsetDateTime;

fn at(seconds: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(seconds).unwrap()
}

/// Ein Status mit allen optionalen Feldern gesetzt, damit der Rundlauf jedes Feld berührt.
fn full_status() -> Status {
    Status {
        state: ServiceState::Backoff,
        since: at(1_800_000_000),
        heartbeat: at(1_800_000_120),
        product_version: "1.2.3".into(),
        node_version: "22.11.0".into(),
        caddy_version: "2.8.4".into(),
        health: Some(HealthStatus {
            ok: false,
            checked_at: at(1_800_000_110),
            message: Some("HTTP 500".into()),
        }),
        last_error: Some(ErrorInfo {
            at: at(1_800_000_100),
            source: "proxy".into(),
            message: "Port 443 ist bereits belegt (z. B. durch IIS/http.sys)".into(),
        }),
        next_attempt: Some(at(1_800_000_130)),
        findings: vec![Finding {
            field: "db.server".into(),
            code: "db_server_missing".into(),
            message: "Der Datenbankserver fehlt.".into(),
            severity: Severity::Error,
        }],
        certificate_not_after: Some(at(1_900_000_000)),
        app: ChildStatus {
            pid: Some(4242),
            running: true,
            restarts: 3,
        },
        proxy: ChildStatus {
            pid: None,
            running: false,
            restarts: 7,
        },
    }
}

fn minimal_status(heartbeat: OffsetDateTime) -> Status {
    Status {
        state: ServiceState::Running,
        since: at(0),
        heartbeat,
        product_version: "0.1.0".into(),
        node_version: String::new(),
        caddy_version: String::new(),
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
fn status_roundtrip() {
    let dir = TempDir::new().unwrap();
    // Der Ordner `state` existiert noch nicht: `write` legt ihn an.
    let path = dir.path().join("state").join("status.json");

    write(&path, &full_status()).unwrap();

    assert_eq!(read(&path).unwrap(), Some(full_status()));
}

#[test]
fn status_roundtrip_without_optionals() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("status.json");
    let status = minimal_status(at(1_800_000_000));

    write(&path, &status).unwrap();

    assert_eq!(read(&path).unwrap(), Some(status));
}

#[test]
fn read_accepts_missing_optional_fields() {
    // Ältere oder knappe Dateien ohne `nextAttempt`/`certificateNotAfter` (auch ohne `health`,
    // `lastError`) sind gültig, nicht beschädigt.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("status.json");
    let json = r#"{
        "state": "unconfigured",
        "since": "2026-11-19T10:00:00Z",
        "heartbeat": "2026-11-19T10:00:05Z",
        "productVersion": "0.1.0",
        "nodeVersion": "",
        "caddyVersion": "",
        "findings": [],
        "app": { "pid": null, "running": false, "restarts": 0 },
        "proxy": { "pid": null, "running": false, "restarts": 0 }
    }"#;
    fs::write(&path, json).unwrap();

    let status = read(&path).unwrap().unwrap();

    assert_eq!(status.state, ServiceState::Unconfigured);
    assert_eq!(status.next_attempt, None);
    assert_eq!(status.certificate_not_after, None);
    assert_eq!(status.health, None);
    assert_eq!(status.last_error, None);
}

#[test]
fn json_uses_camel_case_and_rfc3339() {
    let json = serde_json::to_value(full_status()).unwrap();

    assert_eq!(json["state"], "backoff");
    assert_eq!(json["productVersion"], "1.2.3");
    assert_eq!(json["nodeVersion"], "22.11.0");
    assert_eq!(json["caddyVersion"], "2.8.4");
    assert_eq!(json["heartbeat"], "2027-01-15T08:02:00Z");
    assert_eq!(json["nextAttempt"], "2027-01-15T08:02:10Z");
    assert_eq!(json["certificateNotAfter"], "2030-03-17T17:46:40Z");
    assert_eq!(json["health"]["checkedAt"], "2027-01-15T08:01:50Z");
    assert_eq!(json["lastError"]["source"], "proxy");
    assert_eq!(json["app"]["pid"], 4242);
    assert_eq!(json["proxy"]["pid"], serde_json::Value::Null);
    assert_eq!(json["findings"][0]["severity"], "error");
}

#[test]
fn state_names_are_snake_case() {
    let names = [
        (ServiceState::Unconfigured, "unconfigured"),
        (ServiceState::Starting, "starting"),
        (ServiceState::Running, "running"),
        (ServiceState::Backoff, "backoff"),
        (ServiceState::ConfigError, "config_error"),
        (ServiceState::Stopping, "stopping"),
        (ServiceState::Stopped, "stopped"),
    ];
    for (state, name) in names {
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            format!("\"{name}\"")
        );
        assert_eq!(
            serde_json::from_str::<ServiceState>(&format!("\"{name}\"")).unwrap(),
            state
        );
    }
}

#[test]
fn stale_after_30s() {
    let status = minimal_status(at(1_000));

    assert!(!is_stale(&status, at(1_000)), "frisch");
    assert!(!is_stale(&status, at(1_029)), "29 s alt");
    assert!(is_stale(&status, at(1_031)), "31 s alt");
}

#[test]
fn stale_boundary_is_exclusive() {
    // "Älter als 30 s": genau 30 s zählt noch nicht.
    let status = minimal_status(at(1_000));

    assert!(!is_stale(&status, at(1_030)));
}

#[test]
fn heartbeat_in_the_future_is_not_stale() {
    // Uhrsprung rückwärts: nicht fälschlich "Dienst läuft nicht" melden.
    let status = minimal_status(at(2_000));

    assert!(!is_stale(&status, at(1_000)));
}

#[test]
fn heartbeat_interval_is_10s() {
    assert_eq!(HEARTBEAT_INTERVAL, Duration::from_secs(10));
}

#[test]
fn read_missing_is_none() {
    let dir = TempDir::new().unwrap();

    assert_eq!(read(&dir.path().join("status.json")).unwrap(), None);
    // Auch wenn der ganze Ordner fehlt (Dienst nie gelaufen).
    assert_eq!(
        read(&dir.path().join("state").join("status.json")).unwrap(),
        None
    );
}

#[test]
fn read_corrupt_is_error_not_panic() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("status.json");

    for corrupt in ["", "{", "not json", "[]", r#"{"state":"running"}"#] {
        fs::write(&path, corrupt).unwrap();
        assert!(
            matches!(read(&path), Err(StatusError::Corrupt(_))),
            "{corrupt:?}"
        );
    }
}

#[test]
fn read_invalid_utf8_is_error_not_panic() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("status.json");
    fs::write(&path, [0xff, 0xfe, 0x00, 0x7b]).unwrap();

    assert!(read(&path).is_err());
}

#[test]
fn read_unreadable_path_is_io_error() {
    let dir = TempDir::new().unwrap();

    // Ein Ordner statt der Datei: lesbar ist das nicht, aber auch nicht "fehlt".
    assert!(matches!(read(dir.path()), Err(StatusError::Io(_))));
}

#[test]
fn read_ignores_unknown_fields() {
    // UI/CLI und Dienst können in verschiedenen Versionen laufen.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("status.json");
    let mut json = serde_json::to_value(full_status()).unwrap();
    json["futureField"] = serde_json::json!({ "x": 1 });
    fs::write(&path, json.to_string()).unwrap();

    assert_eq!(read(&path).unwrap(), Some(full_status()));
}

#[test]
fn write_replaces_atomically_without_leftovers() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("status.json");

    write(&path, &minimal_status(at(1))).unwrap();
    write(&path, &full_status()).unwrap();

    assert_eq!(read(&path).unwrap(), Some(full_status()));
    let names: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, ["status.json"], "keine Temp-Dateien übrig");
}
