//! Datenmodell von `config.toml`, Secrets und das Versiegeln einzelner Felder.

use std::fmt;
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;
use ts_rs::TS;
use zeroize::Zeroizing;

use crate::paths::Paths;
use crate::protect::{ProtectError, Protector, is_known_scheme};
use crate::secret::Secret;

/// Aktuelle Version des Dateiformats.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ConfigError {
    /// Datei nicht lesbar oder kein gültiges TOML (auch unbekannte Felder). Nur der Text der
    /// Meldung, nie Zeilen der Datei: Dort könnte ein von Hand eingetragenes Secret stehen.
    #[error("Konfiguration nicht lesbar: {0}")]
    Unreadable(String),
    #[error("Die Konfigurationsversion {0} wird nicht unterstützt")]
    UnsupportedSchema(u32),
    /// Secret-Feld ist weder leer noch versiegelt (Klartext von Hand eingetragen).
    #[error("Das Secret {0} liegt unverschlüsselt vor")]
    UnsealedSecret(&'static str),
    /// Versiegelter Wert lässt sich nicht öffnen (beschädigt oder von einem anderen Rechner).
    #[error("Das Secret {field} lässt sich nicht entschlüsseln: {reason}")]
    SecretUnreadable { field: &'static str, reason: String },
    #[error("Konfiguration konnte nicht gespeichert werden: {0}")]
    Write(String),
    #[error(transparent)]
    Protect(#[from] ProtectError),
}

impl ConfigError {
    /// Stabiler Code für UI und CLI.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreadable(_) => "config_unreadable",
            Self::UnsupportedSchema(_) => "config_schema_unsupported",
            Self::UnsealedSecret(_) => "config_secret_unsealed",
            Self::SecretUnreadable { .. } => "config_secret_unreadable",
            Self::Write(_) => "config_write_failed",
            Self::Protect(_) => "secret_protect_failed",
        }
    }
}

/// Verschlüsselter Wert eines Secret-Feldes: leer oder `<schema>:<base64>`. Das Feld ist
/// öffentlich, damit Tests und Import auch fehlerhafte Werte (Klartext) nachstellen können.
///
/// In TypeScript ein `string` (`#[ts(type = "string")]` an den Feldern): Die UI sieht nur die
/// maskierte Sicht (`***` = gesetzt, `""` = leer) und schickt dazu neuen Klartext.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Sealed(pub String);

impl Sealed {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Ist der Wert mit genau diesem Schema versiegelt?
    pub fn is_sealed(&self, scheme: &str) -> bool {
        self.payload(scheme).is_some()
    }

    /// Der Teil nach `<schema>:`.
    fn payload(&self, scheme: &str) -> Option<&str> {
        self.0.strip_prefix(scheme)?.strip_prefix(':')
    }

    /// Trägt der Wert das Präfix irgendeines bekannten Schemas?
    pub(crate) fn has_known_scheme(&self) -> bool {
        self.0
            .split_once(':')
            .is_some_and(|(scheme, _)| is_known_scheme(scheme))
    }
}

// Der Inhalt kann bei Fehlbedienung Klartext sein, deshalb nie ausgeben.
impl fmt::Debug for Sealed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_empty() {
            f.write_str("Sealed(\"\")")
        } else {
            f.write_str("Sealed(***)")
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TlsMode {
    #[default]
    Certificate,
    Acme,
    Internal,
    Off,
}

impl TlsMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Certificate => "certificate",
            Self::Acme => "acme",
            Self::Internal => "internal",
            Self::Off => "off",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [Self::Certificate, Self::Acme, Self::Internal, Self::Off]
            .into_iter()
            .find(|mode| mode.as_str() == value)
    }
}

/// Die Felder, deren Wert verschlüsselt gespeichert wird.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretField {
    DbPassword,
    OidcClientSecret,
    AppSecret,
    AcmeEabHmac,
}

impl SecretField {
    pub const ALL: [SecretField; 4] = [
        Self::DbPassword,
        Self::OidcClientSecret,
        Self::AppSecret,
        Self::AcmeEabHmac,
    ];

    /// Feldpfad wie in `config set` und in den Befunden.
    pub const fn path(self) -> &'static str {
        match self {
            Self::DbPassword => "db.password",
            Self::OidcClientSecret => "oidc.client_secret",
            Self::AppSecret => "app.secret",
            Self::AcmeEabHmac => "tls.acme_eab_hmac",
        }
    }

    pub fn from_path(path: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|field| field.path() == path)
    }
}

/// Geöffnete Secrets. `None` = nicht gesetzt.
#[derive(Debug, Clone, Default)]
pub struct Secrets {
    pub db_password: Option<Secret>,
    pub oidc_client_secret: Option<Secret>,
    pub app_secret: Option<Secret>,
    pub acme_eab_hmac: Option<Secret>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, default)]
#[ts(export)]
pub struct Config {
    pub schema: u32,
    pub public: PublicConfig,
    pub listen: ListenConfig,
    pub internal: InternalConfig,
    pub tls: TlsConfig,
    pub db: DbConfig,
    pub oidc: OidcConfig,
    pub proxy: ProxyConfig,
    pub mcp: McpConfig,
    pub app: AppConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema: SCHEMA_VERSION,
            public: PublicConfig::default(),
            listen: ListenConfig::default(),
            internal: InternalConfig::default(),
            tls: TlsConfig::default(),
            db: DbConfig::default(),
            oidc: OidcConfig::default(),
            proxy: ProxyConfig::default(),
            mcp: McpConfig::default(),
            app: AppConfig::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, default)]
#[ts(export)]
pub struct PublicConfig {
    pub host: String,
    pub port: u16,
    /// Nur bei `tls.mode = "off"` wirksam.
    pub scheme: String,
}

impl Default for PublicConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 443,
            scheme: "https".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, default)]
#[ts(export)]
pub struct ListenConfig {
    pub http_port: u16,
}

impl Default for ListenConfig {
    fn default() -> Self {
        Self { http_port: 80 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, default)]
#[ts(export)]
pub struct InternalConfig {
    pub port: u16,
}

impl Default for InternalConfig {
    fn default() -> Self {
        Self { port: 3000 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, default)]
#[ts(export)]
pub struct TlsConfig {
    pub mode: TlsMode,
    pub acme_email: String,
    pub acme_ca_url: String,
    pub acme_ca_root: String,
    pub acme_eab_key_id: String,
    #[ts(type = "string")]
    pub acme_eab_hmac: Sealed,
}

/// Art der Datenbank: SQL Server (Standard: dort werden die Analyse-Ergebnisse weiterverarbeitet)
/// oder eine SQLite-Datei auf diesem Rechner (kleine Installationen, Tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum DbKind {
    Sqlite,
    #[default]
    Sqlserver,
}

impl DbKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::Sqlserver => "sqlserver",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [Self::Sqlite, Self::Sqlserver]
            .into_iter()
            .find(|kind| kind.as_str() == value)
    }
}

/// Datenbank. Bei `sqlite` zählt nur `path`, die übrigen Felder gelten für SQL Server und bleiben
/// gespeichert, damit ein Wechsel der Art nichts verliert.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct DbConfig {
    pub kind: DbKind,
    /// SQLite-Datei; leer = `data\pds.db` im Datenordner.
    pub path: String,
    pub server: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    #[ts(type = "string")]
    pub password: Sealed,
    pub encrypt: bool,
    pub trust_server_certificate: bool,
}

impl Default for DbConfig {
    fn default() -> Self {
        Self {
            kind: DbKind::Sqlserver,
            path: String::new(),
            server: String::new(),
            port: 1433,
            database: "pds".into(),
            user: "pds_app".into(),
            password: Sealed::default(),
            encrypt: true,
            trust_server_certificate: false,
        }
    }
}

impl DbConfig {
    /// Die SQLite-Datei, die die App öffnet: der eingetragene Pfad oder der Standard im Datenordner.
    pub fn sqlite_file(&self, paths: &Paths) -> PathBuf {
        match self.path.trim() {
            "" => paths.default_sqlite_file(),
            path => PathBuf::from(path),
        }
    }

    /// Ist ein eigener Pfad eingetragen (statt des Standards im Datenordner)?
    pub fn has_custom_path(&self) -> bool {
        !self.path.trim().is_empty()
    }
}

// Eigenes Lesen nur wegen `kind`: Dateien ohne das Feld (aus dem ESWC übernommenes Format) gelten als
// SQL Server, den Standard des Panel Data Service. Gespeichert wird `kind` danach immer.
impl<'de> Deserialize<'de> for DbConfig {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, default)]
        struct Stored {
            kind: Option<DbKind>,
            path: String,
            server: String,
            port: u16,
            database: String,
            user: String,
            password: Sealed,
            encrypt: bool,
            trust_server_certificate: bool,
        }

        impl Default for Stored {
            fn default() -> Self {
                let db = DbConfig::default();
                Self {
                    kind: None,
                    path: db.path,
                    server: db.server,
                    port: db.port,
                    database: db.database,
                    user: db.user,
                    password: db.password,
                    encrypt: db.encrypt,
                    trust_server_certificate: db.trust_server_certificate,
                }
            }
        }

        let stored = Stored::deserialize(deserializer)?;
        let kind = stored.kind.unwrap_or_default();
        Ok(Self {
            kind,
            path: stored.path,
            server: stored.server,
            port: stored.port,
            database: stored.database,
            user: stored.user,
            password: stored.password,
            encrypt: stored.encrypt,
            trust_server_certificate: stored.trust_server_certificate,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, default)]
#[ts(export)]
pub struct OidcConfig {
    pub tenant_id: String,
    pub issuer: String,
    pub client_id: String,
    #[ts(type = "string")]
    pub client_secret: Sealed,
    pub scopes: String,
    pub roles_claim: String,
    pub admin_roles: String,
    pub provider_name: String,
}

impl Default for OidcConfig {
    fn default() -> Self {
        Self {
            tenant_id: String::new(),
            issuer: String::new(),
            client_id: String::new(),
            client_secret: Sealed::default(),
            scopes: "openid profile email".into(),
            roles_claim: "roles".into(),
            admin_roles: "Admin".into(),
            provider_name: "Microsoft".into(),
        }
    }
}

impl OidcConfig {
    /// Tenant-Modus: Der Issuer wird aus der Tenant-ID gebildet. Ein eigener Issuer ersetzt sie,
    /// dann bleibt `tenant_id` ungenutzt. Prüfung und Rendern fragen beide hier, damit sie
    /// nicht auseinanderlaufen.
    pub fn tenant_mode(&self) -> bool {
        self.issuer.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, default)]
#[ts(export)]
pub struct ProxyConfig {
    pub url: String,
    pub no_proxy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, default)]
#[ts(export)]
pub struct McpConfig {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, default)]
#[ts(export)]
pub struct AppConfig {
    #[ts(type = "string")]
    pub secret: Sealed,
}

/// Verschlüsselt den Klartext und liefert `<schema>:<base64>`.
pub(crate) fn seal_secret(
    secret: &Secret,
    protector: &dyn Protector,
) -> Result<Sealed, ProtectError> {
    let blob = Zeroizing::new(protector.protect(secret.expose().as_bytes())?);
    Ok(Sealed(format!(
        "{}:{}",
        protector.scheme(),
        STANDARD.encode(&*blob)
    )))
}

impl Config {
    pub fn sealed(&self, field: SecretField) -> &Sealed {
        match field {
            SecretField::DbPassword => &self.db.password,
            SecretField::OidcClientSecret => &self.oidc.client_secret,
            SecretField::AppSecret => &self.app.secret,
            SecretField::AcmeEabHmac => &self.tls.acme_eab_hmac,
        }
    }

    pub(crate) fn sealed_mut(&mut self, field: SecretField) -> &mut Sealed {
        match field {
            SecretField::DbPassword => &mut self.db.password,
            SecretField::OidcClientSecret => &mut self.oidc.client_secret,
            SecretField::AppSecret => &mut self.app.secret,
            SecretField::AcmeEabHmac => &mut self.tls.acme_eab_hmac,
        }
    }

    /// Setzt ein Secret verschlüsselt. `None` oder ein leerer Wert löscht es.
    pub fn seal(
        &mut self,
        field: SecretField,
        secret: Option<&Secret>,
        protector: &dyn Protector,
    ) -> Result<(), ConfigError> {
        *self.sealed_mut(field) = match secret {
            Some(secret) if !secret.is_empty() => seal_secret(secret, protector)?,
            _ => Sealed::default(),
        };
        Ok(())
    }

    /// Entschlüsselt alle gesetzten Secrets.
    pub fn open_secrets(&self, protector: &dyn Protector) -> Result<Secrets, ConfigError> {
        Ok(Secrets {
            db_password: self.open(SecretField::DbPassword, protector)?,
            oidc_client_secret: self.open(SecretField::OidcClientSecret, protector)?,
            app_secret: self.open(SecretField::AppSecret, protector)?,
            acme_eab_hmac: self.open(SecretField::AcmeEabHmac, protector)?,
        })
    }

    fn open(
        &self,
        field: SecretField,
        protector: &dyn Protector,
    ) -> Result<Option<Secret>, ConfigError> {
        let sealed = self.sealed(field);
        if sealed.is_empty() {
            return Ok(None);
        }
        let unreadable = |reason: &str| ConfigError::SecretUnreadable {
            field: field.path(),
            reason: reason.to_owned(),
        };
        let encoded = sealed
            .payload(protector.scheme())
            .ok_or(ConfigError::UnsealedSecret(field.path()))?;
        // Die Fehlertexte von base64 und UTF-8 nennen Bytes des Wertes, deshalb eigene Texte.
        let blob = Zeroizing::new(
            STANDARD
                .decode(encoded)
                .map_err(|_| unreadable("kein gültiges Base64"))?,
        );
        let plain = protector
            .unprotect(&blob)
            .map_err(|error| unreadable(&error.to_string()))?;
        let text =
            std::str::from_utf8(&plain).map_err(|_| unreadable("kein gültiger UTF-8-Text"))?;
        Ok(Some(Secret::new(text)))
    }
}
