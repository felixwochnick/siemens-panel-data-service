//! Wartezeit zwischen Neustartversuchen eines Kindprozesses.

use std::time::Duration;

/// Jitter von ±20 % (Faktor 0,8 bis 1,2), damit mehrere Dienste nach einem gemeinsamen Ausfall
/// (z. B. SQL Server startet neu) nicht im Gleichschritt anklopfen.
const JITTER_MIN_FACTOR: f64 = 0.8;
const JITTER_SPREAD: f64 = 0.4;

/// Verdoppelnde Wartezeit: `base`, `2·base`, `4·base` … höchstens `max`.
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempts: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Self {
            base,
            max,
            attempts: 0,
        }
    }

    /// Die nächste Wartezeit. `jitter` (0,0 bis 1,0, außerhalb wird begrenzt) kommt von außen,
    /// damit Tests deterministisch bleiben: 0,0 ergibt 80 %, 0,5 genau 100 % und 1,0 120 % der
    /// Grundwartezeit. Das Ergebnis ist nie größer als `max`: Die Obergrenze gilt auch nach dem
    /// Jitter, `max` ist also die längste Wartezeit, die je vergeben wird.
    pub fn next_delay(&mut self, jitter: f64) -> Duration {
        // Ab 2^31 ist jeder sinnvolle `max` längst erreicht; die Grenze verhindert den Überlauf.
        let factor = 1u32 << self.attempts.min(31);
        let delay = self.base.saturating_mul(factor).min(self.max);
        self.attempts = self.attempts.saturating_add(1);
        apply_jitter(delay, jitter).min(self.max)
    }

    /// Nach stabilem Lauf: die nächste Wartezeit beginnt wieder bei `base`.
    pub fn reset(&mut self) {
        self.attempts = 0;
    }

    /// Wie viele Wartezeiten seit dem letzten `reset` vergeben wurden.
    pub fn attempts(&self) -> u32 {
        self.attempts
    }
}

fn apply_jitter(delay: Duration, jitter: f64) -> Duration {
    // NaN lässt sich nicht begrenzen; die Mitte ist der neutrale Wert.
    let jitter = if jitter.is_nan() {
        0.5
    } else {
        jitter.clamp(0.0, 1.0)
    };
    let factor = JITTER_MIN_FACTOR + JITTER_SPREAD * jitter;
    // Auf Nanosekunden gerundet, damit Gleitkommarauschen keine Werte wie 1,5999999999 s ergibt.
    let nanos = (delay.as_nanos() as f64 * factor).round();
    // Bis 2^64 ns (rund 584 Jahre) exakt; darüber ist die Sättigung gewollt.
    Duration::from_nanos(nanos as u64)
}
