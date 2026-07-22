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

fn sha256_file(path: &Path) -> String {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .unwrap_or_else(|e| panic!("failed to open {} for checksum: {e}", path.display()));
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in &digest {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

/// Minimal SHA-256 implementation for build script (avoids adding a dep to build-dependencies).
/// Based on FIPS 180-4.
struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Sha256 {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    fn update(&mut self, data: &[u8]) {
        let mut offset = 0;
        self.total_len += data.len() as u64;
        if self.buf_len > 0 {
            let space = 64 - self.buf_len;
            let take = space.min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            offset += take;
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        while offset + 64 <= data.len() {
            let block: [u8; 64] = data[offset..offset + 64].try_into().unwrap();
            self.compress(&block);
            offset += 64;
        }
        if offset < data.len() {
            let remaining = data.len() - offset;
            self.buf[..remaining].copy_from_slice(&data[offset..]);
            self.buf_len = remaining;
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.total_len * 8;
        // Padding
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;
        if self.buf_len > 56 {
            for i in self.buf_len..64 {
                self.buf[i] = 0;
            }
            let block = self.buf;
            self.compress(&block);
            self.buf = [0u8; 64];
            self.buf_len = 0;
        }
        for i in self.buf_len..56 {
            self.buf[i] = 0;
        }
        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buf;
        self.compress(&block);

        let mut out = [0u8; 32];
        for (i, &word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        #[rustfmt::skip]
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
            0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
            0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
            0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
            0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ];

        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }
}

fn load_checksums(path: &Path) -> std::collections::HashMap<String, String> {
    let contents = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read checksum manifest {}: {e}", path.display()));
    // Minimal JSON parsing for a flat string→string object (no external deps in build script)
    let mut map = std::collections::HashMap::new();
    let trimmed = contents.trim();
    let inner = trimmed
        .strip_prefix('{')
        .and_then(|s| s.strip_suffix('}'))
        .expect("7z-checksums.json must be a JSON object");
    for entry in inner.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let mut parts = entry.splitn(2, ':');
        let key = parts
            .next()
            .expect("checksum entry key")
            .trim()
            .trim_matches('"');
        let value = parts
            .next()
            .expect("checksum entry value")
            .trim()
            .trim_matches('"');
        map.insert(key.to_string(), value.to_string());
    }
    map
}

fn validate_provenance(path: &Path, checksums: &std::collections::HashMap<String, String>) {
    let contents = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read provenance manifest {}: {e}", path.display()));
    assert!(
        contents.contains("\"officialDownloadPage\": \"https://www.7-zip.org/download.html\""),
        "7z-provenance.json must identify the official download page"
    );
    assert!(
        contents.contains("\"sourceArchives\"") && contents.contains("\"artifacts\""),
        "7z-provenance.json must record source archives and extracted artifacts"
    );
    for source in checksums.keys() {
        assert!(
            contents.contains(&format!("\"{source}\"")),
            "7z-provenance.json has no record for {source}"
        );
    }
}

fn required_sidecar_for_target(target_triple: &str) -> Option<&'static str> {
    match target_triple {
        "x86_64-pc-windows-msvc" => Some("7z-x86_64-pc-windows-msvc.exe"),
        "aarch64-pc-windows-msvc" => Some("7z-aarch64-pc-windows-msvc.exe"),
        "x86_64-apple-darwin" => Some("7z-x86_64-apple-darwin"),
        "aarch64-apple-darwin" => Some("7z-aarch64-apple-darwin"),
        "universal-apple-darwin" => Some("7z-universal-apple-darwin"),
        "x86_64-unknown-linux-gnu" => Some("7z-x86_64-unknown-linux-gnu"),
        "aarch64-unknown-linux-gnu" => Some("7z-aarch64-unknown-linux-gnu"),
        _ => None,
    }
}

fn prepare_7z_binaries() {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set by Cargo");
    let tauri_dir = Path::new(&manifest_dir);
    let root = tauri_dir
        .parent()
        .expect("src-tauri should have a repository parent");
    let assets_dir = root.join("assets");
    let out_dir = tauri_dir.join("binaries");
    let checksums_path = root.join("assets").join("7z-checksums.json");
    let provenance_path = root.join("assets").join("7z-provenance.json");
    // Cargo always sets TARGET for build scripts; HOST is a last-resort fallback.
    let target_triple = std::env::var("TARGET")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_default();

    println!("cargo:rerun-if-changed={}", checksums_path.display());
    println!("cargo:rerun-if-changed={}", provenance_path.display());
    println!("cargo:rerun-if-env-changed=TARGET");
    let checksums = load_checksums(&checksums_path);
    validate_provenance(&provenance_path, &checksums);

    std::fs::create_dir_all(&out_dir).expect("failed to create src-tauri/binaries");

    let required_sidecar = required_sidecar_for_target(&target_triple);
    let mut prepared_required = false;

    for (source, target) in BINARIES {
        let source_path = assets_dir.join(source);
        let target_path = out_dir.join(target);
        println!("cargo:rerun-if-changed={}", source_path.display());

        let is_required = required_sidecar == Some(*target);
        if !source_path.exists() {
            if is_required {
                panic!(
                    "Missing required 7z asset for target {target_triple}: {}\nRun `npm run prepare:7z` (or `npm run prepare:7z:all`) before building.",
                    source_path.display()
                );
            }
            continue;
        }

        // Verify checksum before copying
        let actual_hash = sha256_file(&source_path);
        if let Some(expected) = checksums.get(*source) {
            if actual_hash != *expected {
                panic!(
                    "Checksum mismatch for {}\n  expected: {}\n  actual:   {}\nRun `node scripts/prepare-7z.js --update-checksums --version <verified-version> --verify-downloads <directory>` after verifying the official archives.",
                    source, expected, actual_hash
                );
            }
        } else {
            panic!(
                "No checksum entry for {} in 7z-checksums.json. Run `node scripts/prepare-7z.js --update-checksums --version <verified-version> --verify-downloads <directory>` after verifying the official archives.",
                source
            );
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

        if is_required {
            prepared_required = true;
        }
    }

    if let Some(sidecar) = required_sidecar {
        if !prepared_required || !out_dir.join(sidecar).exists() {
            panic!(
                "Required 7z sidecar `{sidecar}` for target `{target_triple}` was not prepared.\nRun `npm run prepare:7z` before building."
            );
        }
    }
}

fn main() {
    prepare_7z_binaries();
    const COMMANDS: &[&str] = &[
        "run_7z",
        "cancel_7z",
        "is_7z_running",
        "probe_7z",
        "get_startup_recovery_status",
        "validate_archive_paths",
        "load_settings",
        "save_settings",
        "reset_settings",
        "append_local_log",
        "get_log_dir",
        "export_logs",
        "clear_logs",
        "open_log_dir",
        "open_path",
        "register_extract_open_path",
        "get_initial_paths",
        "get_initial_mode",
        "drain_pending_paths",
        "get_extract_paths",
        "close_extract_window",
        "mark_main_window_ready",
        "get_platform_info",
        "get_os_integration_status",
        "open_os_integration_settings",
        "open_finder_services_settings",
        "enable_finder_services",
        "open_finder_sync_settings",
        "enable_finder_sync",
        "reset_preferred_archiver_to_system",
        "set_zinnia_default_archiver",
        "get_cpu_count",
        "is_flatpak",
        "is_packaged",
        "create_temp_extract_dir",
        "remove_managed_temp_dir",
        "set_workspace_window_fx",
        "supports_workspace_window_fx",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application metadata");
}
