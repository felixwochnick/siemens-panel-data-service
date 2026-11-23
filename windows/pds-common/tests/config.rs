//! Konfigurationsmodell: Laden, Speichern, Secrets, Feldzugriff und Maskierung.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use pds_common::config::fields::{FIELDS, FieldError, get_field, set_field};
use pds_common::config::masking::{export_toml, import_toml, masked};
use pds_common::config::{
    Config, ConfigError, DbKind, Sealed, SecretField, Secrets, TlsMode, load, save,
};
use pds_common::{Protector, Secret, system_protector};
use tempfile::TempDir;

const SECRET_FIELDS: [SecretField; 4] = [
    SecretField::DbPassword,
    SecretField::OidcClientSecret,
    SecretField::AppSecret,
    SecretField::AcmeEabHmac,
];

fn config_path(dir: &TempDir) -> PathBuf {
    dir.path().join("config.toml")
}

/// Der Protector der Plattform: DPAPI unter Windows, sonst der Test-Ersatz `insecure`.
fn protector() -> Box<dyn Protector> {
    system_protector()
}

fn scheme() -> &'static str {
    protector().scheme()
}

fn sealed_config(field: SecretField, plain: &str) -> Config {
    let mut cfg = Config::default();
    cfg.seal(field, Some(&Secret::new(plain)), &*protector())
        .unwrap();
    cfg
}

#[test]
fn default_roundtrip() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);

    save(&path, &Config::default()).unwrap();

    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("mode = \"certificate\""), "{text}");
    assert!(text.contains("port = 1433"), "{text}");
    // Die Art der Datenbank steht immer in der Datei, damit sie beim Lesen nicht geraten wird
    assert!(text.contains("kind = \"sqlite\""), "{text}");
    assert_eq!(load(&path).unwrap(), Config::default());
}

#[test]
fn default_values_match_contract() {
    let cfg = Config::default();
    assert_eq!(cfg.schema, 1);
    assert_eq!((cfg.public.host.as_str(), cfg.public.port), ("", 443));
    assert_eq!(cfg.public.scheme, "https");
    assert_eq!(cfg.listen.http_port, 80);
    assert_eq!(cfg.internal.port, 3000);
    assert_eq!(cfg.tls.mode, TlsMode::Certificate);
    assert_eq!(cfg.db.kind, DbKind::Sqlite);
    assert_eq!(cfg.db.path, "");
    assert_eq!(cfg.db.port, 1433);
    assert_eq!(cfg.db.database, "pds");
    assert_eq!(cfg.db.user, "pds_app");
    assert!(cfg.db.encrypt);
    assert!(!cfg.db.trust_server_certificate);
    assert_eq!(cfg.oidc.scopes, "openid profile email");
    assert_eq!(cfg.oidc.roles_claim, "roles");
    assert_eq!(cfg.oidc.admin_roles, "Admin");
    assert_eq!(cfg.oidc.provider_name, "Microsoft");
    assert!(!cfg.mcp.enabled);
    for field in SECRET_FIELDS {
        assert!(cfg.sealed(field).is_empty(), "{}", field.path());
    }
}

#[test]
fn missing_file_is_default() {
    let dir = TempDir::new().unwrap();
    assert_eq!(load(&config_path(&dir)).unwrap(), Config::default());
}

#[test]
fn partial_file_uses_defaults() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    fs::write(&path, "[db]\nserver = \"sql01\"\n").unwrap();

    let cfg = load(&path).unwrap();

    assert_eq!(cfg.db.server, "sql01");
    assert_eq!(cfg.db.port, 1433);
    assert_eq!(cfg.tls.mode, TlsMode::Certificate);
    // Von vor SQLite: mit Server bleibt es SQL Server
    assert_eq!(cfg.db.kind, DbKind::Sqlserver);
}

#[test]
fn db_kind_of_files_without_it() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    let kind = |text: &str| {
        fs::write(&path, text).unwrap();
        load(&path).unwrap().db.kind
    };

    // Ohne Server (nie eingerichtet): der neue Standard
    assert_eq!(kind("schema = 1\n"), DbKind::Sqlite);
    assert_eq!(
        kind("[db]\nport = 14330\nserver = \"  \"\n"),
        DbKind::Sqlite
    );
    // Mit Server: SQL Server wie bisher
    assert_eq!(kind("[db]\nserver = \"sql01\"\n"), DbKind::Sqlserver);
    // Ausdrücklich angegeben gilt die Angabe, auch mit gespeichertem Server
    assert_eq!(
        kind("[db]\nkind = \"sqlite\"\nserver = \"sql01\"\n"),
        DbKind::Sqlite
    );
    assert_eq!(kind("[db]\nkind = \"sqlserver\"\n"), DbKind::Sqlserver);
}

#[test]
fn db_kind_and_unknown_db_fields_are_checked() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);

    fs::write(&path, "[db]\nkind = \"mysql\"\n").unwrap();
    assert!(matches!(load(&path), Err(ConfigError::Unreadable(_))));

    // Unbekannte Felder bleiben verboten, auch mit dem eigenen Lesen von [db]
    fs::write(&path, "[db]\nkind = \"sqlite\"\npfad = \"x\"\n").unwrap();
    let error = load(&path).unwrap_err();
    assert!(matches!(error, ConfigError::Unreadable(_)), "{error}");
    assert!(error.to_string().contains("pfad"), "{error}");
}

#[test]
fn sqlite_file_is_the_path_or_the_default() {
    use pds_common::Paths;
    let paths = Paths::new("/inst", "/daten");
    let mut cfg = Config::default();

    assert_eq!(cfg.db.sqlite_file(&paths), paths.default_sqlite_file());
    assert!(!cfg.db.has_custom_path());

    cfg.db.path = "   ".into();
    assert_eq!(cfg.db.sqlite_file(&paths), paths.default_sqlite_file());

    cfg.db.path = r" D:\PDS\pds.db ".into();
    assert!(cfg.db.has_custom_path());
    assert_eq!(
        cfg.db.sqlite_file(&paths),
        std::path::PathBuf::from(r"D:\PDS\pds.db")
    );
}

#[test]
fn unreadable_toml() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    fs::write(&path, "[db\n").unwrap();

    assert!(matches!(load(&path), Err(ConfigError::Unreadable(_))));
}

#[test]
fn unknown_field_rejected() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    fs::write(&path, "[db]\nservr = \"x\"\n").unwrap();

    match load(&path) {
        Err(ConfigError::Unreadable(message)) => assert!(message.contains("servr"), "{message}"),
        other => panic!("erwartet Unreadable, erhalten {other:?}"),
    }
}

#[test]
fn unreadable_message_never_shows_secret_values() {
    // Von Hand ohne Anführungszeichen oder mit falschem Typ eingetragene Secrets
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    for (text, secret) in [
        ("[db]\npassword = 12345678\n", "12345678"),
        ("[db]\npassword = hunter2\n", "hunter2"),
        ("[oidc]\nclient_secret = true\n", "true"),
        ("[app]\nsecret = 3.14159\n", "3.14159"),
    ] {
        fs::write(&path, text).unwrap();
        match load(&path) {
            Err(ConfigError::Unreadable(message)) => {
                assert!(!message.contains(secret), "{message}");
                assert!(message.contains("Zeile 2"), "{message}");
            }
            other => panic!("erwartet Unreadable, erhalten {other:?}"),
        }
    }
}

#[test]
fn unsupported_schema() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    fs::write(&path, "schema = 2\n").unwrap();

    assert_eq!(load(&path), Err(ConfigError::UnsupportedSchema(2)));
}

#[test]
fn unsupported_schema_wins_over_unknown_fields() {
    // Eine neuere Version darf Felder kennen, die diese nicht kennt.
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    fs::write(&path, "schema = 2\n[future]\nthing = 1\n").unwrap();

    assert_eq!(load(&path), Err(ConfigError::UnsupportedSchema(2)));
}

#[test]
fn save_overwrites_and_leaves_no_temp_file() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    let mut cfg = Config::default();

    save(&path, &cfg).unwrap();
    cfg.db.server = "sql01".into();
    save(&path, &cfg).unwrap();

    assert_eq!(load(&path).unwrap().db.server, "sql01");
    let names: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, ["config.toml"]);
}

#[test]
fn save_creates_missing_parent_dir() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("neu").join("config.toml");

    save(&path, &Config::default()).unwrap();

    assert!(path.is_file());
}

#[test]
fn seal_and_open() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    let cfg = sealed_config(SecretField::DbPassword, "p@ss'wört%");
    assert!(cfg.sealed(SecretField::DbPassword).is_sealed(scheme()));

    save(&path, &cfg).unwrap();

    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains(&format!("{}:", scheme())), "{text}");
    assert!(!text.contains("p@ss"), "{text}");

    let secrets = load(&path).unwrap().open_secrets(&*protector()).unwrap();
    assert_eq!(secrets.db_password.unwrap().expose(), "p@ss'wört%");
    assert!(secrets.oidc_client_secret.is_none());
    assert!(secrets.app_secret.is_none());
    assert!(secrets.acme_eab_hmac.is_none());
}

#[test]
fn seal_none_or_empty_clears() {
    let mut cfg = sealed_config(SecretField::AppSecret, "geheim");

    cfg.seal(
        SecretField::AppSecret,
        Some(&Secret::new("")),
        &*protector(),
    )
    .unwrap();
    assert!(cfg.sealed(SecretField::AppSecret).is_empty());

    cfg.seal(
        SecretField::AppSecret,
        Some(&Secret::new("x")),
        &*protector(),
    )
    .unwrap();
    cfg.seal(SecretField::AppSecret, None, &*protector())
        .unwrap();
    assert!(cfg.sealed(SecretField::AppSecret).is_empty());
}

#[test]
fn every_secret_field_maps_to_its_own_value() {
    for field in SECRET_FIELDS {
        let cfg = sealed_config(field, "geheim");
        for other in SECRET_FIELDS {
            assert_eq!(
                cfg.sealed(other).is_empty(),
                other != field,
                "{} nach Versiegeln von {}",
                other.path(),
                field.path()
            );
        }
        let secrets = cfg.open_secrets(&*protector()).unwrap();
        let opened = match field {
            SecretField::DbPassword => secrets.db_password,
            SecretField::OidcClientSecret => secrets.oidc_client_secret,
            SecretField::AppSecret => secrets.app_secret,
            SecretField::AcmeEabHmac => secrets.acme_eab_hmac,
        };
        assert_eq!(opened.unwrap().expose(), "geheim", "{}", field.path());
    }
}

#[test]
fn secret_field_paths() {
    let paths: Vec<_> = SECRET_FIELDS.iter().map(|field| field.path()).collect();
    assert_eq!(
        paths,
        [
            "db.password",
            "oidc.client_secret",
            "app.secret",
            "tls.acme_eab_hmac"
        ]
    );
}

#[test]
fn open_secrets_rejects_plaintext_and_garbage() {
    let mut cfg = Config::default();
    cfg.db.password = Sealed("klartext".into());
    assert_eq!(
        cfg.open_secrets(&*protector()).unwrap_err(),
        ConfigError::UnsealedSecret("db.password")
    );

    // Richtiges Schema, aber kein gültiges Base64
    let mut cfg = Config::default();
    cfg.app.secret = Sealed(format!("{}:***", scheme()));
    assert!(matches!(
        cfg.open_secrets(&*protector()),
        Err(ConfigError::SecretUnreadable {
            field: "app.secret",
            ..
        })
    ));
}

#[test]
fn save_refuses_plaintext() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    let mut cfg = Config::default();
    cfg.db.password = Sealed("klartext".into());

    assert_eq!(
        save(&path, &cfg),
        Err(ConfigError::UnsealedSecret("db.password"))
    );
    assert!(!path.exists(), "es darf nichts geschrieben werden");
}

#[test]
fn save_refuses_plaintext_in_every_secret_field() {
    let dir = TempDir::new().unwrap();
    let path = config_path(&dir);
    for field in SECRET_FIELDS {
        let mut cfg = Config::default();
        *cfg_sealed_mut(&mut cfg, field) = Sealed("klartext".into());
        assert_eq!(
            save(&path, &cfg),
            Err(ConfigError::UnsealedSecret(field.path()))
        );
    }
}

fn cfg_sealed_mut(cfg: &mut Config, field: SecretField) -> &mut Sealed {
    match field {
        SecretField::DbPassword => &mut cfg.db.password,
        SecretField::OidcClientSecret => &mut cfg.oidc.client_secret,
        SecretField::AppSecret => &mut cfg.app.secret,
        SecretField::AcmeEabHmac => &mut cfg.tls.acme_eab_hmac,
    }
}

#[test]
fn set_field_rejects_secret() {
    let mut cfg = Config::default();
    for field in SECRET_FIELDS {
        assert_eq!(
            set_field(&mut cfg, field.path(), "x"),
            Err(FieldError::SecretNotAllowed),
            "{}",
            field.path()
        );
    }
    assert_eq!(cfg, Config::default());
}

#[test]
fn set_field_typed() {
    let mut cfg = Config::default();

    assert!(matches!(
        set_field(&mut cfg, "db.port", "abc"),
        Err(FieldError::InvalidValue { .. })
    ));
    assert!(matches!(
        set_field(&mut cfg, "db.port", "70000"),
        Err(FieldError::InvalidValue { .. })
    ));
    assert!(matches!(
        set_field(&mut cfg, "mcp.enabled", "ja"),
        Err(FieldError::InvalidValue { .. })
    ));
    assert!(matches!(
        set_field(&mut cfg, "tls.mode", "irgendwas"),
        Err(FieldError::InvalidValue { .. })
    ));
    assert_eq!(cfg, Config::default(), "Fehlversuche ändern nichts");

    set_field(&mut cfg, "tls.mode", "acme").unwrap();
    set_field(&mut cfg, "mcp.enabled", "true").unwrap();
    set_field(&mut cfg, "db.port", "14330").unwrap();
    set_field(&mut cfg, "db.server", "sql01.example.org").unwrap();
    set_field(&mut cfg, "db.encrypt", "false").unwrap();

    assert_eq!(cfg.tls.mode, TlsMode::Acme);
    assert!(cfg.mcp.enabled);
    assert_eq!(cfg.db.port, 14330);
    assert_eq!(cfg.db.server, "sql01.example.org");
    assert!(!cfg.db.encrypt);
}

#[test]
fn set_field_unknown() {
    let mut cfg = Config::default();
    assert_eq!(
        set_field(&mut cfg, "db.servr", "x"),
        Err(FieldError::UnknownField)
    );
    assert_eq!(get_field(&cfg, "db.servr"), None);
}

#[test]
fn get_field_formats_values_and_masks_secrets() {
    let mut cfg = sealed_config(SecretField::DbPassword, "geheim");
    set_field(&mut cfg, "tls.mode", "internal").unwrap();

    assert_eq!(get_field(&cfg, "db.port").as_deref(), Some("1433"));
    assert_eq!(get_field(&cfg, "db.encrypt").as_deref(), Some("true"));
    assert_eq!(get_field(&cfg, "tls.mode").as_deref(), Some("internal"));
    assert_eq!(get_field(&cfg, "db.password").as_deref(), Some("***"));
    assert_eq!(get_field(&cfg, "app.secret").as_deref(), Some(""));
}

#[test]
fn fields_table_matches_config_and_accessors() {
    // Jeder Schlüssel der serialisierten Standardkonfiguration steht in FIELDS (und umgekehrt).
    let toml_text = toml::to_string(&Config::default()).unwrap();
    let table: toml::Table = toml_text.parse().unwrap();
    let mut serialized = BTreeSet::new();
    for (section, value) in &table {
        if let toml::Value::Table(inner) = value {
            for key in inner.keys() {
                serialized.insert(format!("{section}.{key}"));
            }
        }
    }
    let listed: BTreeSet<_> = FIELDS.iter().map(|field| field.path.to_string()).collect();
    assert_eq!(listed, serialized);

    let secret_paths: BTreeSet<_> = FIELDS
        .iter()
        .filter(|field| field.secret)
        .map(|field| field.path)
        .collect();
    let expected: BTreeSet<_> = SECRET_FIELDS.iter().map(|field| field.path()).collect();
    assert_eq!(secret_paths, expected);

    let mut cfg = Config::default();
    for field in FIELDS {
        assert!(get_field(&cfg, field.path).is_some(), "get {}", field.path);
        let result = set_field(&mut cfg, field.path, "x");
        assert_ne!(result, Err(FieldError::UnknownField), "set {}", field.path);
    }
}

#[test]
fn export_masks_secrets() {
    let cfg = sealed_config(SecretField::DbPassword, "p@ss'wört%");

    let text = export_toml(&cfg);

    assert!(text.contains("password = \"***\""), "{text}");
    assert!(text.contains("client_secret = \"\""), "{text}");
    assert!(!text.contains(&format!("{}:", scheme())), "{text}");
    assert!(!text.contains("p@ss"), "{text}");
}

#[test]
fn masked_does_not_touch_original() {
    let cfg = sealed_config(SecretField::DbPassword, "geheim");

    let view = masked(&cfg);

    assert_eq!(view.sealed(SecretField::DbPassword), &Sealed("***".into()));
    assert!(cfg.sealed(SecretField::DbPassword).is_sealed(scheme()));
}

#[test]
fn import_keeps_masked_and_seals_plain() {
    let p = protector();
    let mut existing = sealed_config(SecretField::DbPassword, "alt");
    existing
        .seal(SecretField::AppSecret, Some(&Secret::new("app-alt")), &*p)
        .unwrap();
    existing
        .seal(
            SecretField::OidcClientSecret,
            Some(&Secret::new("oidc-alt")),
            &*p,
        )
        .unwrap();

    let text = r#"
[db]
server = "sql02"
password = "***"
[oidc]
client_secret = "neu-geheim"
[app]
secret = ""
[tls]
acme_eab_hmac = "klartext-hmac"
"#;
    let imported = import_toml(&existing, text, &*p).unwrap();

    // `***` behält den alten versiegelten Wert unverändert
    assert_eq!(
        imported.sealed(SecretField::DbPassword),
        existing.sealed(SecretField::DbPassword)
    );
    assert_eq!(imported.db.server, "sql02");
    // Klartext wird versiegelt, nichts davon landet im Modell
    for field in [SecretField::OidcClientSecret, SecretField::AcmeEabHmac] {
        let sealed = imported.sealed(field);
        assert!(sealed.is_sealed(scheme()), "{}", field.path());
        assert!(!sealed.0.contains("geheim") && !sealed.0.contains("klartext"));
    }
    // Leer löscht
    assert!(imported.sealed(SecretField::AppSecret).is_empty());

    let secrets = imported.open_secrets(&*p).unwrap();
    assert_eq!(secrets.db_password.unwrap().expose(), "alt");
    assert_eq!(secrets.oidc_client_secret.unwrap().expose(), "neu-geheim");
    assert_eq!(secrets.acme_eab_hmac.unwrap().expose(), "klartext-hmac");
    assert!(secrets.app_secret.is_none());
}

#[test]
fn import_keeps_already_sealed_value() {
    let p = protector();
    let sealed = sealed_config(SecretField::DbPassword, "geheim")
        .sealed(SecretField::DbPassword)
        .clone();
    let text = format!("[db]\npassword = \"{}\"\n", sealed.0);

    let imported = import_toml(&Config::default(), &text, &*p).unwrap();

    assert_eq!(imported.sealed(SecretField::DbPassword), &sealed);
}

#[test]
fn import_mask_without_existing_value_stays_empty() {
    let imported = import_toml(
        &Config::default(),
        "[db]\npassword = \"***\"\n",
        &*protector(),
    )
    .unwrap();

    assert!(imported.sealed(SecretField::DbPassword).is_empty());
}

#[test]
fn export_import_roundtrip_keeps_everything() {
    let p = protector();
    let mut cfg = sealed_config(SecretField::DbPassword, "geheim");
    set_field(&mut cfg, "db.server", "sql01").unwrap();
    set_field(&mut cfg, "tls.mode", "off").unwrap();

    let imported = import_toml(&cfg, &export_toml(&cfg), &*p).unwrap();

    assert_eq!(imported, cfg);
}

#[test]
fn import_rejects_bad_files() {
    let p = protector();
    let existing = Config::default();
    assert!(matches!(
        import_toml(&existing, "[db\n", &*p),
        Err(ConfigError::Unreadable(_))
    ));
    assert_eq!(
        import_toml(&existing, "schema = 2\n", &*p).unwrap_err(),
        ConfigError::UnsupportedSchema(2)
    );
}

#[test]
fn secret_debug_masked() {
    let secret = Secret::new("x");
    assert_eq!(format!("{secret:?}"), "***");
    assert_eq!(format!("{secret}"), "***");
    assert_eq!(secret.expose(), "x");
    assert!(!secret.is_empty());
    assert!(Secret::new("").is_empty());
}

#[test]
fn secrets_debug_masked() {
    let secrets = Secrets {
        db_password: Some(Secret::new("p@ss")),
        ..Secrets::default()
    };
    let text = format!("{secrets:?}");
    assert!(!text.contains("p@ss"), "{text}");
}
