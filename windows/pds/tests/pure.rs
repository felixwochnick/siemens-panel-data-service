//! Reine Bausteine des Supervisors: Klassifizierung, Backoff, Schwärzen und Zeilenpuffer.

use std::borrow::Cow;
use std::time::Duration;

use pds::supervisor::{
    Backoff, ChildKind, ExitClass, Redactor, TailBuffer, classify_exit, shorten_message,
};

fn lines(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|line| (*line).to_owned()).collect()
}

fn retry(message: &str) -> ExitClass {
    ExitClass::Retry(message.to_owned())
}

// ---------------------------------------------------------------------------------------------
// Klassifizierung
// ---------------------------------------------------------------------------------------------

#[test]
fn classify_config() {
    let tail = lines(&["[config] NUXT_APP_SECRET muss mindestens 32 Zeichen lang sein"]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        ExitClass::ConfigError("NUXT_APP_SECRET muss mindestens 32 Zeichen lang sein".to_owned())
    );
}

#[test]
fn classify_config_uses_first_config_line_amid_other_output() {
    let tail = lines(&[
        "Nitro server starting",
        "[config] NUXT_DATABASE_URL fehlt; NUXT_APP_SECRET fehlt",
        "weiteres",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        ExitClass::ConfigError("NUXT_DATABASE_URL fehlt; NUXT_APP_SECRET fehlt".to_owned())
    );
}

#[test]
fn classify_config_ignores_carriage_return() {
    // Unter Windows bleibt bei CRLF-Ausgabe ein `\r` am Zeilenende übrig.
    let tail = lines(&["[config] NUXT_APP_SECRET fehlt\r"]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        ExitClass::ConfigError("NUXT_APP_SECRET fehlt".to_owned())
    );
}

#[test]
fn classify_config_must_start_the_line() {
    // Nur der Zeilenanfang zählt, ein Zitat mitten im Text ist kein Konfigurationsfehler.
    let tail = lines(&["Fehler: [config] steht nur im Text"]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Anwendung beendet (Exit-Code 1): Fehler: [config] steht nur im Text")
    );
}

#[test]
fn classify_config_wins_over_db() {
    let tail = lines(&["[db] Datenbankmigration fehlgeschlagen", "[config] kaputt"]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        ExitClass::ConfigError("kaputt".to_owned())
    );
}

#[test]
fn classify_config_applies_only_to_the_app() {
    let tail = lines(&["[config] kaputt"]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &tail),
        retry("Proxy beendet (Exit-Code 1): [config] kaputt")
    );
}

#[test]
fn classify_db() {
    let tail = lines(&[
        "[db] Datenbankmigration fehlgeschlagen",
        "ConnectionError: Failed to connect to sql:1433",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit: ConnectionError: Failed to connect to sql:1433")
    );
}

#[test]
fn classify_db_is_never_a_config_error() {
    // Boot ohne erreichbaren SQL Server: später startet der Dienst von selbst.
    let tail = lines(&[
        "[db] Datenbankmigration fehlgeschlagen",
        "ConnectionError: Failed to connect to sql:1433 in 15000ms",
    ]);

    assert!(matches!(
        classify_exit(ChildKind::App, Some(1), &tail),
        ExitClass::Retry(_)
    ));
}

#[test]
fn classify_sqlite_failures_explain_the_cause() {
    // So schreibt Node einen Fehler von `node:sqlite` hinter den Festtext, mit Code darunter
    let cases = [
        (
            "unable to open database file",
            "NT SERVICE\\pds dort kein „Ändern“",
        ),
        ("attempt to write a readonly database", "schreibgeschützt"),
        ("database is locked", "von einem anderen Programm gesperrt"),
        (
            "database table is locked",
            "von einem anderen Programm gesperrt",
        ),
        ("disk I/O error", "Ein-/Ausgabefehler"),
        ("database or disk is full", "kein Platz mehr"),
        ("file is not a database", "keine SQLite-Datenbank"),
        ("database disk image is malformed", "beschädigt"),
    ];
    for (sqlite, expected) in cases {
        let tail = lines(&[
            &format!("[db] Datenbankmigration fehlgeschlagen Error: {sqlite}"),
            "    at DatabaseSync.exec (node:internal/sqlite:1:1) {",
            "  code: 'ERR_SQLITE_ERROR',",
            "}",
        ]);
        match classify_exit(ChildKind::App, Some(1), &tail) {
            // Nie ein Konfigurationsfehler: Sperren und Rechte lassen sich beheben, ohne die
            // Konfiguration zu ändern
            ExitClass::Retry(message) => {
                assert!(
                    message.starts_with("Datenbank nicht bereit (SQLite): "),
                    "{message}"
                );
                assert!(message.contains(expected), "{sqlite}: {message}");
            }
            other => panic!("{sqlite}: {other:?}"),
        }
    }
}

#[test]
fn classify_sqlite_failure_outside_the_migration() {
    let tail = lines(&[
        "Error: database is locked",
        "    at handler (file:///C:/Program Files/app/server/index.mjs:1:2)",
        "Node.js v24.12.0",
    ]);

    let ExitClass::Retry(message) = classify_exit(ChildKind::App, Some(1), &tail) else {
        panic!("kein Retry");
    };
    assert!(message.contains("gesperrt"), "{message}");
}

#[test]
fn classify_sqlite_missing_folder_without_rights() {
    let tail = lines(&[
        r"[db] Datenbankmigration fehlgeschlagen Error: EPERM: operation not permitted, mkdir 'D:\PDS'",
    ]);

    let ExitClass::Retry(message) = classify_exit(ChildKind::App, Some(1), &tail) else {
        panic!("kein Retry");
    };
    assert!(message.contains("darf ihn nicht anlegen"), "{message}");
}

#[test]
fn classify_db_skips_empty_lines_after_the_marker() {
    let tail = lines(&[
        "[db] Datenbankmigration fehlgeschlagen",
        "",
        "   ",
        "ESOCKET",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit: ESOCKET")
    );
}

#[test]
fn classify_db_marker_may_sit_inside_a_line() {
    // `console.error('[db] …', error)` setzt Präfixe oder Zeitstempel davor.
    let tail = lines(&["12:00:01 [db] Datenbankmigration fehlgeschlagen", "ESOCKET"]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit: ESOCKET")
    );
}

#[test]
fn classify_db_cause_on_the_same_line() {
    // So schreibt Node `console.error('[db] …', error)`: die Meldung steht hinter dem Festtext,
    // danach folgen Stack-Zeilen.
    let tail = lines(&[
        "[db] Datenbankmigration fehlgeschlagen Error: Migration core/? fehlgeschlagen: Failed to connect to 127.0.0.1:1 - Could not connect (sequence)",
        "    at migrateDatabase (file:///C:/Program Files/EPLAN Panel Data Service/app/server/index.mjs:1:2)",
        "    at async file:///C:/Program Files/EPLAN Panel Data Service/app/server/index.mjs:3:4 {",
        "  [cause]: ConnectionError: Failed to connect to 127.0.0.1:1",
        "}",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry(
            "Datenbank nicht bereit: Migration core/? fehlgeschlagen: Failed to connect to 127.0.0.1:1 - Could not connect (sequence)"
        )
    );
}

#[test]
fn classify_db_same_line_keeps_other_error_names() {
    // Nur ein führendes "Error: " fällt weg, "ConnectionError: " bleibt.
    let tail = lines(&[
        "[db] Datenbankmigration fehlgeschlagen ConnectionError: Failed to connect to sql:1433\r",
        "    at connect (x)",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit: ConnectionError: Failed to connect to sql:1433")
    );
}

#[test]
fn classify_db_same_line_wins_over_the_next_line() {
    let tail = lines(&[
        "[db] Datenbankmigration fehlgeschlagen Error: ESOCKET",
        "weitere Zeile",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit: ESOCKET")
    );
}

#[test]
fn classify_db_error_prefix_alone_falls_back_to_the_next_line() {
    // Nach dem Festtext bleibt nach dem Entfernen von "Error: " nichts übrig.
    let tail = lines(&[
        "[db] Datenbankmigration fehlgeschlagen Error:",
        "ConnectionError: x",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit: ConnectionError: x")
    );
}

#[test]
fn classify_db_next_line_skips_stack_frames() {
    let tail = lines(&[
        "[db] Datenbankmigration fehlgeschlagen",
        "    at migrateDatabase (file:///x:1:2)",
        "at async run (y)",
        "[cause]: ConnectionError: Failed to connect to sql:1433",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit: [cause]: ConnectionError: Failed to connect to sql:1433")
    );
}

#[test]
fn classify_db_next_line_only_skips_real_stack_frames() {
    // "attempt …" beginnt mit "at", ist aber kein Stack-Frame ("at " mit Leerzeichen).
    let tail = lines(&["[db] Datenbankmigration fehlgeschlagen", "attempt failed"]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit: attempt failed")
    );
}

#[test]
fn classify_db_with_only_stack_frames_has_no_cause() {
    let tail = lines(&[
        "[db] Datenbankmigration fehlgeschlagen",
        "    at migrateDatabase (file:///x:1:2)",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit")
    );
}

// Gekürzt wird erst nach dem Schwärzen (im Supervisor), sonst bliebe von einem Secret an der
// Schnittstelle ein Anfang im Klartext stehen. Die Klassifizierung liefert deshalb alles.
#[test]
fn classify_db_same_line_cause_is_complete() {
    let long = "ä".repeat(1000);
    let tail = lines(&[&format!(
        "[db] Datenbankmigration fehlgeschlagen Error: {long}"
    )]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry(&format!("Datenbank nicht bereit: {long}"))
    );
}

#[test]
fn classify_db_without_following_line() {
    let tail = lines(&["[db] Datenbankmigration fehlgeschlagen"]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Datenbank nicht bereit")
    );
    let only_blank_after = lines(&["[db] Datenbankmigration fehlgeschlagen", "", "  "]);
    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &only_blank_after),
        retry("Datenbank nicht bereit")
    );
}

#[test]
fn classify_db_following_line_is_complete() {
    let long = "ä".repeat(1000);
    let tail = lines(&["[db] Datenbankmigration fehlgeschlagen", &long]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry(&format!("Datenbank nicht bereit: {long}"))
    );
}

#[test]
fn classify_config_message_is_complete() {
    let long = "ö".repeat(1000);
    let tail = lines(&[&format!("[config] {long}")]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        ExitClass::ConfigError(long)
    );
}

#[test]
fn shorten_message_cuts_to_300_chars() {
    let long = format!("Datenbank nicht bereit: {}", "ä".repeat(1000));

    let message = shorten_message(&long);

    assert_eq!(message.chars().count(), 300);
    assert!(message.starts_with("Datenbank nicht bereit: ääää"));
    assert!(message.ends_with('…'));
}

#[test]
fn shorten_message_keeps_short_messages() {
    // Genau 300 Zeichen bleiben unverändert.
    let exact = "x".repeat(300);
    assert_eq!(shorten_message(&exact), exact);
    assert_eq!(shorten_message("kurz"), "kurz");
}

#[test]
fn classify_db_applies_only_to_the_app() {
    let tail = lines(&["[db] irgendwas"]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &tail),
        retry("Proxy beendet (Exit-Code 1): [db] irgendwas")
    );
}

#[test]
fn classify_port_windows() {
    let tail = lines(&[
        "Error: loading initial config: loading new config: http app module: start: listening on :443: listen tcp :443: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.",
    ]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &tail),
        retry("Port 443 ist bereits belegt (z. B. durch IIS/http.sys)")
    );
}

#[test]
fn classify_port_windows_access_forbidden() {
    // WSAEACCES: http.sys oder eine Ausschlussliste hält den Port.
    let tail = lines(&[
        "Error: loading initial config: listen tcp :80: bind: An attempt was made to access a socket in a way forbidden by its access permissions.",
    ]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &tail),
        retry("Port 80 ist bereits belegt (z. B. durch IIS/http.sys)")
    );
}

#[test]
fn classify_port_linux_address_in_use() {
    let tail = lines(&["Error: listen tcp :8443: bind: address already in use"]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &tail),
        retry("Port 8443 ist bereits belegt (z. B. durch IIS/http.sys)")
    );
}

#[test]
fn classify_port_with_host_in_the_address() {
    let tail = lines(&["Error: listen tcp 127.0.0.1:9443: bind: address already in use"]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &tail),
        retry("Port 9443 ist bereits belegt (z. B. durch IIS/http.sys)")
    );
}

#[test]
fn classify_port_inside_a_json_log_line() {
    let tail = lines(&[
        r#"{"level":"error","msg":"loading initial config: listen tcp :443: bind: address already in use"}"#,
    ]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &tail),
        retry("Port 443 ist bereits belegt (z. B. durch IIS/http.sys)")
    );
}

#[test]
fn classify_port_is_found_among_other_lines() {
    let tail = lines(&[
        "{\"level\":\"info\",\"msg\":\"using config from stdin\"}",
        "",
        "Error: listen tcp :443: bind: address already in use",
        "exit status 1",
    ]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &tail),
        retry("Port 443 ist bereits belegt (z. B. durch IIS/http.sys)")
    );
}

#[test]
fn classify_port_needs_bind_and_a_known_text() {
    // Ohne `bind:` oder ohne bekannten Text bleibt es ein gewöhnlicher Abbruch.
    let no_bind = lines(&["Error: dial tcp :443: address already in use"]);
    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &no_bind),
        retry("Proxy beendet (Exit-Code 1): Error: dial tcp :443: address already in use")
    );
    let other_text = lines(&["Error: listen tcp :443: bind: permission denied"]);
    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &other_text),
        retry("Proxy beendet (Exit-Code 1): Error: listen tcp :443: bind: permission denied")
    );
}

#[test]
fn classify_port_without_parsable_port_still_names_the_cause() {
    let tail = lines(&["Error: bind: address already in use"]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &tail),
        retry("Port ist bereits belegt (z. B. durch IIS/http.sys)")
    );
}

#[test]
fn classify_port_applies_only_to_the_proxy() {
    let tail = lines(&["Error: listen tcp :3000: bind: address already in use"]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry(
            "Anwendung beendet (Exit-Code 1): Error: listen tcp :3000: bind: address already in use"
        )
    );
}

#[test]
fn classify_other() {
    let tail = lines(&["starte", "", "TypeError: boom", "   "]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(2), &tail),
        retry("Anwendung beendet (Exit-Code 2): TypeError: boom")
    );
    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(3), &tail),
        retry("Proxy beendet (Exit-Code 3): TypeError: boom")
    );
}

#[test]
fn classify_other_skips_node_stack_and_version() {
    // So endet Node nach einer unbehandelten Ausnahme: Fehlerzeile, Stacktrace, Version
    let tail = lines(&[
        "file:///C:/Program%20Files/EPLAN%20Smart%20Wiring%20Controller/app/server/index.mjs:12",
        "    throw new Error('boom');",
        "    ^",
        "",
        "Error: boom",
        "    at main (file:///C:/app/server/index.mjs:12:11)",
        "    at async run (node:internal/modules/esm/module_job:271:25)",
        "",
        "Node.js v24.11.1",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Anwendung beendet (Exit-Code 1): Error: boom")
    );
}

#[test]
fn classify_other_skips_punctuation_only_lines() {
    let tail = lines(&[
        "Error: connect ECONNREFUSED 127.0.0.1:1433",
        "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16) {",
        "  code: 'ECONNREFUSED'",
        "}",
        "",
        "Node.js v24.11.1",
    ]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Anwendung beendet (Exit-Code 1): code: 'ECONNREFUSED'")
    );
}

#[test]
fn classify_other_with_only_noise_has_no_detail() {
    let tail = lines(&["    at x (y:1:2)", "}", "Node.js v24.11.1"]);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &tail),
        retry("Anwendung beendet (Exit-Code 1)")
    );
    // Nur am Zeilenanfang: Mitten im Text bleibt „at “ eine gewöhnliche Meldung
    assert_eq!(
        classify_exit(ChildKind::Proxy, Some(1), &lines(&["look at this"])),
        retry("Proxy beendet (Exit-Code 1): look at this")
    );
}

#[test]
fn classify_other_without_exit_code() {
    // Unter Windows kann ein Prozess ohne Code enden (z. B. beendet durch ein Signal des Systems).
    let tail = lines(&["abgebrochen"]);

    assert_eq!(
        classify_exit(ChildKind::Proxy, None, &tail),
        retry("Proxy beendet (Exit-Code unbekannt): abgebrochen")
    );
}

#[test]
fn classify_other_without_output() {
    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &[]),
        retry("Anwendung beendet (Exit-Code 1)")
    );
    assert_eq!(
        classify_exit(ChildKind::App, None, &lines(&["", "  "])),
        retry("Anwendung beendet (Exit-Code unbekannt)")
    );
}

#[test]
fn classify_other_with_negative_exit_code() {
    // Windows liefert Fehlercodes wie 0xC0000005 als negative i32.
    assert_eq!(
        classify_exit(ChildKind::App, Some(-1073741819), &lines(&["x"])),
        retry("Anwendung beendet (Exit-Code -1073741819): x")
    );
}

#[test]
fn classify_other_keeps_very_long_lines() {
    let long = "ü".repeat(2000);

    assert_eq!(
        classify_exit(ChildKind::App, Some(1), &lines(&[&long])),
        retry(&format!("Anwendung beendet (Exit-Code 1): {long}"))
    );
}

// ---------------------------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------------------------

fn secs(seconds: u64) -> Duration {
    Duration::from_secs(seconds)
}

#[test]
fn backoff_sequence() {
    let mut backoff = Backoff::new(secs(2), secs(300));

    // Jitter 0,5 ergibt den Faktor 1,0: die reine Folge.
    let delays: Vec<Duration> = (0..11).map(|_| backoff.next_delay(0.5)).collect();

    let expected: Vec<Duration> = [2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]
        .into_iter()
        .map(secs)
        .collect();
    assert_eq!(delays, expected);

    backoff.reset();
    assert_eq!(backoff.next_delay(0.5), secs(2));
    assert_eq!(backoff.next_delay(0.5), secs(4));
}

#[test]
fn backoff_counts_attempts() {
    let mut backoff = Backoff::new(secs(2), secs(300));
    assert_eq!(backoff.attempts(), 0);

    backoff.next_delay(0.5);
    backoff.next_delay(0.5);
    assert_eq!(backoff.attempts(), 2);

    backoff.reset();
    assert_eq!(backoff.attempts(), 0);
}

#[test]
fn jitter_bounds() {
    let mut low = Backoff::new(secs(10), secs(300));
    let mut high = Backoff::new(secs(10), secs(300));

    assert_eq!(low.next_delay(0.0), Duration::from_millis(8_000));
    assert_eq!(high.next_delay(1.0), Duration::from_millis(12_000));
    // Zweiter Schritt: der Jitter wirkt auf den verdoppelten Wert, nicht kumulativ.
    assert_eq!(low.next_delay(0.0), Duration::from_millis(16_000));
    assert_eq!(high.next_delay(1.0), Duration::from_millis(24_000));
}

#[test]
fn backoff_sequence_with_max_jitter_is_capped_at_max() {
    // Jitter 1,0 ergibt 1,2·d, aber nie mehr als `max`: 256 s · 1,2 = 307,2 s wird 300 s.
    let mut backoff = Backoff::new(secs(2), secs(300));

    let delays: Vec<Duration> = (0..10).map(|_| backoff.next_delay(1.0)).collect();

    let expected: Vec<Duration> = [
        2_400, 4_800, 9_600, 19_200, 38_400, 76_800, 153_600, 300_000, 300_000, 300_000,
    ]
    .into_iter()
    .map(Duration::from_millis)
    .collect();
    assert_eq!(delays, expected);
}

#[test]
fn jitter_at_the_cap_never_exceeds_max() {
    let max = secs(300);
    let mut low = Backoff::new(secs(2), max);
    let mut high = Backoff::new(secs(2), max);
    let mut over_range = Backoff::new(secs(2), max);

    // Bis weit über den Deckel hinaus.
    for _ in 0..20 {
        low.next_delay(0.0);
        high.next_delay(1.0);
        over_range.next_delay(9.0);
    }

    assert_eq!(low.next_delay(0.0), secs(240), "0,8 · 300 s");
    assert_eq!(
        high.next_delay(1.0),
        max,
        "1,2 · 300 s wird auf max begrenzt"
    );
    assert_eq!(over_range.next_delay(9.0), max);
}

#[test]
fn delay_never_exceeds_max_for_any_jitter() {
    for jitter in [
        -1.0,
        0.0,
        0.25,
        0.5,
        0.75,
        1.0,
        2.0,
        f64::NAN,
        f64::INFINITY,
    ] {
        let mut backoff = Backoff::new(secs(2), secs(300));
        for _ in 0..40 {
            assert!(backoff.next_delay(jitter) <= secs(300), "jitter {jitter}");
        }
    }
}

#[test]
fn jitter_is_linear() {
    let mut backoff = Backoff::new(secs(10), secs(300));

    // 0,8 + 0,4 · 0,25 = 0,9
    assert_eq!(backoff.next_delay(0.25), Duration::from_millis(9_000));
}

#[test]
fn jitter_is_clamped() {
    let mut below = Backoff::new(secs(10), secs(300));
    let mut above = Backoff::new(secs(10), secs(300));

    assert_eq!(below.next_delay(-5.0), Duration::from_millis(8_000));
    assert_eq!(above.next_delay(7.5), Duration::from_millis(12_000));
}

#[test]
fn jitter_nan_does_not_panic() {
    let mut backoff = Backoff::new(secs(10), secs(300));

    let delay = backoff.next_delay(f64::NAN);

    assert!(delay >= Duration::from_millis(8_000) && delay <= Duration::from_millis(12_000));
}

#[test]
fn backoff_stays_at_the_cap_without_overflow() {
    let mut backoff = Backoff::new(secs(2), secs(300));

    let last = (0..10_000).map(|_| backoff.next_delay(0.5)).last().unwrap();

    assert_eq!(last, secs(300));
    assert_eq!(backoff.attempts(), 10_000);
}

#[test]
fn backoff_base_above_max_is_capped() {
    let mut backoff = Backoff::new(secs(10), secs(5));

    assert_eq!(backoff.next_delay(0.5), secs(5));
    // Auch mit Jitter bleibt es unter `max`.
    assert_eq!(backoff.next_delay(1.0), secs(5));
    assert_eq!(backoff.next_delay(0.0), secs(4));
}

// ---------------------------------------------------------------------------------------------
// Schwärzen
// ---------------------------------------------------------------------------------------------

fn redactor(values: &[&str]) -> Redactor {
    Redactor::new(values.iter().map(|value| (*value).to_owned()))
}

#[test]
fn redact_replaces_secrets() {
    let redactor = redactor(&["s3cret-pass"]);

    assert_eq!(
        redactor.redact("login mit s3cret-pass und nochmal s3cret-pass"),
        "login mit *** und nochmal ***"
    );
}

#[test]
fn redact_longest_first() {
    // Wäre der kurze Wert zuerst dran, bliebe "1234" des langen Werts stehen.
    let redactor = redactor(&["abcd", "abcd1234"]);

    assert_eq!(redactor.redact("pw=abcd1234 ok"), "pw=*** ok");
    assert_eq!(redactor.redact("pw=abcd ok"), "pw=*** ok");
}

#[test]
fn redact_overlapping_secrets_leave_no_rest() {
    // Die Werte überlappen sich in der Zeile: kein Rest darf stehen bleiben.
    let redactor = redactor(&["abcd1234", "1234wxyz"]);

    assert_eq!(redactor.redact("x abcd1234wxyz y"), "x *** y");
}

#[test]
fn redact_overlapping_occurrences_of_the_same_secret() {
    let redactor = redactor(&["aaaa"]);

    assert_eq!(redactor.redact("aaaaaaa"), "***");
}

#[test]
fn redact_ignores_short() {
    // Unter vier Zeichen würde fast jede Zeile getroffen und unlesbar.
    let redactor = redactor(&["abc", "xy", "", "äöü"]);

    let line = "abc xy äöü bleibt";
    assert!(matches!(redactor.redact(line), Cow::Borrowed(text) if text == line));
}

#[test]
fn redact_counts_characters_not_bytes() {
    // Vier Zeichen, auch wenn es acht Bytes sind.
    let redactor = redactor(&["äöüß"]);

    assert_eq!(redactor.redact("pw=äöüß!"), "pw=***!");
}

#[test]
fn redact_four_characters_is_enough() {
    let redactor = redactor(&["pw12"]);

    assert_eq!(redactor.redact("a pw12 b"), "a *** b");
}

#[test]
fn redact_without_match_borrows() {
    let redactor = redactor(&["geheimnis"]);

    assert!(matches!(
        redactor.redact("nichts zu sehen"),
        Cow::Borrowed(_)
    ));
}

#[test]
fn redact_without_values_borrows() {
    let redactor = Redactor::new(Vec::<String>::new());

    assert!(matches!(
        redactor.redact("alles sichtbar"),
        Cow::Borrowed(_)
    ));
}

#[test]
fn redact_special_characters_are_literal() {
    // Keine Muster: Zeichen wie `*`, `.` und `$` in Passwörtern sind wörtlich gemeint.
    let redactor = redactor(&["p.*$'%@:/#?x", "a b c d"]);

    assert_eq!(redactor.redact("url=p.*$'%@:/#?x;"), "url=***;");
    assert_eq!(redactor.redact("pa.*$'%@:/#?x"), "pa.*$'%@:/#?x");
    assert_eq!(redactor.redact("t: a b c d."), "t: ***.");
}

#[test]
fn redact_deduplicates_and_survives_utf8_boundaries() {
    let redactor = redactor(&["pässwörd", "pässwörd", "ß🔑ß🔑"]);

    // Mehrbyte-Zeichen vor, in und nach dem Treffer; keine Panik an Zeichengrenzen.
    assert_eq!(
        redactor.redact("🔑pässwörd🔑 und ß🔑ß🔑ß🔑ß🔑"),
        "🔑***🔑 und ***"
    );
}

#[test]
fn redact_never_panics_on_odd_input() {
    let redactor = redactor(&["geheim-wert"]);

    for line in [
        "",
        " ",
        "\u{0}",
        "\r\n",
        "🔑",
        "geheim-we",
        "geheim-wert",
        "ä",
    ] {
        let _ = redactor.redact(line);
    }
    assert_eq!(redactor.redact("geheim-wert"), "***");
}

#[test]
fn redactor_debug_does_not_leak_values() {
    let redactor = redactor(&["s3cret-pass"]);

    assert!(!format!("{redactor:?}").contains("s3cret"));
}

// ---------------------------------------------------------------------------------------------
// Zeilenpuffer
// ---------------------------------------------------------------------------------------------

#[test]
fn tail_debug_hides_lines() {
    // Der Puffer hält ungeschwärzte Zeilen; `{:?}` darf sie nie zeigen
    let mut tail = TailBuffer::new(50);
    tail.push("Login mit Geheim-Pa55wort".to_owned());

    let debug = format!("{tail:?}");

    assert!(!debug.contains("Geheim"), "{debug}");
    assert!(debug.contains("TailBuffer"), "{debug}");
}

#[test]
fn tail_keeps_last_50() {
    let mut tail = TailBuffer::new(50);

    for index in 0..120 {
        tail.push(format!("zeile {index}"));
    }

    let kept = tail.lines();
    assert_eq!(kept.len(), 50);
    assert_eq!(kept.first().unwrap(), "zeile 70");
    assert_eq!(kept.last().unwrap(), "zeile 119");
}

#[test]
fn tail_below_capacity_keeps_everything_in_order() {
    let mut tail = TailBuffer::new(50);
    assert!(tail.lines().is_empty());

    tail.push("a".to_owned());
    tail.push("b".to_owned());

    assert_eq!(tail.lines(), ["a", "b"]);
    // Lesen verbraucht nichts.
    assert_eq!(tail.lines(), ["a", "b"]);
}

#[test]
fn tail_with_zero_capacity_keeps_nothing() {
    let mut tail = TailBuffer::new(0);

    tail.push("a".to_owned());

    assert!(tail.lines().is_empty());
}
