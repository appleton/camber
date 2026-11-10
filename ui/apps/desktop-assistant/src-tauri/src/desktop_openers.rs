#[cfg(target_os = "macos")]
use std::collections::{HashMap, HashSet};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{OnceLock, RwLock},
};
#[cfg(target_os = "macos")]
use std::{
    os::unix::fs::PermissionsExt,
    process::Stdio,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const OPENERS_CACHE_FILE_NAME: &str = "openers-cache.json";
// v4: icons downscaled to ICON_MAX_DIMENSION (full-size app icons made the
// cache ~8.9MB, which get_desktop_settings parsed, cloned, and shipped over
// IPC on every boot).
const OPENERS_CACHE_VERSION: u32 = 4;
// Openers render at 16-32 CSS px; 64 physical px keeps them sharp on retina
// displays at a few KB per icon instead of up to ~1MB for a full app icon.
#[cfg(target_os = "macos")]
const ICON_MAX_DIMENSION: &str = "64";
const CAMBER_DESKTOP_APP_ICON: &[u8] = include_bytes!("../icons/32x32.png");
static DETECTED_OPENERS: OnceLock<RwLock<DetectedOpeners>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFileOpener {
    pub(crate) id: String,
    label: String,
    kind: DesktopFileOpenerKind,
    app_path: Option<String>,
    bundle_id: Option<String>,
    icon_data_uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DetectedOpeners {
    pub file_openers: Vec<DesktopFileOpener>,
    pub desktop_openers: Vec<DesktopFileOpener>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedDetectedOpeners {
    version: u32,
    editor_env: Option<String>,
    openers: DetectedOpeners,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopFileOpenerKind {
    InApp,
    Default,
    EditorEnv,
    Application,
    Terminal,
}

impl DesktopFileOpener {
    /// Drops the (potentially large) inline icon; used to slim the boot
    /// settings response, whose transport cost scales with payload size.
    pub fn clear_icon(&mut self) {
        self.icon_data_uri = None;
    }
}

pub fn in_app_file_opener_id() -> String {
    "poolside".to_string()
}

pub fn in_app_file_opener() -> DesktopFileOpener {
    DesktopFileOpener {
        id: in_app_file_opener_id(),
        label: "In-app viewer".to_string(),
        kind: DesktopFileOpenerKind::InApp,
        app_path: None,
        bundle_id: None,
        icon_data_uri: Some(camber_desktop_app_icon_data_uri()),
    }
}

fn camber_desktop_app_icon_data_uri() -> String {
    format!(
        "data:image/png;base64,{}",
        STANDARD.encode(CAMBER_DESKTOP_APP_ICON)
    )
}

pub fn default_file_opener_id() -> String {
    "default".to_string()
}

pub fn cached_detected_openers_or_default(app_handle: &AppHandle) -> DetectedOpeners {
    if let Some(openers) = read_cached_detected_openers(app_handle) {
        return openers;
    }
    fallback_detected_openers()
}

pub fn fallback_detected_openers() -> DetectedOpeners {
    let file_openers = vec![in_app_file_opener(), default_file_opener_without_icon()];
    DetectedOpeners {
        desktop_openers: vec![default_desktop_opener_without_icon()],
        file_openers,
    }
}

pub fn detected_openers(app_handle: &AppHandle) -> DetectedOpeners {
    let lock = DETECTED_OPENERS.get_or_init(|| RwLock::new(load_detected_openers(app_handle)));
    lock.read()
        .map(|openers| openers.clone())
        .unwrap_or_else(|err| err.into_inner().clone())
}

fn load_detected_openers(app_handle: &AppHandle) -> DetectedOpeners {
    if let Some(openers) = read_cached_detected_openers(app_handle) {
        return openers;
    }
    let openers = detect_openers();
    let _ = write_cached_detected_openers(app_handle, &openers);
    openers
}

pub fn refresh_detected_openers(app_handle: &AppHandle) -> Result<DetectedOpeners, String> {
    let openers = detect_openers();
    write_cached_detected_openers(app_handle, &openers)?;
    // get_or_init + write-through: a plain `set` silently loses this fresh
    // result when another thread (the boot warm-up) initializes the lock
    // between the check and the set, leaving stale openers for the session.
    let lock = DETECTED_OPENERS.get_or_init(|| RwLock::new(openers.clone()));
    *lock.write().unwrap_or_else(|err| err.into_inner()) = openers.clone();
    Ok(openers)
}

fn detect_openers() -> DetectedOpeners {
    let mut file_openers = vec![in_app_file_opener()];
    file_openers.extend(detect_file_openers());
    let mut desktop_openers = file_openers.clone();
    desktop_openers.retain(|opener| opener.id != in_app_file_opener_id());
    if let Some(default_opener) = desktop_openers
        .iter_mut()
        .find(|opener| opener.id == default_file_opener_id())
    {
        default_opener.label = default_desktop_opener_label().to_string();
    }
    desktop_openers.extend(detect_terminal_openers());
    DetectedOpeners {
        file_openers,
        desktop_openers,
    }
}

fn openers_cache_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_handle
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?
        .join(OPENERS_CACHE_FILE_NAME))
}

// Editor environment variables checked, in priority order. `$EDITOR` keeps its
// existing precedence; `$VISUAL` is supported as a common fallback.
const EDITOR_ENV_VARS: [&str; 2] = ["EDITOR", "VISUAL"];

/// Returns the configured editor command and the name of the environment
/// variable it came from, preferring `$EDITOR` over `$VISUAL`.
fn editor_env() -> Option<(&'static str, String)> {
    EDITOR_ENV_VARS.into_iter().find_map(|var| {
        std::env::var(var)
            .ok()
            .map(|editor| editor.trim().to_string())
            .filter(|editor| !editor.is_empty())
            .map(|editor| (var, editor))
    })
}

fn current_editor_env() -> Option<String> {
    editor_env().map(|(_, editor)| editor)
}

fn read_cached_detected_openers(app_handle: &AppHandle) -> Option<DetectedOpeners> {
    let path = openers_cache_path(app_handle).ok()?;
    let contents = fs::read_to_string(path).ok()?;
    let cached: CachedDetectedOpeners = serde_json::from_str(&contents).ok()?;
    if cached.version != OPENERS_CACHE_VERSION || cached.editor_env != current_editor_env() {
        return None;
    }
    Some(cached.openers)
}

fn write_cached_detected_openers(
    app_handle: &AppHandle,
    openers: &DetectedOpeners,
) -> Result<(), String> {
    let path = openers_cache_path(app_handle)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let cached = CachedDetectedOpeners {
        version: OPENERS_CACHE_VERSION,
        editor_env: current_editor_env(),
        openers: openers.clone(),
    };
    let contents = serde_json::to_string(&cached).map_err(|err| err.to_string())?;
    // Atomic replace with a per-write temp name: the boot warm-up thread and
    // the post-mount openers refresh can both write on a cache-miss launch —
    // same pid, so a pid-only suffix would still collide — and concurrently
    // launching builds share the path across processes.
    let tmp = unique_tmp_path(&path);
    fs::write(&tmp, contents).map_err(|err| err.to_string())?;
    fs::rename(&tmp, &path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        err.to_string()
    })
}

/// A temp path unique per write: pid distinguishes processes, the counter
/// distinguishes concurrent writers within one.
pub(crate) fn unique_tmp_path(path: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_extension(format!("tmp.{}.{nonce}", std::process::id()))
}

fn detect_file_openers() -> Vec<DesktopFileOpener> {
    let mut openers = vec![default_file_opener()];

    if let Some((var, editor)) = editor_env() {
        openers.push(DesktopFileOpener {
            id: "editor".to_string(),
            label: format!("${var} ({editor})"),
            kind: DesktopFileOpenerKind::EditorEnv,
            app_path: None,
            bundle_id: None,
            icon_data_uri: None,
        });
    }

    openers.extend(detect_application_file_openers());
    openers
}

pub fn default_file_opener() -> DesktopFileOpener {
    DesktopFileOpener {
        id: default_file_opener_id(),
        label: default_file_opener_label().to_string(),
        kind: DesktopFileOpenerKind::Default,
        app_path: None,
        bundle_id: None,
        icon_data_uri: default_file_opener_icon_data_uri(),
    }
}

/// Builds a minimal opener with the given id for use in other modules' tests.
#[cfg(test)]
pub(crate) fn test_opener(id: &str) -> DesktopFileOpener {
    DesktopFileOpener {
        id: id.to_string(),
        label: id.to_string(),
        kind: DesktopFileOpenerKind::Application,
        app_path: None,
        bundle_id: None,
        icon_data_uri: None,
    }
}

#[cfg(test)]
pub(crate) fn test_opener_with_icon(id: &str, icon_data_uri: &str) -> DesktopFileOpener {
    DesktopFileOpener {
        icon_data_uri: Some(icon_data_uri.to_string()),
        ..test_opener(id)
    }
}

fn default_file_opener_without_icon() -> DesktopFileOpener {
    DesktopFileOpener {
        id: default_file_opener_id(),
        label: default_file_opener_label().to_string(),
        kind: DesktopFileOpenerKind::Default,
        app_path: None,
        bundle_id: None,
        icon_data_uri: None,
    }
}

fn default_desktop_opener_without_icon() -> DesktopFileOpener {
    DesktopFileOpener {
        id: default_file_opener_id(),
        label: default_desktop_opener_label().to_string(),
        kind: DesktopFileOpenerKind::Default,
        app_path: None,
        bundle_id: None,
        icon_data_uri: None,
    }
}

#[cfg(target_os = "macos")]
fn default_file_opener_label() -> &'static str {
    "Default macOS app"
}

#[cfg(target_os = "linux")]
fn default_file_opener_label() -> &'static str {
    "Default Linux App"
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn default_file_opener_label() -> &'static str {
    "Default App"
}

#[cfg(target_os = "macos")]
fn default_desktop_opener_label() -> &'static str {
    "Finder"
}

#[cfg(target_os = "linux")]
fn default_desktop_opener_label() -> &'static str {
    "Default Linux App"
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn default_desktop_opener_label() -> &'static str {
    "Default App"
}

#[cfg(target_os = "macos")]
fn default_file_opener_icon_data_uri() -> Option<String> {
    icon_file_data_uri(Path::new(
        "/System/Library/CoreServices/Finder.app/Contents/Resources/Finder.icns",
    ))
}

#[cfg(not(target_os = "macos"))]
fn default_file_opener_icon_data_uri() -> Option<String> {
    None
}

pub fn open_file_with_selected_opener(
    app_handle: &AppHandle,
    file_opener_id: &str,
    path: &Path,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    if file_opener_id == "editor" {
        return open_with_editor_env(path, line, column);
    }

    if file_opener_id != default_file_opener_id() {
        if let Some(opener) = detected_openers(app_handle)
            .file_openers
            .iter()
            .find(|opener| opener.id == file_opener_id)
        {
            if let Some(line) = line {
                if open_with_application_file_position(opener, path, line, column).is_ok() {
                    return Ok(());
                }
            }
            if let Some(bundle_id) = &opener.bundle_id {
                return open_with_application_bundle(bundle_id, path);
            }
            if let Some(app_path) = &opener.app_path {
                return open_with_application_path(Path::new(app_path), path);
            }
        }
    }

    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|err| err.to_string())
}

fn file_position_target(path: &Path, line: u32, column: Option<u32>) -> String {
    let mut target = path.to_string_lossy().to_string();
    target.push(':');
    target.push_str(&line.to_string());
    if let Some(column) = column {
        target.push(':');
        target.push_str(&column.to_string());
    }
    target
}

#[cfg(target_os = "macos")]
fn open_with_application_file_position(
    opener: &DesktopFileOpener,
    path: &Path,
    line: u32,
    column: Option<u32>,
) -> Result<(), String> {
    let target = file_position_target(path, line, column);
    if let Some(command) = bundled_goto_command(opener) {
        return command.spawn(&target);
    }
    if let Some(scheme) = editor_url_scheme(opener) {
        return tauri_plugin_opener::open_url(
            editor_file_url(scheme, path, line, column),
            None::<&str>,
        )
        .map_err(|err| err.to_string());
    }
    Err("application does not support file positions".to_string())
}

#[cfg(not(target_os = "macos"))]
fn open_with_application_file_position(
    _opener: &DesktopFileOpener,
    _path: &Path,
    _line: u32,
    _column: Option<u32>,
) -> Result<(), String> {
    Err("application does not support file positions".to_string())
}

#[cfg(target_os = "macos")]
enum GotoCommand {
    GotoFlag(PathBuf),
    PlainTarget(PathBuf),
}

#[cfg(target_os = "macos")]
impl GotoCommand {
    fn spawn(self, target: &str) -> Result<(), String> {
        let mut command = match self {
            Self::GotoFlag(path) => {
                let mut command = Command::new(path);
                command.arg("--goto");
                command
            }
            Self::PlainTarget(path) => Command::new(path),
        };
        command
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|err| err.to_string())
    }
}

#[cfg(target_os = "macos")]
fn bundled_goto_command(opener: &DesktopFileOpener) -> Option<GotoCommand> {
    let app_path = Path::new(opener.app_path.as_ref()?);
    let label = opener.label.as_str();
    let bundle_id = opener.bundle_id.as_deref().unwrap_or("");
    let candidates: &[(&str, &[&str], GotoCommandKind)] = &[
        (
            "code",
            &["Visual Studio Code", "Visual Studio Code - Insiders"],
            GotoCommandKind::GotoFlag,
        ),
        ("cursor", &["Cursor"], GotoCommandKind::GotoFlag),
        ("windsurf", &["Windsurf"], GotoCommandKind::GotoFlag),
        ("subl", &["Sublime Text"], GotoCommandKind::PlainTarget),
    ];

    for (command_name, labels, kind) in candidates {
        if !labels.iter().any(|candidate| *candidate == label)
            && !bundle_id
                .to_ascii_lowercase()
                .contains(&command_name.to_ascii_lowercase())
        {
            continue;
        }

        let path = match *command_name {
            "subl" => app_path.join("Contents/SharedSupport/bin/subl"),
            _ => app_path
                .join("Contents/Resources/app/bin")
                .join(command_name),
        };
        if path.exists() {
            return Some(match kind {
                GotoCommandKind::GotoFlag => GotoCommand::GotoFlag(path),
                GotoCommandKind::PlainTarget => GotoCommand::PlainTarget(path),
            });
        }
    }
    None
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum GotoCommandKind {
    GotoFlag,
    PlainTarget,
}

#[cfg(target_os = "macos")]
fn editor_url_scheme(opener: &DesktopFileOpener) -> Option<&'static str> {
    let label = opener.label.as_str();
    let bundle_id = opener.bundle_id.as_deref().unwrap_or("");
    if label == "Visual Studio Code - Insiders" || bundle_id.contains("VSCodeInsiders") {
        return Some("vscode-insiders");
    }
    if label == "Visual Studio Code" || bundle_id.contains("VSCode") {
        return Some("vscode");
    }
    if label == "Cursor" || bundle_id.to_ascii_lowercase().contains("cursor") {
        return Some("cursor");
    }
    if label == "Windsurf" || bundle_id.to_ascii_lowercase().contains("windsurf") {
        return Some("windsurf");
    }
    None
}

#[cfg(target_os = "macos")]
fn editor_file_url(scheme: &str, path: &Path, line: u32, column: Option<u32>) -> String {
    let mut url = format!("{scheme}://file/{}", percent_encode_file_path(path));
    url.push(':');
    url.push_str(&line.to_string());
    if let Some(column) = column {
        url.push(':');
        url.push_str(&column.to_string());
    }
    url
}

#[cfg(target_os = "macos")]
fn percent_encode_file_path(path: &Path) -> String {
    path.to_string_lossy()
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

pub fn open_directory_with_opener(
    app_handle: &AppHandle,
    opener_id: &str,
    path: &Path,
) -> Result<(), String> {
    if opener_id == "editor" {
        return open_with_editor_env(path, None, None);
    }

    if opener_id != default_file_opener_id() {
        if let Some(opener) = detected_openers(app_handle)
            .desktop_openers
            .iter()
            .find(|opener| opener.id == opener_id)
        {
            if let Some(bundle_id) = &opener.bundle_id {
                return open_with_application_bundle(bundle_id, path);
            }
            if let Some(app_path) = &opener.app_path {
                return open_with_application_path(Path::new(app_path), path);
            }
        }
    }

    open_default_directory(path)
}

#[cfg(target_os = "macos")]
fn open_default_directory(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg("-b")
        .arg("com.apple.finder")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(not(target_os = "macos"))]
fn open_default_directory(path: &Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|err| err.to_string())
}

fn open_with_editor_env(path: &Path, line: Option<u32>, column: Option<u32>) -> Result<(), String> {
    let (_, editor) = editor_env().ok_or_else(|| "$EDITOR/$VISUAL is not set".to_string())?;
    let target = line
        .map(|line| file_position_target(path, line, column))
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let editor_command = editor_command_line(&editor, &target);

    open_editor_command_in_terminal(&editor_command)
}

fn editor_command_line(editor: &str, target: &str) -> String {
    format!("{editor} {}", shell_quote(target))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "macos")]
fn open_editor_command_in_terminal(editor_command: &str) -> Result<(), String> {
    open_macos_terminal_command_file(editor_command)
}

#[cfg(target_os = "macos")]
fn open_macos_terminal_command_file(editor_command: &str) -> Result<(), String> {
    let script_path = macos_terminal_command_file_path();
    let script = macos_terminal_command_file(editor_command, &script_path);
    fs::write(&script_path, script).map_err(|err| err.to_string())?;
    if let Err(err) = fs::set_permissions(&script_path, fs::Permissions::from_mode(0o700)) {
        let _ = fs::remove_file(&script_path);
        return Err(err.to_string());
    }

    // The extensionless executable is a public.unix-executable, so
    // LaunchServices sends it to the user's default terminal app.
    let result = Command::new("open")
        .arg(&script_path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string());
    if result.is_err() {
        let _ = fs::remove_file(&script_path);
        return result;
    }

    // The script deletes itself as soon as the terminal starts it. Also clean
    // it up if the configured terminal ignores executable shell files.
    thread::spawn(move || {
        thread::sleep(std::time::Duration::from_secs(60));
        let _ = fs::remove_file(script_path);
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_terminal_command_file_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "camber-editor-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ))
}

#[cfg(target_os = "macos")]
fn macos_terminal_command_file(editor_command: &str, script_path: &Path) -> String {
    format!(
        "#!/bin/sh\nrm -f -- {}\nexec {} -lic {}\n",
        shell_quote(&script_path.to_string_lossy()),
        shell_quote(&crate::shell_env::login_shell()),
        shell_quote(editor_command),
    )
}

#[cfg(target_os = "linux")]
fn open_editor_command_in_terminal(editor_command: &str) -> Result<(), String> {
    let terminal = std::env::var("TERMINAL")
        .ok()
        .filter(|terminal| !terminal.trim().is_empty())
        .unwrap_or_else(|| "x-terminal-emulator".to_string());
    let mut parts = terminal.split_whitespace();
    let command = parts
        .next()
        .ok_or_else(|| "Unable to resolve an external terminal".to_string())?;
    Command::new(command)
        .args(parts)
        .arg("-e")
        .arg(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()))
        .arg("-lic")
        .arg(editor_command)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_editor_command_in_terminal(editor_command: &str) -> Result<(), String> {
    Command::new("sh")
        .args(["-lc", editor_command])
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "macos")]
fn detect_application_file_openers() -> Vec<DesktopFileOpener> {
    const APP_NAMES: &[&str] = &[
        "Visual Studio Code",
        "Visual Studio Code - Insiders",
        "Cursor",
        "Windsurf",
        "Zed",
        "Zed Preview",
        "Sublime Text",
        "WebStorm",
        "PhpStorm",
        "GoLand",
        "PyCharm",
        "DataGrip",
        "DataSpell",
        "Rider",
        "RubyMine",
        "IntelliJ IDEA",
        "Android Studio",
    ];

    macos_openers_for_app_names(APP_NAMES, DesktopFileOpenerKind::Application)
}

#[cfg(not(target_os = "macos"))]
fn detect_application_file_openers() -> Vec<DesktopFileOpener> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn detect_terminal_openers() -> Vec<DesktopFileOpener> {
    const APP_NAMES: &[&str] = &[
        "Terminal",
        "iTerm",
        "iTerm2",
        "Warp",
        "Ghostty",
        "Rex",
        "WezTerm",
        "Alacritty",
        "kitty",
    ];

    macos_openers_for_app_names(APP_NAMES, DesktopFileOpenerKind::Terminal)
}

#[cfg(not(target_os = "macos"))]
fn detect_terminal_openers() -> Vec<DesktopFileOpener> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn macos_openers_for_app_names(
    app_names: &[&str],
    kind: DesktopFileOpenerKind,
) -> Vec<DesktopFileOpener> {
    let mut openers = Vec::new();
    let mut seen_ids = HashSet::new();
    for (app_name, app_path) in find_macos_app_bundles(app_names) {
        let opener = macos_app_opener(&app_name, app_path, kind);
        if !seen_ids.insert(opener.id.clone()) {
            continue;
        }
        openers.push(opener);
    }
    openers
}

#[cfg(target_os = "macos")]
fn open_with_application_bundle(bundle_id: &str, file_path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg("-b")
        .arg(bundle_id)
        .arg(file_path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(not(target_os = "macos"))]
fn open_with_application_bundle(_bundle_id: &str, file_path: &Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(file_path, None::<&str>).map_err(|err| err.to_string())
}

#[cfg(target_os = "macos")]
fn open_with_application_path(app_path: &Path, file_path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg("-a")
        .arg(app_path)
        .arg(file_path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(not(target_os = "macos"))]
fn open_with_application_path(_app_path: &Path, file_path: &Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(file_path, None::<&str>).map_err(|err| err.to_string())
}

#[cfg(target_os = "macos")]
fn find_macos_app_bundles(app_names: &[&str]) -> Vec<(String, PathBuf)> {
    let wanted: HashMap<String, &str> = app_names
        .iter()
        .map(|app_name| (format!("{app_name}.app"), *app_name))
        .collect();
    let mut matches: HashMap<String, Vec<PathBuf>> = HashMap::new();

    for root in macos_app_roots() {
        collect_matching_macos_app_bundles(&root, &wanted, 0, &mut matches);
    }

    let mut out = Vec::new();
    for app_name in app_names {
        if let Some(paths) = matches.remove(&format!("{app_name}.app")) {
            out.extend(
                paths
                    .into_iter()
                    .map(|path| ((*app_name).to_string(), path)),
            );
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn macos_app_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots
}

#[cfg(target_os = "macos")]
fn collect_matching_macos_app_bundles(
    root: &Path,
    wanted: &HashMap<String, &str>,
    depth: usize,
    out: &mut HashMap<String, Vec<PathBuf>>,
) {
    if depth > 3 {
        return;
    }

    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let file_name = path.file_name().and_then(|name| name.to_str());
        if let Some(bundle_name) = file_name.filter(|name| wanted.contains_key(*name)) {
            out.entry(bundle_name.to_string()).or_default().push(path);
            continue;
        }

        if depth < 3 && !path.extension().is_some_and(|ext| ext == "app") {
            collect_matching_macos_app_bundles(&path, wanted, depth + 1, out);
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_app_opener(
    label: &str,
    app_path: PathBuf,
    kind: DesktopFileOpenerKind,
) -> DesktopFileOpener {
    let bundle_id = read_macos_bundle_value(&app_path, "CFBundleIdentifier");
    let id = bundle_id
        .as_ref()
        .map(|bundle_id| opener_id(kind, bundle_id))
        .unwrap_or_else(|| opener_id(kind, &app_path.to_string_lossy()));
    let icon_data_uri = macos_app_icon_data_uri(&app_path);

    DesktopFileOpener {
        id,
        label: label.to_string(),
        kind,
        app_path: Some(app_path.to_string_lossy().to_string()),
        bundle_id,
        icon_data_uri,
    }
}

#[cfg(target_os = "macos")]
fn opener_id(kind: DesktopFileOpenerKind, value: &str) -> String {
    match kind {
        DesktopFileOpenerKind::Terminal => format!("terminal:{value}"),
        _ => format!("app:{value}"),
    }
}

#[cfg(target_os = "macos")]
fn read_macos_bundle_value(app_path: &Path, key: &str) -> Option<String> {
    let info_plist = app_path.join("Contents/Info.plist");
    let output = Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg(format!("Print:{key}"))
        .arg(info_plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "macos")]
fn macos_app_icon_data_uri(app_path: &Path) -> Option<String> {
    let icon_name = read_macos_bundle_value(app_path, "CFBundleIconFile")?;
    let icon_file_name = if Path::new(&icon_name).extension().is_some() {
        icon_name
    } else {
        format!("{icon_name}.icns")
    };
    let icon_path = app_path.join("Contents/Resources").join(icon_file_name);
    icon_file_data_uri(&icon_path)
}

#[cfg(target_os = "macos")]
fn icon_file_data_uri(icon_path: &Path) -> Option<String> {
    if !icon_path.exists() {
        return None;
    }
    let output_path = std::env::temp_dir().join(format!(
        "camber-app-icon-{}-{}-{}.png",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
        icon_path
            .to_string_lossy()
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect::<String>()
    ));
    let status = Command::new("sips")
        .args(["-s", "format", "png", "-Z", ICON_MAX_DIMENSION])
        .arg(&icon_path)
        .arg("--out")
        .arg(&output_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }

    let bytes = fs::read(&output_path).ok()?;
    let _ = fs::remove_file(output_path);
    Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Serializes tests that mutate process-wide editor env vars so they cannot
    // race with each other (Rust runs tests in parallel by default).
    static EDITOR_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn fallback_openers_include_in_app_file_opener_without_desktop_opener() {
        let openers = fallback_detected_openers();

        assert_eq!(openers.file_openers.len(), 2);
        assert_eq!(openers.desktop_openers.len(), 1);
        assert_eq!(openers.file_openers[0].id, in_app_file_opener_id());
        assert_eq!(openers.file_openers[0].label, "In-app viewer");
        assert_eq!(openers.file_openers[1].id, default_file_opener_id());
        assert_eq!(openers.file_openers[1].label, default_file_opener_label());
        assert_eq!(
            openers.desktop_openers[0].label,
            default_desktop_opener_label()
        );
        assert_eq!(
            openers.file_openers[0].icon_data_uri,
            Some(camber_desktop_app_icon_data_uri())
        );
        assert_eq!(openers.file_openers[1].icon_data_uri, None);
        assert_eq!(openers.desktop_openers[0].icon_data_uri, None);
        assert!(!openers
            .desktop_openers
            .iter()
            .any(|opener| opener.id == in_app_file_opener_id()));
    }

    #[test]
    fn editor_env_prefers_editor_then_falls_back_to_visual() {
        let _guard = EDITOR_ENV_LOCK
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let saved_editor = std::env::var_os("EDITOR");
        let saved_visual = std::env::var_os("VISUAL");

        // $EDITOR wins when both are set.
        std::env::set_var("EDITOR", "nvim");
        std::env::set_var("VISUAL", "code --wait");
        assert_eq!(editor_env(), Some(("EDITOR", "nvim".to_string())));

        // $VISUAL is used when $EDITOR is unset or blank.
        std::env::remove_var("EDITOR");
        assert_eq!(editor_env(), Some(("VISUAL", "code --wait".to_string())));
        std::env::set_var("EDITOR", "   ");
        assert_eq!(editor_env(), Some(("VISUAL", "code --wait".to_string())));

        // Neither set means no editor opener.
        std::env::remove_var("EDITOR");
        std::env::remove_var("VISUAL");
        assert_eq!(editor_env(), None);

        match saved_editor {
            Some(value) => std::env::set_var("EDITOR", value),
            None => std::env::remove_var("EDITOR"),
        }
        match saved_visual {
            Some(value) => std::env::set_var("VISUAL", value),
            None => std::env::remove_var("VISUAL"),
        }
    }

    #[test]
    fn file_position_target_preserves_line_and_column() {
        assert_eq!(
            file_position_target(Path::new("/tmp/project/src/main.ts"), 42, Some(5)),
            "/tmp/project/src/main.ts:42:5"
        );
    }

    #[test]
    fn file_position_target_omits_missing_column() {
        assert_eq!(
            file_position_target(Path::new("/tmp/project/src/main.ts"), 42, None),
            "/tmp/project/src/main.ts:42"
        );
    }

    #[test]
    fn editor_command_line_quotes_file_paths_for_the_terminal_shell() {
        assert_eq!(
            editor_command_line("nvim -f", "/tmp/a file's name.ts"),
            "nvim -f '/tmp/a file'\"'\"'s name.ts'"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn terminal_command_file_removes_itself_and_runs_editor_in_a_login_shell() {
        let path = Path::new("/tmp/camber-editor");
        let script = macos_terminal_command_file("vim '/tmp/file name.ts'", path);

        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("rm -f -- '/tmp/camber-editor'"));
        assert!(script.contains("-lic 'vim '\"'\"'/tmp/file name.ts'\"'\"''"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn terminal_command_file_is_a_unix_executable_without_an_extension() {
        assert_eq!(macos_terminal_command_file_path().extension(), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn editor_file_url_percent_encodes_spaces() {
        assert_eq!(
            editor_file_url(
                "vscode",
                Path::new("/Users/test/Application Support/main file.ts"),
                12,
                Some(3),
            ),
            "vscode://file//Users/test/Application%20Support/main%20file.ts:12:3"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_openers_are_deduplicated_by_final_id() {
        let first = macos_app_opener(
            "Visual Studio Code",
            PathBuf::from("/Applications/Visual Studio Code.app"),
            DesktopFileOpenerKind::Application,
        );
        let second = DesktopFileOpener {
            app_path: Some("/Users/test/Applications/Visual Studio Code.app".to_string()),
            ..first.clone()
        };
        let mut seen = HashSet::new();
        let unique: Vec<_> = [first, second]
            .into_iter()
            .filter(|opener| seen.insert(opener.id.clone()))
            .collect();

        assert_eq!(unique.len(), 1);
    }
}
