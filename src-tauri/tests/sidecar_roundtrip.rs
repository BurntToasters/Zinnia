//! End-to-end test against the real bundled 7-Zip binary. Skips (passes) when the
//! per-host sidecar binary is absent (run `npm run prepare:7z` to provide it).

use std::path::{Path, PathBuf};
use std::process::Command;

fn binary_path() -> Option<PathBuf> {
    // CARGO_MANIFEST_DIR is src-tauri/. Pick the sidecar for the host arch/os.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let arch = std::env::consts::ARCH; // "aarch64", "x86_64"
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["pc-windows-msvc.exe"]
    } else if cfg!(target_os = "macos") {
        &["apple-darwin", "universal-apple-darwin"]
    } else {
        &["unknown-linux-gnu"]
    };

    for suffix in candidates {
        let name = if suffix.starts_with("universal") {
            format!("7z-{suffix}")
        } else {
            format!("7z-{arch}-{suffix}")
        };
        let path = dir.join(name);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn temp_dir(tag: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "zinnia-it-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).unwrap();
    base
}

#[test]
fn create_list_test_extract_roundtrip() {
    let Some(bin) = binary_path() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };

    let work = temp_dir("roundtrip");
    let src = work.join("hello.txt");
    std::fs::write(&src, b"zinnia integration test\n").unwrap();
    let archive = work.join("out.7z");

    // create
    let add = Command::new(&bin)
        .current_dir(&work)
        .args([
            "a",
            "-t7z",
            archive.to_str().unwrap(),
            "--",
            src.to_str().unwrap(),
        ])
        .output()
        .expect("7z add should run");
    assert!(
        add.status.success(),
        "add failed: {}",
        String::from_utf8_lossy(&add.stderr)
    );
    assert!(archive.exists(), "archive should be created");

    // list
    let list = Command::new(&bin)
        .args(["l", "--", archive.to_str().unwrap()])
        .output()
        .expect("7z list should run");
    assert!(list.status.success());
    assert!(String::from_utf8_lossy(&list.stdout).contains("hello.txt"));

    // test integrity
    let test = Command::new(&bin)
        .args(["t", "--", archive.to_str().unwrap()])
        .output()
        .expect("7z test should run");
    assert!(test.status.success());
    assert!(String::from_utf8_lossy(&test.stdout).contains("Everything is Ok"));

    // extract to a fresh dir
    let out = work.join("extracted");
    let extract = Command::new(&bin)
        .args([
            "x",
            &format!("-o{}", out.to_str().unwrap()),
            "-y",
            "--",
            archive.to_str().unwrap(),
        ])
        .output()
        .expect("7z extract should run");
    assert!(
        extract.status.success(),
        "extract failed: {}",
        String::from_utf8_lossy(&extract.stderr)
    );
    let extracted = out.join("hello.txt");
    assert_eq!(
        std::fs::read_to_string(&extracted).unwrap(),
        "zinnia integration test\n"
    );

    let _ = std::fs::remove_dir_all(work);
}

#[test]
fn rejects_extract_with_wrong_password() {
    let Some(bin) = binary_path() else {
        return;
    };

    let work = temp_dir("wrongpw");
    let src = work.join("secret.txt");
    std::fs::write(&src, b"top secret\n").unwrap();
    let archive = work.join("enc.7z");

    let add = Command::new(&bin)
        .args([
            "a",
            "-t7z",
            "-pcorrect",
            "-mhe=on",
            archive.to_str().unwrap(),
            "--",
            src.to_str().unwrap(),
        ])
        .output()
        .expect("7z add should run");
    assert!(add.status.success());

    // wrong password must fail
    let out = work.join("out");
    let extract = Command::new(&bin)
        .args([
            "x",
            &format!("-o{}", out.to_str().unwrap()),
            "-pwrong",
            "-y",
            "--",
            archive.to_str().unwrap(),
        ])
        .output()
        .expect("7z extract should run");
    assert!(!extract.status.success(), "wrong password should fail");

    let _ = std::fs::remove_dir_all(work);
}
