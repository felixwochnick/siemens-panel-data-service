//! Job Object für die Kindprozesse (Node, Caddy).
//!
//! Mit `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` beendet Windows alle zugewiesenen Prozesse, sobald das
//! letzte Handle geschlossen ist, auch wenn der Dienst abstürzt oder hart beendet wird. So bleiben
//! keine verwaisten Kinder, die die Ports belegen.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::Child;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows::core::PCWSTR;

use super::os_error;
use crate::platform::PlatformError;

/// Exit-Code der Prozesse, die `terminate` beendet.
const TERMINATED_EXIT_CODE: u32 = 1;

/// Job Object, das seine Prozesse beim Drop beendet. `Send` und `Sync`: Kernel-Handles dürfen von
/// jedem Thread benutzt werden.
#[derive(Debug)]
pub struct JobObject {
    handle: OwnedHandle,
}

impl JobObject {
    pub fn new_kill_on_close() -> Result<Self, PlatformError> {
        // SAFETY: Anonymes Job Object ohne besondere Sicherheitsattribute.
        let raw = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|error| os_error("Job Object anlegen", &error))?;
        // SAFETY: Das Handle ist neu und gehört ab hier nur `handle`, das es beim Drop schließt.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw.0) };
        let job = Self { handle };

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: Zeiger und Größe beschreiben `limits`, das den Aufruf überlebt.
        unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|error| os_error("Job Object einrichten", &error))?;
        Ok(job)
    }

    /// Weist einen gestarteten Prozess zu. Was er danach startet, gehört automatisch dazu.
    pub fn assign(&self, child: &Child) -> Result<(), PlatformError> {
        // SAFETY: Beide Handles sind gültig, solange `self` und `child` leben.
        unsafe { AssignProcessToJobObject(self.raw(), HANDLE(child.as_raw_handle())) }
            .map_err(|error| os_error("Prozess dem Job Object zuweisen", &error))
    }

    /// Beendet alle zugewiesenen Prozesse sofort; das Job Object bleibt benutzbar.
    pub fn terminate(&self) -> Result<(), PlatformError> {
        // SAFETY: Das Handle ist gültig, solange `self` lebt.
        unsafe { TerminateJobObject(self.raw(), TERMINATED_EXIT_CODE) }
            .map_err(|error| os_error("Job Object beenden", &error))
    }

    fn raw(&self) -> HANDLE {
        HANDLE(self.handle.as_raw_handle())
    }
}
