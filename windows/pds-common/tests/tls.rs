//! TLS-Import und -Prüfung: PEM (PKCS#8, PKCS#1, SEC1), PFX (AES-256, 3DES, RC2-40), Hostnamen, Ablage.
//!
//! Die Zertifikate entstehen zur Laufzeit mit `rcgen`; den RSA-Schlüssel liefert `rsa`, weil `rcgen`
//! mit `ring` keine RSA-Schlüssel erzeugen kann. Zwei PFX-Dateien stammen von OpenSSL 3, damit nicht
//! nur die eigene Schreib-/Lesekette geprüft wird (Passwort beider Dateien: `Pässwört 1!`):
//!
//! ```text
//! openssl pkcs12 -export -legacy -inkey leaf.key -in leaf.pem -certfile ca.pem \
//!     -out windows-legacy-3des.pfx -passout 'pass:Pässwört 1!'   # wie der Windows-Export
//! openssl pkcs12 -export -inkey leaf.key -in leaf.pem -certfile ca.pem \
//!     -out openssl-aes256.pfx -passout 'pass:Pässwört 1!'        # neuere Standardwerte
//! ```
//!
//! Leaf `windows-legacy.example.com` (SAN auch `*.legacy.example.com`), ausgestellt von `LPD Test CA`,
//! beide EC P-256 und 100 Jahre gültig.

use std::fs;
use std::sync::OnceLock;

use p12_keystore::{
    Certificate, EncryptionAlgorithm, KeyStore, KeyStoreEntry, MacAlgorithm, PrivateKey,
    PrivateKeyChain,
};
use p256::pkcs8::DecodePrivateKey;
use pds_common::Secret;
use pds_common::tls::{self, CertInfo, TlsError, TlsMaterial};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, Issuer, KeyPair,
    PKCS_ECDSA_P256_SHA256, PKCS_ECDSA_P384_SHA384, PKCS_ED25519, date_time_ymd,
};
use sha1::{Digest, Sha1};
use time::OffsetDateTime;

const LEAF_HOST: &str = "pds.example.com";
const WILDCARD: &str = "*.lpd.example.com";
const FIXTURE_PASSWORD: &str = "Pässwört 1!";

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

fn der_to_pem(label: &str, der: &[u8]) -> String {
    pem::encode(&pem::Pem::new(label, der.to_vec()))
}

/// Ein Zertifikat samt Schlüssel (PKCS#8-DER).
struct Issued {
    pem: String,
    der: Vec<u8>,
    key_der: Vec<u8>,
}

impl Issued {
    fn key_pem(&self) -> Secret {
        Secret::new(der_to_pem("PRIVATE KEY", &self.key_der))
    }
}

fn params(cn: &str, sans: &[&str]) -> CertificateParams {
    let mut params =
        CertificateParams::new(sans.iter().map(ToString::to_string).collect::<Vec<_>>()).unwrap();
    params.distinguished_name = DistinguishedName::new();
    params.distinguished_name.push(DnType::CommonName, cn);
    params.not_before = date_time_ymd(2020, 1, 1);
    params.not_after = date_time_ymd(2031, 3, 4);
    params
}

fn self_signed(key: &KeyPair, cn: &str, sans: &[&str]) -> Issued {
    let cert = params(cn, sans).self_signed(key).unwrap();
    Issued {
        pem: cert.pem(),
        der: cert.der().to_vec(),
        key_der: key.serialize_der(),
    }
}

fn ec_key() -> KeyPair {
    KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap()
}

/// 2048 Bit (kleiner nimmt `ring` nicht an). Die Erzeugung ist im Debug-Build langsam, deshalb
/// einmal je Testprogramm.
fn rsa_key() -> KeyPair {
    static DER: OnceLock<Vec<u8>> = OnceLock::new();
    let der = DER.get_or_init(|| {
        use rsa::pkcs8::EncodePrivateKey;
        let key = rsa::PrivateKey::new(&mut rand::rngs::SysRng, 2048).unwrap();
        key.to_pkcs8_der().unwrap().as_bytes().to_vec()
    });
    KeyPair::try_from(der.as_slice()).unwrap()
}

fn leaf(key: &KeyPair) -> Issued {
    self_signed(key, "EPLAN Panel Data Service", &[LEAF_HOST, WILDCARD])
}

/// Leaf mit Zwischen-CA: (Leaf, CA-Zertifikat als DER, CA-Zertifikat als PEM).
fn leaf_with_ca(key: &KeyPair) -> (Issued, Vec<u8>, String) {
    let ca_key = ec_key();
    let mut ca_params = params("PDS Test CA", &[]);
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::from_params(&ca_params, &ca_key);
    let cert = params("EPLAN Panel Data Service", &[LEAF_HOST, WILDCARD])
        .signed_by(key, &issuer)
        .unwrap();
    let leaf = Issued {
        pem: cert.pem(),
        der: cert.der().to_vec(),
        key_der: key.serialize_der(),
    };
    (leaf, ca.der().to_vec(), ca.pem())
}

/// PFX mit Leaf und weiteren Zertifikaten. Einzelne Zertifikate schreibt `p12-keystore` vor der
/// Kette, so lässt sich "CA steht in der Datei vor dem Leaf" nachstellen.
fn make_pfx(
    leaf: &Issued,
    extra_certs: &[&[u8]],
    password: &str,
    encryption: EncryptionAlgorithm,
    mac: MacAlgorithm,
) -> Vec<u8> {
    let mut store = KeyStore::new();
    let chain = PrivateKeyChain::new(
        b"leaf".to_vec(),
        PrivateKey::from_der(&leaf.key_der).unwrap(),
        [Certificate::from_der(&leaf.der).unwrap()],
    );
    store.add_entry("leaf", KeyStoreEntry::PrivateKeyChain(chain));
    for (index, der) in extra_certs.iter().enumerate() {
        let cert = Certificate::from_der(der).unwrap();
        store.add_entry(&format!("extra-{index}"), KeyStoreEntry::Certificate(cert));
    }
    store
        .writer(password)
        .encryption_algorithm(encryption)
        .mac_algorithm(mac)
        .write()
        .unwrap()
}

fn pfx_aes(leaf: &Issued, extra: &[&[u8]], password: &str) -> Vec<u8> {
    make_pfx(
        leaf,
        extra,
        password,
        EncryptionAlgorithm::PbeWithHmacSha256AndAes256,
        MacAlgorithm::HmacSha256,
    )
}

fn pfx_3des(leaf: &Issued, extra: &[&[u8]], password: &str) -> Vec<u8> {
    make_pfx(
        leaf,
        extra,
        password,
        EncryptionAlgorithm::PbeWithShaAnd3KeyTripleDesCbc,
        MacAlgorithm::HmacSha1,
    )
}

fn fixture(name: &str) -> Vec<u8> {
    fs::read(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn cert_count(chain_pem: &str) -> usize {
    pem::parse_many(chain_pem)
        .unwrap()
        .iter()
        .filter(|block| block.tag() == "CERTIFICATE")
        .count()
}

fn cert_der(chain_pem: &str, index: usize) -> Vec<u8> {
    pem::parse_many(chain_pem).unwrap()[index]
        .contents()
        .to_vec()
}

/// Das Ergebnis eines Imports ist ein stimmiges Paar im PKCS#8-Format.
fn assert_usable(material: &TlsMaterial) {
    assert!(
        material
            .key_pem
            .expose()
            .starts_with("-----BEGIN PRIVATE KEY-----"),
        "Ausgabe ist immer PKCS#8"
    );
    assert!(material.chain_pem.contains("BEGIN CERTIFICATE"));
    assert!(tls::key_matches(material).unwrap());
    // Das Ergebnis lässt sich erneut importieren
    let again = tls::from_pem(&material.chain_pem, &material.key_pem).unwrap();
    assert_eq!(again.chain_pem, material.chain_pem);
    assert_eq!(again.key_pem.expose(), material.key_pem.expose());
}

fn info_with(names: &[&str]) -> CertInfo {
    CertInfo {
        subject: "CN=Test".into(),
        issuer: "CN=Test".into(),
        dns_names: names.iter().map(ToString::to_string).collect(),
        not_before: date_time_ymd(2020, 1, 1),
        not_after: date_time_ymd(2031, 3, 4),
        thumbprint_sha1: String::new(),
    }
}

// ---------------------------------------------------------------------------------------------
// PEM
// ---------------------------------------------------------------------------------------------

#[test]
fn pem_ec_p256_roundtrip() {
    let issued = leaf(&ec_key());
    let material = tls::from_pem(&issued.pem, &issued.key_pem()).unwrap();
    assert_eq!(cert_count(&material.chain_pem), 1);
    assert_usable(&material);
}

#[test]
fn pem_ec_p384_roundtrip() {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let issued = leaf(&key);
    let material = tls::from_pem(&issued.pem, &issued.key_pem()).unwrap();
    assert_usable(&material);
}

#[test]
fn pem_rsa_roundtrip() {
    let issued = leaf(&rsa_key());
    let material = tls::from_pem(&issued.pem, &issued.key_pem()).unwrap();
    assert_usable(&material);
}

#[test]
fn pem_pkcs1_accepted() {
    // PKCS#8 und PKCS#1 enthalten für RSA dieselben Bytes; PKCS#1 ist die Hülle ohne Algorithmus
    let issued = leaf(&rsa_key());
    let info = pkcs8::PrivateKeyInfoRef::try_from(issued.key_der.as_slice()).unwrap();
    let pkcs1 = der_to_pem("RSA PRIVATE KEY", info.private_key.as_bytes());
    assert!(pkcs1.contains("BEGIN RSA PRIVATE KEY"));

    let material = tls::from_pem(&issued.pem, &Secret::new(pkcs1)).unwrap();
    assert_usable(&material);
    assert_eq!(
        pem::parse(material.key_pem.expose()).unwrap().contents(),
        issued.key_der.as_slice(),
        "PKCS#1 wird zu demselben PKCS#8-Schlüssel"
    );
}

#[test]
fn pem_sec1_accepted() {
    for curve_key in [
        ec_key(),
        KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap(),
    ] {
        let issued = leaf(&curve_key);
        let sec1 = if curve_key.algorithm() == &PKCS_ECDSA_P256_SHA256 {
            p256::SecretKey::from_pkcs8_der(&issued.key_der)
                .unwrap()
                .to_sec1_der()
                .unwrap()
                .to_vec()
        } else {
            p384::SecretKey::from_pkcs8_der(&issued.key_der)
                .unwrap()
                .to_sec1_der()
                .unwrap()
                .to_vec()
        };
        let sec1_pem = der_to_pem("EC PRIVATE KEY", &sec1);
        assert!(sec1_pem.contains("BEGIN EC PRIVATE KEY"));

        let material = tls::from_pem(&issued.pem, &Secret::new(sec1_pem)).unwrap();
        assert_usable(&material);
    }
}

#[test]
fn pem_chain_keeps_order_and_ignores_other_blocks() {
    let key = ec_key();
    let (leaf, _, ca_pem) = leaf_with_ca(&key);
    let noisy = format!(
        "Bag Attributes\n    friendlyName: x\n{}\r\n{}",
        leaf.pem.replace('\n', "\r\n"),
        ca_pem
    );
    let material = tls::from_pem(&noisy, &leaf.key_pem()).unwrap();
    assert_eq!(cert_count(&material.chain_pem), 2);
    assert_eq!(cert_der(&material.chain_pem, 0), leaf.der);
    assert!(!material.chain_pem.contains('\r'));
    assert!(!material.chain_pem.contains("Bag Attributes"));
}

#[test]
fn pem_key_mismatch() {
    let issued = leaf(&ec_key());
    let other = leaf(&ec_key());
    let error = tls::from_pem(&issued.pem, &other.key_pem()).unwrap_err();
    assert_eq!(error, TlsError::KeyMismatch);
    assert_eq!(error.code(), "tls_key_mismatch");
}

#[test]
fn pem_key_mismatch_between_key_types() {
    let rsa = leaf(&rsa_key());
    let ec = leaf(&ec_key());
    assert_eq!(
        tls::from_pem(&rsa.pem, &ec.key_pem()).unwrap_err(),
        TlsError::KeyMismatch
    );
    assert_eq!(
        tls::from_pem(&ec.pem, &rsa.key_pem()).unwrap_err(),
        TlsError::KeyMismatch
    );
}

#[test]
fn pem_without_certificate_or_key() {
    let issued = leaf(&ec_key());
    assert_eq!(
        tls::from_pem("kein PEM", &issued.key_pem()).unwrap_err(),
        TlsError::NoCertificate
    );
    // Ein Schlüssel an Stelle des Zertifikats ist kein Zertifikat
    assert_eq!(
        tls::from_pem(issued.key_pem().expose(), &issued.key_pem()).unwrap_err(),
        TlsError::NoCertificate
    );
    assert_eq!(
        tls::from_pem(&issued.pem, &Secret::new("")).unwrap_err(),
        TlsError::NoPrivateKey
    );
    assert_eq!(
        tls::from_pem(&issued.pem, &Secret::new(issued.pem.clone())).unwrap_err(),
        TlsError::NoPrivateKey,
        "ein Zertifikat ist kein Schlüssel"
    );
}

#[test]
fn pem_unsupported_keys() {
    let ed = self_signed(
        &KeyPair::generate_for(&PKCS_ED25519).unwrap(),
        "Ed",
        &[LEAF_HOST],
    );
    let error = tls::from_pem(&ed.pem, &ed.key_pem()).unwrap_err();
    assert!(
        matches!(&error, TlsError::UnsupportedKey(name) if name.contains("Ed25519")),
        "{error:?}"
    );
    assert_eq!(error.code(), "tls_unsupported_key");

    let issued = leaf(&ec_key());
    let encrypted = der_to_pem("ENCRYPTED PRIVATE KEY", b"irgendwas");
    assert!(matches!(
        tls::from_pem(&issued.pem, &Secret::new(encrypted)).unwrap_err(),
        TlsError::UnsupportedKey(_)
    ));
}

#[test]
fn pem_garbage_is_parse_error_without_leaking_the_key() {
    let issued = leaf(&ec_key());
    // "QUJDREVGR0hJ..." = "ABCDEFGHIJKLMNOPQRSTUVWX": gültiges Base64, aber kein Schlüssel
    let body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldY";
    let bad_key = format!("-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----\n");
    let error = tls::from_pem(&issued.pem, &Secret::new(bad_key)).unwrap_err();
    assert!(matches!(error, TlsError::Parse(_)), "{error:?}");
    let shown = format!("{error} {error:?}");
    assert!(
        !shown.contains(body),
        "Fehlertext enthält Schlüsselmaterial"
    );
    assert!(
        !shown.contains("ABCDEFGH"),
        "Fehlertext enthält Schlüsselmaterial"
    );

    let bad_cert = der_to_pem("CERTIFICATE", b"kein Zertifikat");
    assert!(matches!(
        tls::from_pem(&bad_cert, &issued.key_pem()).unwrap_err(),
        TlsError::Parse(_)
    ));
}

// ---------------------------------------------------------------------------------------------
// PFX
// ---------------------------------------------------------------------------------------------

#[test]
fn pfx_aes256_imports() {
    let key = ec_key();
    let (leaf, ca_der, _) = leaf_with_ca(&key);
    let pfx = pfx_aes(&leaf, &[&ca_der], "Pässwört 1!");
    let material = tls::from_pfx(&pfx, &Secret::new("Pässwört 1!")).unwrap();
    assert_eq!(cert_count(&material.chain_pem), 2);
    assert_eq!(
        cert_der(&material.chain_pem, 0),
        leaf.der,
        "Leaf steht vorn"
    );
    assert_eq!(cert_der(&material.chain_pem, 1), ca_der);
    assert_usable(&material);
}

#[test]
fn pfx_3des_sha1_imports() {
    // Der Windows-Export ("TripleDES-SHA1") nutzt PBE-SHA1-3DES und MAC SHA-1
    let key = rsa_key();
    let (leaf, ca_der, _) = leaf_with_ca(&key);
    let pfx = pfx_3des(&leaf, &[&ca_der], "geheim");
    let material = tls::from_pfx(&pfx, &Secret::new("geheim")).unwrap();
    assert_eq!(cert_count(&material.chain_pem), 2);
    assert_eq!(cert_der(&material.chain_pem, 0), leaf.der);
    assert_usable(&material);
}

#[test]
fn pfx_rc2_40_imports() {
    let leaf = leaf(&ec_key());
    let pfx = make_pfx(
        &leaf,
        &[],
        "geheim",
        EncryptionAlgorithm::PbeWithShaAnd40BitRc4Cbc,
        MacAlgorithm::HmacSha1,
    );
    let material = tls::from_pfx(&pfx, &Secret::new("geheim")).unwrap();
    assert_usable(&material);
}

#[test]
fn pfx_from_openssl_windows_style_imports() {
    // Schlüssel 3DES, Zertifikate RC2-40, MAC SHA-1, Passwort mit Umlauten
    let material = tls::from_pfx(
        &fixture("windows-legacy-3des.pfx"),
        &Secret::new(FIXTURE_PASSWORD),
    )
    .unwrap();
    assert_eq!(cert_count(&material.chain_pem), 2);
    let info = tls::inspect(&material.chain_pem).unwrap();
    assert_eq!(info.subject, "CN=windows-legacy.example.com");
    assert_eq!(info.issuer, "CN=LPD Test CA");
    assert_eq!(
        info.dns_names,
        ["windows-legacy.example.com", "*.legacy.example.com"]
    );
    assert_usable(&material);
}

#[test]
fn pfx_from_openssl_aes256_imports() {
    let material = tls::from_pfx(
        &fixture("openssl-aes256.pfx"),
        &Secret::new(FIXTURE_PASSWORD),
    )
    .unwrap();
    assert_eq!(cert_count(&material.chain_pem), 2);
    assert_eq!(
        tls::inspect(&material.chain_pem).unwrap().subject,
        "CN=windows-legacy.example.com"
    );
    assert_usable(&material);
}

#[test]
fn pfx_wrong_password() {
    let leaf = leaf(&ec_key());
    for pfx in [
        pfx_aes(&leaf, &[], "richtig"),
        pfx_3des(&leaf, &[], "richtig"),
    ] {
        let error = tls::from_pfx(&pfx, &Secret::new("falsch")).unwrap_err();
        assert_eq!(error, TlsError::WrongPassword);
        assert_eq!(error.code(), "tls_wrong_password");
        assert!(tls::from_pfx(&pfx, &Secret::new("")).is_err());
    }
    for name in ["windows-legacy-3des.pfx", "openssl-aes256.pfx"] {
        assert_eq!(
            tls::from_pfx(&fixture(name), &Secret::new("Passwort")).unwrap_err(),
            TlsError::WrongPassword
        );
    }
}

#[test]
fn pfx_leaf_comes_first_even_if_listed_last() {
    let key = ec_key();
    let (leaf, ca_der, _) = leaf_with_ca(&key);
    let pfx = pfx_aes(&leaf, &[&ca_der], "pw");
    // Die Datei listet die einzelne CA vor der Kette des Schlüssels
    let archive = p12_keystore::Pkcs12Archive::from_pkcs12(&pfx, "pw").unwrap();
    assert_eq!(archive.certs[0].cert.as_der(), ca_der, "Voraussetzung");

    let material = tls::from_pfx(&pfx, &Secret::new("pw")).unwrap();
    assert_eq!(cert_der(&material.chain_pem, 0), leaf.der);
    assert_eq!(cert_der(&material.chain_pem, 1), ca_der);
}

#[test]
fn pfx_duplicate_certificates_are_dropped() {
    let key = ec_key();
    let (leaf, ca_der, _) = leaf_with_ca(&key);
    let pfx = pfx_aes(&leaf, &[&ca_der, &ca_der, &leaf.der], "pw");
    let material = tls::from_pfx(&pfx, &Secret::new("pw")).unwrap();
    assert_eq!(cert_count(&material.chain_pem), 2);
    assert_eq!(cert_der(&material.chain_pem, 0), leaf.der);
    assert_eq!(cert_der(&material.chain_pem, 1), ca_der);
}

#[test]
fn pfx_without_matching_key_or_certificate() {
    let issued = leaf(&ec_key());
    let other = leaf(&ec_key());

    // Nur ein Zertifikat, kein Schlüssel
    let mut store = KeyStore::new();
    store.add_entry(
        "nur-zertifikat",
        KeyStoreEntry::Certificate(Certificate::from_der(&issued.der).unwrap()),
    );
    let pfx = store.writer("pw").write().unwrap();
    assert_eq!(
        tls::from_pfx(&pfx, &Secret::new("pw")).unwrap_err(),
        TlsError::NoPrivateKey
    );

    // Schlüssel und Zertifikat gehören nicht zusammen
    let mut store = KeyStore::new();
    let chain = PrivateKeyChain::new(
        b"id".to_vec(),
        PrivateKey::from_der(&other.key_der).unwrap(),
        [Certificate::from_der(&issued.der).unwrap()],
    );
    store.add_entry("falsch", KeyStoreEntry::PrivateKeyChain(chain));
    let pfx = store.writer("pw").write().unwrap();
    assert_eq!(
        tls::from_pfx(&pfx, &Secret::new("pw")).unwrap_err(),
        TlsError::KeyMismatch
    );
}

#[test]
fn pfx_garbage_is_parse_error() {
    let error = tls::from_pfx(b"das ist keine PFX-Datei", &Secret::new("pw")).unwrap_err();
    assert!(matches!(error, TlsError::Parse(_)), "{error:?}");
    assert_eq!(error.code(), "tls_parse_error");
    assert!(matches!(
        tls::from_pfx(&[], &Secret::new("pw")).unwrap_err(),
        TlsError::Parse(_)
    ));
}

// ---------------------------------------------------------------------------------------------
// Prüfung
// ---------------------------------------------------------------------------------------------

#[test]
fn inspect_reads_sans_and_dates() {
    let issued = leaf(&ec_key());
    let info = tls::inspect(&issued.pem).unwrap();
    assert_eq!(info.dns_names, [LEAF_HOST, WILDCARD]);
    assert_eq!(info.not_before, date_time_ymd(2020, 1, 1));
    assert_eq!(info.not_after, date_time_ymd(2031, 3, 4));
    assert_eq!(info.subject, "CN=EPLAN Panel Data Service");
    assert_eq!(info.issuer, "CN=EPLAN Panel Data Service");

    let expected: String = Sha1::digest(&issued.der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    assert_eq!(info.thumbprint_sha1, expected);
    assert_eq!(info.thumbprint_sha1.len(), 40);
}

#[test]
fn inspect_takes_the_first_certificate_as_leaf() {
    let key = ec_key();
    let (leaf, _, ca_pem) = leaf_with_ca(&key);
    let info = tls::inspect(&format!("{}{}", leaf.pem, ca_pem)).unwrap();
    assert_eq!(info.subject, "CN=EPLAN Panel Data Service");
    assert_eq!(info.issuer, "CN=PDS Test CA");
}

#[test]
fn inspect_rejects_input_without_certificate() {
    assert_eq!(tls::inspect("").unwrap_err(), TlsError::NoCertificate);
    assert_eq!(
        tls::inspect(&der_to_pem("PRIVATE KEY", b"x")).unwrap_err(),
        TlsError::NoCertificate
    );
    assert!(matches!(
        tls::inspect(&der_to_pem("CERTIFICATE", b"x")).unwrap_err(),
        TlsError::Parse(_)
    ));
}

#[test]
fn cert_info_serializes_for_the_ui() {
    let info = CertInfo {
        subject: "CN=a".into(),
        issuer: "CN=b".into(),
        dns_names: vec!["a.example.com".into()],
        not_before: OffsetDateTime::from_unix_timestamp(1_577_836_800).unwrap(),
        not_after: OffsetDateTime::from_unix_timestamp(1_930_000_000).unwrap(),
        thumbprint_sha1: "AB".into(),
    };
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["dnsNames"][0], "a.example.com");
    assert_eq!(json["thumbprintSha1"], "AB");
    assert_eq!(json["notBefore"], "2020-01-01T00:00:00Z");
    assert_eq!(json["notAfter"], "2031-02-27T23:06:40Z");
    let back: CertInfo = serde_json::from_value(json).unwrap();
    assert_eq!(back, info);
}

#[test]
fn debug_output_hides_the_key() {
    let issued = leaf(&ec_key());
    let material = tls::from_pem(&issued.pem, &issued.key_pem()).unwrap();
    let shown = format!("{material:?}");
    assert!(shown.contains("***"));
    assert!(!shown.contains("PRIVATE KEY"));
    let body = material.key_pem.expose().lines().nth(1).unwrap().to_owned();
    assert!(!shown.contains(&body));
}

#[test]
fn key_matches_compares_public_keys() {
    let issued = leaf(&ec_key());
    let other = leaf(&ec_key());
    let ok = TlsMaterial {
        chain_pem: issued.pem.clone(),
        key_pem: issued.key_pem(),
    };
    assert!(tls::key_matches(&ok).unwrap());
    let wrong = TlsMaterial {
        chain_pem: issued.pem,
        key_pem: other.key_pem(),
    };
    assert!(!tls::key_matches(&wrong).unwrap());

    let broken = TlsMaterial {
        chain_pem: "nichts".into(),
        key_pem: ok.key_pem.clone(),
    };
    assert_eq!(
        tls::key_matches(&broken).unwrap_err(),
        TlsError::NoCertificate
    );
}

#[test]
fn hostname_wildcard() {
    let info = info_with(&[LEAF_HOST, WILDCARD]);
    assert!(tls::hostname_matches(&info, "a.lpd.example.com"));
    assert!(!tls::hostname_matches(&info, "a.b.lpd.example.com"));
    assert!(tls::hostname_matches(&info, "PDS.example.com"));
}

#[test]
fn hostname_edge_cases() {
    let info = info_with(&["Trainee.Example.com", WILDCARD, "w*.example.com"]);
    assert!(tls::hostname_matches(&info, "trainee.example.com"));
    assert!(
        tls::hostname_matches(&info, "trainee.example.com."),
        "Punkt am Ende"
    );
    assert!(
        !tls::hostname_matches(&info, "lpd.example.com"),
        "Wildcard braucht ein Label"
    );
    assert!(
        !tls::hostname_matches(&info, ".lpd.example.com"),
        "leeres Label"
    );
    assert!(
        !tls::hostname_matches(&info, "wxyz.example.com"),
        "Wildcard nur als ganzes Label"
    );
    assert!(!tls::hostname_matches(&info, ""));
    assert!(!tls::hostname_matches(&info_with(&[]), LEAF_HOST));
}

// ---------------------------------------------------------------------------------------------
// Ablage
// ---------------------------------------------------------------------------------------------

// Läuft mit dem Protector der Plattform: DPAPI unter Windows, sonst der Test-Ersatz `insecure`.
mod storage {
    use pds_common::{Paths, Protector, system_protector};
    use tempfile::TempDir;

    use super::*;

    fn protector() -> Box<dyn Protector> {
        system_protector()
    }

    fn material() -> TlsMaterial {
        let issued = leaf(&ec_key());
        tls::from_pem(&issued.pem, &issued.key_pem()).unwrap()
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path().join("inst"), dir.path().join("data"));
        let material = material();

        tls::save(&paths, &material, &*protector()).unwrap();

        let key_file = fs::read_to_string(paths.tls_key_file()).unwrap();
        assert!(!key_file.contains("BEGIN PRIVATE KEY"), "{key_file}");
        let prefix = format!("{}:", protector().scheme());
        assert!(
            key_file.starts_with(&prefix),
            "Schema steht vorn: {key_file}"
        );
        let cert_file = fs::read_to_string(paths.tls_cert_file()).unwrap();
        assert!(cert_file.contains("BEGIN CERTIFICATE"));
        assert!(!cert_file.contains("PRIVATE KEY"));

        let loaded = tls::load(&paths, &*protector()).unwrap().unwrap();
        assert_eq!(loaded.chain_pem, material.chain_pem);
        assert_eq!(loaded.key_pem.expose(), material.key_pem.expose());
        assert!(tls::key_matches(&loaded).unwrap());
    }

    #[test]
    fn save_overwrites_and_leaves_no_temp_files() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path(), dir.path().join("data"));
        tls::save(&paths, &material(), &*protector()).unwrap();
        let second = material();
        tls::save(&paths, &second, &*protector()).unwrap();

        let loaded = tls::load(&paths, &*protector()).unwrap().unwrap();
        assert_eq!(loaded.chain_pem, second.chain_pem);
        let names: Vec<_> = fs::read_dir(paths.tls_dir())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn load_info_needs_no_key() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path(), dir.path().join("data"));
        let material = material();
        tls::save(&paths, &material, &*protector()).unwrap();
        fs::remove_file(paths.tls_key_file()).unwrap();

        let info = tls::load_info(&paths).unwrap().unwrap();
        assert_eq!(info, tls::inspect(&material.chain_pem).unwrap());
    }

    #[test]
    fn nothing_saved_means_none() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path(), dir.path().join("data"));
        assert!(tls::load(&paths, &*protector()).unwrap().is_none());
        assert!(tls::load_info(&paths).unwrap().is_none());
    }

    #[test]
    fn half_saved_pair_is_reported() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path(), dir.path().join("data"));
        tls::save(&paths, &material(), &*protector()).unwrap();

        fs::remove_file(paths.tls_key_file()).unwrap();
        assert_eq!(
            tls::load(&paths, &*protector()).unwrap_err(),
            TlsError::NoPrivateKey
        );
        tls::save(&paths, &material(), &*protector()).unwrap();
        fs::remove_file(paths.tls_cert_file()).unwrap();
        assert_eq!(
            tls::load(&paths, &*protector()).unwrap_err(),
            TlsError::NoCertificate
        );
    }

    #[test]
    fn unreadable_key_file_is_a_protect_error() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path(), dir.path().join("data"));
        tls::save(&paths, &material(), &*protector()).unwrap();

        // Fremdes Schema, Klartext und kaputtes Base64 öffnen sich nicht
        let scheme = protector().scheme();
        let foreign = if scheme == "dpapi" {
            "insecure"
        } else {
            "dpapi"
        };
        let mut contents = vec![
            format!("{foreign}:AAAA"),
            "-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n".to_owned(),
            format!("{scheme}:***"),
            String::new(),
        ];
        // Gültiges Base64, das DPAPI nicht entschlüsseln kann (der Ersatz würde es öffnen)
        if scheme == "dpapi" {
            contents.push("dpapi:QUJD".to_owned());
        }
        for content in contents {
            fs::write(paths.tls_key_file(), &content).unwrap();
            let error = tls::load(&paths, &*protector()).unwrap_err();
            assert!(
                matches!(error, TlsError::Protect(_)),
                "{content}: {error:?}"
            );
            assert_eq!(error.code(), "tls_protect_error");
            assert!(
                !format!("{error}").contains("QUJD"),
                "kein Schlüsselmaterial im Text"
            );
        }
    }

    #[test]
    fn unreadable_certificate_file_is_reported() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::new(dir.path(), dir.path().join("data"));
        tls::save(&paths, &material(), &*protector()).unwrap();
        fs::write(paths.tls_cert_file(), "Müll").unwrap();
        assert_eq!(tls::load_info(&paths).unwrap_err(), TlsError::NoCertificate);

        // Ein Ordner statt der Datei ist ein E/A-Fehler
        fs::remove_file(paths.tls_cert_file()).unwrap();
        fs::create_dir(paths.tls_cert_file()).unwrap();
        let error = tls::load_info(&paths).unwrap_err();
        assert!(matches!(error, TlsError::Io(_)), "{error:?}");
        assert_eq!(error.code(), "tls_io_error");
    }
}

// ---------------------------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------------------------

#[test]
fn error_codes_and_messages() {
    use pds_common::ProtectError;

    let cases = [
        (TlsError::WrongPassword, "tls_wrong_password"),
        (TlsError::NoCertificate, "tls_no_certificate"),
        (TlsError::NoPrivateKey, "tls_no_private_key"),
        (TlsError::KeyMismatch, "tls_key_mismatch"),
        (TlsError::UnsupportedKey("X".into()), "tls_unsupported_key"),
        (TlsError::Parse("X".into()), "tls_parse_error"),
        (TlsError::Io("X".into()), "tls_io_error"),
        (
            TlsError::Protect(ProtectError::Failed("X".into())),
            "tls_protect_error",
        ),
    ];
    for (error, code) in cases {
        assert_eq!(error.code(), code);
        assert!(
            code.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
            "{code}"
        );
        assert!(!error.to_string().is_empty());
    }
    assert!(TlsError::WrongPassword.to_string().contains("Passwort"));
    assert!(TlsError::KeyMismatch.to_string().contains("Schlüssel"));
}
