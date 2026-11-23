//! TLS-Zertifikat und -Schlüssel: Import aus PFX oder PEM, Prüfung und Ablage.
//!
//! Der Schlüssel ist ein Secret: Er liegt nur als [`Secret`] im Speicher, steht in keiner Fehlermeldung
//! und kommt nur versiegelt (`key.dpapi`) auf die Platte. Die Kette (`certificate.pem`) ist öffentlich.
//! Reines Rust ohne OpenSSL, damit der Windows-Build keine zusätzlichen Werkzeuge braucht.

use std::fs;
use std::io;
use std::net::IpAddr;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use p12_keystore::Pkcs12Archive;
use p12_keystore::error::Error as PfxError;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use pkcs8::der::Encode;
use pkcs8::der::asn1::{AnyRef, ObjectIdentifier, OctetStringRef};
use pkcs8::{AlgorithmIdentifierRef, PrivateKeyInfoRef};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use thiserror::Error;
use time::OffsetDateTime;
use ts_rs::TS;
use x509_parser::extensions::GeneralName;
use x509_parser::prelude::{FromDer, X509Certificate};
use zeroize::Zeroizing;

use crate::config::model::seal_secret;
use crate::config::store::write_atomic;
use crate::paths::Paths;
use crate::protect::{ProtectError, Protector, is_known_scheme};
use crate::secret::Secret;

/// Zertifikatskette (Leaf zuerst, öffentlich) und PKCS#8-Schlüssel als PEM.
#[derive(Debug, Clone)]
pub struct TlsMaterial {
    pub chain_pem: String,
    pub key_pem: Secret,
}

/// Angaben zum Leaf-Zertifikat für Anzeige und Prüfung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CertInfo {
    pub subject: String,
    pub issuer: String,
    pub dns_names: Vec<String>,
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub not_before: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub not_after: OffsetDateTime,
    // SHA-1 des Zertifikats in Großbuchstaben, wie ihn Windows als Fingerabdruck zeigt.
    pub thumbprint_sha1: String,
}

/// Die Texte enthalten nie Schlüsselmaterial, auch nicht aus Fehlern der Bibliotheken.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TlsError {
    #[error("Das Passwort der PFX-Datei ist falsch.")]
    WrongPassword,
    #[error("Es wurde kein Zertifikat gefunden.")]
    NoCertificate,
    #[error("Es wurde kein privater Schlüssel gefunden.")]
    NoPrivateKey,
    #[error("Der private Schlüssel passt nicht zum Zertifikat.")]
    KeyMismatch,
    #[error("Dieser Schlüsseltyp wird nicht unterstützt: {0}")]
    UnsupportedKey(String),
    #[error("Die Zertifikatsdaten sind ungültig: {0}")]
    Parse(String),
    #[error("Zertifikatsdateien konnten nicht gelesen oder geschrieben werden: {0}")]
    Io(String),
    #[error("Der private Schlüssel konnte nicht ver- oder entschlüsselt werden: {0}")]
    Protect(#[from] ProtectError),
}

impl TlsError {
    /// Stabiler Code für UI und CLI, Tests prüfen ihn statt der Texte.
    pub fn code(&self) -> &'static str {
        match self {
            Self::WrongPassword => "tls_wrong_password",
            Self::NoCertificate => "tls_no_certificate",
            Self::NoPrivateKey => "tls_no_private_key",
            Self::KeyMismatch => "tls_key_mismatch",
            Self::UnsupportedKey(_) => "tls_unsupported_key",
            Self::Parse(_) => "tls_parse_error",
            Self::Io(_) => "tls_io_error",
            Self::Protect(_) => "tls_protect_error",
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

/// Liest eine PFX-Datei (PBES2/AES, PBE-SHA1-3DES und RC2-40, wie sie der Windows-Export schreibt).
/// Das Leaf ist das Zertifikat, dessen öffentlicher Schlüssel zum privaten passt; es steht in der
/// Kette vorn, die übrigen Zertifikate folgen in Dateireihenfolge.
pub fn from_pfx(bytes: &[u8], password: &Secret) -> Result<TlsMaterial, TlsError> {
    let archive = Pkcs12Archive::from_pkcs12(bytes, password.expose()).map_err(pfx_error)?;
    if archive.keys.is_empty() {
        return Err(TlsError::NoPrivateKey);
    }
    if archive.certs.is_empty() {
        return Err(TlsError::NoCertificate);
    }
    let certs: Vec<&[u8]> = archive.certs.iter().map(|bag| bag.cert.as_der()).collect();
    let cert_keys: Vec<Result<PublicKey, TlsError>> =
        certs.iter().map(|der| cert_public_key(der)).collect();

    // Bei mehreren Schlüsseln der erste, zu dem ein Zertifikat passt. Ein nicht unterstützter Typ
    // bricht nicht ab, solange ein anderer Schlüssel passt; sonst wird sein Fehler gemeldet.
    let mut first_error = None;
    for bag in &archive.keys {
        let key_der = bag.key.as_der();
        let key_public = match key_public_key(key_der) {
            Ok(public) => public,
            Err(error) => {
                first_error.get_or_insert(error);
                continue;
            }
        };
        let leaf = cert_keys
            .iter()
            .position(|cert_public| cert_public.as_ref().is_ok_and(|p| *p == key_public));
        if let Some(leaf) = leaf {
            // Leaf vorn, der Rest in Dateireihenfolge; doppelte Zertifikate nur einmal
            let mut ordered = vec![certs[leaf]];
            for der in &certs {
                if !ordered.contains(der) {
                    ordered.push(der);
                }
            }
            return Ok(material(ordered.into_iter(), key_der));
        }
    }
    Err(first_error.unwrap_or(TlsError::KeyMismatch))
}

/// Liest Kette und Schlüssel aus PEM-Text. Der Schlüssel darf PKCS#8, PKCS#1 (RSA) oder SEC1 (EC)
/// sein, die Ausgabe ist immer PKCS#8. Das erste Zertifikat ist das Leaf.
pub fn from_pem(cert_pem: &str, key_pem: &Secret) -> Result<TlsMaterial, TlsError> {
    let certs = certificates(cert_pem)?;
    let key_der = pkcs8_from_pem(key_pem)?;
    if key_public_key(&key_der)? != cert_public_key(&certs[0])? {
        return Err(TlsError::KeyMismatch);
    }
    Ok(material(certs.iter().map(Vec::as_slice), &key_der))
}

fn material<'a>(certs: impl Iterator<Item = &'a [u8]>, key_der: &[u8]) -> TlsMaterial {
    let chain_pem = certs
        .map(|der| pem::encode_config(&pem::Pem::new("CERTIFICATE", der), pem_config()))
        .collect();
    let key_block = pem::Pem::new("PRIVATE KEY", key_der);
    let key_pem = Secret::new(pem::encode_config(&key_block, pem_config()));
    // Die Kopie des Schlüssels im PEM-Block nicht liegen lassen
    drop(Zeroizing::new(key_block.into_contents()));
    TlsMaterial { chain_pem, key_pem }
}

fn pem_config() -> pem::EncodeConfig {
    pem::EncodeConfig::new().set_line_ending(pem::LineEnding::LF)
}

// Ein falsches Passwort zeigt sich je nach Verfahren als MAC-, Padding- oder PBES2-Fehler.
// Texte der Bibliothek werden nicht durchgereicht.
fn pfx_error(error: PfxError) -> TlsError {
    match error {
        PfxError::MacError(_) | PfxError::UnpadError | PfxError::Pkcs5Error(_) => {
            TlsError::WrongPassword
        }
        PfxError::UnsupportedEncryptionScheme | PfxError::UnsupportedMacAlgorithm => {
            TlsError::Parse(
                "Die PFX-Datei nutzt ein nicht unterstütztes Verschlüsselungsverfahren".into(),
            )
        }
        _ => TlsError::Parse("Die PFX-Datei ist beschädigt oder keine PFX-Datei".into()),
    }
}

/// Alle Zertifikate aus dem PEM-Text als DER, in Reihenfolge. Andere Blöcke und Text dazwischen
/// (etwa "Bag Attributes" von OpenSSL) werden ignoriert.
fn certificates(text: &str) -> Result<Vec<Vec<u8>>, TlsError> {
    let blocks =
        pem::parse_many(text).map_err(|_| TlsError::Parse("Der PEM-Text ist beschädigt".into()))?;
    let certs: Vec<Vec<u8>> = blocks
        .into_iter()
        .filter(|block| block.tag() == "CERTIFICATE")
        .map(pem::Pem::into_contents)
        .collect();
    if certs.is_empty() {
        return Err(TlsError::NoCertificate);
    }
    for der in &certs {
        parse_cert(der)?;
    }
    Ok(certs)
}

fn parse_cert(der: &[u8]) -> Result<X509Certificate<'_>, TlsError> {
    X509Certificate::from_der(der)
        .map(|(_, cert)| cert)
        .map_err(|_| TlsError::Parse("Ein Zertifikat ist beschädigt".into()))
}

// ---------------------------------------------------------------------------------------------
// Schlüssel
// ---------------------------------------------------------------------------------------------

const OID_RSA: &str = "1.2.840.113549.1.1.1";
const OID_EC: &str = "1.2.840.10045.2.1";
const OID_P256: &str = "1.2.840.10045.3.1.7";
const OID_P384: &str = "1.3.132.0.34";

/// Öffentlicher Schlüssel in vergleichbarer Form, aus Zertifikat und aus privatem Schlüssel.
#[derive(PartialEq, Eq)]
enum PublicKey {
    Rsa { modulus: Vec<u8>, exponent: Vec<u8> },
    P256(p256::PublicKey),
    P384(p384::PublicKey),
}

fn unsupported(oid: &str) -> TlsError {
    let name = match oid {
        "1.3.101.112" => "Ed25519",
        "1.3.101.113" => "Ed448",
        "1.3.132.0.35" => "ECDSA P-521",
        "1.2.840.10040.4.1" => "DSA",
        other => return TlsError::UnsupportedKey(format!("OID {other}")),
    };
    TlsError::UnsupportedKey(name.into())
}

fn key_error() -> TlsError {
    TlsError::Parse("Der private Schlüssel ist beschädigt".into())
}

fn trim_leading_zeros(bytes: &[u8]) -> Vec<u8> {
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
    bytes[start..].to_vec()
}

fn cert_public_key(der: &[u8]) -> Result<PublicKey, TlsError> {
    let cert = parse_cert(der)?;
    let spki = cert.public_key();
    let key_bits = spki.subject_public_key.data.as_ref();
    let oid = spki.algorithm.algorithm.to_id_string();
    let broken =
        || TlsError::Parse("Der öffentliche Schlüssel des Zertifikats ist beschädigt".into());
    match oid.as_str() {
        OID_RSA => {
            let key = pkcs1::RsaPublicKeyRef::try_from(key_bits).map_err(|_| broken())?;
            Ok(PublicKey::Rsa {
                modulus: trim_leading_zeros(key.modulus.as_bytes()),
                exponent: trim_leading_zeros(key.public_exponent.as_bytes()),
            })
        }
        OID_EC => {
            let curve = spki
                .algorithm
                .parameters
                .as_ref()
                .and_then(|params| params.as_oid().ok())
                .map(|curve| curve.to_id_string())
                .ok_or_else(broken)?;
            match curve.as_str() {
                OID_P256 => p256::PublicKey::from_sec1_bytes(key_bits)
                    .map(PublicKey::P256)
                    .map_err(|_| broken()),
                OID_P384 => p384::PublicKey::from_sec1_bytes(key_bits)
                    .map(PublicKey::P384)
                    .map_err(|_| broken()),
                other => Err(unsupported(other)),
            }
        }
        other => Err(unsupported(other)),
    }
}

/// Öffentlicher Schlüssel zu einem PKCS#8-Schlüssel.
fn key_public_key(pkcs8_der: &[u8]) -> Result<PublicKey, TlsError> {
    let info = PrivateKeyInfoRef::try_from(pkcs8_der).map_err(|_| key_error())?;
    let oid = info.algorithm.oid.to_string();
    match oid.as_str() {
        OID_RSA => {
            let key = pkcs1::RsaPrivateKeyRef::try_from(info.private_key.as_bytes())
                .map_err(|_| key_error())?;
            Ok(PublicKey::Rsa {
                modulus: trim_leading_zeros(key.modulus.as_bytes()),
                exponent: trim_leading_zeros(key.public_exponent.as_bytes()),
            })
        }
        OID_EC => {
            let curve = info
                .algorithm
                .parameters
                .and_then(|params| params.decode_as::<ObjectIdentifier>().ok())
                .ok_or_else(key_error)?
                .to_string();
            match curve.as_str() {
                OID_P256 => p256::SecretKey::from_pkcs8_der(pkcs8_der)
                    .map(|key| PublicKey::P256(key.public_key()))
                    .map_err(|_| key_error()),
                OID_P384 => p384::SecretKey::from_pkcs8_der(pkcs8_der)
                    .map(|key| PublicKey::P384(key.public_key()))
                    .map_err(|_| key_error()),
                other => Err(unsupported(other)),
            }
        }
        other => Err(unsupported(other)),
    }
}

/// Bringt einen privaten Schlüssel aus PEM (PKCS#8, PKCS#1, SEC1) ins PKCS#8-Format.
fn pkcs8_from_pem(key_pem: &Secret) -> Result<Zeroizing<Vec<u8>>, TlsError> {
    let blocks = pem::parse_many(key_pem.expose())
        .map_err(|_| TlsError::Parse("Der PEM-Text des Schlüssels ist beschädigt".into()))?;
    // Alle Blöcke sofort in Zeroizing-Puffer, damit auch nicht gewählte Schlüssel verschwinden
    let mut chosen: Option<(String, bool, Zeroizing<Vec<u8>>)> = None;
    for block in blocks {
        let tag = block.tag().to_owned();
        let protected = block.headers().get("DEK-Info").is_some();
        let der = Zeroizing::new(block.into_contents());
        if chosen.is_none() && tag.ends_with("PRIVATE KEY") {
            chosen = Some((tag, protected, der));
        }
    }
    let (tag, protected, der) = chosen.ok_or(TlsError::NoPrivateKey)?;
    if protected || tag == "ENCRYPTED PRIVATE KEY" {
        return Err(TlsError::UnsupportedKey(
            "passwortgeschützter Schlüssel, bitte ohne Passwort exportieren".into(),
        ));
    }
    match tag.as_str() {
        "PRIVATE KEY" => Ok(der),
        "RSA PRIVATE KEY" => pkcs1_to_pkcs8(&der),
        "EC PRIVATE KEY" => sec1_to_pkcs8(&der),
        "DSA PRIVATE KEY" => Err(unsupported("1.2.840.10040.4.1")),
        _ => Err(TlsError::UnsupportedKey(format!("PEM-Typ {tag}"))),
    }
}

/// PKCS#1 ist der innere Teil des PKCS#8-Schlüssels, es fehlt nur die Hülle mit dem Algorithmus.
fn pkcs1_to_pkcs8(pkcs1_der: &[u8]) -> Result<Zeroizing<Vec<u8>>, TlsError> {
    pkcs1::RsaPrivateKeyRef::try_from(pkcs1_der).map_err(|_| key_error())?;
    let algorithm = AlgorithmIdentifierRef {
        oid: pkcs1::ALGORITHM_OID,
        parameters: Some(AnyRef::NULL),
    };
    let private_key = OctetStringRef::new(pkcs1_der).map_err(|_| key_error())?;
    let info = PrivateKeyInfoRef::new(algorithm, private_key);
    info.to_der().map(Zeroizing::new).map_err(|_| key_error())
}

fn sec1_to_pkcs8(sec1_der: &[u8]) -> Result<Zeroizing<Vec<u8>>, TlsError> {
    let parsed = sec1::EcPrivateKey::try_from(sec1_der).map_err(|_| key_error())?;
    let curve = parsed
        .parameters
        .map(|sec1::EcParameters::NamedCurve(oid)| oid.to_string());
    // Ohne Kurvenangabe entscheidet die Schlüssellänge: P-256 vor P-384
    if matches!(curve.as_deref(), None | Some(OID_P256))
        && let Ok(key) = p256::SecretKey::from_sec1_der(sec1_der)
    {
        return pkcs8_bytes(&key);
    }
    if matches!(curve.as_deref(), None | Some(OID_P384))
        && let Ok(key) = p384::SecretKey::from_sec1_der(sec1_der)
    {
        return pkcs8_bytes(&key);
    }
    match curve.as_deref() {
        Some(other) if other != OID_P256 && other != OID_P384 => Err(unsupported(other)),
        _ => Err(key_error()),
    }
}

fn pkcs8_bytes(key: &impl EncodePrivateKey) -> Result<Zeroizing<Vec<u8>>, TlsError> {
    let document = key.to_pkcs8_der().map_err(|_| key_error())?;
    Ok(Zeroizing::new(document.as_bytes().to_vec()))
}

// ---------------------------------------------------------------------------------------------
// Prüfung
// ---------------------------------------------------------------------------------------------

/// Angaben zum ersten Zertifikat der Kette (dem Leaf).
pub fn inspect(chain_pem: &str) -> Result<CertInfo, TlsError> {
    let certs = certificates(chain_pem)?;
    let der = &certs[0];
    let cert = parse_cert(der)?;

    let mut dns_names = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for name in &san.value.general_names {
            if let GeneralName::DNSName(dns) = name {
                dns_names.push((*dns).to_owned());
            }
        }
    }
    Ok(CertInfo {
        subject: cert.subject().to_string(),
        issuer: cert.issuer().to_string(),
        dns_names,
        not_before: cert.validity().not_before.to_datetime(),
        not_after: cert.validity().not_after.to_datetime(),
        thumbprint_sha1: hex::encode_upper(Sha1::digest(der)),
    })
}

/// Gehört der Schlüssel zum Leaf? Verglichen werden die öffentlichen Schlüssel.
pub fn key_matches(material: &TlsMaterial) -> Result<bool, TlsError> {
    let certs = certificates(&material.chain_pem)?;
    let key_der = pkcs8_from_pem(&material.key_pem)?;
    Ok(key_public_key(&key_der)? == cert_public_key(&certs[0])?)
}

/// Deckt das Zertifikat den Hostnamen ab? Nur DNS-Namen; ein Platzhalter gilt nur als ganzes
/// erstes Label (`*.example.com`) und für genau ein Label. Groß-/Kleinschreibung zählt nicht.
pub fn hostname_matches(info: &CertInfo, host: &str) -> bool {
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    if host.is_empty() || host.parse::<IpAddr>().is_ok() {
        return false;
    }
    info.dns_names
        .iter()
        .any(|name| name_matches(&name.to_ascii_lowercase(), &host))
}

fn name_matches(pattern: &str, host: &str) -> bool {
    let pattern = pattern.strip_suffix('.').unwrap_or(pattern);
    match pattern.strip_prefix("*.") {
        Some(rest) => host
            .split_once('.')
            .is_some_and(|(label, tail)| !label.is_empty() && !rest.is_empty() && tail == rest),
        None => pattern == host,
    }
}

// ---------------------------------------------------------------------------------------------
// Ablage
// ---------------------------------------------------------------------------------------------

/// Speichert Kette (`certificate.pem`) und versiegelten Schlüssel (`key.dpapi`, Format
/// `<schema>:<base64>` wie in `config.toml`). Der Schlüssel kommt zuerst: Bricht es dazwischen
/// ab, ist das Paar unstimmig und fällt der Prüfung auf (`certificate_key_mismatch`).
pub fn save(
    paths: &Paths,
    material: &TlsMaterial,
    protector: &dyn Protector,
) -> Result<(), TlsError> {
    // Eine brauchbare Ablage nie durch Müll ersetzen
    certificates(&material.chain_pem)?;
    if material.key_pem.is_empty() {
        return Err(TlsError::NoPrivateKey);
    }
    let sealed = seal_secret(&material.key_pem, protector)?;
    write_file(&paths.tls_key_file(), sealed.0.as_bytes())?;
    write_file(&paths.tls_cert_file(), material.chain_pem.as_bytes())
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), TlsError> {
    write_atomic(path, bytes).map_err(|error| io_error(path, &error))
}

fn io_error(path: &Path, error: &io::Error) -> TlsError {
    TlsError::Io(format!("{}: {error}", path.display()))
}

/// Lädt Kette und Schlüssel; `None`, wenn nichts gespeichert ist. Ist nur eine der beiden Dateien
/// da, ist das ein Fehler (`NoCertificate` bzw. `NoPrivateKey`).
pub fn load(paths: &Paths, protector: &dyn Protector) -> Result<Option<TlsMaterial>, TlsError> {
    let chain_pem = read_optional(&paths.tls_cert_file())?;
    let sealed = read_optional(&paths.tls_key_file())?;
    match (chain_pem, sealed) {
        (None, None) => Ok(None),
        (None, Some(_)) => Err(TlsError::NoCertificate),
        (Some(_), None) => Err(TlsError::NoPrivateKey),
        (Some(chain_pem), Some(sealed)) => Ok(Some(TlsMaterial {
            chain_pem,
            key_pem: unseal(&sealed, protector)?,
        })),
    }
}

/// Angaben zum gespeicherten Leaf, ohne den Schlüssel zu entschlüsseln.
pub fn load_info(paths: &Paths) -> Result<Option<CertInfo>, TlsError> {
    read_optional(&paths.tls_cert_file())?
        .map(|chain_pem| inspect(&chain_pem))
        .transpose()
}

fn read_optional(path: &Path) -> Result<Option<String>, TlsError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(path, &error)),
    }
}

// Die Texte nennen weder das Schema aus der Datei noch Inhalt: Bei einer von Hand ersetzten
// Datei könnte dort Klartext stehen.
fn unseal(sealed: &str, protector: &dyn Protector) -> Result<Secret, TlsError> {
    let failed = |reason: &str| TlsError::Protect(ProtectError::Failed(reason.into()));
    let (_, encoded) = sealed
        .trim()
        .split_once(':')
        .filter(|(scheme, _)| *scheme == protector.scheme() && is_known_scheme(scheme))
        .ok_or_else(|| failed("Die Schlüsseldatei hat ein unbekanntes Format"))?;
    let blob = Zeroizing::new(
        STANDARD
            .decode(encoded)
            .map_err(|_| failed("Die Schlüsseldatei ist kein gültiges Base64"))?,
    );
    let plain = protector.unprotect(&blob)?;
    let text = std::str::from_utf8(&plain)
        .map_err(|_| failed("Die Schlüsseldatei enthält keinen gültigen Text"))?;
    Ok(Secret::new(text))
}
