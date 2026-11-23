//! Schreibt je TLS-Modus eine Caddy-Konfiguration, wie der Dienst sie Caddy über stdin gibt,
//! damit die Windows-CI sie mit dem mitgelieferten `caddy.exe validate` prüfen kann.
//!
//! Nur Beispielwerte: Zertifikat und Schlüssel stammen aus der Test-PFX, der EAB-HMAC ist ein
//! Platzhalter. Es gibt bewusst keinen Produktbefehl dafür, denn die echte Konfiguration enthält
//! Secrets (TLS-Schlüssel, EAB-HMAC).
//!
//! ```text
//! cargo run -p pds-common --example render_samples -- <ausgabeordner>
//! ```
//!
//! Ergebnis: `<ausgabeordner>/caddy-<modus>.json` für `certificate`, `acme`, `internal` und `off`.
//! Caddys Ablage zeigt je Modus auf `<ausgabeordner>/data-<modus>/caddy`.

use std::path::{Path, PathBuf};
use std::{env, fs, process};

use pds_common::Secret;
use pds_common::config::{Config, TlsMode};
use pds_common::paths::Paths;
use pds_common::render;
use pds_common::tls::{self, TlsMaterial};

/// Hostname der Test-PFX (`tests/fixtures/openssl-aes256.pfx`).
const FIXTURE_HOST: &str = "windows-legacy.example.com";
const FIXTURE_PASSWORD: &str = "Pässwört 1!";

fn main() {
    let Some(out_dir) = env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("Aufruf: render_samples <ausgabeordner>");
        process::exit(2);
    };
    if let Err(error) = run(&out_dir) {
        eprintln!("render_samples: {error}");
        process::exit(1);
    }
}

fn run(out_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    let out_dir = fs::canonicalize(out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    let material = fixture_material()?;

    // Die CA-Wurzel für ACME muss als Datei existieren, Caddy liest sie schon beim Prüfen
    let ca_root = out_dir.join("acme-ca-root.pem");
    write(&ca_root, &material.chain_pem)?;

    for mode in [
        TlsMode::Certificate,
        TlsMode::Acme,
        TlsMode::Internal,
        TlsMode::Off,
    ] {
        let name = mode_name(mode);
        let data_dir = out_dir.join(format!("data-{name}"));
        fs::create_dir_all(data_dir.join("caddy"))
            .map_err(|e| format!("{}: {e}", data_dir.display()))?;
        let paths = Paths::new(out_dir.join("install"), &data_dir);

        let mut config = Config::default();
        config.public.host = FIXTURE_HOST.into();
        config.tls.mode = mode;
        let mut tls = None;
        let mut eab_hmac = None;
        match mode {
            TlsMode::Certificate => tls = Some(&material),
            TlsMode::Acme => {
                config.tls.acme_email = "admin@example.com".into();
                config.tls.acme_ca_url = "https://acme.example.com/acme/directory".into();
                config.tls.acme_ca_root = ca_root.to_string_lossy().into_owned();
                config.tls.acme_eab_key_id = "kid-platzhalter".into();
                // base64url wie bei echten EAB-Schlüsseln
                eab_hmac = Some(Secret::new("cGxhdHpoYWx0ZXItZWFiLWhtYWMtZnVlci1kaWUtY2k"));
            }
            TlsMode::Internal => {}
            TlsMode::Off => {
                config.public.scheme = "http".into();
                config.public.port = 80;
            }
        }

        let json = render::caddy_json(&config, &paths, tls, eab_hmac.as_ref());
        let file = out_dir.join(format!("caddy-{name}.json"));
        write(&file, json.expose())?;
        println!("{}", file.display());
    }
    Ok(())
}

fn fixture_material() -> Result<TlsMaterial, String> {
    let pfx = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/openssl-aes256.pfx");
    let bytes = fs::read(&pfx).map_err(|e| format!("{}: {e}", pfx.display()))?;
    tls::from_pfx(&bytes, &Secret::new(FIXTURE_PASSWORD))
        .map_err(|e| format!("Test-PFX nicht lesbar: {e}"))
}

fn mode_name(mode: TlsMode) -> &'static str {
    match mode {
        TlsMode::Certificate => "certificate",
        TlsMode::Acme => "acme",
        TlsMode::Internal => "internal",
        TlsMode::Off => "off",
    }
}

fn write(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("{}: {e}", path.display()))
}
