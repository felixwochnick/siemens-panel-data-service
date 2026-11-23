//! Verschlüsselung der Secrets in `config.toml`.
//!
//! Auf Windows übernimmt DPAPI das (Schema `dpapi`, [`crate::platform::DpapiProtector`]).
//! Unter anderen Systemen gibt es nur einen Ersatz für Tests, der nichts verschlüsselt.

use thiserror::Error;
use zeroize::Zeroizing;

/// Schema-Kennung für DPAPI, Präfix `dpapi:` in `config.toml`.
pub const SCHEME_DPAPI: &str = "dpapi";
/// Schema-Kennung des Test-Ersatzes, Präfix `insecure:` in `config.toml`.
pub const SCHEME_INSECURE: &str = "insecure";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProtectError {
    #[error("Secret konnte nicht ver- oder entschlüsselt werden: {0}")]
    Failed(String),
}

/// Ver- und entschlüsselt Secret-Bytes. Das Schema steht als Präfix vor dem Wert in der Datei.
pub trait Protector: Send + Sync {
    fn scheme(&self) -> &'static str;
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, ProtectError>;
    fn unprotect(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, ProtectError>;
}

/// Schemata, die `save` als "versiegelt" durchgehen lässt. `insecure` zählt nur dort, wo es den
/// Ersatz überhaupt gibt: Unter Windows wäre `insecure:<Klartext>` sonst eine Hintertür.
pub(crate) fn is_known_scheme(scheme: &str) -> bool {
    scheme == SCHEME_DPAPI || (cfg!(not(windows)) && scheme == SCHEME_INSECURE)
}

/// Nur für Tests unter Nicht-Windows: lässt den Klartext unverändert. Sie sollen das Format
/// `insecure:<base64>` sehen können, mehr nicht. Nie produktiv verwenden.
#[cfg(not(windows))]
#[derive(Debug, Clone, Copy, Default)]
pub struct InsecureProtector;

#[cfg(not(windows))]
impl Protector for InsecureProtector {
    fn scheme(&self) -> &'static str {
        SCHEME_INSECURE
    }

    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, ProtectError> {
        Ok(plain.to_vec())
    }

    fn unprotect(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, ProtectError> {
        Ok(Zeroizing::new(blob.to_vec()))
    }
}

/// Der Protector, den die Anwendung benutzt: DPAPI des Computers.
#[cfg(windows)]
pub fn system_protector() -> Box<dyn Protector> {
    Box::new(crate::platform::DpapiProtector)
}

/// Der Protector, den die Anwendung benutzt: ohne Windows nur der Test-Ersatz.
#[cfg(not(windows))]
pub fn system_protector() -> Box<dyn Protector> {
    Box::new(InsecureProtector)
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn insecure_protector_roundtrip() {
        let protector = InsecureProtector;
        let blob = protector.protect("p@ss'wört%".as_bytes()).unwrap();
        let plain = protector.unprotect(&blob).unwrap();
        assert_eq!(plain.as_slice(), "p@ss'wört%".as_bytes());
        assert_eq!(protector.scheme(), "insecure");
    }

    #[test]
    fn system_protector_is_insecure_replacement_here() {
        assert_eq!(system_protector().scheme(), SCHEME_INSECURE);
    }

    #[test]
    fn known_schemes() {
        assert!(is_known_scheme("dpapi"));
        assert!(is_known_scheme("insecure"));
        assert!(!is_known_scheme("klartext"));
        assert!(!is_known_scheme(""));
    }
}
