//! Einrichtung des Worker-Dienstes `pds-eplan` (siehe [`crate::eplan`]): Konto auflösen, Recht
//! „Als Dienst anmelden“ über die LSA, Anmeldung mit `LogonUserW` prüfen, Dienst anlegen bzw. ändern
//! (`windows-service`), Sicherheitsbeschreibung des Dienstes setzen, Dienst entfernen.
//!
//! Das Passwort liegt nur so kurz wie möglich in Puffern dieses Prozesses, die danach überschrieben
//! werden. `windows-service` kopiert es für `CreateServiceW`/`ChangeServiceConfigW` noch einmal in
//! einen eigenen UTF-16-Puffer, den wir nicht überschreiben können.

use std::ffi::OsString;

use windows::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_NONE_MAPPED, ERROR_SERVICE_DOES_NOT_EXIST,
    HANDLE, NTSTATUS,
};
use windows::Win32::Security::Authentication::Identity::{
    LSA_HANDLE, LSA_OBJECT_ATTRIBUTES, LSA_UNICODE_STRING, LsaAddAccountRights, LsaClose,
    LsaNtStatusToWinError, LsaOpenPolicy, POLICY_CREATE_ACCOUNT, POLICY_LOOKUP_NAMES,
};
use windows::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows::Win32::Security::{
    DACL_SECURITY_INFORMATION, LOGON32_LOGON_SERVICE, LOGON32_PROVIDER_DEFAULT, LogonUserW,
    LookupAccountNameW, PSID, SID_NAME_USE, SidTypeUser,
};
use windows::Win32::System::Services::{SC_HANDLE, SetServiceObjectSecurity};
use windows::core::{HRESULT, HSTRING, PCWSTR, PWSTR};
use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceErrorControl, ServiceFailureActions,
    ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use zeroize::Zeroizing;

use super::acl::{Descriptor, sid_text};
use super::scm::{open, os_code, service_error};
use super::{LocalMemory, os_error};
use crate::eplan::ServicePlan;
use crate::platform::{PlatformError, win32_code};
use crate::secret::Secret;

/// SID (`S-1-…`) eines Kontos und ob es ein Benutzerkonto ist; `None`, wenn Windows es nicht kennt.
pub fn lookup_account(name: &str) -> Result<Option<(String, bool)>, PlatformError> {
    let account = HSTRING::from(name);
    let mut sid_len = 0u32;
    let mut domain_len = 0u32;
    let mut kind = SID_NAME_USE::default();
    // Erster Aufruf nur für die Puffergrößen; er scheitert dabei absichtlich
    // SAFETY: Ohne Puffer schreibt Windows nur die beiden Längen und `kind`.
    let sizing = unsafe {
        LookupAccountNameW(
            PCWSTR::null(),
            &account,
            None,
            &mut sid_len,
            None,
            &mut domain_len,
            &mut kind,
        )
    };
    match sizing {
        Err(error) if error.code() == ERROR_NONE_MAPPED.to_hresult() => return Ok(None),
        Err(error) if error.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() => {
            return Err(os_error("Konto suchen", &error));
        }
        _ => {}
    }
    if sid_len == 0 {
        return Ok(None);
    }
    // u32-Puffer, damit die SID passend ausgerichtet ist
    let mut sid = vec![0u32; (sid_len as usize).div_ceil(4)];
    let mut domain = vec![0u16; domain_len.max(1) as usize];
    let psid = PSID(sid.as_mut_ptr().cast());
    // SAFETY: Beide Puffer sind mindestens so groß wie im ersten Aufruf gemeldet und leben bis zum
    // Ende der Funktion.
    unsafe {
        LookupAccountNameW(
            PCWSTR::null(),
            &account,
            Some(psid),
            &mut sid_len,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut kind,
        )
    }
    .map_err(|error| os_error("Konto suchen", &error))?;
    Ok(Some((sid_text(psid)?, kind == SidTypeUser)))
}

/// Gewährt dem Konto mit der SID `sid` das Benutzerrecht `right` (etwa `SeServiceLogonRight`) in
/// der lokalen Sicherheitsrichtlinie. Schon vorhanden ist kein Fehler.
pub fn add_account_right(sid: &str, right: &str) -> Result<(), PlatformError> {
    const CONTEXT: &str = "Recht „Als Dienst anmelden“ gewähren";
    let mut psid = PSID::default();
    // SAFETY: Der Text lebt bis zum Ende des Aufrufs; `psid` wird mit LocalAlloc belegt.
    unsafe { ConvertStringSidToSidW(&HSTRING::from(sid), &mut psid) }
        .map_err(|error| os_error(CONTEXT, &error))?;
    let _psid = LocalMemory(psid.0);

    // Die Felder werden laut Doku nicht benutzt, müssen aber null sein
    let attributes = LSA_OBJECT_ATTRIBUTES::default();
    let mut handle = LSA_HANDLE::default();
    // SAFETY: `attributes` und `handle` leben bis zum Ende des Aufrufs.
    let status = unsafe {
        LsaOpenPolicy(
            None,
            &attributes,
            (POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES) as u32,
            &mut handle,
        )
    };
    lsa_result(CONTEXT, status)?;
    let _policy = Policy(handle);

    let mut name: Vec<u16> = right.encode_utf16().collect();
    let bytes = u16::try_from(name.len() * 2).map_err(|_| PlatformError::Os {
        context: CONTEXT,
        code: 0,
        message: "Name des Rechts zu lang".into(),
    })?;
    let rights = [LSA_UNICODE_STRING {
        Length: bytes,
        MaximumLength: bytes,
        Buffer: PWSTR(name.as_mut_ptr()),
    }];
    // SAFETY: Handle, SID und der Puffer des Namens leben bis zum Ende des Aufrufs.
    let status = unsafe { LsaAddAccountRights(handle, psid, &rights) };
    lsa_result(CONTEXT, status)
}

/// Offene Richtlinie der LSA; wird beim Drop geschlossen.
struct Policy(LSA_HANDLE);

impl Drop for Policy {
    fn drop(&mut self) {
        // SAFETY: Das Handle stammt aus LsaOpenPolicy und wird danach nicht mehr benutzt.
        unsafe {
            let _ = LsaClose(self.0);
        }
    }
}

fn lsa_result(context: &'static str, status: NTSTATUS) -> Result<(), PlatformError> {
    if status.is_ok() {
        return Ok(());
    }
    // SAFETY: reine Umrechnung des Statuscodes.
    let code = unsafe { LsaNtStatusToWinError(status) };
    Err(os_error(
        context,
        &windows::core::Error::from_hresult(HRESULT::from_win32(code)),
    ))
}

/// Meldet sich mit Anmeldetyp „Dienst“ an (so wie später der SCM) und schließt das Token gleich
/// wieder. [`PlatformError::LogonFailed`] mit dem Win32-Code, wenn Windows ablehnt.
pub fn check_logon(
    user: &str,
    domain: Option<&str>,
    password: &Secret,
) -> Result<(), PlatformError> {
    let user = HSTRING::from(user);
    let domain = domain.map(HSTRING::from);
    let password: Zeroizing<Vec<u16>> =
        Zeroizing::new(password.expose().encode_utf16().chain([0]).collect());
    let mut token = HANDLE::default();
    // SAFETY: Alle Texte sind nullterminiert und leben bis zum Ende des Aufrufs; `token` ist
    // beschreibbar.
    let result = unsafe {
        LogonUserW(
            &user,
            domain
                .as_ref()
                .map_or(PCWSTR::null(), |domain| PCWSTR(domain.as_ptr())),
            PCWSTR(password.as_ptr()),
            LOGON32_LOGON_SERVICE,
            LOGON32_PROVIDER_DEFAULT,
            &mut token,
        )
    };
    match result {
        Ok(()) => {
            // SAFETY: Das Token stammt aus LogonUserW und wird danach nicht mehr benutzt.
            let _ = unsafe { CloseHandle(token) };
            Ok(())
        }
        Err(error) => Err(PlatformError::LogonFailed(win32_code(
            error.code().0 as u32,
        ))),
    }
}

/// Legt den Dienst nach `plan` an (`true`) oder ändert einen vorhandenen (`false`): Konto und
/// Passwort, Programm, Start automatisch (verzögert), Beschreibung, Wiederherstellung.
pub fn configure_service(
    plan: &ServicePlan,
    account: &str,
    password: &Secret,
) -> Result<bool, PlatformError> {
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|error| service_error("Dienststeuerung öffnen", error))?;
    let access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::QUERY_CONFIG
        | ServiceAccess::CHANGE_CONFIG
        // SC_ACTION_RESTART in den Fehleraktionen verlangt das Startrecht
        | ServiceAccess::START;
    let mut info = ServiceInfo {
        name: plan.name.into(),
        display_name: plan.display_name.into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: plan.executable.clone(),
        launch_arguments: plan.arguments.iter().map(OsString::from).collect(),
        dependencies: Vec::new(),
        account_name: Some(account.into()),
        account_password: Some(OsString::from(password.expose())),
    };
    let result = match manager.open_service(plan.name, access) {
        Ok(service) => service.change_config(&info).map(|()| (service, false)),
        Err(error) if os_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST.0) => manager
            .create_service(&info, access)
            .map(|service| (service, true)),
        Err(error) => Err(error),
    };
    // Die eigene Kopie des Passworts sofort überschreiben
    if let Some(copy) = info.account_password.take() {
        drop(Zeroizing::new(copy.into_encoded_bytes()));
    }
    let (service, created) = result.map_err(|error| service_error("Dienst einrichten", error))?;

    service
        .set_description(plan.description)
        .map_err(|error| service_error("Dienstbeschreibung setzen", error))?;
    service
        .set_delayed_auto_start(plan.delayed_auto_start)
        .map_err(|error| service_error("Verzögerten Start setzen", error))?;
    service
        .update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(plan.recovery_reset),
            reboot_msg: None,
            command: None,
            actions: Some(
                plan.recovery
                    .iter()
                    .map(|delay| ServiceAction {
                        action_type: ServiceActionType::Restart,
                        delay: *delay,
                    })
                    .collect(),
            ),
        })
        .map_err(|error| service_error("Wiederherstellung setzen", error))?;
    service
        .set_failure_actions_on_non_crash_failures(plan.failure_actions_on_non_crash)
        .map_err(|error| service_error("Wiederherstellung setzen", error))?;
    Ok(created)
}

/// Ersetzt die DACL des Dienstes `name` durch `sddl` (nur `D:…`).
pub fn set_service_security(name: &str, sddl: &str) -> Result<(), PlatformError> {
    let service = open(name, ServiceAccess::READ_CONTROL | ServiceAccess::WRITE_DAC)?;
    let descriptor = Descriptor::from_sddl(sddl)?;
    // SAFETY: Handle und Sicherheitsbeschreibung leben bis zum Ende des Aufrufs.
    unsafe {
        SetServiceObjectSecurity(
            SC_HANDLE(service.raw_handle()),
            DACL_SECURITY_INFORMATION,
            descriptor.raw,
        )
    }
    .map_err(|error| os_error("Rechte am Dienst setzen", &error))
}

/// Entfernt den Dienst (gestoppt hat ihn der Aufrufer). `false`, wenn es ihn nicht gab. Windows
/// löscht ihn endgültig, sobald niemand mehr ein Handle darauf hält.
pub fn delete_service(name: &str) -> Result<bool, PlatformError> {
    let service = match open(name, ServiceAccess::DELETE) {
        Ok(service) => service,
        Err(PlatformError::ServiceNotInstalled) => return Ok(false),
        Err(error) => return Err(error),
    };
    service
        .delete()
        .map_err(|error| service_error("Dienst entfernen", error))?;
    Ok(true)
}
