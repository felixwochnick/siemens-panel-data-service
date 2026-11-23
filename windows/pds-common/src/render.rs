//! Rendern von App-Umgebung und Caddy-Konfiguration aus der geprüften Konfiguration.
//!
//! Alles hier ist rein: Es liest weder Dateien noch Umgebung. Der Aufrufer (der Supervisor)
//! validiert vorher mit [`crate::validate`], deshalb gibt es keine Fehlerfälle. Secrets gehen
//! nur über den Umgebungsblock der Kinder (Node) und über stdin (Caddy), nie über Dateien oder
//! Argumente. Die URL-Form der App folgt `parseDatabaseUrl` bzw. `parseSqliteUrl` in `packages/core`
//! und der Origin-Prüfung in `02.request-guard.ts`.

use std::net::Ipv6Addr;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::Paths;
use crate::config::{Config, DbKind, Secrets, TlsMode};
use crate::secret::Secret;
use crate::tls::TlsMaterial;

/// Die App hört nur auf der Loopback-Adresse, von außen kommt Caddy.
const APP_HOST: &str = "127.0.0.1";
/// So lange darf Nitro beim Beenden offene Anfragen abarbeiten (ms).
const NITRO_SHUTDOWN_TIMEOUT_MS: &str = "10000";
/// Obergrenze für Anfragekörper (2 MB), zusätzlich zur Grenze der App in `02.request-guard.ts`.
const MAX_REQUEST_BODY_BYTES: u64 = 2_000_000;
/// Schlagwort am Zertifikat, damit sich Caddys Protokoll darauf beziehen lässt.
const CERTIFICATE_TAG: &str = "pds";
/// Diese Adressen gehen nie über den Proxy: Caddy spricht mit der App, die App mit sich selbst.
const LOCAL_NO_PROXY: &str = "127.0.0.1,localhost";

/// Alles außer `A–Z a–z 0–9 - . _ ~` wird kodiert, wie bei `encodeURIComponent`.
const URL_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

// ---------------------------------------------------------------------------------------------
// Adressen
// ---------------------------------------------------------------------------------------------

/// Öffentliche Adresse ohne abschließenden `/`. Die App vergleicht den `Origin` der Browser
/// exakt mit `new URL(...).origin`, deshalb steht der Port nur da, wo er nicht der Standard ist.
pub fn app_url(config: &Config) -> String {
    let public = &config.public;
    // Das Schema gilt nur bei `off`: Dort terminiert ein vorgelagerter Proxy das TLS.
    let scheme = if config.tls.mode == TlsMode::Off {
        public.scheme.as_str()
    } else {
        "https"
    };
    let default_port = if scheme == "http" { 80 } else { 443 };

    // Kleingeschrieben, wie der Origin der Browser: Redirect-URI und MCP-Issuer sind so kanonisch
    let host = url_host(&public.host.to_ascii_lowercase());
    if public.port == default_port {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{}", public.port)
    }
}

/// Issuer der Anmeldung: der eigene ohne abschließenden `/`, sonst der von Entra ID.
pub fn issuer(config: &Config) -> String {
    let oidc = &config.oidc;
    if oidc.tenant_mode() {
        format!("https://login.microsoftonline.com/{}/v2.0", oidc.tenant_id)
    } else {
        oidc.issuer.trim_end_matches('/').to_owned()
    }
}

pub fn redirect_uri(config: &Config) -> String {
    format!("{}/auth/callback", app_url(config))
}

/// Ein IPv6-Literal als öffentlicher Host braucht in einer URL Klammern, sonst lehnt `new URL`
/// es ab oder zerlegt es an den Doppelpunkten.
fn url_host(host: &str) -> String {
    match host.parse::<Ipv6Addr>() {
        Ok(_) => format!("[{host}]"),
        Err(_) => host.to_owned(),
    }
}

/// Das Ergebnis kann ein Passwort sein und wird beim Freigeben überschrieben.
fn encode(value: &str) -> Zeroizing<String> {
    Zeroizing::new(utf8_percent_encode(value, URL_COMPONENT).to_string())
}

/// `NUXT_DATABASE_URL` je nach Art der Datenbank: `sqlite:<pfad>` (der Pfad roh, wie
/// `parseSqliteUrl` ihn liest; ohne eigenen Pfad die Datei im Datenordner) oder die URL des
/// SQL Servers ([`sqlserver_url`]). Für SQLite spielt `password` keine Rolle.
pub fn database_url(config: &Config, paths: &Paths, password: &Secret) -> Secret {
    match config.db.kind {
        DbKind::Sqlite => Secret::new(format!("sqlite:{}", config.db.sqlite_file(paths).display())),
        DbKind::Sqlserver => sqlserver_url(config, password),
    }
}

/// URL des SQL Servers (`mssql://…`). Benutzer, Passwort und Datenbank werden kodiert, weil
/// `parseDatabaseUrl` sie mit `decodeURIComponent` zurückholt. Der Server bleibt unkodiert,
/// die App nimmt ihn wörtlich (`url.hostname`); die Validierung stellt sicher, dass er ein
/// Hostname oder eine IPv4-Adresse ist (kein IPv6, das bräuchte Klammern).
pub fn sqlserver_url(config: &Config, password: &Secret) -> Secret {
    let db = &config.db;
    let user = encode(&db.user);
    let password = encode(password.expose());
    let database = encode(&db.database);
    Secret::new(format!(
        "mssql://{user}:{password}@{server}:{port}/{database}\
         ?encrypt={encrypt}&trustServerCertificate={trust}",
        user = user.as_str(),
        password = password.as_str(),
        server = db.server,
        port = db.port,
        database = database.as_str(),
        encrypt = db.encrypt,
        trust = db.trust_server_certificate,
    ))
}

// ---------------------------------------------------------------------------------------------
// Umgebung der Kindprozesse
// ---------------------------------------------------------------------------------------------

fn plain(key: &str, value: impl Into<String>) -> (String, Secret) {
    (key.to_owned(), Secret::new(value))
}

fn secret_or_empty(secret: &Option<Secret>) -> Secret {
    secret.clone().unwrap_or_default()
}

/// Umgebung der Node-App: die Laufzeitkonfiguration von Nuxt (`NUXT_*`) und Nitro.
/// `NUXT_LOG_DIR` zeigt auf die Logs des Dienstes, damit die Web-Konsole sie anzeigen kann.
pub fn app_env(
    config: &Config,
    secrets: &Secrets,
    paths: &Paths,
    version: &str,
) -> Vec<(String, Secret)> {
    let app_url = app_url(config);
    let oidc = &config.oidc;
    // Das Cookie trägt nur über https das `Secure`-Attribut; über http würde der Browser es verwerfen
    let cookie_secure = app_url.starts_with("https://");

    let mut env = vec![
        plain("NODE_ENV", "production"),
        plain("HOST", APP_HOST),
        plain("PORT", config.internal.port.to_string()),
        plain("PDS_VERSION", version),
        plain("NITRO_SHUTDOWN_TIMEOUT", NITRO_SHUTDOWN_TIMEOUT_MS),
        (
            "NUXT_DATABASE_URL".to_owned(),
            database_url(config, paths, &secret_or_empty(&secrets.db_password)),
        ),
        (
            "NUXT_APP_SECRET".to_owned(),
            secret_or_empty(&secrets.app_secret),
        ),
        plain("NUXT_PUBLIC_APP_URL", app_url),
        plain("NUXT_SESSION_COOKIE_SECURE", cookie_secure.to_string()),
        plain("NUXT_OIDC_ISSUER", issuer(config)),
        plain("NUXT_OIDC_CLIENT_ID", oidc.client_id.as_str()),
        (
            "NUXT_OIDC_CLIENT_SECRET".to_owned(),
            secret_or_empty(&secrets.oidc_client_secret),
        ),
        plain("NUXT_OIDC_SCOPES", oidc.scopes.as_str()),
        plain("NUXT_OIDC_ROLES_CLAIM", oidc.roles_claim.as_str()),
        plain("NUXT_OIDC_ADMIN_ROLES", oidc.admin_roles.as_str()),
        plain(
            "NUXT_PUBLIC_OIDC_PROVIDER_NAME",
            oidc.provider_name.as_str(),
        ),
        plain("NUXT_PUBLIC_MCP_ENABLED", config.mcp.enabled.to_string()),
        plain("NUXT_LOG_DIR", paths.logs_dir().to_string_lossy()),
    ];
    env.extend(proxy_variables(config));
    env
}

/// Umgebung von Caddy: Ablage im Datenordner (nicht im Profil des Dienstkontos) und der
/// ausgehende Proxy, über den ACME die CA erreicht.
pub fn proxy_env(config: &Config, paths: &Paths) -> Vec<(String, Secret)> {
    let caddy_dir = paths.caddy_dir();
    let mut env = vec![
        plain("XDG_DATA_HOME", caddy_dir.to_string_lossy()),
        plain(
            "XDG_CONFIG_HOME",
            caddy_dir.join("config").to_string_lossy(),
        ),
    ];
    env.extend(proxy_variables(config));
    env
}

/// Ausgehender Proxy, nur bei gesetzter Adresse. `NODE_USE_ENV_PROXY` schaltet ihn in Nodes
/// `fetch` ein (Node liest die Variablen sonst nicht), Caddy (Go) ignoriert es.
pub(crate) fn proxy_variables(config: &Config) -> Vec<(String, Secret)> {
    let proxy = &config.proxy;
    if proxy.url.is_empty() {
        return Vec::new();
    }
    // Eigene Ausnahmen ohne Leerraum und leere Einträge, dann die lokalen Adressen
    let mut entries: Vec<&str> = proxy
        .no_proxy
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    entries.push(LOCAL_NO_PROXY);
    let no_proxy = entries.join(",");
    vec![
        plain("HTTPS_PROXY", proxy.url.as_str()),
        plain("HTTP_PROXY", proxy.url.as_str()),
        plain("NO_PROXY", no_proxy),
        plain("NODE_USE_ENV_PROXY", "1"),
    ]
}

// ---------------------------------------------------------------------------------------------
// Caddy
// ---------------------------------------------------------------------------------------------

/// Die Konfiguration, die Caddy über stdin bekommt (`caddy run --config -`, JSON ohne Adapter).
///
/// Im Modus `certificate` enthält sie Zertifikat und Schlüssel; `tls` muss dort gesetzt sein.
/// Der Aufrufer hat vorher validiert (`certificate_missing` ist ein Fehler), ein fehlendes
/// Material ist hier ein Programmfehler und löst in Debug-Builds einen Abbruch aus; ohne
/// `debug_assert` fiele Caddy sonst stumm auf eigene Zertifikate zurück. In den anderen Modi
/// wird `tls` ignoriert. `eab_hmac` gilt nur für `acme` und nur zusammen mit
/// `tls.acme_eab_key_id`.
pub fn caddy_json(
    config: &Config,
    paths: &Paths,
    tls: Option<&TlsMaterial>,
    eab_hmac: Option<&Secret>,
) -> Secret {
    debug_assert!(
        config.tls.mode != TlsMode::Certificate || tls.is_some(),
        "Im Modus certificate fehlt das Zertifikat: vor dem Rendern validieren"
    );
    let off = config.tls.mode == TlsMode::Off;
    // Bei `off` lauscht nur der HTTP-Port, TLS endet am vorgelagerten Proxy
    let listen_port = if off {
        config.listen.http_port
    } else {
        config.public.port
    };

    let mut http_server = json!({
        "listen": [format!(":{listen_port}")],
        "protocols": ["h1", "h2"],
        "routes": [{
            "match": [{"host": [config.public.host]}],
            "handle": handlers(config),
            "terminal": true,
        }],
    });
    if off {
        http_server["automatic_https"] = json!({"disable": true});
    }

    let mut apps = json!({
        "http": {
            "http_port": config.listen.http_port,
            "https_port": config.public.port,
            "servers": {"pds": http_server},
        },
    });
    match config.tls.mode {
        TlsMode::Certificate => {
            if let Some(tls) = tls {
                apps["tls"] = json!({"certificates": {"load_pem": [{
                    "certificate": tls.chain_pem,
                    "key": tls.key_pem.expose(),
                    "tags": [CERTIFICATE_TAG],
                }]}});
            }
        }
        TlsMode::Acme => apps["tls"] = automation(config, acme_issuer(config, eab_hmac)),
        TlsMode::Internal => {
            apps["tls"] = automation(config, json!({"module": "internal"}));
            // Das Dienstkonto ändert den Vertrauensspeicher des Rechners nicht
            apps["pki"] = json!({"certificate_authorities": {"local": {"install_trust": false}}});
        }
        TlsMode::Off => {}
    }

    let root = json!({
        // Ohne Admin-Schnittstelle und ohne `autosave.json`, das den Schlüssel auf die Platte legte
        "admin": {"disabled": true, "config": {"persist": false}},
        "storage": {"module": "file_system", "root": paths.caddy_dir().to_string_lossy()},
        "logging": {"logs": {"default": {"writer": {"output": "stderr"}, "level": "INFO"}}},
        "apps": apps,
    });
    Secret::new(root.to_string())
}

/// Handler-Kette: Größenlimit, Kompression, Sicherheits-Header, Weiterleitung an die App.
fn handlers(config: &Config) -> Value {
    json!([
        {"handler": "request_body", "max_size": MAX_REQUEST_BODY_BYTES},
        {
            "handler": "encode",
            "encodings": {"zstd": {}, "gzip": {}},
            "prefer": ["zstd", "gzip"],
        },
        {
            "handler": "headers",
            "response": {
                // Aufgeschoben, sonst setzt der Upstream `Server` nach dem Löschen wieder
                "deferred": true,
                "set": {
                    "Strict-Transport-Security": ["max-age=31536000"],
                    "X-Content-Type-Options": ["nosniff"],
                    "X-Frame-Options": ["DENY"],
                    "Referrer-Policy": ["strict-origin-when-cross-origin"],
                },
                "delete": ["Server"],
            },
        },
        {
            "handler": "reverse_proxy",
            "upstreams": [{"dial": format!("{APP_HOST}:{}", config.internal.port)}],
        },
    ])
}

fn automation(config: &Config, issuer: Value) -> Value {
    json!({"automation": {"policies": [{
        "subjects": [config.public.host],
        "issuers": [issuer],
    }]}})
}

fn acme_issuer(config: &Config, eab_hmac: Option<&Secret>) -> Value {
    let tls = &config.tls;
    let mut issuer = json!({"module": "acme", "email": tls.acme_email});
    if !tls.acme_ca_url.is_empty() {
        issuer["ca"] = json!(tls.acme_ca_url);
    }
    if !tls.acme_ca_root.is_empty() {
        issuer["trusted_roots_pem_files"] = json!([tls.acme_ca_root]);
    }
    // Key-ID und HMAC nur gemeinsam: eins allein ließe die Registrierung scheitern
    if let Some(hmac) = eab_hmac.filter(|hmac| !hmac.is_empty())
        && !tls.acme_eab_key_id.is_empty()
    {
        issuer["external_account"] = json!({
            "key_id": tls.acme_eab_key_id,
            "mac_key": hmac.expose(),
        });
    }
    issuer
}

// ---------------------------------------------------------------------------------------------
// Werte für den Redactor
// ---------------------------------------------------------------------------------------------

/// Alle Texte, die in der Ausgabe der Kinder nicht auftauchen dürfen: jedes Secret wörtlich,
/// dazu die Formen, in denen es in Umgebung und Caddy-JSON steht (prozentkodiertes
/// Datenbankpasswort, die ganze `NUXT_DATABASE_URL` des SQL Servers, der JSON-maskierte
/// TLS-Schlüssel mit `\n`). Der Redactor sucht wörtlich und kennt abgeleitete Formen nicht. Eine
/// SQLite-URL enthält kein Secret, nur den Pfad, der in Fehlermeldungen lesbar bleiben soll.
///
/// Braucht die Konfiguration, weil die Datenbank-URL Benutzer, Server und Datenbank enthält.
pub fn secret_values(config: &Config, secrets: &Secrets, tls: Option<&TlsMaterial>) -> Vec<String> {
    let mut values = Values::default();
    for secret in [
        &secrets.db_password,
        &secrets.oidc_client_secret,
        &secrets.app_secret,
        &secrets.acme_eab_hmac,
    ]
    .into_iter()
    .flatten()
    {
        values.add(secret.expose());
    }

    if let Some(password) = secrets.db_password.as_ref().filter(|p| !p.is_empty()) {
        values.add(&encode(password.expose()));
        // Auch bei SQLite: Ein gespeichertes Passwort von früher bleibt ein Secret
        values.add(sqlserver_url(config, password).expose());
    }
    // Der HMAC steht im Caddy-JSON, dort mit maskierten Zeichen
    if let Some(hmac) = &secrets.acme_eab_hmac {
        values.add(&json_escaped(hmac.expose()));
    }
    if let Some(tls) = tls {
        values.add(tls.key_pem.expose());
        values.add(&json_escaped(tls.key_pem.expose()));
    }
    values.0
}

/// Wie `value` im Inneren eines JSON-Strings steht (Zeilenumbruch als `\n`, `"` als `\"`).
fn json_escaped(value: &str) -> String {
    let quoted = Value::String(value.to_owned()).to_string();
    quoted[1..quoted.len() - 1].to_owned()
}

/// Sammelt Werte ohne leere und ohne doppelte: Ein leerer Wert träfe jede Zeile.
#[derive(Default)]
struct Values(Vec<String>);

impl Values {
    fn add(&mut self, value: &str) {
        if !value.is_empty() && !self.0.iter().any(|known| known == value) {
            self.0.push(value.to_owned());
        }
    }
}
