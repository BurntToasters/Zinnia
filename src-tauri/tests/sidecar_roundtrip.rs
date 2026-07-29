//! End-to-end test against the real bundled 7-Zip binary. Skips (passes) when the
//! per-host sidecar binary is absent (run `npm run prepare:7z` to provide it).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

fn output_with_piped_password(command: &mut Command, password: &str) -> std::process::Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("7z should run");
    let mut stdin = child.stdin.take().expect("7z stdin pipe");
    for _ in 0..3 {
        stdin.write_all(password.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
    }
    drop(stdin);
    child.wait_with_output().unwrap()
}

#[cfg(windows)]
fn volume_guid_alias(path: &Path) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
    use windows_sys::Win32::Storage::FileSystem::{
        GetVolumeNameForVolumeMountPointW, GetVolumePathNameW,
    };

    let input: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut mount = vec![0u16; 32_768];
    if unsafe { GetVolumePathNameW(input.as_ptr(), mount.as_mut_ptr(), mount.len() as u32) } == 0 {
        return None;
    }
    let mount_len = mount.iter().position(|unit| *unit == 0)?;
    let mount_path = PathBuf::from(OsString::from_wide(&mount[..mount_len]));
    let relative = path.strip_prefix(&mount_path).ok()?;

    let mount_wide: Vec<u16> = mount_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut volume = [0u16; 50];
    if unsafe {
        GetVolumeNameForVolumeMountPointW(
            mount_wide.as_ptr(),
            volume.as_mut_ptr(),
            volume.len() as u32,
        )
    } == 0
    {
        return None;
    }
    let volume_len = volume.iter().position(|unit| *unit == 0)?;
    Some(PathBuf::from(OsString::from_wide(&volume[..volume_len])).join(relative))
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
fn ui_compression_switch_matrix_runs_on_bundled_sidecar() {
    let Some(bin) = binary_path() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };
    let work = temp_dir("format-matrix");
    std::fs::write(work.join("input.txt"), b"format matrix\n").unwrap();
    let cases: &[(&str, &str, &[&str])] = &[
        ("7z", "7z", &["-m0=lzma2", "-md=64m", "-mfb=64"]),
        ("zip", "zip", &["-m0=deflate", "-mfb=64"]),
        ("tar", "tar", &[]),
        ("gzip", "gz", &["-mfb=64"]),
        ("bzip2", "bz2", &[]),
        ("xz", "xz", &["-md=64m", "-mfb=64"]),
    ];

    for (format, extension, method_switches) in cases {
        let archive = work.join(format!("matrix.{extension}"));
        let mut command = Command::new(&bin);
        command
            .current_dir(&work)
            .arg("a")
            .arg(format!("-t{format}"))
            .arg("-mx=5");
        command.args(*method_switches);
        let add = command
            .arg("-snl")
            .arg("-snh")
            .arg(&archive)
            .arg("--")
            .arg("input.txt")
            .output()
            .expect("7z matrix add should run");
        assert!(
            add.status.success(),
            "{format} add failed: stdout={} stderr={}",
            String::from_utf8_lossy(&add.stdout),
            String::from_utf8_lossy(&add.stderr)
        );

        let test = Command::new(&bin)
            .args(["t", "--"])
            .arg(&archive)
            .output()
            .expect("7z matrix test should run");
        assert!(
            test.status.success(),
            "{format} integrity test failed: {}",
            String::from_utf8_lossy(&test.stderr)
        );
    }

    let _ = std::fs::remove_dir_all(work);
}

#[cfg(windows)]
#[test]
fn create_extract_roundtrip_supports_extended_and_volume_guid_paths() {
    use std::ffi::OsString;

    let Some(bin) = binary_path() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };

    let work = temp_dir("windows-namespaces");
    let Some(volume_work) = volume_guid_alias(&work) else {
        eprintln!("skipping: temporary directory has no volume-GUID alias");
        let _ = std::fs::remove_dir_all(work);
        return;
    };
    let extended_work = PathBuf::from(format!(r"\\?\{}", work.display()));
    let source = extended_work.join("namespace-input.txt");
    std::fs::write(&source, b"windows namespace roundtrip\n").unwrap();
    let archive = volume_work.join("namespace-output.7z");

    let add = Command::new(&bin)
        .args(["a", "-t7z"])
        .arg(&archive)
        .arg("--")
        .arg(&source)
        .output()
        .expect("7z add through extended paths should run");
    assert!(
        add.status.success(),
        "extended-path add failed: {}",
        String::from_utf8_lossy(&add.stderr)
    );

    let out = volume_work.join("namespace-extracted");
    let mut output_arg = OsString::from("-o");
    output_arg.push(&out);
    let extract = Command::new(&bin)
        .arg("x")
        .arg(output_arg)
        .arg("-y")
        .arg("--")
        .arg(&archive)
        .output()
        .expect("7z extract through volume-GUID path should run");
    assert!(
        extract.status.success(),
        "volume-GUID extract failed: {}",
        String::from_utf8_lossy(&extract.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(out.join("namespace-input.txt")).unwrap(),
        "windows namespace roundtrip\n"
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

#[test]
fn encrypted_archive_without_password_reaches_eof_instead_of_hanging() {
    let Some(bin) = binary_path() else {
        return;
    };
    let work = temp_dir("password-eof");
    let src = work.join("secret.txt");
    std::fs::write(&src, b"secret\n").unwrap();
    let archive = work.join("encrypted.7z");
    assert!(Command::new(&bin)
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
        .unwrap()
        .status
        .success());

    let mut child = Command::new(&bin)
        .args(["l", "--", archive.to_str().unwrap()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(!status.success(), "listing should require a password");
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            panic!("7-Zip waited indefinitely after password input reached EOF");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(work);
}

#[test]
fn password_prompt_accepts_the_bounded_pipe_used_by_zinnia() {
    let Some(bin) = binary_path() else {
        return;
    };
    let work = temp_dir("password-pipe");
    let src = work.join("secret.txt");
    std::fs::write(&src, b"secret\n").unwrap();
    let archive = work.join("encrypted.7z");
    let add = output_with_piped_password(
        Command::new(&bin).args([
            "a",
            "-t7z",
            "-p",
            "-mhe=on",
            archive.to_str().unwrap(),
            "--",
            src.to_str().unwrap(),
        ]),
        "correct",
    );
    assert!(
        add.status.success(),
        "pipe password failed: {}",
        String::from_utf8_lossy(&add.stderr)
    );

    let list_without_password = Command::new(&bin)
        .args(["l", "--", archive.to_str().unwrap()])
        .stdin(Stdio::null())
        .output()
        .expect("7z list should run");
    assert!(
        !list_without_password.status.success(),
        "encrypted archive listed without a password"
    );

    let test_without_password = Command::new(&bin)
        .args(["t", "--", archive.to_str().unwrap()])
        .stdin(Stdio::null())
        .output()
        .expect("7z test should run");
    assert!(
        !test_without_password.status.success(),
        "encrypted archive tested without a password"
    );

    let out = work.join("without-password");
    let extract_without_password = Command::new(&bin)
        .args([
            "x",
            &format!("-o{}", out.display()),
            "-y",
            "--",
            archive.to_str().unwrap(),
        ])
        .stdin(Stdio::null())
        .output()
        .expect("7z extract should run");
    assert!(
        !extract_without_password.status.success(),
        "encrypted archive extracted without a password"
    );

    let encrypted_listing = output_with_piped_password(
        Command::new(&bin).args(["l", "-slt", "--", archive.to_str().unwrap()]),
        "correct",
    );
    assert!(
        encrypted_listing.status.success(),
        "listing with piped password failed: {}",
        String::from_utf8_lossy(&encrypted_listing.stderr)
    );
    assert!(
        String::from_utf8_lossy(&encrypted_listing.stdout).contains("Encrypted = +"),
        "7z listing did not mark the archived file as encrypted:\n{}",
        String::from_utf8_lossy(&encrypted_listing.stdout)
    );

    let _ = std::fs::remove_dir_all(work);
}
