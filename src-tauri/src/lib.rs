use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};

#[derive(Default)]
struct EditorState {
    allowed_roots: Mutex<HashSet<PathBuf>>,
}

fn project_root(path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("프로젝트 폴더를 열 수 없습니다: {error}"))?;
    if !root.join("story/manifest.yaml").is_file() {
        return Err("story/manifest.yaml이 없는 폴더입니다.".into());
    }
    if !root.join("tools/story_editor_bridge.py").is_file() {
        return Err("tools/story_editor_bridge.py가 없는 프로젝트입니다.".into());
    }
    Ok(root)
}

fn allowed_root(state: &tauri::State<'_, EditorState>, path: &str) -> Result<PathBuf, String> {
    let root = project_root(path)?;
    let allowed = state
        .allowed_roots
        .lock()
        .map_err(|_| "프로젝트 권한 상태를 읽을 수 없습니다.".to_string())?;
    if !allowed.contains(&root) {
        return Err("먼저 앱에서 프로젝트 폴더를 여세요.".into());
    }
    Ok(root)
}

fn python_executable(root: &Path) -> String {
    let local = root.join(".venv/bin/python");
    if local.is_file() {
        local.to_string_lossy().into_owned()
    } else {
        "python3".into()
    }
}

fn python_process(root: &Path) -> Command {
    #[cfg(target_os = "macos")]
    {
        // Apple's Command Line Tools Python is a Python.app launcher. When it is
        // spawned directly by an AppKit process it can stall during GUI startup,
        // so keep a non-GUI shell process between Tauri and the interpreter.
        let mut process = Command::new("/bin/sh");
        process
            .arg("-c")
            .arg("\"$@\"; editor_exit=$?; exit \"$editor_exit\"")
            .arg("story-editor-python")
            .arg(python_executable(root));
        process
    }

    #[cfg(not(target_os = "macos"))]
    {
        Command::new(python_executable(root))
    }
}

fn run_bridge(root: &Path, command: &str, payload: Option<Value>) -> Result<Value, String> {
    let bridge = root.join("tools/story_editor_bridge.py");
    let mut process = python_process(root);
    process
        .arg(bridge)
        .arg(command)
        .arg("--root")
        .arg(root)
        .current_dir(root)
        .env_remove("__CFBundleIdentifier")
        .env_remove("XPC_SERVICE_NAME")
        .env_remove("XPC_FLAGS")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    if payload.is_some() {
        process.stdin(Stdio::piped());
    }

    let mut child = process
        .spawn()
        .map_err(|error| format!("스토리 도구를 실행할 수 없습니다: {error}"))?;
    if let Some(value) = payload {
        let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        child
            .stdin
            .as_mut()
            .ok_or_else(|| "스토리 도구 입력을 열 수 없습니다.".to_string())?
            .write_all(&bytes)
            .map_err(|error| format!("스토리 데이터를 전달할 수 없습니다: {error}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("스토리 도구 실행을 기다릴 수 없습니다: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Ok(value) = serde_json::from_str::<Value>(stderr.trim()) {
            if let Some(message) = value.get("error").and_then(Value::as_str) {
                return Err(message.to_string());
            }
        }
        return Err(stderr.trim().to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("스토리 도구 응답이 올바르지 않습니다: {error}"))
}

#[tauri::command]
fn default_project_root() -> Option<String> {
    let candidate = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    if candidate.join("story/manifest.yaml").is_file() {
        Some(candidate.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[tauri::command]
fn load_project(state: tauri::State<'_, EditorState>, root: String) -> Result<Value, String> {
    let root = project_root(&root)?;
    state
        .allowed_roots
        .lock()
        .map_err(|_| "프로젝트 권한 상태를 저장할 수 없습니다.".to_string())?
        .insert(root.clone());
    run_bridge(&root, "load", None)
}

#[tauri::command]
fn validate_project(state: tauri::State<'_, EditorState>, root: String) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    run_bridge(&root, "validate", None)
}

#[tauri::command]
fn validate_scene(
    state: tauri::State<'_, EditorState>,
    root: String,
    scene: Value,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    run_bridge(&root, "validate-scene", Some(json!({ "scene": scene })))
}

#[tauri::command]
fn save_scene(
    state: tauri::State<'_, EditorState>,
    root: String,
    scene: Value,
    revision: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    run_bridge(
        &root,
        "save-scene",
        Some(json!({ "scene": scene, "revision": revision })),
    )
}

#[tauri::command]
fn save_document(
    state: tauri::State<'_, EditorState>,
    root: String,
    kind: String,
    document: Value,
    revision: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    run_bridge(
        &root,
        "save-document",
        Some(json!({ "kind": kind, "document": document, "revision": revision })),
    )
}

#[tauri::command]
fn duplicate_scene(
    state: tauri::State<'_, EditorState>,
    root: String,
    source_id: String,
    new_id: String,
    title: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    run_bridge(
        &root,
        "duplicate-scene",
        Some(json!({ "source_id": source_id, "new_id": new_id, "title": title })),
    )
}

#[tauri::command]
fn duplicate_event(
    state: tauri::State<'_, EditorState>,
    root: String,
    source_id: String,
    new_id: String,
    title: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    run_bridge(
        &root,
        "duplicate-event",
        Some(json!({ "source_id": source_id, "new_id": new_id, "title": title })),
    )
}

#[tauri::command]
fn build_runtime(state: tauri::State<'_, EditorState>, root: String) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    run_bridge(&root, "build", None)
}

#[tauri::command]
fn read_asset(
    state: tauri::State<'_, EditorState>,
    root: String,
    relative_path: String,
) -> Result<String, String> {
    let root = allowed_root(&state, &root)?;
    let requested = PathBuf::from(&relative_path);
    if requested.is_absolute() || !relative_path.starts_with("assets/") {
        return Err("assets 폴더 안의 파일만 열 수 있습니다.".into());
    }
    let asset = root
        .join(requested)
        .canonicalize()
        .map_err(|error| format!("이미지를 열 수 없습니다: {error}"))?;
    let asset_root = root
        .join("assets")
        .canonicalize()
        .map_err(|error| format!("assets 폴더를 열 수 없습니다: {error}"))?;
    if !asset.starts_with(&asset_root) || !asset.is_file() {
        return Err("허용되지 않은 이미지 경로입니다.".into());
    }
    let mime = match asset.extension().and_then(|value| value.to_str()) {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    let bytes =
        std::fs::read(&asset).map_err(|error| format!("이미지를 읽을 수 없습니다: {error}"))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
fn reveal_in_file_manager(
    state: tauri::State<'_, EditorState>,
    root: String,
    relative_path: Option<String>,
) -> Result<(), String> {
    let root = allowed_root(&state, &root)?;
    let target = match relative_path {
        Some(relative) if !relative.is_empty() => {
            let relative = PathBuf::from(relative);
            if relative.is_absolute() {
                return Err("프로젝트 안의 상대 경로만 열 수 있습니다.".into());
            }
            let target = root
                .join(relative)
                .canonicalize()
                .map_err(|error| format!("파일 위치를 확인할 수 없습니다: {error}"))?;
            if !target.starts_with(&root) {
                return Err("프로젝트 밖의 파일은 열 수 없습니다.".into());
            }
            target
        }
        _ => root.clone(),
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        if target.is_file() {
            command.arg("-R");
        }
        command.arg(&target);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        if target.is_file() {
            command.arg(format!("/select,{}", target.display()));
        } else {
            command.arg(&target);
        }
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(if target.is_file() {
            target.parent().unwrap_or(&root)
        } else {
            &target
        });
        command
    };

    command
        .spawn()
        .map_err(|error| format!("파일 관리자를 열 수 없습니다: {error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EditorState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_project_root,
            load_project,
            validate_project,
            validate_scene,
            save_scene,
            save_document,
            duplicate_scene,
            duplicate_event,
            build_runtime,
            read_asset,
            reveal_in_file_manager,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the story editor");
}
