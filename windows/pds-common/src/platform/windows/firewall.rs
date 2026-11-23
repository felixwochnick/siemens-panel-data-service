//! Firewall-Regel für Caddy über die COM-Schnittstelle `INetFwPolicy2`.
//!
//! Eine Regel mit fester Bezeichnung: eingehend, erlauben, TCP, alle Profile, nur für `caddy.exe`.
//! Vor dem Anlegen werden alle Regeln dieses Namens entfernt, so ersetzt ein neuer Aufruf die alte
//! Regel, statt eine zweite anzulegen.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, RPC_E_CHANGED_MODE, VARIANT_TRUE};
use windows::Win32::NetworkManagement::WindowsFirewall::{
    INetFwPolicy2, INetFwRule, INetFwRules, NET_FW_ACTION_ALLOW, NET_FW_IP_PROTOCOL_TCP,
    NET_FW_PROFILE2_ALL, NET_FW_RULE_DIR_IN, NetFwPolicy2, NetFwRule,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::core::BSTR;

use super::os_error;
use crate::names::{FIREWALL_RULE_NAME, PRODUCT_DIR_NAME, SERVICE_DISPLAY_NAME};
use crate::platform::{PlatformError, port_list};

/// Mehr gleichnamige Regeln entstehen nur von Hand; die Grenze verhindert eine Endlosschleife.
const MAX_RULES: usize = 64;

/// Legt die Regel für `caddy_exe` und die Ports an bzw. ersetzt sie. Ohne Ports wird sie nur
/// entfernt. Braucht Administratorrechte.
pub fn ensure_rule(caddy_exe: &Path, tcp_ports: &[u16]) -> Result<(), PlatformError> {
    let ports = port_list(tcp_ports);
    // COM zuerst: Es wird als Letztes freigegeben, nach allen COM-Objekten unten
    let _com = Com::init()?;
    let rules = rules()?;
    remove_all(&rules)?;
    if ports.is_empty() {
        return Ok(());
    }

    let context = "Firewall-Regel anlegen";
    let fail = |error: windows::core::Error| os_error(context, &error);
    let program: Vec<u16> = caddy_exe.as_os_str().encode_wide().collect();
    // SAFETY: COM ist initialisiert; alle Argumente sind gültige BSTRs bzw. Konstanten.
    unsafe {
        let rule: INetFwRule =
            CoCreateInstance(&NetFwRule, None, CLSCTX_INPROC_SERVER).map_err(fail)?;
        rule.SetName(&BSTR::from(FIREWALL_RULE_NAME))
            .map_err(fail)?;
        rule.SetDescription(&BSTR::from(format!(
            "HTTP/HTTPS für {SERVICE_DISPLAY_NAME} (Caddy)"
        )))
        .map_err(fail)?;
        rule.SetGrouping(&BSTR::from(PRODUCT_DIR_NAME))
            .map_err(fail)?;
        rule.SetApplicationName(&BSTR::from_wide(&program))
            .map_err(fail)?;
        // Das Protokoll muss vor den Ports stehen, sonst lehnt Windows die Ports ab
        rule.SetProtocol(NET_FW_IP_PROTOCOL_TCP.0).map_err(fail)?;
        rule.SetLocalPorts(&BSTR::from(ports.as_str()))
            .map_err(fail)?;
        rule.SetDirection(NET_FW_RULE_DIR_IN).map_err(fail)?;
        rule.SetAction(NET_FW_ACTION_ALLOW).map_err(fail)?;
        rule.SetProfiles(NET_FW_PROFILE2_ALL.0).map_err(fail)?;
        rule.SetEnabled(VARIANT_TRUE).map_err(fail)?;
        rules.Add(&rule).map_err(fail)?;
    }
    Ok(())
}

/// Entfernt alle Regeln mit dem Namen; fehlt sie, ist das kein Fehler.
pub fn remove_rule() -> Result<(), PlatformError> {
    let _com = Com::init()?;
    let rules = rules()?;
    remove_all(&rules)
}

fn rules() -> Result<INetFwRules, PlatformError> {
    let fail = |error: windows::core::Error| os_error("Firewall öffnen", &error);
    // SAFETY: COM ist im aufrufenden Thread initialisiert (Com::init).
    unsafe {
        let policy: INetFwPolicy2 =
            CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER).map_err(fail)?;
        policy.Rules().map_err(fail)
    }
}

/// `Remove` löscht je Aufruf nur eine Regel; es kann mehrere gleichnamige geben (alte Versionen,
/// von Hand angelegt). Deshalb so lange, bis `Item` keine mehr findet.
fn remove_all(rules: &INetFwRules) -> Result<(), PlatformError> {
    let context = "Firewall-Regel entfernen";
    let name = BSTR::from(FIREWALL_RULE_NAME);
    for _ in 0..MAX_RULES {
        // SAFETY: `rules` ist ein gültiges COM-Objekt, `name` ein gültiger BSTR.
        match unsafe { rules.Item(&name) } {
            Ok(_) => {}
            // Nur "nicht gefunden" (0x80070002) heißt "keine Regel mehr". Jeder andere Fehler wird
            // gemeldet, sonst bliebe eine alte Regel still stehen oder es entstünde eine zweite.
            Err(error) if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() => return Ok(()),
            Err(error) => return Err(os_error(context, &error)),
        }
        // SAFETY: wie oben
        unsafe { rules.Remove(&name) }.map_err(|error| os_error(context, &error))?;
    }
    Err(PlatformError::Os {
        context,
        code: 0,
        message: format!("Mehr als {MAX_RULES} Regeln mit diesem Namen"),
    })
}

/// COM für den aktuellen Thread. Hat der Thread COM schon in einem anderen Modell initialisiert
/// (etwa STA in der UI), ist COM trotzdem nutzbar; dann wird es hier auch nicht beendet.
struct Com {
    uninitialize: bool,
}

impl Com {
    fn init() -> Result<Self, PlatformError> {
        // SAFETY: Initialisiert COM nur für diesen Thread; Drop gleicht es aus.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == RPC_E_CHANGED_MODE {
            return Ok(Self {
                uninitialize: false,
            });
        }
        // S_OK und S_FALSE (schon initialisiert) zählen beide und brauchen je ein CoUninitialize
        result
            .ok()
            .map_err(|error| os_error("COM initialisieren", &error))?;
        Ok(Self { uninitialize: true })
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.uninitialize {
            // SAFETY: Gleicht das erfolgreiche CoInitializeEx in `init` aus; alle COM-Objekte
            // dieses Aufrufs sind vorher freigegeben (später deklariert, früher gedroppt).
            unsafe { CoUninitialize() };
        }
    }
}
