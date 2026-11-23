//! Zertifikate aus `LocalMachine\My` auflisten und samt privatem Schlüssel übernehmen.
//!
//! Für die Übernahme exportiert Windows das Zertifikat als PFX in den Speicher, geschützt mit
//! einem Zufallspasswort nur für diesen Aufruf; [`tls::from_pfx`] liest es wieder ein. PFX und
//! Passwort berühren nie die Platte und stehen in keinem Log.
//!
//! Funktionen mit `*const CERT_CONTEXT` erwarten einen gültigen Kontext aus Windows.

use std::ffi::c_void;
use std::ptr;

use sha1::{Digest, Sha1};
use windows::Win32::Foundation::{
    CRYPT_E_NOT_FOUND, NTE_BAD_KEY, NTE_BAD_KEY_STATE, NTE_NO_KEY, NTE_NOT_SUPPORTED, NTE_PERM,
};
use windows::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom, CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL,
    CERT_CHAIN_CONTEXT, CERT_CHAIN_PARA, CERT_CONTEXT, CERT_FIND_SHA1_HASH,
    CERT_KEY_PROV_INFO_PROP_ID, CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_OPEN_STORE_FLAGS,
    CERT_QUERY_ENCODING_TYPE, CERT_STORE_ADD_ALWAYS, CERT_STORE_OPEN_EXISTING_FLAG,
    CERT_STORE_PROV_MEMORY, CERT_STORE_PROV_SYSTEM_W, CERT_STORE_READONLY_FLAG,
    CERT_SYSTEM_STORE_LOCAL_MACHINE, CERT_TRUST_IS_SELF_SIGNED, CRYPT_INTEGER_BLOB,
    CertAddCertificateContextToStore, CertCloseStore, CertEnumCertificatesInStore,
    CertFindCertificateInStore, CertFreeCertificateChain, CertFreeCertificateContext,
    CertGetCertificateChain, CertGetCertificateContextProperty, CertGetNameStringW, CertOpenStore,
    EXPORT_PRIVATE_KEYS, HCERTCHAINENGINE, HCERTSTORE, PFXExportCertStoreEx, PKCS_7_ASN_ENCODING,
    REPORT_NO_PRIVATE_KEY, REPORT_NOT_ABLE_TO_EXPORT_PRIVATE_KEY, X509_ASN_ENCODING,
};
use windows::core::{HSTRING, PCWSTR};
use x509_parser::prelude::{FromDer, X509Certificate};
use zeroize::Zeroizing;

use super::os_error;
use crate::platform::cert_store::normalize_thumbprint;
use crate::platform::{PlatformError, StoreCert};
use crate::secret::Secret;
use crate::tls::{self, TlsError, TlsMaterial};

/// Kettenaufbau aus Sicht des Computers (wie der Dienst), nicht des angemeldeten Benutzers.
/// `HCCE_LOCAL_MACHINE` fehlt in den `windows`-Bindings.
const HCCE_LOCAL_MACHINE: usize = 1;

/// Alle Zertifikate des Speichers. Nicht lesbare Einträge werden übersprungen.
pub fn list() -> Result<Vec<StoreCert>, PlatformError> {
    let store = Store::local_machine_my()?;
    let mut certs = Vec::new();
    let mut current: *mut CERT_CONTEXT = ptr::null_mut();
    loop {
        // SAFETY: Die Funktion gibt den vorigen Kontext frei und liefert den nächsten bzw. null am
        // Ende. Die Schleife verlässt sie nur am Ende, es bleibt also kein Kontext übrig.
        current = unsafe {
            CertEnumCertificatesInStore(
                store.0,
                (!current.is_null()).then_some(current.cast_const()),
            )
        };
        if current.is_null() {
            break;
        }
        if let Some(cert) = describe(current) {
            certs.push(cert);
        }
    }
    Ok(certs)
}

/// Übernimmt Zertifikat, Zwischenzertifikate und privaten Schlüssel.
///
/// Fehler: [`PlatformError::InvalidThumbprint`], [`PlatformError::CertificateNotFound`],
/// [`PlatformError::NotExportable`] und `Tls(NoPrivateKey)`, wenn es keinen Schlüssel gibt.
pub fn export(thumbprint: &str) -> Result<TlsMaterial, PlatformError> {
    let thumbprint = normalize_thumbprint(thumbprint).ok_or(PlatformError::InvalidThumbprint)?;
    let hash = hex::decode(&thumbprint).map_err(|_| PlatformError::InvalidThumbprint)?;
    let store = Store::local_machine_my()?;
    let cert = store
        .find_sha1(&hash)
        .ok_or(PlatformError::CertificateNotFound)?;
    if !has_private_key(cert.0) {
        return Err(TlsError::NoPrivateKey.into());
    }

    // Nur dieses Zertifikat in einen Speicher im RAM, damit genau es exportiert wird
    let memory = Store::memory()?;
    // SAFETY: Beide Objekte sind gültig; der Speicher bekommt eine eigene Kopie samt Eigenschaften
    // (darunter der Verweis auf den Schlüssel).
    unsafe {
        CertAddCertificateContextToStore(Some(memory.0), cert.0, CERT_STORE_ADD_ALWAYS, None)
    }
    .map_err(|error| os_error("Zertifikat kopieren", &error))?;

    let password = random_password()?;
    let pfx = export_pfx(&memory, &password)?;
    let mut material = tls::from_pfx(&pfx, &password)?;
    append_intermediates(&mut material, cert.0);
    Ok(material)
}

fn describe(cert: *const CERT_CONTEXT) -> Option<StoreCert> {
    // SAFETY: `list` übergibt den aktuellen Kontext der Aufzählung; `der` lebt nur in dieser Funktion.
    let der = unsafe { encoded(cert) };
    let (_, parsed) = X509Certificate::from_der(der).ok()?;
    let subject = display_name(cert).unwrap_or_else(|| parsed.subject().to_string());
    Some(StoreCert {
        thumbprint: hex::encode_upper(Sha1::digest(der)),
        subject,
        not_after: parsed.validity().not_after.to_datetime(),
        has_private_key: has_private_key(cert),
    })
}

/// DER-Bytes des Zertifikats.
///
/// # Safety
/// `cert` muss ein gültiger Kontext aus Windows sein, und das Ergebnis darf ihn nicht überleben.
unsafe fn encoded<'a>(cert: *const CERT_CONTEXT) -> &'a [u8] {
    // SAFETY: laut Vertrag gültig; `pbCertEncoded` zeigt auf `cbCertEncoded` Bytes, die mit dem
    // Kontext leben.
    unsafe {
        let cert = &*cert;
        if cert.pbCertEncoded.is_null() {
            return &[];
        }
        std::slice::from_raw_parts(cert.pbCertEncoded, cert.cbCertEncoded as usize)
    }
}

/// Anzeigename wie in der Zertifikatsverwaltung (meist der CN).
fn display_name(cert: *const CERT_CONTEXT) -> Option<String> {
    // SAFETY: Ohne Puffer liefert die Funktion nur die Länge inklusive abschließender Null.
    let len = unsafe { CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, None) };
    if len <= 1 {
        return None;
    }
    let mut buffer = vec![0u16; len as usize];
    // SAFETY: Der Puffer hat die eben gemeldete Länge.
    let written = unsafe {
        CertGetNameStringW(
            cert,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            None,
            Some(&mut buffer),
        )
    };
    let text = buffer.get(..(written as usize).saturating_sub(1))?;
    Some(String::from_utf16_lossy(text))
}

/// Hat das Zertifikat einen zugeordneten privaten Schlüssel (CAPI oder CNG)? Der Schlüssel selbst
/// wird dabei nicht geöffnet.
fn has_private_key(cert: *const CERT_CONTEXT) -> bool {
    let mut size = 0u32;
    // SAFETY: Ohne Puffer fragt die Funktion nur die Größe der Eigenschaft ab.
    unsafe { CertGetCertificateContextProperty(cert, CERT_KEY_PROV_INFO_PROP_ID, None, &mut size) }
        .is_ok()
}

/// Einmalpasswort für den PFX im Speicher: 24 Zufallsbytes als Hex.
fn random_password() -> Result<Secret, PlatformError> {
    let mut bytes = Zeroizing::new([0u8; 24]);
    // SAFETY: Füllt den Puffer mit Zufallsbytes des Systems.
    unsafe { BCryptGenRandom(None, bytes.as_mut_slice(), BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
        .ok()
        .map_err(|error| os_error("Zufallszahlen erzeugen", &error))?;
    Ok(Secret::new(hex::encode(bytes.as_slice())))
}

fn export_pfx(store: &Store, password: &Secret) -> Result<Zeroizing<Vec<u8>>, PlatformError> {
    let wide: Zeroizing<Vec<u16>> = Zeroizing::new(
        password
            .expose()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect(),
    );
    // Ohne exportierbaren bzw. ohne Schlüssel scheitert der Export, statt still ohne ihn zu laufen
    let flags = EXPORT_PRIVATE_KEYS | REPORT_NOT_ABLE_TO_EXPORT_PRIVATE_KEY | REPORT_NO_PRIVATE_KEY;
    let mut blob = CRYPT_INTEGER_BLOB::default();
    // Erster Aufruf ohne Puffer: Windows meldet nur die Größe
    // SAFETY: Speicher und Passwort (nullterminiert) sind gültig; `pvPara` muss null sein.
    unsafe {
        PFXExportCertStoreEx(
            store.0,
            &mut blob,
            PCWSTR(wide.as_ptr()),
            ptr::null(),
            flags,
        )
    }
    .map_err(export_error)?;

    let mut pfx = Zeroizing::new(vec![0u8; blob.cbData as usize]);
    blob.pbData = pfx.as_mut_ptr();
    // SAFETY: wie oben; `blob` zeigt jetzt auf `cbData` beschreibbare Bytes in `pfx`.
    unsafe {
        PFXExportCertStoreEx(
            store.0,
            &mut blob,
            PCWSTR(wide.as_ptr()),
            ptr::null(),
            flags,
        )
    }
    .map_err(export_error)?;
    pfx.truncate(blob.cbData as usize);
    Ok(pfx)
}

fn export_error(error: windows::core::Error) -> PlatformError {
    let code = error.code();
    if [NTE_BAD_KEY_STATE, NTE_BAD_KEY, NTE_PERM, NTE_NOT_SUPPORTED].contains(&code) {
        PlatformError::NotExportable
    } else if [NTE_NO_KEY, CRYPT_E_NOT_FOUND].contains(&code) {
        TlsError::NoPrivateKey.into()
    } else {
        os_error("Zertifikat exportieren", &error)
    }
}

/// Hängt die Zwischenzertifikate an die Kette, damit Caddy sie mitsendet; Clients ohne
/// Firmen-CA-Zwischenzertifikat bauen die Kette sonst nicht. Die Wurzel bleibt weg. Ohne
/// verfügbare Kette (oder bei Fehlern) bleibt es beim Leaf: Nur aus dem Cache, damit ein Server
/// ohne Internet hier nicht auf Zeitüberschreitungen wartet.
fn append_intermediates(material: &mut TlsMaterial, cert: *const CERT_CONTEXT) {
    let para = CERT_CHAIN_PARA {
        cbSize: size_of::<CERT_CHAIN_PARA>() as u32,
        ..Default::default()
    };
    let mut chain: *mut CERT_CHAIN_CONTEXT = ptr::null_mut();
    // SAFETY: Zertifikat und Parameter sind gültig; `chain` wird unten freigegeben.
    let built = unsafe {
        CertGetCertificateChain(
            Some(HCERTCHAINENGINE(ptr::without_provenance_mut::<c_void>(
                HCCE_LOCAL_MACHINE,
            ))),
            cert,
            None,
            None,
            &para,
            CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL,
            None,
            &mut chain,
        )
    };
    if built.is_err() || chain.is_null() {
        return;
    }
    let chain = ChainContext(chain);
    let config = pem::EncodeConfig::new().set_line_ending(pem::LineEnding::LF);
    for der in chain.intermediates() {
        material.chain_pem.push_str(&pem::encode_config(
            &pem::Pem::new("CERTIFICATE", der),
            config,
        ));
    }
}

/// Eine von Windows gebaute Zertifikatskette; wird beim Drop freigegeben.
struct ChainContext(*mut CERT_CHAIN_CONTEXT);

impl ChainContext {
    /// DER der Zertifikate nach dem Leaf bis vor die (selbstsignierte) Wurzel, aus der ersten
    /// einfachen Kette.
    fn intermediates(&self) -> Vec<Vec<u8>> {
        let mut result = Vec::new();
        // SAFETY: Windows hat die Kette vollständig gebaut; alle Zeiger zeigen in sie hinein und
        // leben bis zum Drop. Zahlen und Zeiger werden vor dem Zugriff geprüft.
        unsafe {
            let context = &*self.0;
            if context.cChain == 0 || context.rgpChain.is_null() {
                return result;
            }
            let simple = *context.rgpChain;
            if simple.is_null() || (*simple).rgpElement.is_null() {
                return result;
            }
            let elements =
                std::slice::from_raw_parts((*simple).rgpElement, (*simple).cElement as usize);
            for &element in elements.iter().skip(1) {
                if element.is_null() || (*element).pCertContext.is_null() {
                    continue;
                }
                if (*element).TrustStatus.dwInfoStatus & CERT_TRUST_IS_SELF_SIGNED != 0 {
                    continue;
                }
                result.push(encoded((*element).pCertContext).to_vec());
            }
        }
        result
    }
}

impl Drop for ChainContext {
    fn drop(&mut self) {
        // SAFETY: Der Zeiger stammt von CertGetCertificateChain und wird danach nicht mehr benutzt.
        unsafe { CertFreeCertificateChain(self.0) };
    }
}

/// Geöffneter Zertifikatspeicher; wird beim Drop geschlossen.
struct Store(HCERTSTORE);

impl Store {
    /// `LocalMachine\My` nur lesend: Hier wird nichts geändert.
    fn local_machine_my() -> Result<Self, PlatformError> {
        let name = HSTRING::from("MY");
        let flags = CERT_OPEN_STORE_FLAGS(CERT_SYSTEM_STORE_LOCAL_MACHINE)
            | CERT_STORE_OPEN_EXISTING_FLAG
            | CERT_STORE_READONLY_FLAG;
        // SAFETY: Der Name ist eine nullterminierte Zeichenkette, die den Aufruf überlebt.
        unsafe {
            CertOpenStore(
                CERT_STORE_PROV_SYSTEM_W,
                CERT_QUERY_ENCODING_TYPE(0),
                None,
                flags,
                Some(name.as_ptr().cast()),
            )
        }
        .map(Self)
        .map_err(|error| os_error("Zertifikatspeicher öffnen", &error))
    }

    fn memory() -> Result<Self, PlatformError> {
        // SAFETY: Ein leerer Speicher im RAM braucht keine Parameter.
        unsafe {
            CertOpenStore(
                CERT_STORE_PROV_MEMORY,
                CERT_QUERY_ENCODING_TYPE(0),
                None,
                CERT_OPEN_STORE_FLAGS(0),
                None,
            )
        }
        .map(Self)
        .map_err(|error| os_error("Zertifikatspeicher anlegen", &error))
    }

    fn find_sha1(&self, hash: &[u8]) -> Option<CertContext> {
        let blob = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(hash.len()).ok()?,
            pbData: hash.as_ptr().cast_mut(),
        };
        // SAFETY: `blob` zeigt auf den Hash, der den Aufruf überlebt; Windows liest ihn nur.
        let found = unsafe {
            CertFindCertificateInStore(
                self.0,
                X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
                0,
                CERT_FIND_SHA1_HASH,
                Some(ptr::from_ref(&blob).cast()),
                None,
            )
        };
        (!found.is_null()).then_some(CertContext(found))
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        // SAFETY: Das Handle stammt von CertOpenStore und wird danach nicht mehr benutzt; offene
        // Kontexte (CertContext) halten den Speicher selbst am Leben.
        let _ = unsafe { CertCloseStore(Some(self.0), 0) };
    }
}

/// Ein einzelnes Zertifikat aus einem Speicher; wird beim Drop freigegeben.
struct CertContext(*mut CERT_CONTEXT);

impl Drop for CertContext {
    fn drop(&mut self) {
        // SAFETY: Der Kontext stammt von CertFindCertificateInStore und wird danach nicht mehr
        // benutzt. Laut Dokumentation gibt die Funktion immer TRUE zurück.
        let _ = unsafe { CertFreeCertificateContext(Some(self.0.cast_const())) };
    }
}
