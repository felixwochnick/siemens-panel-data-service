//! Unter Windows erzeugt tauri-build Kontext (Oberfläche aus `ui/dist`, Rechte aus
//! `capabilities/`) und Ressourcen (Symbol, Manifest mit Administratorrechten). Für andere Ziele
//! gibt es keine Oberfläche, also nichts zu tun – so braucht `cargo test` unter Linux weder WebKit
//! noch GTK.

fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    // Zielsystem, nicht das des Builds: Auch beim Prüfen für Windows unter Linux wird erzeugt
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    // Eigenes Manifest: requireAdministrator (die Oberfläche schreibt in den Datenordner und steuert
    // den Dienst, Windows fragt per UAC) und Common Controls v6 aus Tauris Standardmanifest, das es
    // ersetzt (sonst starten die Dialoge nicht). Nur ASCII, der SxS-Parser ist empfindlich.
    let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("app.manifest"));
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(windows)
        // Kontext im Build-Skript statt per Makro: Dann bettet ein neuer `ui/dist`-Stand neu ein
        .codegen(tauri_build::CodegenContext::new());
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("tauri-build: {error:#}");
    }
}
