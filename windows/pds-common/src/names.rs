//! Feste Namen des Produkts. Kein anderer Code schreibt diese Strings selbst.

use serde::Deserialize;

pub const SERVICE_NAME: &str = "pds";
pub const SERVICE_DISPLAY_NAME: &str = "EPLAN Panel Data Service";
pub const SERVICE_ACCOUNT: &str = "NT SERVICE\\pds";
pub const EVENT_SOURCE: &str = "pds";
pub const FIREWALL_RULE_NAME: &str = "EPLAN Panel Data Service (HTTP/HTTPS)";
pub const PRODUCT_DIR_NAME: &str = "EPLAN Panel Data Service";

/// Produktversion: vom Build vorgegeben (`PDS_VERSION`), sonst die Crate-Version.
pub fn product_version() -> &'static str {
    match option_env!("PDS_VERSION") {
        Some(version) if !version.is_empty() => version,
        _ => env!("CARGO_PKG_VERSION"),
    }
}

/// Versionen der mitgelieferten Fremdkomponenten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorVersions {
    pub node: String,
    pub caddy: String,
}

// Die Datei wird mit einkompiliert, damit EXE und Paketierung nie auseinanderlaufen.
const VENDOR_JSON: &str = include_str!("../../vendor.json");

#[derive(Deserialize)]
struct VendorFile {
    node: VendorEntry,
    caddy: VendorEntry,
}

// Weitere Felder (URL, Prüfsumme) sind für die Laufzeit unwichtig und werden ignoriert.
#[derive(Deserialize)]
struct VendorEntry {
    version: String,
}

pub fn vendor_versions() -> VendorVersions {
    parse_vendor(VENDOR_JSON).expect("windows/vendor.json ist ungültig")
}

fn parse_vendor(text: &str) -> Result<VendorVersions, serde_json::Error> {
    let file: VendorFile = serde_json::from_str(text)?;
    Ok(VendorVersions {
        node: file.node.version,
        caddy: file.caddy.version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Nur die Form prüfen: Versions-Updates per PR sollen keinen Test ändern müssen
    fn is_dotted_version(version: &str) -> bool {
        let parts: Vec<&str> = version.split('.').collect();
        parts.len() >= 2
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
    }

    #[test]
    fn embedded_vendor_json_parses() {
        let versions = vendor_versions();
        assert!(is_dotted_version(&versions.node), "{}", versions.node);
        assert!(is_dotted_version(&versions.caddy), "{}", versions.caddy);
    }

    #[test]
    fn dotted_version_check() {
        assert!(is_dotted_version("24.22.3"));
        assert!(!is_dotted_version(""));
        assert!(!is_dotted_version("24"));
        assert!(!is_dotted_version("v24.1.0"));
        assert!(!is_dotted_version("24..1"));
    }

    #[test]
    fn vendor_json_tolerates_extra_fields() {
        let text = r#"{
            "node": { "version": "24.1.0", "url": "https://example.org/n.zip", "sha256": "ab" },
            "caddy": { "version": "2.12.0", "url": "https://example.org/c.zip", "sha256": "cd" },
            "wix": { "version": "5.0.2" }
        }"#;
        let versions = parse_vendor(text).unwrap();
        assert_eq!(versions.node, "24.1.0");
        assert_eq!(versions.caddy, "2.12.0");
    }

    #[test]
    fn product_version_is_not_empty() {
        assert!(!product_version().is_empty());
    }

    #[test]
    fn service_account_is_virtual_account_of_service() {
        assert_eq!(SERVICE_ACCOUNT, format!("NT SERVICE\\{SERVICE_NAME}"));
    }
}
