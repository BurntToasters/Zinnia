use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandEvent, CommandChild};
use tauri_plugin_shell::ShellExt;

#[derive(serde::Serialize)]
struct RunResult {
    stdout: String,
    stderr: String,
    code: i32,
}

struct InitialPaths(Mutex<Vec<String>>);
struct RunningProcess(Mutex<Option<CommandChild>>);


fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;

    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_7z(app: tauri::AppHandle, args: Vec<String>, state: tauri::State<'_, RunningProcess>) -> Result<RunResult, String> {
    if args.is_empty() {
        return Err("Missing 7z arguments".to_string());
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = -1;

    let command = app
        .shell()
        .sidecar("7z")
        .map_err(|e| e.to_string())?
        .args(args);

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;

    {
        let mut process = state.0.lock().unwrap();
        *process = Some(child);
    }

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => stdout.push_str(&String::from_utf8_lossy(&line)),
            CommandEvent::Stderr(line) => stderr.push_str(&String::from_utf8_lossy(&line)),
            CommandEvent::Terminated(payload) => {
                if let Some(code) = payload.code {
                    exit_code = code;
                }
                break;
            }
            _ => {}
        }
    }

    {
        let mut process = state.0.lock().unwrap();
        *process = None;
    }

    Ok(RunResult {
        stdout,
        stderr,
        code: exit_code,
    })
}

#[tauri::command]
fn cancel_7z(state: tauri::State<'_, RunningProcess>) -> Result<(), String> {
    let mut process = state.0.lock().unwrap();
    if let Some(child) = process.take() {
        child.kill().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("No running process to cancel".to_string())
    }
}

#[tauri::command]
fn register_windows_context_menu() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.to_string_lossy().to_string();

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (classes, _) = hkcu
            .create_subkey("Software\\Classes")
            .map_err(|e| e.to_string())?;

        let entries = [
            ("*\\shell\\Chrysanthemum", "Add to Chrysanthemum"),
            (
                "Directory\\shell\\Chrysanthemum",
                "Add folder to Chrysanthemum",
            ),
        ];

        for (key_path, verb) in entries {
            let (key, _) = classes.create_subkey(key_path).map_err(|e| e.to_string())?;
            key.set_value("MUIVerb", &verb).map_err(|e| e.to_string())?;
            key.set_value("Icon", &format!("\"{}\",0", exe_str))
                .map_err(|e| e.to_string())?;
            let (cmd_key, _) = key.create_subkey("command").map_err(|e| e.to_string())?;
            cmd_key
                .set_value("", &format!("\"{}\" \"%1\"", exe_str))
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err("Explorer integration is only available on Windows.".to_string())
    }
}

#[tauri::command]
fn unregister_windows_context_menu() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (classes, _) = hkcu
            .create_subkey("Software\\Classes")
            .map_err(|e| e.to_string())?;

        let _ = classes.delete_subkey_all("*\\shell\\Chrysanthemum");
        let _ = classes.delete_subkey_all("Directory\\shell\\Chrysanthemum");

        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err("Explorer integration is only available on Windows.".to_string())
    }
}

#[tauri::command]
fn get_initial_paths(state: tauri::State<'_, InitialPaths>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
fn get_platform_info() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
fn get_cpu_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(8)
}

fn emit_open_paths(app: &tauri::AppHandle, argv: Vec<String>) {
    let paths: Vec<String> = argv
        .into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with("--"))
        .collect();

    if paths.is_empty() {
        return;
    }

    let _ = app.emit("open-paths", paths);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

fn collect_cli_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with("--"))
        .collect()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            emit_open_paths(app, argv);
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(InitialPaths(Mutex::new(collect_cli_paths())))
        .manage(RunningProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            run_7z,
            cancel_7z,
            register_windows_context_menu,
            unregister_windows_context_menu,
            load_settings,
            save_settings,
            get_initial_paths,
            get_platform_info,
            get_cpu_count
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
