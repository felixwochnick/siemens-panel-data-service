//! Ringpuffer für die letzten Ausgabezeilen eines Kindprozesses.

use std::collections::VecDeque;
use std::fmt;

/// Hält die letzten `capacity` Zeilen, damit [`super::classify_exit`] beim Ende eines Kindes die
/// Ursache findet, ohne die ganze Ausgabe zu speichern.
///
/// Die Zeilen sind ungeschwärzt und bleiben im Speicher. Was daraus über die Klassifizierung in
/// Status und Oberfläche geht, schwärzt der Aufrufer vorher (siehe [`super::Redactor`]).
#[derive(Clone)]
pub struct TailBuffer {
    capacity: usize,
    lines: VecDeque<String>,
}

impl TailBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            lines: VecDeque::with_capacity(capacity),
        }
    }

    pub fn push(&mut self, line: String) {
        if self.capacity == 0 {
            return;
        }
        if self.lines.len() == self.capacity {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    /// Die gehaltenen Zeilen, älteste zuerst.
    pub fn lines(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }
}

// Absichtlich ohne die Zeilen: Sie sind ungeschwärzt und können Secrets enthalten.
impl fmt::Debug for TailBuffer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TailBuffer")
            .field("capacity", &self.capacity)
            .field("lines", &self.lines.len())
            .finish()
    }
}
