//! Rendern von App-Umgebung und Caddy-JSON: Umgebungsvariablen, URL-Kodierung, TLS-Modi.
//!
//! Das Caddy-JSON wird zurückgeparst und gezielt geprüft (kein Vergleich ganzer Texte), die
//! Zertifikate sind Platzhalter: `render` liest sie nicht, es reicht sie nur durch.

use std::collections::BTreeMap;

use pds_common::Secret;
use pds_common::config::{Config, DbKind, Secrets, TlsMode};
use pds_common::paths::Paths;
use pds_common::render;
use pds_common::tls::TlsMaterial;
use serde_json::{Value, json};

const HOST: &str = "pds.example.com";
const TENANT: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CLIENT: &str = "11111111-2222-3333-4444-555555555555";
const KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUA==\nUVJTVFVWV1hZWjAxMjM0NQ==\n-----END PRIVATE KEY-----\n";
const CHAIN_PEM: &str = "-----BEGIN CERTIFICATE-----\nTEVBRg==\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nUk9PVA==\n-----END CERTIFICATE-----\n";
/// Das Passwort aus dem Auftrag: jedes Sonderzeichen, das in einer URL etwas bedeutet.
const NASTY_PASSWORD: &str = "p@ss:w/rd#?%'ü ";
const NASTY_PASSWORD_ENCODED: &str = "p%40ss%3Aw%2Frd%23%3F%25%27%C3%BC%20";

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------

fn config() -> Config {
    let mut config = Config::default();
    config.public.host = HOST.into();
    config.db.kind = DbKind::Sqlserver;
    config.db.server = "sql.example.com".into();
    config.oidc.tenant_id = TENANT.into();
    config.oidc.client_id = CLIENT.into();
    config
}

fn secrets() -> Secrets {
    Secrets {
        db_password: Some(Secret::new("db-pass")),
        oidc_client_secret: Some(Secret::new("client-secret")),
        app_secret: Some(Secret::new("a".repeat(64))),
        acme_eab_hmac: None,
    }
}

fn paths() -> Paths {
    Paths::new("/opt/pds", "/var/pds")
}

fn tls() -> TlsMaterial {
    TlsMaterial {
        chain_pem: CHAIN_PEM.into(),
        key_pem: Secret::new(KEY_PEM),
    }
}

/// Umgebung als Karte, die Werte im Klartext (nur im Test).
fn env_map(env: Vec<(String, Secret)>) -> BTreeMap<String, String> {
    let count = env.len();
    let map: BTreeMap<String, String> = env
        .into_iter()
        .map(|(key, value)| (key, value.expose().to_owned()))
        .collect();
    assert_eq!(map.len(), count, "doppelte Schlüssel in der Umgebung");
    map
}

fn app_env(config: &Config) -> BTreeMap<String, String> {
    env_map(render::app_env(config, &secrets(), &paths(), "1.2.3"))
}

fn caddy(config: &Config, tls: Option<&TlsMaterial>, eab: Option<&Secret>) -> Value {
    let json = render::caddy_json(config, &paths(), tls, eab);
    serde_json::from_str(json.expose()).expect("Caddy-JSON ist gültiges JSON")
}

fn off_config() -> Config {
    let mut config = config();
    config.tls.mode = TlsMode::Off;
    config.public.scheme = "http".into();
    config.public.port = 80;
    config.listen.http_port = 8080;
    config
}

fn acme_config() -> Config {
    let mut config = config();
    config.tls.mode = TlsMode::Acme;
    config.tls.acme_email = "admin@example.com".into();
    config
}

/// Rust-Nachbildung von `decodeURIComponent`: `%XX` als Byte, der Rest unverändert, dann UTF-8.
/// Ein `+` bleibt ein `+`.
fn decode_uri_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap();
            out.push(u8::from_str_radix(hex, 16).unwrap());
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).expect("dekodiert wieder gültiges UTF-8")
}

/// Das Ergebnis von `parseDatabaseUrl` für eine gerenderte URL.
struct ParsedDatabaseUrl {
    user: String,
    password: String,
    hostname: String,
    port: u16,
    database: String,
}

/// Nachbildung der Teile von `new URL(...)` und `parseDatabaseUrl`, auf die es hier ankommt.
/// Ein Host, den `new URL` ablehnen oder umdeuten würde, lässt den Test scheitern. `mssql:` ist
/// kein spezielles Schema, der Host ist opak: Groß-/Kleinschreibung und `_` bleiben erhalten.
fn parse_database_url(url: &str) -> ParsedDatabaseUrl {
    let rest = url.strip_prefix("mssql://").expect("Schema mssql://");
    let authority_end = rest.find(['/', '?', '#']).unwrap();
    let (authority, tail) = rest.split_at(authority_end);
    // Zugangsdaten enden am letzten `@` der Autorität
    let (credentials, host_port) = authority.rsplit_once('@').expect("Zugangsdaten");
    let (user, password) = credentials.split_once(':').expect("Benutzer:Passwort");
    let (hostname, port) = host_port.rsplit_once(':').expect("Port");
    // Sonst würde `new URL` den Host ablehnen (`\`, Leerraum) oder zerlegen (`@`, `:`, `/`)
    assert!(
        hostname
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._".contains(c)),
        "Host {hostname:?} ist keine gültige URL-Adresse"
    );

    let path = tail.split('?').next().unwrap();
    ParsedDatabaseUrl {
        user: decode_uri_component(user),
        password: decode_uri_component(password),
        hostname: hostname.to_owned(),
        port: port.parse().unwrap(),
        database: decode_uri_component(path.strip_prefix('/').unwrap()),
    }
}

fn server(json: &Value) -> &Value {
    &json["apps"]["http"]["servers"]["pds"]
}

/// Die Handler der allgemeinen Route (die letzte; davor steht nur der Upload).
fn handlers(json: &Value) -> &Vec<Value> {
    server(json)["routes"][1]["handle"].as_array().unwrap()
}

fn handler<'a>(json: &'a Value, name: &str) -> &'a Value {
    handlers(json)
        .iter()
        .find(|handler| handler["handler"] == name)
        .unwrap_or_else(|| panic!("Handler {name} fehlt"))
}

// ---------------------------------------------------------------------------------------------
// Adressen
// ---------------------------------------------------------------------------------------------

#[test]
fn app_url_default_port_omitted() {
    let mut config = config();
    assert_eq!(render::app_url(&config), "https://pds.example.com");

    config.public.port = 8443;
    assert_eq!(render::app_url(&config), "https://pds.example.com:8443");

    // bei `off` bestimmt das Schema den Standardport
    let mut off = off_config();
    assert_eq!(render::app_url(&off), "http://pds.example.com");
    off.public.port = 8080;
    assert_eq!(render::app_url(&off), "http://pds.example.com:8080");
    off.public.scheme = "https".into();
    off.public.port = 443;
    assert_eq!(render::app_url(&off), "https://pds.example.com");
    off.public.port = 80;
    assert_eq!(render::app_url(&off), "https://pds.example.com:80");

    // Das Schema gilt nur bei `off`: sonst ist die öffentliche Adresse immer https
    let mut certificate = config;
    certificate.public.scheme = "http".into();
    certificate.public.port = 443;
    assert_eq!(render::app_url(&certificate), "https://pds.example.com");
}

#[test]
fn app_url_brackets_ipv6_host() {
    // `new URL("https://::1")` schlägt fehl, die Klammern gehören zur Adresse
    let mut config = config();
    config.public.host = "2001:db8::1".into();
    assert_eq!(render::app_url(&config), "https://[2001:db8::1]");
    config.public.port = 8443;
    assert_eq!(render::app_url(&config), "https://[2001:db8::1]:8443");
}

#[test]
fn app_url_lowercases_host() {
    // Der Origin der Browser ist kleingeschrieben; Redirect-URI und MCP-Issuer sollen kanonisch sein
    let mut config = config();
    config.public.host = "Pds.Example.COM".into();
    assert_eq!(render::app_url(&config), "https://pds.example.com");
    assert_eq!(
        render::redirect_uri(&config),
        "https://pds.example.com/auth/callback"
    );
    assert_eq!(
        app_env(&config)["NUXT_PUBLIC_APP_URL"],
        "https://pds.example.com"
    );

    config.public.host = "2001:DB8::A".into();
    assert_eq!(render::app_url(&config), "https://[2001:db8::a]");
}

#[test]
fn issuer_from_tenant() {
    assert_eq!(
        render::issuer(&config()),
        format!("https://login.microsoftonline.com/{TENANT}/v2.0")
    );
}

#[test]
fn issuer_custom_trailing_slash() {
    let mut config = config();
    config.oidc.issuer = "https://idp.example.com/realms/pds/".into();
    assert_eq!(
        render::issuer(&config),
        "https://idp.example.com/realms/pds"
    );
    config.oidc.issuer = "https://idp.example.com/realms/pds".into();
    assert_eq!(
        render::issuer(&config),
        "https://idp.example.com/realms/pds"
    );
    // Die Tenant-ID bleibt ungenutzt, sobald ein eigener Issuer gesetzt ist
    assert!(!render::issuer(&config).contains(TENANT));
}

#[test]
fn tenant_mode_follows_issuer() {
    let mut config = config();
    assert!(config.oidc.tenant_mode());
    config.oidc.issuer = "https://idp.example.com".into();
    assert!(!config.oidc.tenant_mode());
}

#[test]
fn redirect_uri_is_callback_below_app_url() {
    let mut config = config();
    config.public.port = 8443;
    assert_eq!(
        render::redirect_uri(&config),
        "https://pds.example.com:8443/auth/callback"
    );
}

// ---------------------------------------------------------------------------------------------
// Datenbank-URL
// ---------------------------------------------------------------------------------------------

#[test]
fn database_url_encodes() {
    let mut config = config();
    config.db.port = 14330;
    let url = render::database_url(&config, &paths(), &Secret::new(NASTY_PASSWORD));
    assert_eq!(
        url.expose(),
        format!(
            "mssql://pds_app:{NASTY_PASSWORD_ENCODED}@sql.example.com:14330/pds\
             ?encrypt=true&trustServerCertificate=false"
        )
    );

    // Rundlauf wie in `parseDatabaseUrl`: Benutzer, Passwort und Datenbank per Dekodierung zurück
    let rest = url.expose().strip_prefix("mssql://").unwrap();
    let (credentials, tail) = rest.rsplit_once('@').unwrap();
    let (user, password) = credentials.split_once(':').unwrap();
    assert_eq!(decode_uri_component(user), "pds_app");
    assert_eq!(decode_uri_component(password), NASTY_PASSWORD);
    assert_eq!(tail.matches('@').count(), 0);
}

#[test]
fn database_url_keeps_server_as_typed() {
    // Namen und IPv4-Adressen gehen unverändert in die URL; `SQL_PROD` ist ein gültiger Host,
    // weil `mssql:` ein Schema mit opakem Host ist
    let mut config = config();
    config.db.port = 14330;
    for server in [
        "sql.example.com",
        "SQL01",
        "10.0.0.5",
        "SQL_PROD",
        "sql_prod.corp.example.com",
    ] {
        config.db.server = server.into();
        let url = render::database_url(&config, &paths(), &Secret::new(NASTY_PASSWORD));
        assert!(
            url.expose().contains(&format!("@{server}:14330/")),
            "{server}"
        );
        let parsed = parse_database_url(url.expose());
        assert_eq!(parsed.hostname, server);
        assert_eq!(parsed.port, 14330);
        assert_eq!(parsed.user, "pds_app");
        assert_eq!(parsed.password, NASTY_PASSWORD);
        assert_eq!(parsed.database, "pds");
    }
}

#[test]
fn database_url_encodes_user_and_database() {
    let mut config = config();
    config.db.user = "pds app@corp".into();
    config.db.database = "db/name?x#1".into();
    config.db.encrypt = false;
    config.db.trust_server_certificate = true;
    let url = render::database_url(&config, &paths(), &Secret::new("x"));
    assert_eq!(
        url.expose(),
        "mssql://pds%20app%40corp:x@sql.example.com:1433/db%2Fname%3Fx%231\
         ?encrypt=false&trustServerCertificate=true"
    );
}

#[test]
fn database_url_for_sqlite_is_the_raw_path() {
    let mut config = config();
    config.db.kind = DbKind::Sqlite;
    let password = Secret::new(NASTY_PASSWORD);

    let url = render::database_url(&config, &paths(), &password);
    assert_eq!(
        url.expose(),
        format!("sqlite:{}", paths().default_sqlite_file().display())
    );

    // Roh wie in `parseSqliteUrl`: nichts kodiert, Leerzeichen am Rand fallen weg
    config.db.path = r"  C:\ProgramData\EPLAN Panel Data Service\data\pds.db ".into();
    let url = render::database_url(&config, &paths(), &password);
    assert_eq!(
        url.expose(),
        r"sqlite:C:\ProgramData\EPLAN Panel Data Service\data\pds.db"
    );
    assert!(!url.expose().contains(NASTY_PASSWORD));
}

#[test]
fn app_env_for_sqlite_has_the_file_and_no_password() {
    let mut config = config();
    config.db.kind = DbKind::Sqlite;
    config.db.path = r"D:\PDS\pds.db".into();

    let env = env_map(render::app_env(&config, &secrets(), &paths(), "1.2.3"));

    assert_eq!(env["NUXT_DATABASE_URL"], r"sqlite:D:\PDS\pds.db");
    assert!(!env.values().any(|value| value.contains("db-pass")));
}

#[test]
fn secret_values_for_sqlite_leave_the_path_readable() {
    let mut config = config();
    config.db.kind = DbKind::Sqlite;
    config.db.path = r"D:\PDS\pds.db".into();

    let values = render::secret_values(&config, &secrets(), None);

    // Der Pfad soll in Fehlermeldungen lesbar bleiben, ein altes Passwort bleibt geschwärzt
    assert!(
        !values.iter().any(|value| value.contains("PDS")),
        "{values:?}"
    );
    assert!(values.contains(&"db-pass".to_owned()));
}

#[test]
fn database_url_keeps_unreserved_characters() {
    let url = render::database_url(&config(), &paths(), &Secret::new("Az09-._~"));
    assert!(url.expose().contains(":Az09-._~@"), "{}", url.expose());
}

// ---------------------------------------------------------------------------------------------
// Umgebung der App
// ---------------------------------------------------------------------------------------------

// Sortiert wie die Schlüssel der `BTreeMap` aus `env_map`.
const APP_ENV_KEYS: [&str; 20] = [
    "HOST",
    "NITRO_SHUTDOWN_TIMEOUT",
    "NODE_ENV",
    "NUXT_APP_SECRET",
    "NUXT_DATABASE_URL",
    "NUXT_EPLAN_WORKER",
    "NUXT_LOG_DIR",
    "NUXT_OIDC_ADMIN_ROLES",
    "NUXT_OIDC_CLIENT_ID",
    "NUXT_OIDC_CLIENT_SECRET",
    "NUXT_OIDC_ISSUER",
    "NUXT_OIDC_ROLES_CLAIM",
    "NUXT_OIDC_SCOPES",
    "NUXT_PDS_DATA_DIR",
    "NUXT_PUBLIC_APP_URL",
    "NUXT_PUBLIC_MCP_ENABLED",
    "NUXT_PUBLIC_OIDC_PROVIDER_NAME",
    "NUXT_SESSION_COOKIE_SECURE",
    "PDS_VERSION",
    "PORT",
];

#[test]
fn app_env_exact_keys() {
    let env = app_env(&config());
    assert_eq!(
        env.keys().map(String::as_str).collect::<Vec<_>>(),
        APP_ENV_KEYS
    );
}

#[test]
fn app_env_values() {
    let mut config = config();
    config.internal.port = 3100;
    config.oidc.scopes = "openid profile".into();
    config.oidc.roles_claim = "groups".into();
    config.oidc.admin_roles = "Admin,Boss".into();
    config.oidc.provider_name = "Siemens".into();
    config.mcp.enabled = true;
    let env = app_env(&config);

    let expected: [(&str, String); 19] = [
        ("NODE_ENV", "production".into()),
        ("HOST", "127.0.0.1".into()),
        ("PORT", "3100".into()),
        ("PDS_VERSION", "1.2.3".into()),
        ("NITRO_SHUTDOWN_TIMEOUT", "10000".into()),
        (
            "NUXT_DATABASE_URL",
            "mssql://pds_app:db-pass@sql.example.com:1433/pds\
             ?encrypt=true&trustServerCertificate=false"
                .into(),
        ),
        ("NUXT_APP_SECRET", "a".repeat(64)),
        ("NUXT_PUBLIC_APP_URL", "https://pds.example.com".into()),
        ("NUXT_SESSION_COOKIE_SECURE", "true".into()),
        (
            "NUXT_OIDC_ISSUER",
            format!("https://login.microsoftonline.com/{TENANT}/v2.0"),
        ),
        ("NUXT_OIDC_CLIENT_ID", CLIENT.into()),
        ("NUXT_OIDC_CLIENT_SECRET", "client-secret".into()),
        ("NUXT_OIDC_SCOPES", "openid profile".into()),
        ("NUXT_OIDC_ROLES_CLAIM", "groups".into()),
        ("NUXT_OIDC_ADMIN_ROLES", "Admin,Boss".into()),
        ("NUXT_PUBLIC_OIDC_PROVIDER_NAME", "Siemens".into()),
        (
            "NUXT_LOG_DIR",
            paths().logs_dir().to_string_lossy().into_owned(),
        ),
        (
            "NUXT_PDS_DATA_DIR",
            paths().data_dir.to_string_lossy().into_owned(),
        ),
        ("NUXT_EPLAN_WORKER", r"pipe:\\.\pipe\pds-eplan".into()),
    ];
    for (key, value) in expected {
        assert_eq!(env[key], value, "{key}");
    }
    assert_eq!(env["NUXT_PUBLIC_MCP_ENABLED"], "true");

    config.mcp.enabled = false;
    assert_eq!(app_env(&config)["NUXT_PUBLIC_MCP_ENABLED"], "false");
}

#[test]
fn app_env_unset_secrets_are_empty() {
    let env = env_map(render::app_env(
        &config(),
        &Secrets::default(),
        &paths(),
        "1.2.3",
    ));
    assert_eq!(env["NUXT_OIDC_CLIENT_SECRET"], "");
    assert_eq!(env["NUXT_APP_SECRET"], "");
    // Der Schlüsselsatz ändert sich nicht, auch wenn Secrets fehlen
    assert_eq!(
        env.keys().map(String::as_str).collect::<Vec<_>>(),
        APP_ENV_KEYS
    );
}

#[test]
fn app_env_encodes_the_database_password() {
    let mut secrets = secrets();
    secrets.db_password = Some(Secret::new(NASTY_PASSWORD));
    let env = env_map(render::app_env(&config(), &secrets, &paths(), "1.2.3"));
    assert!(
        env["NUXT_DATABASE_URL"].contains(&format!(":{NASTY_PASSWORD_ENCODED}@")),
        "{}",
        env["NUXT_DATABASE_URL"]
    );
}

#[test]
fn cookie_secure_follows_scheme() {
    // Zertifikat, ACME und interne CA liefern immer https
    for mode in [TlsMode::Certificate, TlsMode::Acme, TlsMode::Internal] {
        let mut config = config();
        config.tls.mode = mode;
        assert_eq!(
            app_env(&config)["NUXT_SESSION_COOKIE_SECURE"],
            "true",
            "{mode:?}"
        );
    }
    let mut off = off_config();
    assert_eq!(app_env(&off)["NUXT_SESSION_COOKIE_SECURE"], "false");
    // Hinter einem vorgelagerten Proxy mit TLS ist die öffentliche Adresse https
    off.public.scheme = "https".into();
    off.public.port = 443;
    assert_eq!(app_env(&off)["NUXT_SESSION_COOKIE_SECURE"], "true");
}

#[test]
fn proxy_env_added() {
    let mut config = config();
    config.proxy.url = "http://proxy.example.com:3128".into();
    config.proxy.no_proxy = "sql.example.com,.corp.example.com".into();

    let env = app_env(&config);
    let mut keys: Vec<&str> = env.keys().map(String::as_str).collect();
    let mut expected: Vec<&str> = APP_ENV_KEYS.to_vec();
    expected.extend([
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "NODE_USE_ENV_PROXY",
    ]);
    keys.sort_unstable();
    expected.sort_unstable();
    assert_eq!(keys, expected);
    assert_eq!(env["HTTPS_PROXY"], "http://proxy.example.com:3128");
    assert_eq!(env["HTTP_PROXY"], "http://proxy.example.com:3128");
    assert_eq!(
        env["NO_PROXY"],
        "sql.example.com,.corp.example.com,127.0.0.1,localhost"
    );
    assert_eq!(env["NODE_USE_ENV_PROXY"], "1");

    // Ohne eigene Ausnahmen kein führendes Komma
    config.proxy.no_proxy.clear();
    assert_eq!(app_env(&config)["NO_PROXY"], "127.0.0.1,localhost");
}

#[test]
fn proxy_env_cleans_no_proxy_entries() {
    let mut config = config();
    config.proxy.url = "http://proxy.example.com:3128".into();
    for (own, expected) in [
        ("a, ,b ,", "a,b,127.0.0.1,localhost"),
        (" a.example.com ", "a.example.com,127.0.0.1,localhost"),
        (",a,,b,", "a,b,127.0.0.1,localhost"),
        (" , ,", "127.0.0.1,localhost"),
        ("", "127.0.0.1,localhost"),
    ] {
        config.proxy.no_proxy = own.into();
        assert_eq!(app_env(&config)["NO_PROXY"], expected, "no_proxy {own:?}");
        let caddy = env_map(render::proxy_env(&config, &paths()));
        assert_eq!(caddy["NO_PROXY"], expected, "no_proxy {own:?}");
    }
}

#[test]
fn proxy_env_for_caddy() {
    let paths = paths();
    let mut config = config();
    let env = env_map(render::proxy_env(&config, &paths));
    // Ohne Proxy nur die Ablage von Caddy
    assert_eq!(
        env.keys().map(String::as_str).collect::<Vec<_>>(),
        ["XDG_CONFIG_HOME", "XDG_DATA_HOME"]
    );
    assert_eq!(env["XDG_DATA_HOME"], paths.caddy_dir().to_str().unwrap());
    assert_eq!(
        env["XDG_CONFIG_HOME"],
        paths.caddy_dir().join("config").to_str().unwrap()
    );

    config.proxy.url = "http://proxy.example.com:3128".into();
    config.proxy.no_proxy = "sql.example.com".into();
    let env = env_map(render::proxy_env(&config, &paths));
    assert_eq!(env["HTTPS_PROXY"], "http://proxy.example.com:3128");
    assert_eq!(env["HTTP_PROXY"], "http://proxy.example.com:3128");
    assert_eq!(env["NO_PROXY"], "sql.example.com,127.0.0.1,localhost");
    assert_eq!(env["NODE_USE_ENV_PROXY"], "1");
    assert_eq!(env["XDG_DATA_HOME"], paths.caddy_dir().to_str().unwrap());
}

// ---------------------------------------------------------------------------------------------
// Caddy: Grundeinstellungen und Handler
// ---------------------------------------------------------------------------------------------

#[test]
fn caddy_admin_disabled_and_no_persist() {
    for config in [config(), acme_config(), off_config()] {
        let json = caddy(&config, Some(&tls()), None);
        assert_eq!(
            json["admin"],
            json!({"disabled": true, "config": {"persist": false}}),
            "{:?}",
            config.tls.mode
        );
        assert_eq!(
            json["storage"],
            json!({"module": "file_system", "root": paths().caddy_dir().to_str().unwrap()})
        );
        assert_eq!(
            json["logging"]["logs"]["default"],
            json!({"writer": {"output": "stderr"}, "level": "INFO"})
        );
    }
}

#[test]
fn caddy_headers_and_body_limit() {
    let mut config = config();
    config.internal.port = 3100;
    let json = caddy(&config, Some(&tls()), None);

    let chain: Vec<&str> = handlers(&json)
        .iter()
        .map(|handler| handler["handler"].as_str().unwrap())
        .collect();
    assert_eq!(
        chain,
        ["request_body", "encode", "headers", "reverse_proxy"]
    );

    assert_eq!(handler(&json, "request_body")["max_size"], 2_000_000);

    // Der Upload eines Projekts hat dieselbe Kette mit größerer Grenze und steht davor
    let upload = &server(&json)["routes"][0];
    assert_eq!(
        upload["match"],
        json!([{"host": [HOST], "path": ["/api/projects/upload"]}])
    );
    assert_eq!(upload["terminal"], true);
    let upload_chain = upload["handle"].as_array().unwrap();
    assert_eq!(upload_chain[0]["handler"], "request_body");
    assert_eq!(upload_chain[0]["max_size"], 2_147_483_648u64);
    assert_eq!(upload_chain[1..], handlers(&json)[1..]);
    // Kein Zeitlimit für das Lesen und Schreiben: Ein großer Upload darf dauern
    for timeout in ["read_timeout", "read_header_timeout", "write_timeout"] {
        assert!(server(&json).get(timeout).is_none(), "{timeout}");
    }
    assert!(upload_chain[0].get("read_timeout").is_none());

    let encode = handler(&json, "encode");
    assert_eq!(encode["encodings"], json!({"zstd": {}, "gzip": {}}));
    assert_eq!(encode["prefer"], json!(["zstd", "gzip"]));

    let headers = handler(&json, "headers");
    assert_eq!(
        headers["response"]["set"],
        json!({
            "Strict-Transport-Security": ["max-age=31536000"],
            "X-Content-Type-Options": ["nosniff"],
            "X-Frame-Options": ["DENY"],
            "Referrer-Policy": ["strict-origin-when-cross-origin"],
        })
    );
    assert_eq!(headers["response"]["delete"], json!(["Server"]));
    // Sonst setzt der Upstream `Server` erst nach dem Löschen wieder
    assert_eq!(headers["response"]["deferred"], true);

    assert_eq!(
        handler(&json, "reverse_proxy")["upstreams"],
        json!([{"dial": "127.0.0.1:3100"}])
    );
}

#[test]
fn caddy_listens_for_the_public_host() {
    let mut config = config();
    config.public.port = 8443;
    config.listen.http_port = 8080;
    let json = caddy(&config, Some(&tls()), None);

    let http = &json["apps"]["http"];
    assert_eq!(http["http_port"], 8080);
    assert_eq!(http["https_port"], 8443);
    assert_eq!(server(&json)["listen"], json!([":8443"]));
    assert_eq!(server(&json)["protocols"], json!(["h1", "h2"]));
    assert_eq!(
        server(&json)["routes"][1]["match"],
        json!([{"host": [HOST]}])
    );
    assert_eq!(server(&json)["routes"].as_array().unwrap().len(), 2);
    // HTTPS-Umleitung und Zertifikate verwaltet Caddy selbst, sie bleiben also eingeschaltet
    assert!(server(&json).get("automatic_https").is_none());
}

// ---------------------------------------------------------------------------------------------
// Caddy: TLS-Modi
// ---------------------------------------------------------------------------------------------

#[test]
fn caddy_certificate_inline() {
    let tls = tls();
    let json = caddy(&config(), Some(&tls), None);
    let load_pem = json["apps"]["tls"]["certificates"]["load_pem"]
        .as_array()
        .unwrap();
    assert_eq!(load_pem.len(), 1);
    assert_eq!(load_pem[0]["certificate"], CHAIN_PEM);
    assert_eq!(load_pem[0]["key"], KEY_PEM);
    assert_eq!(load_pem[0]["tags"], json!(["pds"]));
    // Keine Zertifikatsverwaltung neben dem eigenen Zertifikat
    assert!(json["apps"]["tls"].get("automation").is_none());
}

// Der Aufrufer validiert vorher (die Prüfung meldet `certificate_missing`). Ein fehlendes Material
// hier wäre ein Programmfehler, in Debug-Builds soll er laut sein.
#[test]
#[cfg(debug_assertions)]
#[should_panic(expected = "Zertifikat")]
fn caddy_certificate_mode_without_material_is_a_bug() {
    caddy(&config(), None, None);
}

#[test]
fn caddy_acme_with_eab() {
    let mut config = acme_config();
    config.tls.acme_ca_url = "https://acme.corp.example.com/directory".into();
    config.tls.acme_ca_root = r"C:\ProgramData\root.pem".into();
    config.tls.acme_eab_key_id = "kid-1".into();
    let json = caddy(&config, None, Some(&Secret::new("hmac-value")));

    assert_eq!(
        json["apps"]["tls"]["automation"]["policies"],
        json!([{
            "subjects": [HOST],
            "issuers": [{
                "module": "acme",
                "email": "admin@example.com",
                "ca": "https://acme.corp.example.com/directory",
                "trusted_roots_pem_files": [r"C:\ProgramData\root.pem"],
                "external_account": {"key_id": "kid-1", "mac_key": "hmac-value"},
            }]
        }])
    );
    assert!(json["apps"]["tls"].get("certificates").is_none());
}

#[test]
fn caddy_acme_minimal() {
    // Standard-CA, ohne eigene Wurzel und ohne EAB: die optionalen Felder fehlen ganz
    let json = caddy(&acme_config(), None, None);
    assert_eq!(
        json["apps"]["tls"]["automation"]["policies"],
        json!([{
            "subjects": [HOST],
            "issuers": [{"module": "acme", "email": "admin@example.com"}]
        }])
    );

    // Key-ID allein reicht nicht für EAB (die Validierung meldet das als Fehler)
    let mut config = acme_config();
    config.tls.acme_eab_key_id = "kid-1".into();
    let json = caddy(&config, None, None);
    assert!(
        json["apps"]["tls"]["automation"]["policies"][0]["issuers"][0]
            .get("external_account")
            .is_none()
    );
}

#[test]
fn caddy_internal_issuer() {
    let mut config = config();
    config.tls.mode = TlsMode::Internal;
    let json = caddy(&config, None, None);
    assert_eq!(
        json["apps"]["tls"]["automation"]["policies"],
        json!([{"subjects": [HOST], "issuers": [{"module": "internal"}]}])
    );
    // Der Dienstkonto-Benutzer darf den Vertrauensspeicher nicht ändern (wie `skip_install_trust`)
    assert_eq!(
        json["apps"]["pki"]["certificate_authorities"]["local"]["install_trust"],
        false
    );
}

#[test]
fn caddy_off_mode_http_only() {
    let config = off_config();
    let json = caddy(&config, None, None);

    assert_eq!(server(&json)["listen"], json!([":8080"]));
    assert_eq!(server(&json)["automatic_https"], json!({"disable": true}));
    assert!(json["apps"].get("tls").is_none());
    assert!(json["apps"].get("pki").is_none());
    assert_eq!(json["apps"]["http"]["http_port"], 8080);
    assert_eq!(json["apps"]["http"]["https_port"], 80);
    assert_eq!(server(&json)["protocols"], json!(["h1", "h2"]));
    assert_eq!(
        server(&json)["routes"][1]["match"],
        json!([{"host": [HOST]}])
    );
    // Die Handler-Kette ist dieselbe wie bei TLS
    assert_eq!(handlers(&json).len(), 4);
}

#[test]
fn caddy_output_has_no_tls_material_outside_certificate_mode() {
    // Auch wenn der Aufrufer Material übergibt, gehört es nur in den Modus `certificate`
    let text = render::caddy_json(&acme_config(), &paths(), Some(&tls()), None);
    assert!(!text.expose().contains("QUJDREVGR0hJSktMTU5PUA"));
    let text = render::caddy_json(&off_config(), &paths(), Some(&tls()), None);
    assert!(!text.expose().contains("QUJDREVGR0hJSktMTU5PUA"));
}

// ---------------------------------------------------------------------------------------------
// Werte für den Redactor
// ---------------------------------------------------------------------------------------------

#[test]
fn secret_values_include_encoded_password() {
    let mut secrets = secrets();
    secrets.db_password = Some(Secret::new(NASTY_PASSWORD));
    let config = config();
    let values = render::secret_values(&config, &secrets, None);

    assert!(values.contains(&NASTY_PASSWORD.to_owned()));
    assert!(values.contains(&NASTY_PASSWORD_ENCODED.to_owned()));
    assert!(values.contains(&"client-secret".to_owned()));
    assert!(values.contains(&"a".repeat(64)));
    // Die ganze URL, falls ein Treiber sie samt Passwort in eine Fehlermeldung schreibt
    let url = render::database_url(&config, &paths(), &Secret::new(NASTY_PASSWORD));
    assert!(values.contains(&url.expose().to_owned()));
}

#[test]
fn secret_values_include_tls_key_and_its_json_form() {
    let tls = tls();
    let config = config();
    let values = render::secret_values(&config, &secrets(), Some(&tls));
    assert!(values.contains(&KEY_PEM.to_owned()));

    // So steht der Schlüssel im Caddy-JSON, und so könnte Caddy ihn in einer Meldung wiedergeben
    let escaped = KEY_PEM.replace('\n', "\\n");
    assert!(values.contains(&escaped));
    let json = render::caddy_json(&config, &paths(), Some(&tls), None);
    assert!(json.expose().contains(&escaped));
}

#[test]
fn secret_values_include_eab_hmac_in_both_forms() {
    let mut secrets = secrets();
    secrets.acme_eab_hmac = Some(Secret::new("hm\"ac\\key"));
    let values = render::secret_values(&acme_config(), &secrets, None);
    assert!(values.contains(&"hm\"ac\\key".to_owned()));
    assert!(values.contains(&"hm\\\"ac\\\\key".to_owned()));
}

#[test]
fn secret_values_skip_unset_and_duplicates() {
    // Ohne Secrets und ohne Schlüssel gibt es nichts zu schwärzen (ein leerer Wert träfe jede Zeile)
    assert_eq!(
        render::secret_values(&config(), &Secrets::default(), None),
        Vec::<String>::new()
    );

    // Passwort ohne Sonderzeichen: kodierte und wörtliche Form sind gleich und zählen einmal
    let values = render::secret_values(&config(), &secrets(), None);
    assert_eq!(values.iter().filter(|value| *value == "db-pass").count(), 1);
    assert!(values.iter().all(|value| !value.is_empty()));
}
