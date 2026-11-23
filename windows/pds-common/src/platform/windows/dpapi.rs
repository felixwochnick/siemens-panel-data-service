//! DPAPI für die Secrets in `config.toml` und den TLS-Schlüssel (Schema `dpapi`).
//!
//! Maschinenbezogen (`CRYPTPROTECT_LOCAL_MACHINE`): Dienst (virtuelles Konto), CLI und UI
//! (Administratoren) müssen dieselben Werte öffnen. Wer sie lesen darf, regelt die ACL des
//! Datenordners.

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    CryptUnprotectData,
};
use windows::core::PCWSTR;
use zeroize::{Zeroize, Zeroizing};

use crate::protect::{ProtectError, Protector, SCHEME_DPAPI};

/// Zusätzliche Entropie: Fremde DPAPI-Blobs des Rechners öffnen sich damit nicht als unsere
/// Secrets, und unsere nicht mit fremden Werkzeugen ohne diesen Wert.
const ENTROPY: &[u8] = b"pds/v1";
/// Ohne Benutzeroberfläche: Der Dienst hat keine, und DPAPI darf nie nachfragen.
const FLAGS: u32 = CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN;

/// Versiegelt Secrets mit DPAPI des Computers.
#[derive(Debug, Clone, Copy, Default)]
pub struct DpapiProtector;

impl Protector for DpapiProtector {
    fn scheme(&self) -> &'static str {
        SCHEME_DPAPI
    }

    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, ProtectError> {
        let input = input_blob(plain)?;
        let entropy = input_blob(ENTROPY)?;
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` und `entropy` zeigen auf Puffer, die den Aufruf überleben und von DPAPI
        // nur gelesen werden; `output` ist eine gültige, leere Struktur für das Ergebnis.
        unsafe {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                Some(&entropy),
                None,
                None,
                FLAGS,
                &mut output,
            )
        }
        .map_err(|error| failed("Verschlüsseln", &error))?;
        let output = OutputBlob(output);
        Ok(output.as_slice().to_vec())
    }

    fn unprotect(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, ProtectError> {
        let input = input_blob(blob)?;
        let entropy = input_blob(ENTROPY)?;
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: wie bei `protect`; die Beschreibung des Blobs wird nicht abgefragt (None).
        unsafe { CryptUnprotectData(&input, None, Some(&entropy), None, None, FLAGS, &mut output) }
            .map_err(|error| failed("Entschlüsseln", &error))?;
        // Der Klartext liegt jetzt in von Windows belegtem Speicher; OutputBlob nullt ihn beim Drop
        let output = OutputBlob(output);
        Ok(Zeroizing::new(output.as_slice().to_vec()))
    }
}

/// Eingabe-Blob, der auf `data` zeigt. DPAPI verlangt einen `*mut`-Zeiger, schreibt aber nicht.
fn input_blob(data: &[u8]) -> Result<CRYPT_INTEGER_BLOB, ProtectError> {
    let len = u32::try_from(data.len())
        .map_err(|_| ProtectError::Failed("Secret ist zu groß für DPAPI".into()))?;
    Ok(CRYPT_INTEGER_BLOB {
        cbData: len,
        pbData: data.as_ptr().cast_mut(),
    })
}

// Nur Windows-Text und Code; Inhalte des Blobs stehen nie in der Meldung.
fn failed(action: &str, error: &windows::core::Error) -> ProtectError {
    ProtectError::Failed(format!(
        "DPAPI: {action} fehlgeschlagen: {} (Code 0x{:08X})",
        error.message().trim(),
        error.code().0 as u32
    ))
}

/// Ergebnis von DPAPI, mit `LocalAlloc` belegt. Wird beim Drop genullt und freigegeben, weil es
/// Klartext sein kann.
struct OutputBlob(CRYPT_INTEGER_BLOB);

impl OutputBlob {
    fn as_slice(&self) -> &[u8] {
        if self.0.pbData.is_null() || self.0.cbData == 0 {
            return &[];
        }
        // SAFETY: DPAPI hat bei Erfolg `cbData` Bytes ab `pbData` belegt; sie leben bis zum Drop.
        unsafe { std::slice::from_raw_parts(self.0.pbData, self.0.cbData as usize) }
    }
}

impl Drop for OutputBlob {
    fn drop(&mut self) {
        if self.0.pbData.is_null() {
            return;
        }
        // SAFETY: Der Puffer gehört uns (von DPAPI mit LocalAlloc belegt), ist `cbData` Bytes groß
        // und wird nach dem Freigeben nicht mehr benutzt.
        unsafe {
            std::slice::from_raw_parts_mut(self.0.pbData, self.0.cbData as usize).zeroize();
            LocalFree(Some(HLOCAL(self.0.pbData.cast())));
        }
    }
}
