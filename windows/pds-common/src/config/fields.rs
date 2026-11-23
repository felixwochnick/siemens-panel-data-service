//! Zugriff auf einzelne Felder per Pfad (`db.port`), für `config set` und `config show`.

use thiserror::Error;

use super::masking::MASK;
use super::model::{Config, DbKind, SecretField, TlsMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldDef {
    pub path: &'static str,
    pub secret: bool,
}

const fn plain(path: &'static str) -> FieldDef {
    FieldDef {
        path,
        secret: false,
    }
}

const fn secret(field: SecretField) -> FieldDef {
    FieldDef {
        path: field.path(),
        secret: true,
    }
}

/// Alle Felder außer `schema`.
pub const FIELDS: &[FieldDef] = &[
    plain("public.host"),
    plain("public.port"),
    plain("public.scheme"),
    plain("listen.http_port"),
    plain("internal.port"),
    plain("tls.mode"),
    plain("tls.acme_email"),
    plain("tls.acme_ca_url"),
    plain("tls.acme_ca_root"),
    plain("tls.acme_eab_key_id"),
    secret(SecretField::AcmeEabHmac),
    plain("db.kind"),
    plain("db.path"),
    plain("db.server"),
    plain("db.port"),
    plain("db.database"),
    plain("db.user"),
    secret(SecretField::DbPassword),
    plain("db.encrypt"),
    plain("db.trust_server_certificate"),
    plain("oidc.tenant_id"),
    plain("oidc.issuer"),
    plain("oidc.client_id"),
    secret(SecretField::OidcClientSecret),
    plain("oidc.scopes"),
    plain("oidc.roles_claim"),
    plain("oidc.admin_roles"),
    plain("oidc.provider_name"),
    plain("proxy.url"),
    plain("proxy.no_proxy"),
    plain("mcp.enabled"),
    secret(SecretField::AppSecret),
];

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FieldError {
    #[error("Unbekanntes Feld")]
    UnknownField,
    /// Secrets nie über diesen Weg, sonst stünden sie in Argumenten und Verläufen.
    #[error("Secret-Felder lassen sich nicht als Klartext setzen")]
    SecretNotAllowed,
    #[error("Ungültiger Wert, erwartet: {expected}")]
    InvalidValue { expected: &'static str },
}

fn parse_port(value: &str) -> Result<u16, FieldError> {
    value.parse().map_err(|_| FieldError::InvalidValue {
        expected: "Zahl von 0 bis 65535",
    })
}

fn parse_bool(value: &str) -> Result<bool, FieldError> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(FieldError::InvalidValue {
            expected: "true oder false",
        }),
    }
}

fn parse_mode(value: &str) -> Result<TlsMode, FieldError> {
    TlsMode::parse(value).ok_or(FieldError::InvalidValue {
        expected: "certificate, acme, internal oder off",
    })
}

fn parse_kind(value: &str) -> Result<DbKind, FieldError> {
    DbKind::parse(value).ok_or(FieldError::InvalidValue {
        expected: "sqlite oder sqlserver",
    })
}

/// Setzt ein Nicht-Secret-Feld. Bei einem Fehler bleibt die Konfiguration unverändert.
pub fn set_field(cfg: &mut Config, path: &str, value: &str) -> Result<(), FieldError> {
    if SecretField::from_path(path).is_some() {
        return Err(FieldError::SecretNotAllowed);
    }
    let text = || value.to_owned();
    match path {
        "public.host" => cfg.public.host = text(),
        "public.port" => cfg.public.port = parse_port(value)?,
        "public.scheme" => cfg.public.scheme = text(),
        "listen.http_port" => cfg.listen.http_port = parse_port(value)?,
        "internal.port" => cfg.internal.port = parse_port(value)?,
        "tls.mode" => cfg.tls.mode = parse_mode(value)?,
        "tls.acme_email" => cfg.tls.acme_email = text(),
        "tls.acme_ca_url" => cfg.tls.acme_ca_url = text(),
        "tls.acme_ca_root" => cfg.tls.acme_ca_root = text(),
        "tls.acme_eab_key_id" => cfg.tls.acme_eab_key_id = text(),
        "db.kind" => cfg.db.kind = parse_kind(value)?,
        "db.path" => cfg.db.path = text(),
        "db.server" => cfg.db.server = text(),
        "db.port" => cfg.db.port = parse_port(value)?,
        "db.database" => cfg.db.database = text(),
        "db.user" => cfg.db.user = text(),
        "db.encrypt" => cfg.db.encrypt = parse_bool(value)?,
        "db.trust_server_certificate" => cfg.db.trust_server_certificate = parse_bool(value)?,
        "oidc.tenant_id" => cfg.oidc.tenant_id = text(),
        "oidc.issuer" => cfg.oidc.issuer = text(),
        "oidc.client_id" => cfg.oidc.client_id = text(),
        "oidc.scopes" => cfg.oidc.scopes = text(),
        "oidc.roles_claim" => cfg.oidc.roles_claim = text(),
        "oidc.admin_roles" => cfg.oidc.admin_roles = text(),
        "oidc.provider_name" => cfg.oidc.provider_name = text(),
        "proxy.url" => cfg.proxy.url = text(),
        "proxy.no_proxy" => cfg.proxy.no_proxy = text(),
        "mcp.enabled" => cfg.mcp.enabled = parse_bool(value)?,
        _ => return Err(FieldError::UnknownField),
    }
    Ok(())
}

/// Wert eines Feldes als Text. Gesetzte Secrets erscheinen als `***`, leere als `""`.
pub fn get_field(cfg: &Config, path: &str) -> Option<String> {
    if let Some(field) = SecretField::from_path(path) {
        let masked = if cfg.sealed(field).is_empty() {
            ""
        } else {
            MASK
        };
        return Some(masked.to_owned());
    }
    let value = match path {
        "public.host" => cfg.public.host.clone(),
        "public.port" => cfg.public.port.to_string(),
        "public.scheme" => cfg.public.scheme.clone(),
        "listen.http_port" => cfg.listen.http_port.to_string(),
        "internal.port" => cfg.internal.port.to_string(),
        "tls.mode" => cfg.tls.mode.as_str().to_owned(),
        "tls.acme_email" => cfg.tls.acme_email.clone(),
        "tls.acme_ca_url" => cfg.tls.acme_ca_url.clone(),
        "tls.acme_ca_root" => cfg.tls.acme_ca_root.clone(),
        "tls.acme_eab_key_id" => cfg.tls.acme_eab_key_id.clone(),
        "db.kind" => cfg.db.kind.as_str().to_owned(),
        "db.path" => cfg.db.path.clone(),
        "db.server" => cfg.db.server.clone(),
        "db.port" => cfg.db.port.to_string(),
        "db.database" => cfg.db.database.clone(),
        "db.user" => cfg.db.user.clone(),
        "db.encrypt" => cfg.db.encrypt.to_string(),
        "db.trust_server_certificate" => cfg.db.trust_server_certificate.to_string(),
        "oidc.tenant_id" => cfg.oidc.tenant_id.clone(),
        "oidc.issuer" => cfg.oidc.issuer.clone(),
        "oidc.client_id" => cfg.oidc.client_id.clone(),
        "oidc.scopes" => cfg.oidc.scopes.clone(),
        "oidc.roles_claim" => cfg.oidc.roles_claim.clone(),
        "oidc.admin_roles" => cfg.oidc.admin_roles.clone(),
        "oidc.provider_name" => cfg.oidc.provider_name.clone(),
        "proxy.url" => cfg.proxy.url.clone(),
        "proxy.no_proxy" => cfg.proxy.no_proxy.clone(),
        "mcp.enabled" => cfg.mcp.enabled.to_string(),
        _ => return None,
    };
    Some(value)
}
