//! Health-Abfrage gegen einen Mini-HTTP-Server im Test.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

use pds_common::health::{ProbeResult, probe_internal, probe_public};

/// Beantwortet genau eine Anfrage mit `status` und liefert Port und die gelesene Anfragezeile.
fn serve_once(status: &'static str) -> (u16, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 4096];
        let read = stream.read(&mut buffer).unwrap();
        let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
        let body = r#"{"status":"ok"}"#;
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
        request.lines().next().unwrap_or_default().to_owned()
    });
    (port, handle)
}

#[test]
fn probe_internal_ok_on_200() {
    let (port, server) = serve_once("200 OK");

    let result = probe_internal(port, Duration::from_secs(5));

    assert!(result.ok, "{result:?}");
    assert_eq!(result.status, Some(200));
    assert!(!result.message.is_empty());
    assert_eq!(server.join().unwrap(), "GET /api/health HTTP/1.1");
}

#[test]
fn probe_internal_fails_on_server_error() {
    let (port, server) = serve_once("503 Service Unavailable");

    let result = probe_internal(port, Duration::from_secs(5));

    assert!(!result.ok);
    assert_eq!(result.status, Some(503));
    assert!(result.message.contains("503"), "{}", result.message);
    server.join().unwrap();
}

#[test]
fn probe_internal_unreachable_port() {
    // Port belegen und wieder freigeben: Danach lauscht dort (sehr wahrscheinlich) niemand
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();

    let result = probe_internal(port, Duration::from_secs(5));

    assert!(!result.ok);
    assert_eq!(result.status, None);
    assert!(
        result.message.starts_with("Nicht erreichbar"),
        "{}",
        result.message
    );
}

#[test]
fn probe_internal_respects_timeout() {
    // Nimmt die Verbindung an, antwortet aber nie
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_millis(1500));
        drop(stream);
    });

    let started = Instant::now();
    let result = probe_internal(port, Duration::from_millis(300));

    assert!(!result.ok);
    // Deutlich vor dem Schließen durch den Server, sonst prüfte der Test nichts
    assert!(started.elapsed() < Duration::from_secs(1), "{result:?}");
    server.join().unwrap();
}

#[cfg(not(windows))]
#[test]
fn probe_public_is_windows_only() {
    assert_eq!(
        probe_public("https://trainee.example.com", Duration::from_secs(1)),
        None
    );
}

#[test]
fn probe_public_without_url_is_none() {
    assert_eq!(probe_public("", Duration::from_secs(1)), None);
}

#[test]
fn probe_result_json_is_camel_case() {
    let result = ProbeResult {
        ok: true,
        status: Some(200),
        message: "HTTP 200".into(),
    };

    let json = serde_json::to_value(&result).unwrap();

    assert_eq!(
        json,
        serde_json::json!({ "ok": true, "status": 200, "message": "HTTP 200" })
    );
}
