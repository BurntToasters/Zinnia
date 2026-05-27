use std::path::Path;

const BINARIES: &[(&str, &str)] = &[
    ("win/x64/7za.exe", "7z-x86_64-pc-windows-msvc.exe"),
    ("win/arm64/7za.exe", "7z-aarch64-pc-windows-msvc.exe"),
    ("mac/7zz", "7z-x86_64-apple-darwin"),
    ("mac/7zz", "7z-aarch64-apple-darwin"),
    ("mac/7zz", "7z-universal-apple-darwin"),
    ("linux/x64/7zzs", "7z-x86_64-unknown-linux-gnu"),
    ("linux/arm64/7zzs", "7z-aarch64-unknown-linux-gnu"),
];

fn prepare_7z_binaries() {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set by Cargo");
    let tauri_dir = Path::new(&manifest_dir);
    let root = tauri_dir
        .parent()
        .expect("src-tauri should have a repository parent");
    let assets_dir = root.join("assets");
    let out_dir = tauri_dir.join("binaries");

    std::fs::create_dir_all(&out_dir).expect("failed to create src-tauri/binaries");

    for (source, target) in BINARIES {
        let source_path = assets_dir.join(source);
        let target_path = out_dir.join(target);
        println!("cargo:rerun-if-changed={}", source_path.display());

        if !source_path.exists() || target_path.exists() {
            continue;
        }

        std::fs::copy(&source_path, &target_path).unwrap_or_else(|err| {
            panic!(
                "failed to prepare bundled 7z binary {} from {}: {err}",
                target_path.display(),
                source_path.display()
            )
        });

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&target_path)
                .expect("prepared 7z binary should have metadata")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&target_path, permissions)
                .expect("failed to make prepared 7z binary executable");
        }
    }
}

fn main() {
    prepare_7z_binaries();
    tauri_build::build();
}
