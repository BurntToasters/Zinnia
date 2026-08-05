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
fn compound_tar_two_pass_roundtrip() {
    let Some(bin) = binary_path() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };
    let work = temp_dir("compound-tar");
    std::fs::create_dir_all(work.join("payload")).unwrap();
    std::fs::write(work.join("payload/file.txt"), b"compound tar\n").unwrap();
    let inner = work.join("payload.tar");
    let outer = work.join("payload.tar.gz");

    assert!(Command::new(&bin)
        .current_dir(&work)
        .args(["a", "-ttar"])
        .arg(&inner)
        .args(["--", "payload"])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new(&bin)
        .current_dir(&work)
        .args(["a", "-tgzip"])
        .arg(&outer)
        .arg("--")
        .arg(&inner)
        .output()
        .unwrap()
        .status
        .success());

    let outer_stage = work.join("outer-stage");
    let unpack_outer = Command::new(&bin)
        .arg("x")
        .arg(format!("-o{}", outer_stage.display()))
        .arg("-aou")
        .arg("--")
        .arg(&outer)
        .output()
        .unwrap();
    assert!(
        unpack_outer.status.success(),
        "outer extract failed: {}",
        String::from_utf8_lossy(&unpack_outer.stderr)
    );
    let output = work.join("compound-output");
    let unpack_inner = Command::new(&bin)
        .arg("x")
        .arg(format!("-o{}", output.display()))
        .arg("-aou")
        .arg("--")
        .arg(outer_stage.join("payload.tar"))
        .output()
        .unwrap();
    assert!(
        unpack_inner.status.success(),
        "inner extract failed: {}",
        String::from_utf8_lossy(&unpack_inner.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(output.join("payload/file.txt")).unwrap(),
        "compound tar\n"
    );
    let _ = std::fs::remove_dir_all(work);
}

#[test]
fn snld10_switch_is_accepted_by_bundled_sidecar() {
    let Some(bin) = binary_path() else {
        return;
    };
    let work = temp_dir("snld10-switch");
    std::fs::write(work.join("input.txt"), b"switch\n").unwrap();
    let archive = work.join("input.zip");
    assert!(Command::new(&bin)
        .current_dir(&work)
        .args(["a", "-tzip"])
        .arg(&archive)
        .args(["--", "input.txt"])
        .output()
        .unwrap()
        .status
        .success());
    let output = Command::new(&bin)
        .arg("x")
        .arg("-snld10")
        .arg(format!("-o{}", work.join("out").display()))
        .arg("--")
        .arg(&archive)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "-snld10 unsupported: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = std::fs::remove_dir_all(work);
}

#[cfg(windows)]
#[test]
fn full_windows_runtime_has_companion_dll_and_rar_handler() {
    let Some(bin) = binary_path() else {
        return;
    };
    assert!(
        bin.parent()
            .expect("sidecar parent")
            .join("7z.dll")
            .is_file(),
        "full Windows sidecar requires adjacent 7z.dll"
    );
    let info = Command::new(&bin).arg("i").output().expect("7z i");
    assert!(info.status.success(), "7z i failed");
    let stdout = String::from_utf8_lossy(&info.stdout);
    assert!(
        stdout
            .split_whitespace()
            .any(|token| token == "Rar" || token == "Rar5"),
        "{stdout}"
    );
}

#[cfg(unix)]
#[test]
fn zip_round_trips_contained_and_dangling_symlinks() {
    let Some(bin) = binary_path() else {
        return;
    };
    let work = temp_dir("zip-links");
    std::fs::create_dir_all(work.join("tree/real")).unwrap();
    std::fs::write(work.join("tree/real/file.txt"), b"zip links\n").unwrap();
    std::os::unix::fs::symlink("real/file.txt", work.join("tree/current")).unwrap();
    std::os::unix::fs::symlink("generated-later", work.join("tree/dangling")).unwrap();
    let archive = work.join("links.zip");
    let add = Command::new(&bin)
        .current_dir(&work)
        .args(["a", "-tzip", "-snl", "-snh"])
        .arg(&archive)
        .args(["--", "tree"])
        .output()
        .unwrap();
    assert!(
        add.status.success(),
        "{}",
        String::from_utf8_lossy(&add.stderr)
    );
    let out = work.join("out");
    let extract = Command::new(&bin)
        .arg("x")
        .arg("-snld10")
        .arg(format!("-o{}", out.display()))
        .arg("--")
        .arg(&archive)
        .output()
        .unwrap();
    assert!(
        extract.status.success(),
        "{}",
        String::from_utf8_lossy(&extract.stderr)
    );
    assert_eq!(
        std::fs::read_link(out.join("tree/current")).unwrap(),
        PathBuf::from("real/file.txt")
    );
    assert_eq!(
        std::fs::read_link(out.join("tree/dangling")).unwrap(),
        PathBuf::from("generated-later")
    );
    let _ = std::fs::remove_dir_all(work);
}

/// Absolute archive symlinks may be remapped under `-o` with exit 0; never
/// preserve a host path like `/etc/passwd` as-is.
#[cfg(unix)]
#[test]
fn snld10_absolute_symlink_does_not_follow_host_paths() {
    let Some(bin) = binary_path() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };

    let work = temp_dir("snld10-absolute");
    let src = work.join("safe");
    std::fs::create_dir_all(&src).expect("source tree");
    std::fs::write(src.join("a.txt"), b"ok").expect("payload");
    std::os::unix::fs::symlink("/etc/passwd", src.join("abs-link")).expect("absolute link");

    let archive = work.join("absolute.tar");
    let tar = Command::new("tar")
        .current_dir(&work)
        .args(["-cf", archive.to_str().expect("archive utf8"), "safe"])
        .output()
        .expect("tar should create archive");
    assert!(
        tar.status.success(),
        "tar failed: {}",
        String::from_utf8_lossy(&tar.stderr)
    );

    let out = work.join("out");
    let extract = Command::new(&bin)
        .args([
            "x",
            &format!("-o{}", out.display()),
            "-aou",
            "-snld10",
            "--",
            archive.to_str().expect("archive utf8"),
        ])
        .output()
        .expect("7z extract should run");
    // Either 7-Zip rejects it, or it remaps under `-o`. Never follow host /etc.
    let link = out.join("safe/abs-link");
    if extract.status.success() && link.exists() {
        let target = std::fs::read_link(&link).expect("abs-link target");
        let target_text = target.to_string_lossy();
        assert!(
            target.is_absolute() && target_text.contains(out.to_string_lossy().as_ref()),
            "absolute host path must not be preserved as-is: {target_text}"
        );
        assert_ne!(target.as_os_str(), std::ffi::OsStr::new("/etc/passwd"));
    }

    let _ = std::fs::remove_dir_all(work);
}

/// macOS Finder/ditto ZIPs of `.app` bundles store nested framework symlinks in
/// a shape that 7-Zip 25.01+ rejects unless `-snld10` (or higher) is set.
#[cfg(target_os = "macos")]
#[test]
fn ditto_zip_app_framework_links_extract_with_snld10() {
    let Some(bin) = binary_path() else {
        eprintln!("skipping: bundled 7z binary not found (run npm run prepare:7z)");
        return;
    };

    let work = temp_dir("app-framework-zip");
    let app = work.join("Demo.app/Contents/Frameworks/Demo.framework");
    std::fs::create_dir_all(app.join("Versions/A/Libraries")).expect("framework tree");
    std::fs::write(app.join("Versions/A/Libraries/lib.dylib"), b"lib").expect("dylib");
    std::os::unix::fs::symlink("A", app.join("Versions/Current")).expect("Current link");
    std::os::unix::fs::symlink("Versions/Current/Libraries", app.join("Libraries"))
        .expect("Libraries link");

    let archive = work.join("Demo.app.zip");
    let ditto = Command::new("ditto")
        .current_dir(&work)
        .args([
            "-c",
            "-k",
            "--keepParent",
            "Demo.app",
            archive.to_str().expect("archive utf8"),
        ])
        .output()
        .expect("ditto should create the zip");
    assert!(
        ditto.status.success(),
        "ditto failed: {}",
        String::from_utf8_lossy(&ditto.stderr)
    );

    let blocked = work.join("blocked");
    let without_snld = Command::new(&bin)
        .args([
            "x",
            &format!("-o{}", blocked.display()),
            "-aou",
            "-bb1",
            "--",
            archive.to_str().expect("archive utf8"),
        ])
        .output()
        .expect("7z extract without -snld10 should run");
    assert!(
        !without_snld.status.success(),
        "expected ditto-zip nested framework links to fail without -snld10"
    );
    let blocked_log = format!(
        "{}{}",
        String::from_utf8_lossy(&without_snld.stdout),
        String::from_utf8_lossy(&without_snld.stderr)
    );
    assert!(
        blocked_log.contains("Dangerous link via another link"),
        "expected dangerous-link error, got: {blocked_log}"
    );

    let allowed = work.join("allowed");
    let with_snld = Command::new(&bin)
        .args([
            "x",
            &format!("-o{}", allowed.display()),
            "-aou",
            "-bb1",
            "-snld10",
            "--",
            archive.to_str().expect("archive utf8"),
        ])
        .output()
        .expect("7z extract with -snld10 should run");
    assert!(
        with_snld.status.success(),
        "extract with -snld10 failed: {}",
        String::from_utf8_lossy(&with_snld.stderr)
    );
    let libraries = allowed.join("Demo.app/Contents/Frameworks/Demo.framework/Libraries");
    let meta = std::fs::symlink_metadata(&libraries).expect("Libraries entry");
    assert!(
        meta.file_type().is_symlink(),
        "Libraries must remain a symlink after -snld10 extract"
    );
    assert_eq!(
        std::fs::read_link(&libraries).expect("Libraries target"),
        PathBuf::from("Versions/Current/Libraries")
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
