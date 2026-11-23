//! Ein Kindprozess (Node oder Caddy): starten, Ausgabe zeilenweise geschwärzt ins Log schreiben,
//! stderr für die Klassifizierung mitlesen, beenden.
//!
//! Je Kind laufen zwei Lesethreads (stdout, stderr) und für Caddy ein Schreibthread, der die
//! Konfiguration über stdin übergibt. Der Supervisor selbst blockiert nie auf einer Pipe.

use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use pds_common::Secret;
use pds_common::platform::JobObject;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::{ChildKind, Redactor, TailBuffer};

/// So viele stderr-Zeilen hält der Supervisor für die Klassifizierung.
const TAIL_LINES: usize = 50;
/// Längere Zeilen werden ausgelassen statt geteilt: Ein geteiltes Secret erkennte der Redactor
/// nicht mehr, und ohne Grenze könnte ein Kind den Speicher des Dienstes füllen.
pub(crate) const MAX_LINE_BYTES: usize = 64 * 1024;
/// So lange warten wir nach dem Ende eines Kindes höchstens auf seine letzten Ausgabezeilen. Hält
/// ein Enkel die Pipe offen, geht es ohne sie weiter.
const READER_GRACE: Duration = Duration::from_secs(2);
/// Zeilen des Supervisors im Kind-Log beginnen so, damit sie von der Ausgabe des Kindes zu
/// unterscheiden sind.
const MARKER: &str = "[pds]";

/// Was gestartet wird. Secrets stehen nur in `env` und `stdin_payload`, nie in `args`.
#[derive(Debug, Clone)]
pub struct ChildSpec {
    pub kind: ChildKind,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Die vollständige Umgebung: Das Kind erbt nichts vom Dienst.
    pub env: Vec<(String, Secret)>,
    pub cwd: PathBuf,
    /// Wird nach dem Start über stdin geschrieben (Caddy-JSON).
    pub stdin_payload: Option<Secret>,
    /// `true`: stdin bleibt offen, sein Schließen ist das Signal zum Beenden (Node). Sonst wird
    /// stdin nach der Payload geschlossen (Caddy).
    pub keep_stdin_open: bool,
}

/// Ziel einer Logdatei, geteilt zwischen den Lesethreads aller Starts eines Kindes.
pub(crate) type SharedLog = Arc<Mutex<Box<dyn Write + Send>>>;

/// Nachricht der Lesethreads: Eine Pipe ist zu, das Kind endet vermutlich gerade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OutputClosed {
    pub kind: ChildKind,
    pub generation: u64,
}

/// Fehler beim Start; die Meldung ist für Admins und enthält keine Secrets.
#[derive(Debug)]
pub(crate) struct SpawnError(pub String);

impl fmt::Display for SpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Ein laufender Kindprozess.
pub(crate) struct RunningChild {
    pub kind: ChildKind,
    pub generation: u64,
    pub started: Instant,
    child: Child,
    stdin: Option<ChildStdin>,
    /// Letzte stderr-Zeilen dieses Starts, ungeschwärzt (nur für `classify_exit`).
    tail: Arc<Mutex<TailBuffer>>,
    readers: Vec<JoinHandle<()>>,
    log: SharedLog,
}

/// Wie ein Kind geendet hat.
pub(crate) struct Ended {
    pub code: Option<i32>,
    /// stderr-Zeilen ungeschwärzt; schwärzen muss, wer daraus eine Meldung macht.
    pub stderr_tail: Vec<String>,
    pub ran_for: Duration,
}

/// Startet ein Kind, weist es dem Job Object zu und startet seine Lese- und Schreibthreads.
pub(crate) fn spawn<E: From<OutputClosed> + Send + 'static>(
    spec: &ChildSpec,
    generation: u64,
    job: Option<&JobObject>,
    log: &SharedLog,
    redactor: &Redactor,
    events: &Sender<E>,
) -> Result<RunningChild, SpawnError> {
    debug_assert!(
        !(spec.keep_stdin_open && spec.stdin_payload.is_some()),
        "Payload über stdin nur für Kinder, deren stdin danach geschlossen wird"
    );
    // Ohne diese Prüfung meldete das System nur „Datei nicht gefunden“, als fehle das Programm
    if !spec.cwd.is_dir() {
        return Err(SpawnError(format!(
            "{} konnte nicht gestartet werden: Arbeitsordner {} fehlt",
            name(spec.kind),
            spec.cwd.display()
        )));
    }
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(spec.env.iter().map(|(name, value)| (name, value.expose())))
        .stdin(if spec.stdin_payload.is_some() || spec.keep_stdin_open {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Dienst ohne Desktop: kein Konsolenfenster für Node und Caddy
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| {
        SpawnError(format!(
            "{} konnte nicht gestartet werden: {} ({error})",
            name(spec.kind),
            spec.program.display()
        ))
    })?;
    // Gleich nach dem Start: Node und Caddy starten bis dahin keine eigenen Kinder
    if let Some(job) = job
        && let Err(error) = job.assign(&child)
    {
        tracing::warn!(
            "{} (PID {}) nicht im Job Object: {error}",
            name(spec.kind),
            child.id()
        );
    }
    write_line(
        log,
        &format!("{MARKER} Prozess gestartet (PID {})", child.id()),
    );

    let tail = Arc::new(Mutex::new(TailBuffer::new(TAIL_LINES)));
    let mut readers = Vec::with_capacity(2);
    if let Some(stdout) = child.stdout.take() {
        readers.push(read_output(
            stdout, spec.kind, generation, log, redactor, None, events,
        ));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(read_output(
            stderr,
            spec.kind,
            generation,
            log,
            redactor,
            Some(Arc::clone(&tail)),
            events,
        ));
    }

    let mut stdin = child.stdin.take();
    if let Some(payload) = spec.stdin_payload.clone() {
        if spec.keep_stdin_open {
            // Nicht vorgesehen (siehe `debug_assert` oben); im Release-Build trotzdem schreiben,
            // statt die Payload still zu verwerfen. Blockiert, bis das Kind liest.
            if let Some(pipe) = stdin.as_mut() {
                let _ = pipe.write_all(payload.expose().as_bytes());
            }
        } else if let Some(pipe) = stdin.take() {
            write_payload(pipe, payload, spec.kind);
        }
    }

    Ok(RunningChild {
        kind: spec.kind,
        generation,
        started: Instant::now(),
        child,
        stdin,
        tail,
        readers,
        log: Arc::clone(log),
    })
}

/// Schreibt die Payload in einem eigenen Thread und schließt dann stdin (EOF). Größer als der
/// Pipe-Puffer blockierte das Schreiben, bis das Kind liest.
fn write_payload(mut pipe: ChildStdin, payload: Secret, kind: ChildKind) {
    let spawned = thread::Builder::new()
        .name(format!("{}-stdin", thread_name(kind)))
        .spawn(move || {
            // Endet das Kind vorher, scheitert das Schreiben; sein Ende wird ohnehin eingeordnet
            let _ = pipe.write_all(payload.expose().as_bytes());
            drop(pipe);
        });
    if let Err(error) = spawned {
        tracing::error!("Thread für stdin nicht startbar: {error}");
    }
}

fn read_output<E: From<OutputClosed> + Send + 'static>(
    stream: impl Read + Send + 'static,
    kind: ChildKind,
    generation: u64,
    log: &SharedLog,
    redactor: &Redactor,
    tail: Option<Arc<Mutex<TailBuffer>>>,
    events: &Sender<E>,
) -> JoinHandle<()> {
    let log = Arc::clone(log);
    let redactor = redactor.clone();
    let events = events.clone();
    let stream_name = if tail.is_some() { "stderr" } else { "stdout" };
    thread::Builder::new()
        .name(format!("{}-{stream_name}", thread_name(kind)))
        .spawn(move || {
            read_lines(stream, MAX_LINE_BYTES, |line| {
                // Klassifiziert wird ungeschwärzt; ins Log kommt nur die geschwärzte Zeile
                if let Some(tail) = &tail {
                    tail.lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(line.to_owned());
                }
                write_line(&log, &redactor.redact(line));
            });
            let _ = events.send(OutputClosed { kind, generation }.into());
        })
        .expect("Lesethread nicht startbar")
}

impl RunningChild {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// `Some`, wenn das Kind beendet ist.
    pub fn try_wait(&mut self) -> Option<ExitStatus> {
        match self.child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                tracing::warn!("Zustand von {} nicht abfragbar: {error}", name(self.kind));
                None
            }
        }
    }

    /// Schließt stdin: Für Node das Signal, sich geordnet zu beenden.
    pub fn close_stdin(&mut self) {
        self.stdin.take();
    }

    /// Wartet höchstens `timeout` auf das Ende.
    pub fn wait_timeout(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.try_wait() {
                return Some(status);
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            thread::sleep((deadline - now).min(Duration::from_millis(10)));
        }
    }

    /// Beendet hart und wartet auf das Ende.
    pub fn kill(&mut self) -> Option<ExitStatus> {
        if let Some(status) = self.try_wait() {
            return Some(status);
        }
        if let Err(error) = self.child.kill() {
            tracing::warn!("{} nicht beendbar: {error}", name(self.kind));
        }
        match self.child.wait() {
            Ok(status) => Some(status),
            Err(error) => {
                tracing::warn!("Ende von {} nicht abfragbar: {error}", name(self.kind));
                None
            }
        }
    }

    /// Nach dem Ende: auf die letzten Ausgabezeilen warten, das Ende im Log vermerken und die
    /// stderr-Zeilen für die Klassifizierung herausgeben.
    pub fn finish(self, status: Option<ExitStatus>) -> Ended {
        let deadline = Instant::now() + READER_GRACE;
        while Instant::now() < deadline && !self.readers.iter().all(JoinHandle::is_finished) {
            thread::sleep(Duration::from_millis(5));
        }
        for reader in self.readers {
            if reader.is_finished() {
                let _ = reader.join();
            }
        }
        let code = status.and_then(|status| status.code());
        write_line(
            &self.log,
            &format!("{MARKER} Prozess beendet (Exit-Code {})", code_text(code)),
        );
        let stderr_tail = self
            .tail
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .lines();
        Ended {
            code,
            stderr_tail,
            ran_for: self.started.elapsed(),
        }
    }
}

/// Exit-Code für Meldungen; ohne Code (Signal unter Linux) „unbekannt“.
pub(crate) fn code_text(code: Option<i32>) -> String {
    code.map_or_else(|| "unbekannt".to_owned(), |code| code.to_string())
}

/// Deutscher Name für Meldungen.
pub(crate) fn name(kind: ChildKind) -> &'static str {
    match kind {
        ChildKind::App => "Anwendung",
        ChildKind::Proxy => "Proxy",
    }
}

fn thread_name(kind: ChildKind) -> &'static str {
    match kind {
        ChildKind::App => "app",
        ChildKind::Proxy => "proxy",
    }
}

/// Eine Zeile mit Zeitstempel (UTC, Millisekunden) ins Log. Schreibfehler werden übergangen: Ein
/// volles Laufwerk darf die Kinder nicht aufhalten.
fn write_line(log: &SharedLog, line: &str) {
    let now = OffsetDateTime::now_utc();
    let now = now.replace_millisecond(now.millisecond()).unwrap_or(now);
    let stamp = now.format(&Rfc3339).unwrap_or_default();
    // Ein Schreibaufruf je Zeile: Die Rotation teilt so nie eine Zeile auf zwei Dateien
    let mut entry = String::with_capacity(stamp.len() + line.len() + 2);
    entry.push_str(&stamp);
    entry.push(' ');
    entry.push_str(line);
    entry.push('\n');
    let mut log = log.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = log.write_all(entry.as_bytes());
    let _ = log.flush();
}

/// Ruft `on_line` für jede Zeile aus `reader` auf, ohne `\n` bzw. `\r\n`, als UTF-8 (ungültige
/// Bytes werden ersetzt). Zeilen über `max_bytes` werden durch einen Hinweis ersetzt. Endet bei
/// EOF oder einem Lesefehler.
pub(crate) fn read_lines(mut reader: impl Read, max_bytes: usize, mut on_line: impl FnMut(&str)) {
    let mut buffer = [0u8; 8192];
    let mut line: Vec<u8> = Vec::new();
    let mut too_long = false;
    let mut emit = |line: &[u8], too_long: bool| {
        if too_long {
            on_line(&format!(
                "{MARKER} Zeile mit mehr als {max_bytes} Bytes ausgelassen"
            ));
        } else {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            on_line(&String::from_utf8_lossy(line));
        }
    };
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let mut chunk = &buffer[..read];
        while let Some(end) = chunk.iter().position(|byte| *byte == b'\n') {
            if !too_long {
                line.extend_from_slice(&chunk[..end]);
                too_long = line.len() > max_bytes;
            }
            emit(&line, too_long);
            line.clear();
            too_long = false;
            chunk = &chunk[end + 1..];
        }
        if !too_long {
            line.extend_from_slice(chunk);
            if line.len() > max_bytes {
                // Den Rest bis zum Zeilenende verwerfen statt ihn zu sammeln
                line.clear();
                too_long = true;
            }
        }
    }
    if too_long || !line.is_empty() {
        emit(&line, too_long);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(input: &[u8], max: usize) -> Vec<String> {
        let mut lines = Vec::new();
        read_lines(input, max, |line| lines.push(line.to_owned()));
        lines
    }

    /// Liefert jeweils nur wenige Bytes, damit Zeilen über Lesegrenzen gehen.
    struct Trickle<'a>(&'a [u8]);

    impl Read for Trickle<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.0.len().min(buf.len()).min(3);
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }

    #[test]
    fn splits_lines_and_strips_line_endings() {
        assert_eq!(
            lines_of(b"eins\nzwei\r\n\ndrei", 100),
            ["eins", "zwei", "", "drei"]
        );
        assert!(lines_of(b"", 100).is_empty());
    }

    #[test]
    fn lines_survive_read_boundaries() {
        let mut lines = Vec::new();
        read_lines(Trickle(b"Datenbank\r\nnicht bereit\n"), 100, |line| {
            lines.push(line.to_owned());
        });
        assert_eq!(lines, ["Datenbank", "nicht bereit"]);
    }

    #[test]
    fn invalid_utf8_is_replaced() {
        assert_eq!(lines_of(b"a\xffb\n", 100), ["a\u{fffd}b"]);
    }

    #[test]
    fn overlong_lines_are_dropped_whole() {
        let mut input = b"kurz\n".to_vec();
        input.extend(std::iter::repeat_n(b'x', 50));
        input.extend_from_slice(b"\nnoch eine\n");
        input.extend(std::iter::repeat_n(b'q', 50));

        let lines = lines_of(&input, 20);

        assert_eq!(lines.len(), 4, "{lines:?}");
        assert_eq!(lines[0], "kurz");
        assert!(lines[1].contains("ausgelassen") && !lines[1].contains('x'));
        assert_eq!(lines[2], "noch eine");
        assert!(lines[3].contains("ausgelassen") && !lines[3].contains('q'));
    }

    #[test]
    fn line_at_the_limit_is_kept() {
        assert_eq!(lines_of(b"12345\n", 5), ["12345"]);
        assert!(lines_of(b"123456\n", 5)[0].contains("ausgelassen"));
    }

    #[test]
    fn code_text_without_code() {
        assert_eq!(code_text(Some(0)), "0");
        assert_eq!(code_text(None), "unbekannt");
    }
}
