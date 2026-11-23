//! Schwärzen von Secrets in der Ausgabe der Kindprozesse.

use std::borrow::Cow;
use std::fmt;
use std::ops::Range;

/// Ersatztext für geschwärzte Werte.
const MASK: &str = "***";
/// Kürzere Werte würden fast jede Zeile treffen und die Logs unlesbar machen.
const MIN_CHARS: usize = 4;

/// Ersetzt die Werte der Secrets in einer Zeile durch `***`, bevor sie in eine Logdatei, den
/// Status oder das Ereignisprotokoll gelangt.
///
/// Gesucht wird der Wert wörtlich. Abgeleitete Formen (URL-kodiert, JSON-maskiert, Base64) kennt
/// der Redactor nicht; wer sie in den Ausgaben erwartet, übergibt sie zusätzlich als Werte.
#[derive(Clone)]
pub struct Redactor {
    /// Längste zuerst: Enthält ein Wert einen anderen, wird der längere ganz erfasst.
    values: Vec<String>,
}

impl Redactor {
    /// Werte unter vier Zeichen werden ignoriert. Doppelte Werte zählen einmal.
    pub fn new(values: impl IntoIterator<Item = String>) -> Self {
        let mut values: Vec<String> = values
            .into_iter()
            .filter(|value| value.chars().count() >= MIN_CHARS)
            .collect();
        values.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        values.dedup();
        Self { values }
    }

    /// Gibt die Zeile unverändert (geliehen) zurück, wenn kein Wert vorkommt. Das ist der
    /// Normalfall und kostet nur eine Teilstring-Suche je Wert.
    pub fn redact<'a>(&self, line: &'a str) -> Cow<'a, str> {
        let mut hits = self.hits(line);
        if hits.is_empty() {
            return Cow::Borrowed(line);
        }
        // Überlappende Treffer ergeben einen Block, sonst bliebe vom einen Wert ein Rest sichtbar.
        hits.sort_by_key(|hit| hit.start);
        let mut out = String::with_capacity(line.len());
        let mut copied = 0;
        let mut index = 0;
        while index < hits.len() {
            let start = hits[index].start;
            let mut end = hits[index].end;
            index += 1;
            while index < hits.len() && hits[index].start <= end {
                end = end.max(hits[index].end);
                index += 1;
            }
            out.push_str(&line[copied..start]);
            out.push_str(MASK);
            copied = end;
        }
        out.push_str(&line[copied..]);
        Cow::Owned(out)
    }

    // Alle Fundstellen aller Werte, auch sich überlappende desselben Werts ("aaaa" in "aaaaaaa").
    fn hits(&self, line: &str) -> Vec<Range<usize>> {
        let mut hits = Vec::new();
        for value in &self.values {
            let mut from = 0;
            while let Some(offset) = line[from..].find(value.as_str()) {
                let start = from + offset;
                hits.push(start..start + value.len());
                // Ein Zeichen weiter (nicht ein Byte), damit `from` auf einer Zeichengrenze bleibt.
                from = start + line[start..].chars().next().map_or(1, char::len_utf8);
            }
        }
        hits
    }
}

// Absichtlich ohne die Werte: `{:?}` eines Redactors darf nie ein Secret ausgeben.
impl fmt::Debug for Redactor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Redactor")
            .field("values", &self.values.len())
            .finish()
    }
}
