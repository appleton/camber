use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock, Weak,
    },
    time::{Duration, Instant},
};

use crate::file_watcher;
use lsp_types::{
    notification::{Exit, Initialized, Notification},
    request::{Initialize, Request, Shutdown, WorkDoneProgressCreate, WorkspaceConfiguration},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{async_runtime, App, AppHandle, Emitter, Manager};
use tauri_plugin_shell::{
    process::{Command, CommandChild, CommandEvent},
    ShellExt,
};

const HELPER_SIDECAR: &str = "camber-helper";
const MLX_SIDECAR: &str = "camber-mlx-sidecar";
const MLX_SIDECAR_ENV: &str = "CAMBER_MLX_SIDECAR";
const MLX_SIDECAR_DISABLE_DEV_BUILD_ENV: &str = "CAMBER_MLX_SIDECAR_DISABLE_DEV_BUILD";
const REPO_ROOT_FROM_CARGO_MANIFEST_DIR: usize = 4;
const HELPER_JSONRPC_REQUEST_EVENT: &str = "camber:helper-jsonrpc-request";
const HELPER_JSONRPC_NOTIFICATION_BATCH_EVENT: &str = "camber:helper-jsonrpc-notification-batch";
const HELPER_NOTIFICATION_QUEUE_CAPACITY: usize = 64;
const HELPER_NOTIFICATION_BATCH_CAPACITY: usize = 64;
const HELPER_NOTIFICATION_BATCH_MAX_BYTES: usize = 512 * 1024;
const HELPER_NOTIFICATION_BATCH_WINDOW: Duration = Duration::from_millis(32);
const HELPER_NOTIFICATION_ACK_TIMEOUT: Duration = Duration::from_secs(30);
const HELPER_NOTIFICATION_READY_POLL: Duration = Duration::from_millis(10);
const HELPER_NOTIFICATION_RETRY_DELAY: Duration = Duration::from_millis(100);
const HELPER_LOG_SESSIONS_TO_KEEP: usize = 20;
// Upper bound on waiting for the helper to acknowledge LSP `shutdown` before
// escalating to kill. Its shutdown handler runs cleanup before responding —
// including giving ACP agents a graceful stop so they can flush session state
// (PE-2460) — so quitting must give that cleanup time to finish. The helper
// currently runs remote-access (up to 3s), ACP (3s), local-inference (2s), and
// voice-input (2s) cleanup sequentially; leave margin above that combined
// budget.
const HELPER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

static HELPER_LOG_FILE_NAME: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperJsonRpcError {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

impl HelperJsonRpcError {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            data: None,
        }
    }

    fn method_not_found() -> Self {
        Self {
            message: "Method not found".to_string(),
            code: Some(-32601),
            data: None,
        }
    }

    fn from_jsonrpc(error: &Value) -> Self {
        Self {
            message: error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string()),
            code: error.get("code").and_then(Value::as_i64),
            data: error.get("data").cloned(),
        }
    }

    fn to_jsonrpc_value(&self) -> Value {
        let mut error = json!({ "message": self.message });
        if let Some(code) = self.code {
            error["code"] = json!(code);
        }
        if let Some(data) = &self.data {
            error["data"] = data.clone();
        }
        error
    }
}

impl From<String> for HelperJsonRpcError {
    fn from(message: String) -> Self {
        Self::transport(message)
    }
}

impl std::fmt::Display for HelperJsonRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for HelperJsonRpcError {}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperJsonRpcRequestEvent {
    id: Value,
    method: String,
    params: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperJsonRpcNotificationEvent {
    method: String,
    params: Value,
}

impl HelperJsonRpcNotificationEvent {
    fn serialized_len(&self) -> usize {
        // A serialization failure is handled by Tauri's emitter later. Treat
        // it as a full batch here so it cannot pull unrelated notifications
        // into an oversized bridge evaluation.
        serde_json::to_vec(self)
            .map(|value| value.len())
            .unwrap_or(HELPER_NOTIFICATION_BATCH_MAX_BYTES)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperJsonRpcNotificationBatchEvent {
    id: u64,
    notifications: Vec<HelperJsonRpcNotificationEvent>,
}

enum HelperNotificationBridgeItem {
    Notification(HelperJsonRpcNotificationEvent),
    Barrier(async_runtime::Sender<()>),
}

#[derive(Default)]
struct HelperStateInner {
    helper: Option<Arc<HelperProcess>>,
    notification_bridge_ready: bool,
    ready: bool,
    startup_error: Option<HelperJsonRpcError>,
    ready_waiters: Vec<async_runtime::Sender<Result<(), HelperJsonRpcError>>>,
}

#[derive(Clone, Default)]
pub struct HelperState {
    inner: Arc<async_runtime::Mutex<HelperStateInner>>,
    notification_acks: Arc<async_runtime::Mutex<HashMap<u64, async_runtime::Sender<usize>>>>,
    next_notification_batch_id: Arc<AtomicU64>,
}

impl HelperState {
    async fn set_starting(&self, helper: Arc<HelperProcess>) {
        let mut inner = self.inner.lock().await;
        helper
            .notification_bridge_ready
            .store(inner.notification_bridge_ready, Ordering::Release);
        inner.helper = Some(helper);
        inner.ready = false;
        inner.startup_error = None;
    }

    async fn mark_ready(&self) {
        let waiters = {
            let mut inner = self.inner.lock().await;
            inner.ready = true;
            inner.startup_error = None;
            std::mem::take(&mut inner.ready_waiters)
        };

        for waiter in waiters {
            let _ = waiter.send(Ok(())).await;
        }
    }

    async fn mark_error(&self, error: HelperJsonRpcError) {
        let waiters = {
            let mut inner = self.inner.lock().await;
            inner.ready = false;
            inner.startup_error = Some(error.clone());
            std::mem::take(&mut inner.ready_waiters)
        };

        for waiter in waiters {
            let _ = waiter.send(Err(error.clone())).await;
        }
    }

    async fn helper_when_ready(&self) -> Result<Arc<HelperProcess>, HelperJsonRpcError> {
        loop {
            let mut rx = {
                let mut inner = self.inner.lock().await;
                if inner.ready {
                    return inner.helper.clone().ok_or_else(|| {
                        HelperJsonRpcError::transport("camber-helper is not running")
                    });
                }
                if let Some(error) = &inner.startup_error {
                    return Err(error.clone());
                }

                let (tx, rx) = async_runtime::channel(1);
                inner.ready_waiters.push(tx);
                rx
            };

            match rx.recv().await {
                Some(Ok(())) => continue,
                Some(Err(error)) => return Err(error),
                None => {
                    return Err(HelperJsonRpcError::transport(
                        "camber-helper readiness wait failed",
                    ))
                }
            }
        }
    }

    async fn helper_started(&self) -> Result<Arc<HelperProcess>, HelperJsonRpcError> {
        let inner = self.inner.lock().await;
        if let Some(helper) = &inner.helper {
            return Ok(helper.clone());
        }
        if let Some(error) = &inner.startup_error {
            return Err(error.clone());
        }

        Err(HelperJsonRpcError::transport(
            "camber-helper is not running",
        ))
    }

    async fn mark_notification_bridge_ready(&self) {
        let mut inner = self.inner.lock().await;
        inner.notification_bridge_ready = true;
        if let Some(helper) = &inner.helper {
            helper
                .notification_bridge_ready
                .store(true, Ordering::Release);
        }
    }

    async fn ack_notification_batch(&self, id: u64, applied: Option<usize>) {
        if let Some(tx) = self.notification_acks.lock().await.remove(&id) {
            // Missing `applied` keeps compatibility with a webview from the
            // immediately preceding build, where ACK meant the entire batch.
            let _ = tx.send(applied.unwrap_or(usize::MAX)).await;
        }
    }

    pub async fn shutdown(&self) {
        let helper = {
            let mut inner = self.inner.lock().await;
            inner.ready = false;
            inner.startup_error = None;
            std::mem::take(&mut inner.helper)
        };
        if let Some(helper) = helper {
            helper.shutdown().await;
        }
    }
}

pub fn start_on_setup(app: &mut App) {
    let state = app.state::<HelperState>().inner().clone();
    let app_handle = app.handle().clone();

    async_runtime::spawn(async move {
        crate::startup_timing::mark("native.helperSpawnBegin");
        if let Err(err) = start_helper(&app_handle, state).await {
            eprintln!("failed to start camber-helper: {err}");
        }
    });
}

pub fn shutdown_from_run_event(app_handle: &AppHandle) {
    let state = app_handle.state::<HelperState>().inner().clone();
    async_runtime::block_on(state.shutdown());
}

#[tauri::command]
pub async fn helper_jsonrpc(
    app_handle: AppHandle,
    method: String,
    params: Value,
) -> Result<Value, HelperJsonRpcError> {
    let state = app_handle.state::<HelperState>().inner().clone();
    let helper = state.helper_when_ready().await?;

    let result = helper.send_request(&method, params).await?;
    if !file_watcher::sync_after_helper_result(&app_handle, &method, &result)
        && file_watcher::should_refresh_acp_nav_roots(&method, &result)
    {
        match helper
            .send_request(file_watcher::ACP_NAV_LIST_METHOD, json!({}))
            .await
        {
            Ok(nav_state) => {
                file_watcher::sync_after_helper_result(
                    &app_handle,
                    file_watcher::ACP_NAV_LIST_METHOD,
                    &nav_state,
                );
            }
            Err(err) => eprintln!("failed to refresh ACP nav watcher roots: {err}"),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn helper_jsonrpc_notify(
    app_handle: AppHandle,
    method: String,
    params: Value,
) -> Result<(), HelperJsonRpcError> {
    let state = app_handle.state::<HelperState>().inner().clone();
    let helper = state.helper_when_ready().await?;

    helper.send_notification(&method, params).await
}

#[tauri::command]
pub async fn helper_jsonrpc_notification_batch_ack(
    app_handle: AppHandle,
    id: u64,
    applied: Option<usize>,
) -> Result<(), HelperJsonRpcError> {
    let state = app_handle.state::<HelperState>().inner().clone();
    state.ack_notification_batch(id, applied).await;
    Ok(())
}

#[tauri::command]
pub async fn helper_jsonrpc_notification_bridge_ready(app_handle: AppHandle) {
    app_handle
        .state::<HelperState>()
        .inner()
        .mark_notification_bridge_ready()
        .await;
}

pub(crate) async fn send_helper_notification(
    app_handle: &AppHandle,
    method: &str,
    params: Value,
) -> Result<(), HelperJsonRpcError> {
    let state = app_handle.state::<HelperState>().inner().clone();
    let helper = state.helper_when_ready().await?;

    helper.send_notification(method, params).await
}

pub(crate) async fn send_helper_request(
    app_handle: &AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, HelperJsonRpcError> {
    let state = app_handle.state::<HelperState>().inner().clone();
    let helper = state.helper_when_ready().await?;

    helper.send_request(method, params).await
}

#[tauri::command]
pub async fn restart_helper(app_handle: AppHandle) -> Result<(), HelperJsonRpcError> {
    let state = app_handle.state::<HelperState>().inner().clone();
    append_helper_log(&app_handle, "\n--- restarting camber-helper ---\n");
    state.shutdown().await;
    start_helper_with_options(&app_handle, state, None).await
}

#[tauri::command]
pub async fn restart_helper_debug(
    app_handle: AppHandle,
    port: u16,
    dlv_binary: Option<String>,
) -> Result<(), HelperJsonRpcError> {
    let state = app_handle.state::<HelperState>().inner().clone();
    append_helper_log(
        &app_handle,
        &format!("\n--- restarting camber-helper under Delve on port {port} ---\n"),
    );
    state.shutdown().await;
    start_helper_with_options(
        &app_handle,
        state,
        Some(HelperDebugOptions {
            port,
            dlv_binary: dlv_binary.unwrap_or_else(|| "dlv".to_string()),
        }),
    )
    .await
}

#[tauri::command]
pub fn helper_logs(app_handle: AppHandle, lines: Option<usize>) -> Result<String, String> {
    read_helper_log_tail(&app_handle, lines.unwrap_or(500))
}

// Appends a webview startup-diagnostics line into the current helper session
// log so webview state and helper activity interleave chronologically in one
// file. Lines are capped and kept single-line so they cannot corrupt the log.
#[tauri::command]
pub fn record_startup_diagnostic(app_handle: AppHandle, message: String) {
    const MAX_LEN: usize = 8 * 1024;
    let mut message = message.replace(['\n', '\r'], "\\n");
    if message.len() > MAX_LEN {
        let mut end = MAX_LEN;
        while end > 0 && !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push_str("…(truncated)");
    }
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
    append_helper_log(
        &app_handle,
        &format!("webview-diag: {timestamp} {message}\n"),
    );
}

// Webview-invokable wrapper for open_helper_logs, used by the startup issue
// panel's "Show logs" action.
#[tauri::command]
pub fn show_helper_logs(app_handle: AppHandle) -> Result<(), String> {
    open_helper_logs(&app_handle)
}

pub fn open_helper_logs(app_handle: &AppHandle) -> Result<(), String> {
    let path = helper_log_path(app_handle)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    if !path.exists() {
        fs::write(&path, "camber-helper log is empty.\n").map_err(|err| err.to_string())?;
    }
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn helper_jsonrpc_respond(
    app_handle: AppHandle,
    id: Value,
    result: Option<Value>,
    error: Option<HelperJsonRpcError>,
) -> Result<(), HelperJsonRpcError> {
    let state = app_handle.state::<HelperState>().inner().clone();
    let helper = state.helper_started().await?;

    if let Some(error) = error {
        helper.send_error_value(id, error.to_jsonrpc_value()).await
    } else {
        helper
            .send_response(id, result.unwrap_or(Value::Null))
            .await
    }
}

async fn start_helper(
    app_handle: &AppHandle,
    state: HelperState,
) -> Result<(), HelperJsonRpcError> {
    start_helper_with_options(app_handle, state, None).await
}

async fn start_helper_with_options(
    app_handle: &AppHandle,
    state: HelperState,
    debug: Option<HelperDebugOptions>,
) -> Result<(), HelperJsonRpcError> {
    match HelperProcess::spawn(app_handle, debug).await {
        Ok(helper) => {
            state.set_starting(helper.clone()).await;
            if let Err(err) = helper.initialize().await {
                let message = format!("failed to initialize camber-helper: {err}");
                eprintln!("{message}");
                append_helper_log(app_handle, &format!("{message}\n"));
                state.mark_error(err.clone()).await;
                helper.shutdown().await;
                Err(err)
            } else {
                append_helper_log(app_handle, "--- camber-helper started ---\n");
                state.mark_ready().await;
                crate::startup_timing::mark("native.helperReady");
                Ok(())
            }
        }
        Err(err) => {
            append_helper_log(
                app_handle,
                &format!("failed to start camber-helper: {err}\n"),
            );
            state
                .mark_error(HelperJsonRpcError::transport(err.clone()))
                .await;
            Err(HelperJsonRpcError::transport(err))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HelperDebugOptions {
    port: u16,
    dlv_binary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HelperCommandSpec {
    program: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    sidecar: bool,
    env: Vec<(String, String)>,
}

impl HelperCommandSpec {
    fn for_current_build(manifest_dir: &Path, debug: Option<HelperDebugOptions>) -> Self {
        if cfg!(debug_assertions) {
            Self::development(manifest_dir, debug)
        } else {
            Self::production()
        }
    }

    fn development(manifest_dir: &Path, debug: Option<HelperDebugOptions>) -> Self {
        if let Some(debug) = debug {
            return Self::development_debug(manifest_dir, debug);
        }

        Self {
            program: "go".to_string(),
            args: ["run", "-tags=fts5", "./cmd/camber-helper/..."]
                .into_iter()
                .map(str::to_string)
                .collect(),
            cwd: repo_root(manifest_dir),
            sidecar: false,
            env: Self::development_env(manifest_dir),
        }
    }

    fn development_env(manifest_dir: &Path) -> Vec<(String, String)> {
        let mut env = Self::remote_access_dev_env(manifest_dir);
        env.extend(Self::local_inference_dev_env(manifest_dir));
        env
    }

    /// Dev builds serve the mobile-remote UI live: the helper proxies UI
    /// traffic to its Vite dev server (slot-offset ports, mirroring
    /// camberqa's portsForSlot) and falls back to the on-disk bundle, so UI
    /// changes apply without re-embedding or restarting. Explicit env set by
    /// the launcher wins.
    fn remote_access_dev_env(manifest_dir: &Path) -> Vec<(String, String)> {
        Self::remote_access_dev_env_with(manifest_dir, |name| std::env::var(name).ok())
    }

    fn remote_access_dev_env_with(
        manifest_dir: &Path,
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Vec<(String, String)> {
        let mut env = Vec::new();
        if lookup("CAMBER_REMOTE_DEV_SERVER").is_none() {
            let slot = lookup("CAMBER_WORKTREE_SLOT")
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            env.push((
                "CAMBER_REMOTE_DEV_SERVER".to_string(),
                format!("http://127.0.0.1:{}", 5179 + slot * 10),
            ));
        }
        if lookup("CAMBER_REMOTE_STATIC").is_none() {
            if let Some(root) = repo_root(manifest_dir) {
                env.push((
                    "CAMBER_REMOTE_STATIC".to_string(),
                    root.join("ui/apps/mobile-remote/dist")
                        .to_string_lossy()
                        .into_owned(),
                ));
            }
        }
        env
    }

    fn local_inference_dev_env(manifest_dir: &Path) -> Vec<(String, String)> {
        Self::local_inference_dev_env_with(
            manifest_dir,
            current_mlx_sidecar_target_triple(),
            |name| std::env::var(name).ok(),
            file_exists_and_is_non_empty,
        )
    }

    fn local_inference_dev_env_with(
        manifest_dir: &Path,
        target_triple: Option<&str>,
        lookup: impl Fn(&str) -> Option<String>,
        file_exists: impl Fn(&Path) -> bool,
    ) -> Vec<(String, String)> {
        let mut env = vec![(
            MLX_SIDECAR_DISABLE_DEV_BUILD_ENV.to_string(),
            "1".to_string(),
        )];

        if lookup(MLX_SIDECAR_ENV).is_none() {
            if let Some(target_triple) = target_triple {
                let path = manifest_dir
                    .join("binaries")
                    .join(format!("{MLX_SIDECAR}-{target_triple}"));
                if file_exists(&path) {
                    env.push((
                        MLX_SIDECAR_ENV.to_string(),
                        path.to_string_lossy().into_owned(),
                    ));
                }
            }
        }

        env
    }

    fn development_debug(manifest_dir: &Path, debug: HelperDebugOptions) -> Self {
        Self {
            program: debug.dlv_binary,
            args: [
                "debug".to_string(),
                "--continue".to_string(),
                "--headless".to_string(),
                format!("--listen=127.0.0.1:{}", debug.port),
                "--api-version=2".to_string(),
                "--accept-multiclient".to_string(),
                "--build-flags=-tags=fts5".to_string(),
                format!("--log-dest=/tmp/camber-helper-dlv-{}.log", debug.port),
                "./cmd/camber-helper".to_string(),
                "--".to_string(),
                "--stdin".to_string(),
            ]
            .into_iter()
            .collect(),
            cwd: repo_root(manifest_dir),
            sidecar: false,
            env: {
                let mut env = vec![
                    ("CGO_ENABLED".to_string(), "1".to_string()),
                    ("CGO_CPPFLAGS".to_string(), "-w".to_string()),
                ];
                env.extend(Self::development_env(manifest_dir));
                env
            },
        }
    }

    fn production() -> Self {
        Self {
            program: HELPER_SIDECAR.to_string(),
            args: Vec::new(),
            cwd: None,
            sidecar: true,
            env: Vec::new(),
        }
    }

    fn into_command(self, app: &AppHandle) -> Result<Command, String> {
        let mut command = if self.sidecar {
            app.shell()
                .sidecar(self.program)
                .map_err(|err| err.to_string())?
        } else {
            app.shell().command(self.program)
        };

        command = command.args(self.args).set_raw_out(true);
        if let Some(cwd) = self.cwd {
            command = command.current_dir(cwd);
        }
        if !self.env.is_empty() {
            command = command.envs(self.env);
        }

        Ok(command)
    }
}

fn repo_root(manifest_dir: &Path) -> Option<PathBuf> {
    manifest_dir
        .ancestors()
        .nth(REPO_ROOT_FROM_CARGO_MANIFEST_DIR)
        .map(Path::to_path_buf)
}

fn current_mlx_sidecar_target_triple() -> Option<&'static str> {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        Some("aarch64-apple-darwin")
    } else {
        None
    }
}

fn file_exists_and_is_non_empty(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(metadata) => metadata.is_file() && metadata.len() > 0,
        Err(_) => false,
    }
}

fn helper_log_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("CAMBER_DESKTOP_HELPER_LOG_FILE") {
        return Ok(PathBuf::from(path));
    }

    let dir = app_handle
        .path()
        .app_log_dir()
        .map_err(|err| err.to_string())?;
    let name = HELPER_LOG_FILE_NAME.get_or_init(|| {
        prune_helper_session_logs(&dir, HELPER_LOG_SESSIONS_TO_KEEP - 1);
        // UTC with millisecond precision so names sort chronologically even
        // across DST changes and same-second relaunches get distinct files.
        format!(
            "camber-helper-{}.log",
            chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S%.3f")
        )
    });
    Ok(dir.join(name))
}

fn prune_helper_session_logs(dir: &Path, keep: usize) {
    // The pre-session-split single log file; delete it so it does not linger
    // forever after the format change.
    let _ = fs::remove_file(dir.join("camber-helper.log"));

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut sessions: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("camber-helper-") && name.ends_with(".log"))
        })
        .collect();
    // Timestamped names sort lexicographically in chronological order.
    sessions.sort();
    let excess = sessions.len().saturating_sub(keep);
    for path in &sessions[..excess] {
        if let Err(err) = fs::remove_file(path) {
            eprintln!(
                "failed to remove old camber-helper log {}: {err}",
                path.display()
            );
        }
    }
}

fn append_helper_log(app_handle: &AppHandle, message: &str) {
    let Ok(path) = helper_log_path(app_handle) else {
        eprintln!("failed to resolve camber-helper log path");
        return;
    };
    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!("failed to create camber-helper log directory: {err}");
            return;
        }
    }
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut file) => {
            if let Err(err) = file.write_all(message.as_bytes()) {
                eprintln!("failed to write camber-helper log: {err}");
            }
        }
        Err(err) => eprintln!("failed to open camber-helper log: {err}"),
    }
}

fn read_helper_log_tail(app_handle: &AppHandle, lines: usize) -> Result<String, String> {
    let path = helper_log_path(app_handle)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok("(no helper log files found)".to_string())
        }
        Err(err) => return Err(err.to_string()),
    };

    let all_lines = content.lines().collect::<Vec<_>>();
    let start = all_lines.len().saturating_sub(lines);
    Ok(all_lines[start..].join("\n"))
}

struct HelperProcess {
    app_handle: AppHandle,
    child: async_runtime::Mutex<Option<CommandChild>>,
    pending: async_runtime::Mutex<HashMap<u64, async_runtime::Sender<Value>>>,
    notification_bridge_ready: AtomicBool,
    notification_tx: async_runtime::Sender<HelperNotificationBridgeItem>,
    notifications_applied: AtomicU64,
    notifications_enqueued: AtomicU64,
    next_id: AtomicU64,
}

impl HelperProcess {
    async fn spawn(
        app: &AppHandle,
        debug: Option<HelperDebugOptions>,
    ) -> Result<Arc<Self>, String> {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let command =
            HelperCommandSpec::for_current_build(manifest_dir, debug).into_command(app)?;
        let (rx, child) = command.spawn().map_err(|err| err.to_string())?;
        let (notification_tx, notification_rx) =
            async_runtime::channel(HELPER_NOTIFICATION_QUEUE_CAPACITY);
        let helper = Arc::new(Self {
            app_handle: app.clone(),
            child: async_runtime::Mutex::new(Some(child)),
            pending: async_runtime::Mutex::new(HashMap::new()),
            notification_bridge_ready: AtomicBool::new(false),
            notification_tx,
            notifications_applied: AtomicU64::new(0),
            notifications_enqueued: AtomicU64::new(0),
            next_id: AtomicU64::new(1),
        });

        async_runtime::spawn(read_events(helper.clone(), rx));
        async_runtime::spawn(forward_helper_notifications(
            Arc::downgrade(&helper),
            notification_rx,
        ));
        Ok(helper)
    }

    async fn initialize(&self) -> Result<(), HelperJsonRpcError> {
        let app_version = self.app_handle.package_info().version.to_string();
        self.send_request(
            Initialize::METHOD,
            json!({
                "processId": std::process::id(),
                "clientInfo": {
                    "name": "Camber",
                    "version": app_version.clone()
                },
                "capabilities": {
                    "workspace": {
                        "didChangeWatchedFiles": {
                            "dynamicRegistration": true,
                            "relativePatternSupport": true
                        }
                    }
                },
                "initializationOptions": {
                    "agentServers": {},
                    // The desktop app registers the camber:// URL scheme and
                    // forwards camber://oauth/callback deep links back to the
                    // helper (camber/mcpOAuthCallback), so OAuth flows may use
                    // the deep-link redirect instead of the loopback server.
                    //
                    // Gated to release builds only. macOS Launch Services routes
                    // camber:// to a bundle by identifier and cannot address a
                    // specific dev instance; with several same-identity debug
                    // builds (camberqa worktrees) it delivers the callback to
                    // the wrong process, whose helper has no matching flow. Dev
                    // builds therefore fall back to the 127.0.0.1 loopback flow
                    // for connectors whose provider has a loopback redirect
                    // registered; deep-link-only connectors (Slack) can only
                    // sign in from a release build.
                    "clientCapabilities": {
                        "mcpOAuthDeepLink": !cfg!(debug_assertions)
                    },
                    "assistantHost": "desktop",
                    "assistantEnvironment": if cfg!(debug_assertions) {
                        "development"
                    } else {
                        "production"
                    }
                },
                "workspaceFolders": null
            }),
        )
        .await?;
        self.send_notification(Initialized::METHOD, json!({}))
            .await?;
        Ok(())
    }

    async fn shutdown(&self) {
        // Wait (bounded) for the shutdown response: the helper runs its
        // cleanup — including letting ACP agents exit gracefully so they can
        // flush session state (PE-2460) — before responding. Killing on a
        // fire-and-forget write would end that cleanup mid-flight on every
        // normal quit.
        let _ = tokio::time::timeout(
            HELPER_SHUTDOWN_TIMEOUT,
            self.send_request(Shutdown::METHOD, json!(null)),
        )
        .await;
        let _ = self.send_notification(Exit::METHOD, json!(null)).await;
        if let Some(child) = self.child.lock().await.take() {
            let _ = child.kill();
        }
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, HelperJsonRpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = async_runtime::channel(1);
        self.pending.lock().await.insert(id, tx);

        if let Err(err) = self
            .write_message(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params
            }))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(err);
        }

        let message = rx.recv().await.ok_or_else(|| {
            HelperJsonRpcError::transport(format!(
                "camber-helper closed before responding to {method}"
            ))
        })?;
        if let Some(error) = message.get("error") {
            Err(HelperJsonRpcError::from_jsonrpc(error))
        } else {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        }
    }

    async fn send_notification(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(), HelperJsonRpcError> {
        self.write_message(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    async fn send_response(&self, id: Value, result: Value) -> Result<(), HelperJsonRpcError> {
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }))
        .await
    }

    async fn send_error_value(&self, id: Value, error: Value) -> Result<(), HelperJsonRpcError> {
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": error
        }))
        .await
    }

    async fn send_error_response(
        &self,
        id: Value,
        error: HelperJsonRpcError,
    ) -> Result<(), HelperJsonRpcError> {
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": error.to_jsonrpc_value()
        }))
        .await
    }

    async fn write_message(&self, message: Value) -> Result<(), HelperJsonRpcError> {
        let body = serde_json::to_vec(&message)
            .map_err(|err| HelperJsonRpcError::transport(err.to_string()))?;
        let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        frame.extend(body);
        let mut child = self.child.lock().await;
        let child = child
            .as_mut()
            .ok_or_else(|| HelperJsonRpcError::transport("camber-helper is not running"))?;
        child
            .write(&frame)
            .map_err(|err| HelperJsonRpcError::transport(err.to_string()))
    }

    async fn handle_message(&self, message: Value) {
        let is_response = message.get("id").is_some()
            && (message.get("result").is_some() || message.get("error").is_some());

        if is_response {
            self.handle_response(message).await;
            return;
        }

        if message.get("id").is_some() && message.get("method").is_some() {
            self.handle_server_request(message).await;
            return;
        }

        if message.get("id").is_none() && message.get("method").is_some() {
            self.handle_server_notification(message).await;
        }
    }

    async fn handle_response(&self, message: Value) {
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return;
        };

        if !self.wait_for_prior_notifications().await {
            return;
        }

        if let Some(tx) = self.pending.lock().await.remove(&id) {
            let _ = tx.send(message).await;
        }
    }

    async fn handle_server_request(&self, message: Value) {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let result = match method {
            WorkspaceConfiguration::METHOD => Some(json!([])),
            WorkDoneProgressCreate::METHOD => Some(json!(null)),
            "client/registerCapability" => Some(json!(null)),
            "camber/searchSymbolDefinitions" => Some(json!({ "defs": [] })),
            "camber/getDiagnostics" => Some(json!({ "diagnostics": [] })),
            _ => None,
        };

        let response_result = if let Some(result) = result {
            self.send_response(id, result).await
        } else if should_forward_helper_request(method) {
            // Forwarded requests share protocol ordering with notifications.
            // The notification bridge deliberately holds a batch briefly, so
            // emitting this request immediately could otherwise let it
            // overtake an earlier session update on helper stdout.
            if !self.wait_for_prior_notifications().await {
                self.send_error_response(
                    id,
                    HelperJsonRpcError::transport(
                        "Helper notification bridge closed before forwarding request",
                    ),
                )
                .await
            } else {
                match self.app_handle.emit(
                    HELPER_JSONRPC_REQUEST_EVENT,
                    HelperJsonRpcRequestEvent {
                        id,
                        method: method.to_string(),
                        params: message.get("params").cloned().unwrap_or(Value::Null),
                    },
                ) {
                    Ok(()) => Ok(()),
                    Err(err) => {
                        self.send_error_response(
                            message.get("id").cloned().unwrap_or(Value::Null),
                            HelperJsonRpcError::transport(format!(
                                "Failed to forward helper request to webview: {err}"
                            )),
                        )
                        .await
                    }
                }
            }
        } else {
            self.send_error_response(id, HelperJsonRpcError::method_not_found())
                .await
        };

        if let Err(err) = response_result {
            eprintln!("failed to respond to camber-helper request {method}: {err}");
        }
    }

    async fn handle_server_notification(&self, message: Value) {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if should_forward_helper_notification(method) {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if self
                .notification_tx
                .send(HelperNotificationBridgeItem::Notification(
                    HelperJsonRpcNotificationEvent {
                        method: method.to_string(),
                        params,
                    },
                ))
                .await
                .is_err()
            {
                eprintln!("failed to queue camber-helper notification {method}");
            } else {
                self.notifications_enqueued.fetch_add(1, Ordering::Release);
            }
        }
    }

    async fn wait_for_prior_notifications(&self) -> bool {
        wait_for_notification_barrier(
            &self.notification_tx,
            self.notifications_applied.load(Ordering::Acquire),
            self.notifications_enqueued.load(Ordering::Acquire),
        )
        .await
    }
}

async fn forward_helper_notifications(
    helper: Weak<HelperProcess>,
    mut rx: async_runtime::Receiver<HelperNotificationBridgeItem>,
) {
    let mut deferred = None;
    loop {
        let first = match deferred.take().or_else(|| rx.try_recv().ok()) {
            Some(item) => item,
            None => match rx.recv().await {
                Some(item) => item,
                None => return,
            },
        };
        let first = match first {
            HelperNotificationBridgeItem::Barrier(tx) => {
                let _ = tx.send(()).await;
                continue;
            }
            HelperNotificationBridgeItem::Notification(notification) => notification,
        };

        let mut bytes = first.serialized_len();
        let mut notifications = vec![first];
        let deadline = Instant::now() + HELPER_NOTIFICATION_BATCH_WINDOW;

        while notifications.len() < HELPER_NOTIFICATION_BATCH_CAPACITY {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let next = match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(item)) => item,
                Ok(None) => break,
                Err(_) => break,
            };
            let next = match next {
                HelperNotificationBridgeItem::Barrier(tx) => {
                    deferred = Some(HelperNotificationBridgeItem::Barrier(tx));
                    break;
                }
                HelperNotificationBridgeItem::Notification(notification) => notification,
            };
            let next_bytes = next.serialized_len();
            if !notification_batch_has_capacity(notifications.len(), bytes, next_bytes) {
                deferred = Some(HelperNotificationBridgeItem::Notification(next));
                break;
            }
            bytes = bytes.saturating_add(next_bytes);
            notifications.push(next);
        }

        let mut id = None;
        while !notifications.is_empty() {
            let helper = loop {
                let Some(helper) = helper.upgrade() else {
                    return;
                };
                if helper.notification_bridge_ready.load(Ordering::Acquire) {
                    break helper;
                }
                // Do not retain the helper while the webview is unavailable. This lets app
                // shutdown tear down the process even if JavaScript never marks itself ready.
                drop(helper);
                tokio::time::sleep(HELPER_NOTIFICATION_READY_POLL).await;
            };
            // Results live at app scope so an in-flight batch can still be
            // released if the helper restarts before JavaScript finishes
            // applying it. Reuse the id after an uncertain timeout: the JS
            // bridge caches results by id and will not apply the batch twice.
            let state = helper.app_handle.state::<HelperState>().inner().clone();
            let batch_id = *id.get_or_insert_with(|| {
                state
                    .next_notification_batch_id
                    .fetch_add(1, Ordering::Relaxed)
            });
            let notification_count = notifications.len();
            bytes = notifications
                .iter()
                .map(HelperJsonRpcNotificationEvent::serialized_len)
                .sum();
            let (ack_tx, mut ack_rx) = async_runtime::channel(1);
            state
                .notification_acks
                .lock()
                .await
                .insert(batch_id, ack_tx);

            if let Err(err) = helper.app_handle.emit(
                HELPER_JSONRPC_NOTIFICATION_BATCH_EVENT,
                HelperJsonRpcNotificationBatchEvent {
                    id: batch_id,
                    notifications: notifications.clone(),
                },
            ) {
                state.notification_acks.lock().await.remove(&batch_id);
                eprintln!(
                    "failed to forward camber-helper notification batch {batch_id}; retrying: {err}"
                );
                tokio::time::sleep(HELPER_NOTIFICATION_RETRY_DELAY).await;
                continue;
            }

            match tokio::time::timeout(HELPER_NOTIFICATION_ACK_TIMEOUT, ack_rx.recv()).await {
                Ok(Some(reported_applied)) => {
                    let applied = normalized_applied_count(reported_applied, notification_count);
                    if applied > 0 {
                        notifications.drain(..applied);
                        helper
                            .notifications_applied
                            .fetch_add(applied as u64, Ordering::Release);
                    }
                    if notifications.is_empty() {
                        break;
                    }
                    eprintln!(
                        "camber-helper notification batch {batch_id} applied {applied}/{notification_count}; retrying the remaining {} notifications",
                        notifications.len()
                    );
                    // The payload changes after a partial result, so use a new
                    // id rather than the completed result cached for this one.
                    id = None;
                    tokio::time::sleep(HELPER_NOTIFICATION_RETRY_DELAY).await;
                }
                Ok(None) | Err(_) => {
                    state.notification_acks.lock().await.remove(&batch_id);
                    eprintln!(
                        "camber-helper notification batch {batch_id} was not acknowledged ({notification_count} notifications, {bytes} bytes); retrying"
                    );
                    tokio::time::sleep(HELPER_NOTIFICATION_RETRY_DELAY).await;
                }
            }
        }
    }
}

fn notification_barrier_required(applied: u64, enqueued: u64) -> bool {
    applied < enqueued
}

async fn wait_for_notification_barrier(
    notification_tx: &async_runtime::Sender<HelperNotificationBridgeItem>,
    applied: u64,
    enqueued: u64,
) -> bool {
    if !notification_barrier_required(applied, enqueued) {
        return true;
    }

    let (tx, mut rx) = async_runtime::channel(1);
    if notification_tx
        .send(HelperNotificationBridgeItem::Barrier(tx))
        .await
        .is_err()
    {
        return false;
    }
    // The bridge releases this barrier only after every earlier notification
    // has been applied and acknowledged by the webview. This keeps helper
    // stdout order intact across the separate Tauri request-response and event
    // delivery paths.
    rx.recv().await.is_some()
}

fn normalized_applied_count(reported: usize, notification_count: usize) -> usize {
    if reported == usize::MAX {
        notification_count
    } else {
        reported.min(notification_count)
    }
}

fn notification_batch_has_capacity(count: usize, bytes: usize, next_bytes: usize) -> bool {
    count < HELPER_NOTIFICATION_BATCH_CAPACITY
        && (count == 0 || bytes.saturating_add(next_bytes) <= HELPER_NOTIFICATION_BATCH_MAX_BYTES)
}

fn should_forward_helper_request(method: &str) -> bool {
    matches!(
        method,
        "camber/acp/elicitation/create" | "camber/jsonrpc/request"
    )
}

// Forward every camber/* notification to the TS host (host.ts), which owns
// the routing decision via the shared helper-notification table in
// @camber/rpc. A hand-maintained method list here silently dropped
// notifications the webview needed (camber/acp/serverDidExit never reached
// the desktop webview); prefix forwarding makes an unrouted notification a
// visible console.debug in ONE place instead of an invisible gap in two.
fn should_forward_helper_notification(method: &str) -> bool {
    method.starts_with("camber/")
}

async fn read_events(helper: Arc<HelperProcess>, mut rx: async_runtime::Receiver<CommandEvent>) {
    let mut framer = LspFramer::default();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => match framer.push(&bytes) {
                Ok(messages) => {
                    for message in messages {
                        helper.handle_message(message).await;
                    }
                }
                Err(err) => {
                    eprintln!("failed to parse camber-helper LSP message: {err}");
                    framer.clear();
                }
            },
            CommandEvent::Stderr(bytes) => {
                let message = format!("camber-helper: {}", String::from_utf8_lossy(&bytes));
                eprint!("{message}");
                append_helper_log(&helper.app_handle, &message);
            }
            CommandEvent::Error(err) => {
                let message = format!("camber-helper process error: {err}\n");
                eprint!("{message}");
                append_helper_log(&helper.app_handle, &message);
            }
            CommandEvent::Terminated(payload) => {
                let message = format!("camber-helper terminated: {payload:?}\n");
                eprint!("{message}");
                append_helper_log(&helper.app_handle, &message);
                break;
            }
            _ => {}
        }
    }
}

#[derive(Default)]
struct LspFramer {
    buffer: Vec<u8>,
}

impl LspFramer {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut messages = Vec::new();

        loop {
            let Some(header_end) = find_header_end(&self.buffer) else {
                break;
            };
            let content_length = parse_content_length(&self.buffer[..header_end])?;
            let body_start = header_end + 4;
            let body_end = body_start + content_length;
            if self.buffer.len() < body_end {
                break;
            }

            let body = self.buffer[body_start..body_end].to_vec();
            self.buffer.drain(..body_end);
            messages.push(serde_json::from_slice(&body).map_err(|err| err.to_string())?);
        }

        Ok(messages)
    }

    fn clear(&mut self) {
        self.buffer.clear();
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(header: &[u8]) -> Result<usize, String> {
    let header = std::str::from_utf8(header).map_err(|err| err.to_string())?;
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            return value
                .trim()
                .parse::<usize>()
                .map_err(|err| format!("invalid Content-Length: {err}"));
        }
    }

    Err("missing Content-Length header".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notification(method: &str, params: Value) -> HelperJsonRpcNotificationEvent {
        HelperJsonRpcNotificationEvent {
            method: method.to_string(),
            params,
        }
    }

    fn frame(value: Value) -> Vec<u8> {
        let body = serde_json::to_vec(&value).unwrap();
        let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        frame.extend(body);
        frame
    }

    #[test]
    fn parses_single_complete_message() {
        let mut framer = LspFramer::default();
        let message = json!({"jsonrpc": "2.0", "id": 1, "result": null});

        assert_eq!(framer.push(&frame(message.clone())).unwrap(), vec![message]);
    }

    #[test]
    fn parses_split_header_and_body() {
        let mut framer = LspFramer::default();
        let bytes = frame(json!({"jsonrpc": "2.0", "method": "initialized"}));
        let split = 12;

        assert!(framer.push(&bytes[..split]).unwrap().is_empty());
        assert_eq!(framer.push(&bytes[split..]).unwrap().len(), 1);
    }

    #[test]
    fn parses_multiple_messages_from_one_chunk() {
        let mut framer = LspFramer::default();
        let first = json!({"jsonrpc": "2.0", "id": 1, "result": null});
        let second = json!({"jsonrpc": "2.0", "id": 2, "result": []});
        let mut bytes = frame(first.clone());
        bytes.extend(frame(second.clone()));

        assert_eq!(framer.push(&bytes).unwrap(), vec![first, second]);
    }

    #[test]
    fn rejects_missing_content_length() {
        let mut framer = LspFramer::default();

        assert!(framer.push(b"Header: nope\r\n\r\n{}").is_err());
    }

    #[test]
    fn rejects_malformed_content_length() {
        let mut framer = LspFramer::default();

        assert!(framer.push(b"Content-Length: nope\r\n\r\n{}").is_err());
    }

    #[test]
    fn development_command_uses_go_run_from_repo_root() {
        let manifest_dir = Path::new("/repo/ui/apps/desktop-assistant/src-tauri");
        let spec = HelperCommandSpec::development(manifest_dir, None);

        assert_eq!(spec.program, "go");
        assert_eq!(
            spec.args,
            vec!["run", "-tags=fts5", "./cmd/camber-helper/..."]
        );
        assert_eq!(spec.cwd, Some(PathBuf::from("/repo")));
        assert!(!spec.sidecar);
        assert!(spec
            .env
            .iter()
            .any(|(name, value)| { name == MLX_SIDECAR_DISABLE_DEV_BUILD_ENV && value == "1" }));
        // spec.env comes from remote_access_dev_env, which defers to any
        // CAMBER_REMOTE_* already present in the ambient environment (as in
        // shells descended from a running desktop's helper), plus local
        // inference env, so the full contents are asserted only in the
        // controlled-lookup tests below.
    }

    #[test]
    fn remote_access_dev_env_derives_slot_ports_and_respects_overrides() {
        let manifest_dir = Path::new("/repo/ui/apps/desktop-assistant/src-tauri");

        let env = HelperCommandSpec::remote_access_dev_env_with(manifest_dir, |name| match name {
            "CAMBER_WORKTREE_SLOT" => Some("3".to_string()),
            _ => None,
        });
        assert_eq!(
            env,
            vec![
                (
                    "CAMBER_REMOTE_DEV_SERVER".to_string(),
                    "http://127.0.0.1:5209".to_string()
                ),
                (
                    "CAMBER_REMOTE_STATIC".to_string(),
                    "/repo/ui/apps/mobile-remote/dist".to_string()
                ),
            ]
        );

        // Launcher-provided env wins: nothing is injected on top of it.
        let env = HelperCommandSpec::remote_access_dev_env_with(manifest_dir, |name| match name {
            "CAMBER_REMOTE_DEV_SERVER" => Some("http://127.0.0.1:9999".to_string()),
            "CAMBER_REMOTE_STATIC" => Some("/elsewhere".to_string()),
            _ => None,
        });
        assert!(env.is_empty());
    }

    #[test]
    fn local_inference_dev_env_uses_downloaded_mlx_sidecar() {
        let manifest_dir = Path::new("/repo/ui/apps/desktop-assistant/src-tauri");
        let sidecar = manifest_dir
            .join("binaries")
            .join("camber-mlx-sidecar-aarch64-apple-darwin");

        let env = HelperCommandSpec::local_inference_dev_env_with(
            manifest_dir,
            Some("aarch64-apple-darwin"),
            |_| None,
            |path| path == sidecar.as_path(),
        );

        assert_eq!(
            env,
            vec![
                (
                    MLX_SIDECAR_DISABLE_DEV_BUILD_ENV.to_string(),
                    "1".to_string()
                ),
                (
                    MLX_SIDECAR_ENV.to_string(),
                    sidecar.to_string_lossy().into_owned()
                ),
            ]
        );
    }

    #[test]
    fn local_inference_dev_env_respects_existing_sidecar_env() {
        let manifest_dir = Path::new("/repo/ui/apps/desktop-assistant/src-tauri");

        let env = HelperCommandSpec::local_inference_dev_env_with(
            manifest_dir,
            Some("aarch64-apple-darwin"),
            |name| {
                if name == MLX_SIDECAR_ENV {
                    Some("/custom/camber-mlx-sidecar".to_string())
                } else {
                    None
                }
            },
            |_| true,
        );

        assert_eq!(
            env,
            vec![(
                MLX_SIDECAR_DISABLE_DEV_BUILD_ENV.to_string(),
                "1".to_string()
            )]
        );
    }

    #[test]
    fn development_debug_command_uses_dlv_from_repo_root() {
        let manifest_dir = Path::new("/repo/ui/apps/desktop-assistant/src-tauri");
        let spec = HelperCommandSpec::development(
            manifest_dir,
            Some(HelperDebugOptions {
                port: 21375,
                dlv_binary: "dlv".to_string(),
            }),
        );

        assert_eq!(spec.program, "dlv");
        assert_eq!(
            spec.args,
            vec![
                "debug",
                "--continue",
                "--headless",
                "--listen=127.0.0.1:21375",
                "--api-version=2",
                "--accept-multiclient",
                "--build-flags=-tags=fts5",
                "--log-dest=/tmp/camber-helper-dlv-21375.log",
                "./cmd/camber-helper",
                "--",
                "--stdin"
            ]
        );
        assert_eq!(spec.cwd, Some(PathBuf::from("/repo")));
        assert!(!spec.sidecar);
        // Only the CGO entries are deterministic; the remote_access_dev_env
        // tail depends on the ambient environment (see the development test).
        assert_eq!(
            spec.env[..2],
            vec![
                ("CGO_ENABLED".to_string(), "1".to_string()),
                ("CGO_CPPFLAGS".to_string(), "-w".to_string())
            ]
        );
        assert!(spec
            .env
            .iter()
            .any(|(name, value)| { name == MLX_SIDECAR_DISABLE_DEV_BUILD_ENV && value == "1" }));
    }

    #[test]
    fn production_command_uses_sidecar() {
        let spec = HelperCommandSpec::production();

        assert_eq!(spec.program, "camber-helper");
        assert!(spec.args.is_empty());
        assert_eq!(spec.cwd, None);
        assert!(spec.sidecar);
        assert!(spec.env.is_empty());
    }

    #[test]
    fn forwards_local_inference_notifications() {
        assert!(should_forward_helper_notification(
            "camber/localInference/didChange"
        ));
    }

    #[test]
    fn forwards_every_camber_notification_and_nothing_else() {
        // The TS host routes; this layer only guards against non-camber
        // traffic reaching the webview event bus.
        assert!(should_forward_helper_notification(
            "camber/acp/serverDidExit"
        ));
        assert!(should_forward_helper_notification(
            "camber/acpNav/didChange"
        ));
        assert!(!should_forward_helper_notification("window/logMessage"));
        assert!(!should_forward_helper_notification(""));
    }

    #[test]
    fn helper_notification_queue_is_bounded() {
        let (tx, _rx) = async_runtime::channel(2);

        assert!(tx
            .try_send(notification("camber/jsonrpc/notify", json!({ "seq": 1 })))
            .is_ok());
        assert!(tx
            .try_send(notification("camber/jsonrpc/notify", json!({ "seq": 2 })))
            .is_ok());
        assert!(tx
            .try_send(notification("camber/jsonrpc/notify", json!({ "seq": 3 })))
            .is_err());
    }

    #[test]
    fn helper_notification_batches_are_bounded_by_count_and_bytes() {
        assert!(notification_batch_has_capacity(1, 100, 100));
        assert!(!notification_batch_has_capacity(
            HELPER_NOTIFICATION_BATCH_CAPACITY,
            100,
            100
        ));
        assert!(!notification_batch_has_capacity(
            1,
            HELPER_NOTIFICATION_BATCH_MAX_BYTES - 10,
            11
        ));
        // A single large notification must still make progress; the channel
        // capacity bounds how many such payloads can wait behind it.
        assert!(notification_batch_has_capacity(
            0,
            0,
            HELPER_NOTIFICATION_BATCH_MAX_BYTES + 1
        ));
    }

    #[test]
    fn ordered_messages_wait_only_while_earlier_notifications_are_unapplied() {
        assert!(!notification_barrier_required(0, 0));
        assert!(notification_barrier_required(4, 5));
        assert!(!notification_barrier_required(5, 5));
    }

    #[test]
    fn ordering_barrier_resolves_only_after_the_bridge_releases_it() {
        async_runtime::block_on(async {
            let (bridge_tx, mut bridge_rx) = async_runtime::channel(1);
            let (result_tx, mut result_rx) = async_runtime::channel(1);
            async_runtime::spawn(async move {
                let result = wait_for_notification_barrier(&bridge_tx, 0, 1).await;
                let _ = result_tx.send(result).await;
            });

            let barrier = bridge_rx.recv().await.expect("expected response barrier");
            assert!(result_rx.try_recv().is_err());
            let HelperNotificationBridgeItem::Barrier(tx) = barrier else {
                panic!("expected a barrier behind the queued notification");
            };
            tx.send(()).await.expect("release response barrier");

            assert_eq!(result_rx.recv().await, Some(true));
        });
    }

    #[test]
    fn notification_results_preserve_partial_progress_and_legacy_full_acks() {
        assert_eq!(normalized_applied_count(2, 5), 2);
        assert_eq!(normalized_applied_count(20, 5), 5);
        assert_eq!(normalized_applied_count(usize::MAX, 5), 5);
    }

    #[test]
    fn notification_batch_ack_reports_the_applied_prefix() {
        async_runtime::block_on(async {
            let state = HelperState::default();
            let (tx, mut rx) = async_runtime::channel(1);
            state.notification_acks.lock().await.insert(7, tx);

            state.ack_notification_batch(7, Some(3)).await;

            assert_eq!(rx.recv().await, Some(3));
        });
    }

    fn temp_log_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "camber-helper-log-prune-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn session_log_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn prune_keeps_the_newest_session_logs() {
        let dir = temp_log_dir("keeps-newest");
        for i in 0..25 {
            fs::write(
                dir.join(format!("camber-helper-2026-01-01T00-00-{i:02}.000.log")),
                "",
            )
            .unwrap();
        }

        prune_helper_session_logs(&dir, 19);

        let names = session_log_names(&dir);
        assert_eq!(names.len(), 19);
        assert_eq!(names[0], "camber-helper-2026-01-01T00-00-06.000.log");
        assert_eq!(
            names.last().unwrap(),
            "camber-helper-2026-01-01T00-00-24.000.log"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prune_removes_the_legacy_single_log_file() {
        let dir = temp_log_dir("legacy");
        fs::write(dir.join("camber-helper.log"), "old").unwrap();

        prune_helper_session_logs(&dir, 19);

        assert!(session_log_names(&dir).is_empty());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prune_ignores_unrelated_files_and_small_session_counts() {
        let dir = temp_log_dir("unrelated");
        fs::write(dir.join("other.log"), "").unwrap();
        fs::write(dir.join("camber-helper-2026-01-01T00-00-00.000.log"), "").unwrap();
        fs::write(dir.join("camber-helper-2026-01-02T00-00-00.000.log"), "").unwrap();

        prune_helper_session_logs(&dir, 19);

        assert_eq!(
            session_log_names(&dir),
            vec![
                "camber-helper-2026-01-01T00-00-00.000.log",
                "camber-helper-2026-01-02T00-00-00.000.log",
                "other.log",
            ]
        );

        fs::remove_dir_all(dir).unwrap();
    }
}
