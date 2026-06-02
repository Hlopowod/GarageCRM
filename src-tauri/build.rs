use dotenvy::from_path_override;
use std::env;
use std::fs;
use std::path::PathBuf;

fn escape_rustc_env(value: &str) -> String {
    value.replace("\r\n", "\\n").replace('\n', "\\n")
}

fn main() {
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is unavailable during build"),
    );
    let project_root = manifest_dir
        .parent()
        .map(PathBuf::from)
        .unwrap_or(manifest_dir);
    let env_path = project_root.join(".env");
    let env_local_path = project_root.join(".env.local");

    println!("cargo:rerun-if-changed={}", env_path.display());
    println!("cargo:rerun-if-changed={}", env_local_path.display());
    println!("cargo:rerun-if-env-changed=VITE_SUPABASE_URL");
    println!("cargo:rerun-if-env-changed=VITE_SUPABASE_ANON_KEY");
    println!("cargo:rerun-if-env-changed=GARAGE_CRM_SUPABASE_URL");
    println!("cargo:rerun-if-env-changed=GARAGE_CRM_SUPABASE_ANON_KEY");
    println!("cargo:rerun-if-env-changed=GARAGE_CRM_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-env-changed=GARAGE_CRM_UPDATER_PUBKEY");
    println!("cargo:rerun-if-env-changed=GARAGE_CRM_UPDATER_PUBKEY_PATH");

    let _ = from_path_override(&env_path);
    let _ = from_path_override(&env_local_path);

    if let Ok(url) = env::var("VITE_SUPABASE_URL").or_else(|_| env::var("GARAGE_CRM_SUPABASE_URL"))
    {
        println!("cargo:rustc-env=GARAGE_CRM_SUPABASE_URL={}", url.trim());
    }
    if let Ok(key) =
        env::var("VITE_SUPABASE_ANON_KEY").or_else(|_| env::var("GARAGE_CRM_SUPABASE_ANON_KEY"))
    {
        println!(
            "cargo:rustc-env=GARAGE_CRM_SUPABASE_ANON_KEY={}",
            key.trim()
        );
    }
    if let Ok(endpoint) = env::var("GARAGE_CRM_UPDATER_ENDPOINT") {
        println!(
            "cargo:rustc-env=GARAGE_CRM_UPDATER_ENDPOINT={}",
            endpoint.trim()
        );
    }
    if let Ok(pubkey) = env::var("GARAGE_CRM_UPDATER_PUBKEY") {
        println!(
            "cargo:rustc-env=GARAGE_CRM_UPDATER_PUBKEY={}",
            escape_rustc_env(pubkey.trim())
        );
    } else if let Ok(pubkey_path) = env::var("GARAGE_CRM_UPDATER_PUBKEY_PATH") {
        let trimmed_path = pubkey_path.trim();
        if !trimmed_path.is_empty() {
            println!("cargo:rerun-if-changed={}", trimmed_path);
            let pubkey = fs::read_to_string(trimmed_path).unwrap_or_else(|_| {
                panic!("Failed to read updater public key from {}", trimmed_path)
            });
            println!(
                "cargo:rustc-env=GARAGE_CRM_UPDATER_PUBKEY={}",
                escape_rustc_env(pubkey.trim())
            );
        }
    }

    tauri_build::build()
}
