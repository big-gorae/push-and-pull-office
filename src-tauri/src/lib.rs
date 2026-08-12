use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct EditorState {
    allowed_roots: Mutex<HashSet<PathBuf>>,
    commit_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    workers: Mutex<HashMap<PathBuf, Arc<Mutex<ProjectWorker>>>>,
}

fn project_commit_lock(
    state: &tauri::State<'_, EditorState>,
    root: &Path,
) -> Result<Arc<Mutex<()>>, String> {
    let mut locks = state
        .commit_locks
        .lock()
        .map_err(|_| "프로젝트 저장 큐를 열 수 없습니다.".to_string())?;
    Ok(locks
        .entry(root.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn project_worker(
    state: &tauri::State<'_, EditorState>,
    root: &Path,
) -> Result<Arc<Mutex<ProjectWorker>>, String> {
    let mut workers = state
        .workers
        .lock()
        .map_err(|_| "프로젝트 백그라운드 워커를 열 수 없습니다.".to_string())?;
    Ok(workers
        .entry(root.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(ProjectWorker::new(root.to_path_buf()))))
        .clone())
}

fn source_editor_is_allowed(editor: &str) -> bool {
    ["system", "vscode", "cursor", "zed"].contains(&editor)
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

enum BridgeCallError {
    Remote(String),
    Broken(String),
}

struct BridgeWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl BridgeWorker {
    fn spawn(root: &Path) -> Result<Self, String> {
        let bridge = root.join("tools/story_editor_bridge.py");
        let mut process = python_process(root);
        process
            .arg(bridge)
            .arg("serve")
            .arg("--root")
            .arg(root)
            .current_dir(root)
            .env_remove("__CFBundleIdentifier")
            .env_remove("XPC_SERVICE_NAME")
            .env_remove("XPC_FLAGS")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::piped());
        let mut child = process
            .spawn()
            .map_err(|error| format!("스토리 워커를 실행할 수 없습니다: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "스토리 워커 입력을 열 수 없습니다.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "스토리 워커 출력을 열 수 없습니다.".to_string())?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn call(&mut self, command: &str, payload: Option<Value>) -> Result<Value, BridgeCallError> {
        let request = json!({ "command": command, "payload": payload });
        serde_json::to_writer(&mut self.stdin, &request).map_err(|error| {
            BridgeCallError::Broken(format!("스토리 요청을 직렬화할 수 없습니다: {error}"))
        })?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| {
                BridgeCallError::Broken(format!("스토리 워커에 요청을 전달할 수 없습니다: {error}"))
            })?;

        let mut line = String::new();
        let length = self.stdout.read_line(&mut line).map_err(|error| {
            BridgeCallError::Broken(format!("스토리 워커 응답을 읽을 수 없습니다: {error}"))
        })?;
        if length == 0 {
            return Err(BridgeCallError::Broken(
                "스토리 워커가 예기치 않게 종료되었습니다.".into(),
            ));
        }
        let response: Value = serde_json::from_str(&line).map_err(|error| {
            BridgeCallError::Broken(format!("스토리 워커 응답이 올바르지 않습니다: {error}"))
        })?;
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            response
                .get("result")
                .cloned()
                .ok_or_else(|| BridgeCallError::Broken("스토리 워커 결과가 비어 있습니다.".into()))
        } else {
            Err(BridgeCallError::Remote(
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("스토리 저장에 실패했습니다.")
                    .to_string(),
            ))
        }
    }
}

impl Drop for BridgeWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct ProjectWorker {
    root: PathBuf,
    bridge: Option<BridgeWorker>,
}

impl ProjectWorker {
    fn new(root: PathBuf) -> Self {
        Self { root, bridge: None }
    }

    fn call(&mut self, command: &str, payload: Option<Value>) -> Result<Value, String> {
        for attempt in 0..2 {
            if self.bridge.is_none() {
                self.bridge = Some(BridgeWorker::spawn(&self.root)?);
            }
            let result = self
                .bridge
                .as_mut()
                .expect("bridge initialized")
                .call(command, payload.clone());
            match result {
                Ok(value) => return Ok(value),
                Err(BridgeCallError::Remote(message)) => return Err(message),
                Err(BridgeCallError::Broken(_)) if attempt == 0 => {
                    self.bridge.take();
                    continue;
                }
                Err(BridgeCallError::Broken(message)) => return Err(message),
            }
        }
        Err("스토리 워커를 다시 시작할 수 없습니다.".into())
    }
}

fn run_bridge_worker(
    worker: &Arc<Mutex<ProjectWorker>>,
    command: &str,
    payload: Option<Value>,
) -> Result<Value, String> {
    worker
        .lock()
        .map_err(|_| "스토리 워커 큐가 손상되었습니다.".to_string())?
        .call(command, payload)
}

#[allow(dead_code)]
fn run_bridge_once(root: &Path, command: &str, payload: Option<Value>) -> Result<Value, String> {
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

async fn run_bridge_background(
    worker: Arc<Mutex<ProjectWorker>>,
    command: &'static str,
    payload: Option<Value>,
    commit_lock: Option<Arc<Mutex<()>>>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = commit_lock
            .as_ref()
            .map(|lock| {
                lock.lock()
                    .map_err(|_| "프로젝트 저장 큐가 손상되었습니다.".to_string())
            })
            .transpose()?;
        run_bridge_worker(&worker, command, payload)
    })
    .await
    .map_err(|error| format!("스토리 백그라운드 작업이 중단되었습니다: {error}"))?
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
async fn load_project(state: tauri::State<'_, EditorState>, root: String) -> Result<Value, String> {
    let root = project_root(&root)?;
    state
        .allowed_roots
        .lock()
        .map_err(|_| "프로젝트 권한 상태를 저장할 수 없습니다.".to_string())?
        .insert(root.clone());
    let commit_lock = project_commit_lock(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(worker, "load", None, Some(commit_lock)).await
}

#[tauri::command]
async fn validate_project(
    state: tauri::State<'_, EditorState>,
    root: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    let commit_lock = project_commit_lock(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(worker, "validate", None, Some(commit_lock)).await
}

#[tauri::command]
async fn validate_scene(
    state: tauri::State<'_, EditorState>,
    root: String,
    scene: Value,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    let commit_lock = project_commit_lock(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(
        worker,
        "validate-scene",
        Some(json!({ "scene": scene })),
        Some(commit_lock),
    )
    .await
}

#[tauri::command]
async fn save_scene(
    state: tauri::State<'_, EditorState>,
    root: String,
    scene: Value,
    revision: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    let commit_lock = project_commit_lock(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(
        worker,
        "save-scene",
        Some(json!({ "scene": scene, "revision": revision })),
        Some(commit_lock),
    )
    .await
}

#[tauri::command]
async fn save_document(
    state: tauri::State<'_, EditorState>,
    root: String,
    kind: String,
    document: Value,
    revision: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    let commit_lock = project_commit_lock(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(
        worker,
        "save-document",
        Some(json!({ "kind": kind, "document": document, "revision": revision })),
        Some(commit_lock),
    )
    .await
}

#[tauri::command]
async fn get_story_text_owner(
    state: tauri::State<'_, EditorState>,
    root: String,
    localization_key: String,
    locale: Option<String>,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(
        worker,
        "text-owner",
        Some(json!({ "localization_key": localization_key, "locale": locale })),
        None,
    )
    .await
}

#[tauri::command]
async fn save_story_text(
    state: tauri::State<'_, EditorState>,
    root: String,
    edits: Value,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    let commit_lock = project_commit_lock(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(
        worker,
        "save-text",
        Some(json!({ "edits": edits })),
        Some(commit_lock),
    )
    .await
}

#[tauri::command]
async fn duplicate_scene(
    state: tauri::State<'_, EditorState>,
    root: String,
    source_id: String,
    new_id: String,
    title: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    let commit_lock = project_commit_lock(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(
        worker,
        "duplicate-scene",
        Some(json!({ "source_id": source_id, "new_id": new_id, "title": title })),
        Some(commit_lock),
    )
    .await
}

#[tauri::command]
async fn duplicate_event(
    state: tauri::State<'_, EditorState>,
    root: String,
    source_id: String,
    new_id: String,
    title: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    let commit_lock = project_commit_lock(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(
        worker,
        "duplicate-event",
        Some(json!({ "source_id": source_id, "new_id": new_id, "title": title })),
        Some(commit_lock),
    )
    .await
}

#[tauri::command]
async fn build_runtime(
    state: tauri::State<'_, EditorState>,
    root: String,
) -> Result<Value, String> {
    let root = allowed_root(&state, &root)?;
    let commit_lock = project_commit_lock(&state, &root)?;
    let worker = project_worker(&state, &root)?;
    run_bridge_background(worker, "build", None, Some(commit_lock)).await
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

#[tauri::command]
fn open_source_location(
    state: tauri::State<'_, EditorState>,
    root: String,
    relative_path: String,
    line: Option<u32>,
    column: Option<u32>,
    editor: Option<String>,
) -> Result<(), String> {
    let root = allowed_root(&state, &root)?;
    let relative = PathBuf::from(&relative_path);
    if relative.is_absolute() {
        return Err("프로젝트 안의 상대 경로만 열 수 있습니다.".into());
    }
    let target = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("원본 파일을 찾을 수 없습니다: {error}"))?;
    let story_root = root
        .join("story")
        .canonicalize()
        .map_err(|error| format!("story 폴더를 열 수 없습니다: {error}"))?;
    if !target.starts_with(&story_root) || !target.is_file() {
        return Err("story 폴더 안의 원본 파일만 열 수 있습니다.".into());
    }

    let editor = editor.unwrap_or_else(|| "system".to_string());
    if !source_editor_is_allowed(&editor) {
        return Err("허용되지 않은 원본 편집기입니다.".into());
    }
    if editor != "system" {
        let location = format!(
            "{}:{}:{}",
            target.display(),
            line.unwrap_or(1).max(1),
            column.unwrap_or(1).max(1)
        );
        let mut editor_command = match editor.as_str() {
            "vscode" => {
                let mut command = Command::new("code");
                command.arg("--goto").arg(&location);
                command
            }
            "cursor" => {
                let mut command = Command::new("cursor");
                command.arg("--goto").arg(&location);
                command
            }
            "zed" => {
                let mut command = Command::new("zed");
                command.arg(&location);
                command
            }
            _ => unreachable!(),
        };
        if editor_command.spawn().is_ok() {
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&target);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", ""]).arg(&target);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&target);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("원본 파일을 열 수 없습니다: {error}"))?;
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
            get_story_text_owner,
            save_story_text,
            duplicate_scene,
            duplicate_event,
            build_runtime,
            read_asset,
            reveal_in_file_manager,
            open_source_location,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the story editor");
}

#[cfg(test)]
mod tests {
    use super::source_editor_is_allowed;

    #[test]
    fn source_editor_rejects_free_form_commands() {
        assert!(source_editor_is_allowed("system"));
        assert!(source_editor_is_allowed("vscode"));
        assert!(!source_editor_is_allowed("sh -c touch /tmp/unsafe"));
        assert!(!source_editor_is_allowed("/Applications/Unknown.app"));
    }
}
