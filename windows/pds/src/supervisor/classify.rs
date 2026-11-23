//! Einordnung des Endes eines Kindprozesses: Konfigurationsfehler (nicht neu starten) oder
//! vorübergehender Fehler (nach Wartezeit neu starten).
//!
//! Wichtig ist die Grenze: Nur ein ausdrücklicher `[config]`-Fehler der App stoppt den Neustart.
//! Alles andere, auch eine nicht erreichbare Datenbank, eine gesperrte oder nicht beschreibbare
//! SQLite-Datei oder ein belegter Port, ist `Retry`, damit der Dienst nach einem Boot ohne SQL Server,
//! nach dem Freigeben einer Sperre oder nach dem Korrigieren von Rechten von selbst startet. Die
//! Texte sind für Admins gedacht.
//!
//! Die Meldungen sind ungekürzt und ungeschwärzt. Der Aufrufer schwärzt zuerst und kürzt dann mit
//! [`shorten_message`]; umgekehrt bliebe vom Secret an der Schnittstelle ein Anfang im Klartext.

/// Welcher Kindprozess geendet ist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildKind {
    /// Node mit der App (Web-App, Warteschlange der Analysen und Zeitplaner).
    App,
    /// Caddy.
    Proxy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitClass {
    /// Die App lehnt ihre Konfiguration ab; Neustart sinnlos, bis die Konfiguration geändert wird.
    ConfigError(String),
    /// Vorübergehend oder unbekannt: nach Backoff erneut versuchen.
    Retry(String),
}

/// So viele Zeichen darf eine Meldung höchstens haben (sie landet im Status und in der UI).
pub const MAX_MESSAGE_CHARS: usize = 300;

const CONFIG_PREFIX: &str = "[config] ";
const DB_MARKER: &str = "[db]";
const DB_FAILED_TEXT: &str = "Datenbankmigration fehlgeschlagen";
/// Fehlertexte von SQLite (`sqlite3_errstr`, englisch und stabil), die `node:sqlite` als Meldung
/// trägt, mit dem, was der Admin dagegen tun kann. Das Konto steht ausgeschrieben da, weil die
/// Rechte fast immer die Ursache sind.
const SQLITE_PROBLEMS: [(&str, &str); 8] = [
    (
        "unable to open database file",
        "Die SQLite-Datei lässt sich nicht öffnen: Fehlt der Ordner, oder hat das Dienstkonto \
         NT SERVICE\\pds dort kein „Ändern“? Pfad unter db.path, Prüfung mit `pds db test`",
    ),
    (
        "attempt to write a readonly database",
        "Die SQLite-Datei ist schreibgeschützt: Das Dienstkonto NT SERVICE\\pds braucht „Ändern“ \
         auf der Datei und ihrem Ordner (dort entstehen -wal und -shm); Schreibschutz prüfen",
    ),
    (
        "database is locked",
        "Die SQLite-Datei ist von einem anderen Programm gesperrt (etwa der .NET-Version, einer \
         Sicherung oder einem Virenscanner); der Dienst versucht es erneut",
    ),
    (
        "database table is locked",
        "Die SQLite-Datei ist von einem anderen Programm gesperrt (etwa der .NET-Version, einer \
         Sicherung oder einem Virenscanner); der Dienst versucht es erneut",
    ),
    (
        "disk I/O error",
        "Ein-/Ausgabefehler beim Zugriff auf die SQLite-Datei: Datenträger, Virenscanner oder ein \
         Netzlaufwerk (nicht unterstützt) prüfen",
    ),
    (
        "database or disk is full",
        "Auf dem Laufwerk der SQLite-Datei ist kein Platz mehr",
    ),
    (
        "file is not a database",
        "Die Datei unter db.path ist keine SQLite-Datenbank",
    ),
    (
        "database disk image is malformed",
        "Die SQLite-Datei ist beschädigt: aus einer Sicherung wiederherstellen (`pds db backup` \
         erstellt welche)",
    ),
];
/// Node meldet einen fehlenden Ordner, den das Dienstkonto nicht anlegen darf, als `mkdir`-Fehler.
const MKDIR_DENIED: [&str; 2] = [
    "EPERM: operation not permitted, mkdir",
    "EACCES: permission denied, mkdir",
];
const BIND_MARKER: &str = "bind:";
/// Go-Texte für "Port belegt": Linux/Windows (WSAEADDRINUSE) und WSAEACCES, wenn http.sys oder eine
/// Ausschlussliste den Port hält. Go fragt Windows zuerst nach dem englischen Text, daher stabil.
const PORT_BUSY_TEXTS: [&str; 3] = [
    "address already in use",
    "Only one usage of each socket address",
    "An attempt was made to access a socket in a way forbidden",
];

/// Ordnet das Ende eines Kindes ein. `stderr_tail` sind die letzten Zeilen von stderr, älteste
/// zuerst und ungeschwärzt, damit Schwärzen keine Marker zerstört. Die Meldung im Ergebnis kann
/// deshalb Secrets enthalten: Der Aufrufer schwärzt sie, bevor sie in Status oder Log geht.
pub fn classify_exit(kind: ChildKind, code: Option<i32>, stderr_tail: &[String]) -> ExitClass {
    match kind {
        ChildKind::App => {
            if let Some(message) = config_error(stderr_tail) {
                return ExitClass::ConfigError(message);
            }
            if let Some(message) = sqlite_problem(stderr_tail) {
                return ExitClass::Retry(message);
            }
            if let Some(message) = database_not_ready(stderr_tail) {
                return ExitClass::Retry(message);
            }
        }
        ChildKind::Proxy => {
            if let Some(message) = port_busy(stderr_tail) {
                return ExitClass::Retry(message);
            }
        }
    }
    ExitClass::Retry(generic(kind, code, stderr_tail))
}

// Nur der Zeilenanfang zählt: `01.config-check.ts` schreibt `[config] …` ohne Präfix, ein Zitat
// mitten im Text wäre kein Konfigurationsfehler.
fn config_error(tail: &[String]) -> Option<String> {
    tail.iter()
        .find_map(|line| line.strip_prefix(CONFIG_PREFIX))
        .map(|rest| rest.trim_end().to_owned())
}

// Ein typischer Fehler einer SQLite-Datei, egal ob bei der Migration (`[db]`-Zeile) oder später:
// die Erklärung statt des englischen Texts.
fn sqlite_problem(tail: &[String]) -> Option<String> {
    let advice = tail.iter().find_map(|line| {
        SQLITE_PROBLEMS
            .iter()
            .find(|(text, _)| line.contains(text))
            .map(|(_, advice)| (*advice).to_owned())
            .or_else(|| {
                MKDIR_DENIED
                    .iter()
                    .any(|text| line.contains(text))
                    .then(|| {
                        "Der Ordner der SQLite-Datei fehlt, und das Dienstkonto darf ihn nicht \
                     anlegen: die Konfiguration als Administrator speichern (legt ihn an und setzt \
                     die Rechte) oder die Installation reparieren"
                            .to_owned()
                    })
            })
    })?;
    Some(format!("Datenbank nicht bereit (SQLite): {advice}"))
}

// `00.database.ts` ruft `console.error('[db] Datenbankmigration fehlgeschlagen', error)`: Node hängt
// die Fehlermeldung an dieselbe Zeile, danach folgen Stack-Zeilen (`    at …`) und gegebenenfalls
// `[cause]: …`. Die Ursache ist deshalb zuerst der Rest dieser Zeile hinter dem Festtext, sonst die
// erste folgende Zeile, die kein Stack-Frame ist.
fn database_not_ready(tail: &[String]) -> Option<String> {
    let index = tail.iter().position(|line| line.contains(DB_MARKER))?;
    let cause = cause_on_marker_line(&tail[index]).or_else(|| {
        tail[index + 1..]
            .iter()
            .map(|line| line.trim())
            .find(|line| !line.is_empty() && !line.starts_with("at "))
            .map(str::to_owned)
    });
    Some(match cause {
        Some(cause) => format!("Datenbank nicht bereit: {cause}"),
        None => "Datenbank nicht bereit".to_owned(),
    })
}

// Der Rest der `[db]`-Zeile hinter dem Festtext ohne führendes `Error:` (Node schreibt den Namen
// des Fehlers mit). Leer, wenn der Festtext fehlt oder nichts dahinter steht.
fn cause_on_marker_line(line: &str) -> Option<String> {
    let (_, rest) = line.split_once(DB_FAILED_TEXT)?;
    let rest = rest.trim();
    let cause = rest.strip_prefix("Error:").unwrap_or(rest).trim_start();
    (!cause.is_empty()).then(|| cause.to_owned())
}

fn port_busy(tail: &[String]) -> Option<String> {
    let line = tail.iter().find(|line| {
        line.contains(BIND_MARKER) && PORT_BUSY_TEXTS.iter().any(|text| line.contains(text))
    })?;
    Some(match port_of(line) {
        Some(port) => format!("Port {port} ist bereits belegt (z. B. durch IIS/http.sys)"),
        None => "Port ist bereits belegt (z. B. durch IIS/http.sys)".to_owned(),
    })
}

// Der Port steht vor dem `bind:` (`listen tcp :443: bind: …`, auch mit Adresse davor). Als
// Rückfall dient der Text nach `listen tcp `. Nur Zeichenketten-Suche, keine Byte-Indizes von
// außen: gültig für beliebiges UTF-8.
fn port_of(line: &str) -> Option<u16> {
    let (before_bind, _) = line.split_once(BIND_MARKER)?;
    last_port(before_bind).or_else(|| {
        let (_, after) = line.split_once("listen tcp ")?;
        let address = after.split_whitespace().next()?;
        last_port(address)
    })
}

// Die Ziffern direkt nach dem letzten ':' im Text (ohne abschließende ':' und Leerraum).
fn last_port(text: &str) -> Option<u16> {
    let text = text.trim_end().trim_end_matches(':');
    let digits = text.rsplit(':').next()?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn generic(kind: ChildKind, code: Option<i32>, tail: &[String]) -> String {
    let name = match kind {
        ChildKind::App => "Anwendung",
        ChildKind::Proxy => "Proxy",
    };
    let code = code.map_or_else(|| "unbekannt".to_owned(), |code| code.to_string());
    let last = tail
        .iter()
        .rev()
        .map(|line| line.trim())
        .find(|line| meaningful(line));
    match last {
        Some(last) => format!("{name} beendet (Exit-Code {code}): {last}"),
        None => format!("{name} beendet (Exit-Code {code})"),
    }
}

/// Sagt die Zeile etwas über den Fehler? Node schreibt nach einem Absturz den Stacktrace (`at …`)
/// und zuletzt seine Version (`Node.js v24…`); die Fehlerzeile steht davor. Zeilen nur aus
/// Satzzeichen (`}`, `^`) sagen ebenfalls nichts.
fn meaningful(line: &str) -> bool {
    line.chars().any(char::is_alphanumeric)
        && !line.starts_with("Node.js v")
        && !line.starts_with("at ")
}

/// Kürzt eine Meldung auf höchstens 300 Zeichen. Erst nach dem Schwärzen aufrufen.
///
/// Auf Zeichen statt Bytes: Ein Schnitt mitten im Mehrbyte-Zeichen wäre eine Panik. Die
/// Auslassungspunkte zählen mit.
pub fn shorten_message(message: &str) -> String {
    if message.chars().count() <= MAX_MESSAGE_CHARS {
        return message.to_owned();
    }
    let mut shortened: String = message.chars().take(MAX_MESSAGE_CHARS - 1).collect();
    shortened.push('…');
    shortened
}
