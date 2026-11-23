//! Konfiguration (`config.toml`): Modell, Speicher, Feldzugriff und Maskierung.

pub mod fields;
pub mod masking;
pub mod model;
pub mod store;

pub use model::{
    AppConfig, Config, ConfigError, DbConfig, DbKind, InternalConfig, ListenConfig, McpConfig,
    OidcConfig, ProxyConfig, PublicConfig, SCHEMA_VERSION, Sealed, SecretField, Secrets, TlsConfig,
    TlsMode,
};
pub use store::{load, save};
