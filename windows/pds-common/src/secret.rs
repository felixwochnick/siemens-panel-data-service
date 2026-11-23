//! Geheimer Wert, der weder ausgegeben noch im Speicher liegen gelassen wird.

use std::fmt;

use zeroize::Zeroizing;

/// Ein Secret (Passwort, Client-Secret, ...). `Debug` und `Display` zeigen nur `***`,
/// damit es nicht versehentlich in Logs oder Fehlermeldungen landet.
#[derive(Clone, Default)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(Zeroizing::new(value.into()))
    }

    /// Klartext, nur dort aufrufen, wo er wirklich gebraucht wird (Umgebungsblock, stdin).
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}
