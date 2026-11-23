//! Supervisor: startet Caddy und Node, beobachtet sie, ordnet ihr Ende ein und startet nach
//! Wartezeit neu.
//!
//! Ohne Prozesse testbar sind die Klassifizierung eines Kindendes, der Backoff, das Schwärzen von
//! Secrets und der Zeilenpuffer. Darauf setzen der Startplan (`planner`), der einzelne Kindprozess
//! (`process`) und die Laufzeit (`runtime`) auf; `production` baut alles für den Betrieb zusammen.

pub mod backoff;
pub mod classify;
pub mod planner;
pub mod process;
pub mod production;
pub mod redact;
pub mod runtime;
pub mod tail;

pub use backoff::Backoff;
pub use classify::{ChildKind, ExitClass, MAX_MESSAGE_CHARS, classify_exit, shorten_message};
pub use planner::{ConfigPlanner, LaunchPlan, LaunchPlanner};
pub use process::ChildSpec;
pub use production::{FileStatusSink, InternalProbe, build_production};
pub use redact::Redactor;
pub use runtime::{HealthProbe, LogSinks, StatusSink, Supervisor, SupervisorOptions};
pub use tail::TailBuffer;
