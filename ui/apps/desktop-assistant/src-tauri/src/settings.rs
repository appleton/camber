use std::{
    collections::{BTreeMap, HashSet},
    env,
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
};

use crate::app_icon::AppIconTint;
#[cfg(test)]
use crate::desktop_openers::default_file_opener;
use crate::desktop_openers::{
    cached_detected_openers_or_default, default_file_opener_id, detected_openers,
    in_app_file_opener_id, open_directory_with_opener, open_file_with_selected_opener,
    refresh_detected_openers, DesktopFileOpener, DetectedOpeners,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, Runtime, State, Url,
};

use crate::updater::DesktopUpdaterState;

const ASSISTANT_CONFIG_FILE_NAME: &str = "assistant.json";
const ASSISTANT_CONFIG_SCHEMA_URL: &str =
    "https://raw.githubusercontent.com/appleton/camber/main/schemas/assistant/v1.json";
pub const SETTINGS_CHANGED_EVENT: &str = "camber:desktop-settings-changed";
pub const OPEN_SETTINGS_PANEL_EVENT: &str = "camber:desktop-open-settings-panel";
pub const NEW_CONVERSATION_EVENT: &str = "camber:desktop-new-conversation";
pub const NEW_PROJECT_EVENT: &str = "camber:desktop-new-project";
pub const OPEN_IN_IDE_EVENT: &str = "camber:desktop-open-in-ide";
pub const DEEP_LINK_EVENT: &str = "camber:desktop-deep-link";
pub const NEW_TAB_EVENT: &str = "camber:desktop-new-tab";
pub const CLOSE_TAB_EVENT: &str = "camber:desktop-close-tab";
pub const REOPEN_CLOSED_TAB_EVENT: &str = "camber:desktop-reopen-closed-tab";
pub const OPEN_FILE_TAB_EVENT: &str = "camber:desktop-open-file-tab";
pub const SELECT_PREVIOUS_TAB_EVENT: &str = "camber:desktop-select-previous-tab";
pub const SELECT_NEXT_TAB_EVENT: &str = "camber:desktop-select-next-tab";
pub const SPLIT_RIGHT_EVENT: &str = "camber:desktop-split-right";
pub const SPLIT_DOWN_EVENT: &str = "camber:desktop-split-down";
pub const TOGGLE_LEFT_SIDEBAR_EVENT: &str = "camber:desktop-toggle-left-sidebar";
pub const TOGGLE_RIGHT_SIDEBAR_EVENT: &str = "camber:desktop-toggle-right-sidebar";
pub const TOGGLE_BOTTOM_PANEL_EVENT: &str = "camber:desktop-toggle-bottom-panel";
pub const SAVE_LAYOUT_AS_DEFAULT_EVENT: &str = "camber:desktop-save-layout-as-default";
pub const CHECK_FOR_UPDATES_EVENT: &str = "camber:desktop-check-for-updates";
pub const NAVIGATE_BACK_EVENT: &str = "camber:desktop-navigate-back";
pub const NAVIGATE_FORWARD_EVENT: &str = "camber:desktop-navigate-forward";
pub const OPEN_SETTINGS_MENU_ID: &str = "camber-open-settings";
pub const CHECK_FOR_UPDATES_MENU_ID: &str = "camber-check-for-updates";
pub const CHANGELOG_MENU_ID: &str = "camber-changelog";
pub const OPEN_HELPER_LOGS_MENU_ID: &str = "camber-open-helper-logs";
pub const SET_SYSTEM_THEME_MENU_ID: &str = "camber-set-system-theme";
pub const SET_LIGHT_THEME_MENU_ID: &str = "camber-set-light-theme";
pub const SET_DARK_THEME_MENU_ID: &str = "camber-set-dark-theme";
pub const NEW_CONVERSATION_MENU_ID: &str = "camber-new-conversation";
pub const NEW_PROJECT_MENU_ID: &str = "camber-new-project";
pub const OPEN_IN_IDE_MENU_ID: &str = "camber-open-in-ide";
pub const NEW_TAB_MENU_ID: &str = "camber-new-tab";
pub const CLOSE_TAB_MENU_ID: &str = "camber-close-tab";
pub const REOPEN_CLOSED_TAB_MENU_ID: &str = "camber-reopen-closed-tab";
pub const SELECT_PREVIOUS_TAB_MENU_ID: &str = "camber-select-previous-tab";
pub const SELECT_NEXT_TAB_MENU_ID: &str = "camber-select-next-tab";
pub const SPLIT_RIGHT_MENU_ID: &str = "camber-split-right";
pub const SPLIT_DOWN_MENU_ID: &str = "camber-split-down";
pub const TOGGLE_LEFT_SIDEBAR_MENU_ID: &str = "camber-toggle-left-sidebar";
pub const TOGGLE_RIGHT_SIDEBAR_MENU_ID: &str = "camber-toggle-right-sidebar";
pub const TOGGLE_BOTTOM_PANEL_MENU_ID: &str = "camber-toggle-bottom-panel";
pub const SAVE_LAYOUT_AS_DEFAULT_MENU_ID: &str = "camber-save-layout-as-default";
pub const NAVIGATE_BACK_MENU_ID: &str = "camber-navigate-back";
pub const NAVIGATE_FORWARD_MENU_ID: &str = "camber-navigate-forward";

const SETTINGS_FILE_NAME: &str = "settings.json";
const MAX_TEXT_FILE_BYTES: u64 = 5 * 1024 * 1024;
// Matches VS Code's binary sniff window: NUL bytes past this offset can occur
// in legitimate source files (e.g. NUL used as a string-literal separator).
const BINARY_SNIFF_BYTES: usize = 512;
const DEFAULT_CHAT_FONT_SIZE: u16 = 15;
const MIN_CHAT_FONT_SIZE: u16 = 10;
const MAX_CHAT_FONT_SIZE: u16 = 24;
const DEFAULT_CODE_FONT_FAMILY: &str = "Menlo";
const DEFAULT_CODE_FONT_SIZE: u16 = 13;
const MIN_CODE_FONT_SIZE: u16 = 8;
const MAX_CODE_FONT_SIZE: u16 = 24;
const MAX_CODE_FONT_FAMILY_LEN: usize = 200;
const DEFAULT_TERMINAL_FONT_FAMILY: &str = DEFAULT_CODE_FONT_FAMILY;
const DEFAULT_TERMINAL_FONT_SIZE: u16 = 12;
const MIN_TERMINAL_FONT_SIZE: u16 = 8;
const MAX_TERMINAL_FONT_SIZE: u16 = 24;
const MAX_TERMINAL_FONT_FAMILY_LEN: usize = 200;

const ACP_NAV_GET_FILE_OPENER_METHOD: &str = "camber/acpNav/getFileOpener";
const ACP_NAV_SET_FILE_OPENER_METHOD: &str = "camber/acpNav/setFileOpener";
static CODE_FONT_FAMILIES: OnceLock<Vec<String>> = OnceLock::new();

// Upper bound on how long a file-opener read may wait on the helper before
// falling back to the default, so the UI is never gated on helper readiness.
const FILE_OPENER_HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
// The user's preferred file opener is no longer stored here; it lives in the
// ACP database owned by camber-helper (see resolve_file_opener_id). A legacy
// `fileOpenerId` key may still exist in older settings.json files and is
// migrated on first read, then ignored.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default)]
    theme_preference: DesktopThemePreference,
    #[serde(default = "default_chat_font_size")]
    chat_font_size: u16,
    #[serde(default = "default_code_font_family")]
    code_font_family: String,
    #[serde(default = "default_code_font_size")]
    code_font_size: u16,
    #[serde(default = "default_terminal_font_family")]
    terminal_font_family: String,
    #[serde(default = "default_terminal_font_size")]
    terminal_font_size: u16,
    #[serde(default)]
    terminal_cursor_style: DesktopTerminalCursorStyle,
    #[serde(default)]
    tool_activity: DesktopToolActivity,
    #[serde(default)]
    steer_with_enter: bool,
    #[serde(default = "default_window_vibrancy")]
    window_vibrancy: bool,
    #[serde(default)]
    app_icon_tint: AppIconTint,
    #[serde(default)]
    update_channel: DesktopUpdateChannel,
    #[serde(default = "default_auto_install_updates", alias = "autoUpdateOnLoad")]
    auto_install_updates: bool,
    /// Last installed version announced by the post-update toast; None until
    /// the first launch records a baseline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_seen_changelog_version: Option<String>,
}

impl DesktopSettings {
    /// The colour the app icon is tinted with. Read at launch so the Dock shows
    /// the user's choice from the first draw (see app_icon.rs).
    pub fn app_icon_tint(&self) -> AppIconTint {
        self.app_icon_tint
    }

    /// Whether the macOS window renders the frosted vibrancy material behind
    /// the webview (see navigation.rs). Read at window creation, before any
    /// commands run.
    pub fn window_vibrancy(&self) -> bool {
        self.window_vibrancy
    }

    /// Which releases the self-updater follows. Read at update-check time to
    /// pick the eligible endpoints (see updater.rs / lib.rs).
    pub fn update_channel(&self) -> DesktopUpdateChannel {
        self.update_channel
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsResponse {
    theme_preference: DesktopThemePreference,
    chat_font_size: u16,
    code_font_family: String,
    code_font_families: Vec<String>,
    code_font_size: u16,
    terminal_font_family: String,
    terminal_font_families: Vec<String>,
    terminal_font_size: u16,
    terminal_cursor_style: DesktopTerminalCursorStyle,
    tool_activity: DesktopToolActivity,
    steer_with_enter: bool,
    window_vibrancy: bool,
    app_icon_tint: AppIconTint,
    update_channel: DesktopUpdateChannel,
    auto_install_updates: bool,
    file_opener_id: String,
    file_openers: Vec<DesktopFileOpener>,
    desktop_openers: Vec<DesktopFileOpener>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFileData {
    data: String,
    mime_type: String,
    path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTextFile {
    path: String,
    contents: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenFileTabPayload {
    path: String,
    line: Option<u32>,
    column: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFileTree {
    root_path: String,
    entries: Vec<DesktopFileTreeEntry>,
    deferred_directories: Vec<String>,
    git_status: Vec<DesktopFileTreeGitStatusEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFileTreeEntry {
    path: String,
    relative_path: String,
    kind: DesktopFileTreeEntryKind,
    git_ignored: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopFileTreeEntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFileTreeGitStatusEntry {
    path: String,
    status: DesktopFileTreeGitStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopFileTreeGitStatus {
    Added,
    Deleted,
    Ignored,
    Modified,
    Renamed,
    Untracked,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopTerminalCursorStyle {
    #[default]
    Block,
    Bar,
    Underline,
}

/// Mirrors the shared `ToolActivityMode` mode strings
/// ("detailed" | "grouped" | "compact") so the persisted value is the mode
/// itself and future modes are new variants, not a settings migration.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopToolActivity {
    Detailed,
    #[default]
    Grouped,
    Compact,
}

/// Which releases the self-updater follows. Stable is the default for everyone;
/// nightly opts into both stable and pre-release updates (see updater.rs).
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopUpdateChannel {
    #[default]
    Stable,
    Nightly,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme_preference: DesktopThemePreference::System,
            chat_font_size: DEFAULT_CHAT_FONT_SIZE,
            code_font_family: default_code_font_family(),
            code_font_size: DEFAULT_CODE_FONT_SIZE,
            terminal_font_family: default_terminal_font_family(),
            terminal_font_size: DEFAULT_TERMINAL_FONT_SIZE,
            terminal_cursor_style: DesktopTerminalCursorStyle::Block,
            tool_activity: DesktopToolActivity::Grouped,
            steer_with_enter: false,
            window_vibrancy: true,
            app_icon_tint: AppIconTint::Default,
            update_channel: DesktopUpdateChannel::Stable,
            auto_install_updates: true,
            last_seen_changelog_version: None,
        }
    }
}

/// Warms the process-wide caches get_desktop_settings needs, off the
/// first-paint path. Font enumeration shells out to fc-list/atsutil (~250ms)
/// and a missed openers cache runs full app detection (sips per app); both
/// hide behind the webview's own boot time when started right after window
/// creation, instead of stalling the first get_desktop_settings call.
pub fn warm_boot_caches(app_handle: &AppHandle) {
    let app_handle = app_handle.clone();
    std::thread::spawn(move || {
        let _ = code_font_families_for_setting("");
        crate::startup_timing::mark("native.fontCacheWarm");
        let _ = detected_openers(&app_handle);
        crate::startup_timing::mark("native.openersCacheWarm");
    });
}

#[tauri::command]
pub async fn get_desktop_settings(
    app_handle: AppHandle,
    boot: Option<bool>,
) -> Result<DesktopSettingsResponse, String> {
    crate::startup_timing::mark("native.settingsCmdBegin");
    let settings = read_settings(&app_handle)?;
    crate::startup_timing::mark("native.settingsRead");
    let file_opener_id = resolve_file_opener_id_cached(&app_handle).await;
    crate::startup_timing::mark("native.openerResolved");
    let mut response = settings_response(&app_handle, settings, file_opener_id);
    // The webview awaits the boot call before its first mount, and opener
    // icons dominate its size (transport through the isolation layer costs
    // real time per KB). Only that call may go without icons: the openers
    // refresh right after mount re-emits the full set, and the UI shows a
    // generic glyph until then. Every other caller (preferences panel, open
    // target controls mounting later) needs the icons.
    if boot == Some(true) {
        strip_opener_icons(&mut response);
    }
    crate::startup_timing::mark("native.settingsCmdEnd");
    Ok(response)
}

fn strip_opener_icons(response: &mut DesktopSettingsResponse) {
    for opener in response
        .file_openers
        .iter_mut()
        .chain(response.desktop_openers.iter_mut())
    {
        opener.clear_icon();
    }
}

#[tauri::command]
pub fn refresh_desktop_openers_cache(app_handle: AppHandle) {
    refresh_openers_cache_on_load(app_handle);
}

pub fn refresh_openers_cache_on_load(app_handle: AppHandle) {
    std::thread::spawn(move || {
        let openers = match refresh_detected_openers(&app_handle) {
            Ok(openers) => openers,
            Err(err) => {
                eprintln!("failed to refresh desktop openers cache: {err}");
                return;
            }
        };
        let settings = match read_settings(&app_handle) {
            Ok(settings) => settings,
            Err(err) => {
                eprintln!("failed to read desktop settings after opener refresh: {err}");
                return;
            }
        };
        let file_opener_id = tauri::async_runtime::block_on(resolve_file_opener_id(&app_handle));
        let response = settings_response_with_openers(settings, file_opener_id, openers);
        if let Err(err) = app_handle.emit(SETTINGS_CHANGED_EVENT, response) {
            eprintln!("failed to emit refreshed desktop openers: {err}");
        }
    });
}

#[tauri::command]
pub async fn set_desktop_theme_preference(
    app_handle: AppHandle,
    theme_preference: DesktopThemePreference,
) -> Result<DesktopSettingsResponse, String> {
    persist_desktop_theme_preference(&app_handle, theme_preference).await
}

#[tauri::command]
pub async fn set_desktop_chat_preferences(
    app_handle: AppHandle,
    chat_font_size: u16,
) -> Result<DesktopSettingsResponse, String> {
    let settings = set_chat_preferences(read_settings(&app_handle)?, chat_font_size)?;
    write_and_emit_settings(&app_handle, settings).await
}

#[tauri::command]
pub async fn set_desktop_code_preferences(
    app_handle: AppHandle,
    code_font_family: String,
    code_font_size: u16,
) -> Result<DesktopSettingsResponse, String> {
    let settings = set_code_preferences(
        read_settings(&app_handle)?,
        &code_font_family,
        code_font_size,
    )?;
    write_and_emit_settings(&app_handle, settings).await
}

#[tauri::command]
pub async fn set_desktop_terminal_preferences(
    app_handle: AppHandle,
    terminal_font_family: String,
    terminal_font_size: u16,
    terminal_cursor_style: DesktopTerminalCursorStyle,
) -> Result<DesktopSettingsResponse, String> {
    let settings = set_terminal_preferences(
        read_settings(&app_handle)?,
        &terminal_font_family,
        terminal_font_size,
        terminal_cursor_style,
    )?;
    write_and_emit_settings(&app_handle, settings).await
}

#[tauri::command]
pub async fn set_desktop_tool_activity(
    app_handle: AppHandle,
    tool_activity: DesktopToolActivity,
) -> Result<DesktopSettingsResponse, String> {
    let settings = set_tool_activity(read_settings(&app_handle)?, tool_activity);
    write_and_emit_settings(&app_handle, settings).await
}

#[tauri::command]
pub async fn set_desktop_steer_with_enter(
    app_handle: AppHandle,
    steer_with_enter: bool,
) -> Result<DesktopSettingsResponse, String> {
    let settings = set_steer_with_enter(read_settings(&app_handle)?, steer_with_enter);
    write_and_emit_settings(&app_handle, settings).await
}

#[tauri::command]
pub async fn set_desktop_window_vibrancy(
    app_handle: AppHandle,
    window_vibrancy: bool,
) -> Result<DesktopSettingsResponse, String> {
    let settings = set_window_vibrancy(read_settings(&app_handle)?, window_vibrancy);
    let response = write_and_emit_settings(&app_handle, settings).await?;
    crate::navigation::apply_window_vibrancy(&app_handle, window_vibrancy);
    Ok(response)
}

#[tauri::command]
pub async fn set_desktop_app_icon_tint(
    app_handle: AppHandle,
    app_icon_tint: AppIconTint,
) -> Result<DesktopSettingsResponse, String> {
    let settings = set_app_icon_tint(read_settings(&app_handle)?, app_icon_tint);
    let response = write_and_emit_settings(&app_handle, settings).await?;
    crate::app_icon::apply(&app_handle, app_icon_tint);
    Ok(response)
}

#[tauri::command]
pub async fn set_desktop_update_channel(
    app_handle: AppHandle,
    updater_state: State<'_, DesktopUpdaterState>,
    update_channel: DesktopUpdateChannel,
) -> Result<DesktopSettingsResponse, String> {
    // Serialize the preference write with checks/downloads. If an operation
    // stages an update first, changing the feed would make the persisted
    // channel disagree with the build that will launch after restart.
    let _operation = updater_state.operation.lock().await;
    updater_state.ensure_no_pending_update()?;
    let settings = set_update_channel(read_settings(&app_handle)?, update_channel);
    write_and_emit_settings(&app_handle, settings).await
}

#[tauri::command]
pub async fn set_desktop_auto_install_updates(
    app_handle: AppHandle,
    auto_install_updates: bool,
) -> Result<DesktopSettingsResponse, String> {
    let mut settings = read_settings(&app_handle)?;
    settings.auto_install_updates = auto_install_updates;
    write_and_emit_settings(&app_handle, settings).await
}

fn default_auto_install_updates() -> bool {
    true
}

#[tauri::command]
pub async fn set_desktop_file_opener(
    app_handle: AppHandle,
    file_opener_id: String,
) -> Result<DesktopSettingsResponse, String> {
    let openers = detected_openers(&app_handle);
    let normalized = validate_file_opener_id(&file_opener_id, &openers.file_openers)?;
    persist_file_opener_in_db(&app_handle, &normalized).await?;
    write_cached_file_opener_id(&app_handle, &normalized);
    let settings = read_settings(&app_handle)?;
    let response = settings_response(&app_handle, settings, normalized);
    app_handle
        .emit(SETTINGS_CHANGED_EVENT, response.clone())
        .map_err(|err| err.to_string())?;
    Ok(response)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn check_file_exists(path: String) -> bool {
    validate_file_path(&path)
        .ok()
        .and_then(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let path = validate_file_path(&path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, contents).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn open_file(
    app_handle: AppHandle,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    match validate_existing_open_path(&path)? {
        ExistingOpenPath::File(path) => {
            let resolved_file_opener_id = resolve_file_opener_id_cached(&app_handle).await;
            let file_opener_id = if resolved_file_opener_id == in_app_file_opener_id() {
                resolved_file_opener_id
            } else if should_open_with_default_app(&path) {
                default_file_opener_id()
            } else {
                resolved_file_opener_id
            };
            open_file_path_with_opener(&app_handle, &file_opener_id, &path, line, column)
        }
        ExistingOpenPath::Directory(path) => {
            open_directory_with_opener(&app_handle, &default_file_opener_id(), &path)
        }
    }
}

#[tauri::command]
pub fn open_assistant_config_with_opener(
    app_handle: AppHandle,
    opener_id: String,
) -> Result<(), String> {
    let path = assistant_config_path()?;
    ensure_assistant_config_file(&path)?;
    let opener_id = if opener_id == in_app_file_opener_id() {
        default_file_opener_id()
    } else {
        opener_id
    };
    open_file_path_with_opener(&app_handle, &opener_id, &path, None, None)
}

#[tauri::command]
pub fn open_path_with_opener(
    app_handle: AppHandle,
    path: String,
    opener_id: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    match validate_existing_open_path(&path)? {
        ExistingOpenPath::File(path) => {
            open_file_path_with_opener(&app_handle, &opener_id, &path, line, column)
        }
        ExistingOpenPath::Directory(path) => {
            let opener_id = if opener_id == in_app_file_opener_id() {
                default_file_opener_id()
            } else {
                opener_id
            };
            open_directory_with_opener(&app_handle, &opener_id, &path)
        }
    }
}

fn assistant_config_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("CAMBER_ASSISTANT_CONFIG_PATH") {
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    let config_home = default_config_home()?;
    Ok(config_home
        .join("poolside")
        .join(ASSISTANT_CONFIG_FILE_NAME))
}

fn default_config_home() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("XDG_CONFIG_HOME") {
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    // Must resolve the same file as the helper's userconfig.Directory(),
    // which uses Go's os.UserHomeDir and HOME on macOS.
    if let Ok(path) = env::var("HOME") {
        if !path.is_empty() {
            return Ok(PathBuf::from(path).join(".config"));
        }
    }
    Err("Unable to resolve config directory".to_string())
}

fn ensure_assistant_config_file(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            let config = format!(
                "{{\n  \"$schema\": \"{ASSISTANT_CONFIG_SCHEMA_URL}\",\n  \"agent_servers\": {{}}\n}}\n"
            );
            file.write_all(config.as_bytes()).map_err(|err| {
                // Drop the partially written file so a later attempt does not
                // treat it as an already initialized config.
                drop(file);
                let _ = fs::remove_file(path);
                err.to_string()
            })
        }
        Err(err) if err.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

fn open_file_path_with_opener(
    app_handle: &AppHandle,
    opener_id: &str,
    path: &Path,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    if opener_id == in_app_file_opener_id() {
        app_handle
            .emit(
                OPEN_FILE_TAB_EVENT,
                DesktopOpenFileTabPayload {
                    path: path.to_string_lossy().to_string(),
                    line,
                    column,
                },
            )
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    open_file_with_selected_opener(app_handle, opener_id, path, line, column)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<DesktopTextFile, String> {
    let file_path = validate_existing_file_path(&path)?;
    let metadata = fs::metadata(&file_path).map_err(|err| err.to_string())?;
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "File is too large to open in Camber (max {} MiB).",
            MAX_TEXT_FILE_BYTES / 1024 / 1024
        ));
    }

    let bytes = fs::read(&file_path).map_err(|err| err.to_string())?;
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Err("Binary files cannot be opened in Camber.".to_string());
    }

    let contents = String::from_utf8(bytes)
        .map_err(|_| "Only UTF-8 text files can be opened in Camber.".to_string())?;

    Ok(DesktopTextFile { path, contents })
}

#[tauri::command]
pub fn list_directory_tree(
    path: String,
    include_git_ignored: Option<bool>,
) -> Result<DesktopFileTree, String> {
    let root = validate_existing_directory_path(&path)?;
    build_desktop_file_tree(&root, include_git_ignored.unwrap_or(false))
}

#[tauri::command]
pub fn list_directory_subtree(
    root_path: String,
    relative_path: String,
    include_git_ignored: Option<bool>,
) -> Result<DesktopFileTree, String> {
    let root = validate_existing_directory_path(&root_path)?;
    let relative = validate_desktop_file_tree_relative_directory_path(&relative_path)?;
    validate_desktop_file_tree_subtree_directory(&root, &relative)?;
    build_desktop_file_tree_from(&root, &relative, include_git_ignored.unwrap_or(false))
}

#[tauri::command]
pub fn get_image_file_data(path: String) -> Result<Option<ImageFileData>, String> {
    let mime_type = match image_mime_type(&path) {
        Some(mime_type) => mime_type,
        None => return Ok(None),
    };
    let file_path = validate_existing_file_path(&path)?;
    let bytes = fs::read(&file_path).map_err(|err| err.to_string())?;

    Ok(Some(ImageFileData {
        data: STANDARD.encode(bytes),
        mime_type: mime_type.to_string(),
        path,
    }))
}

pub fn build_menu<R: Runtime>(app_handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    crate::startup_timing::mark("native.menuBuildBegin");
    let menu = Menu::default(app_handle)?;

    remove_default_close_window_items(&menu)?;
    append_desktop_tab_menu_items(app_handle, &ensure_window_menu(app_handle, &menu)?)?;

    let view_menu = ensure_view_menu(app_handle, &menu)?;
    prepend_navigation_menu_items(app_handle, &view_menu)?;
    append_appearance_menu_items(app_handle, &view_menu)?;

    let helper_logs = MenuItem::with_id(
        app_handle,
        OPEN_HELPER_LOGS_MENU_ID,
        "Camber Helper Logs",
        true,
        None::<&str>,
    )?;
    view_menu.append(&PredefinedMenuItem::separator(app_handle)?)?;
    view_menu.append(&helper_logs)?;

    insert_file_menu(app_handle, &menu)?;
    insert_edit_menu(app_handle, &menu)?;

    #[cfg(target_os = "macos")]
    {
        if let Some(app_menu) = menu
            .items()?
            .into_iter()
            .next()
            .and_then(|item| item.as_submenu().cloned())
        {
            // Standard macOS placement: "Check for Updates…" directly under the
            // native "About" item (index 0), then "Changelog", then
            // "Preferences…". Indices below build the app menu top-down:
            // About(0), Check for Updates(1), Changelog(2), sep(3),
            // Preferences(4), sep(5), then the platform's Services/Hide/Quit.
            let check_for_updates = MenuItem::with_id(
                app_handle,
                CHECK_FOR_UPDATES_MENU_ID,
                "Check for Updates…",
                true,
                None::<&str>,
            )?;
            let changelog = MenuItem::with_id(
                app_handle,
                CHANGELOG_MENU_ID,
                "Changelog",
                true,
                None::<&str>,
            )?;
            let preferences = MenuItem::with_id(
                app_handle,
                OPEN_SETTINGS_MENU_ID,
                "Preferences...",
                true,
                Some("Cmd+,"),
            )?;
            app_menu.insert(&check_for_updates, 1)?;
            app_menu.insert(&changelog, 2)?;
            app_menu.insert(&PredefinedMenuItem::separator(app_handle)?, 3)?;
            app_menu.insert(&preferences, 4)?;
            app_menu.insert(&PredefinedMenuItem::separator(app_handle)?, 5)?;
        }
    }

    crate::startup_timing::mark("native.menuBuildEnd");
    Ok(menu)
}

/// Puts Back and Forward first in View, ahead of appearance and diagnostics.
fn prepend_navigation_menu_items<R: Runtime>(
    app_handle: &AppHandle<R>,
    view_menu: &Submenu<R>,
) -> tauri::Result<()> {
    let back = MenuItem::with_id(
        app_handle,
        NAVIGATE_BACK_MENU_ID,
        "Back",
        false,
        Some("Cmd+["),
    )?;
    let forward = MenuItem::with_id(
        app_handle,
        NAVIGATE_FORWARD_MENU_ID,
        "Forward",
        false,
        Some("Cmd+]"),
    )?;
    view_menu.insert(&back, 0)?;
    view_menu.insert(&forward, 1)?;
    view_menu.insert(&PredefinedMenuItem::separator(app_handle)?, 2)?;
    Ok(())
}

#[tauri::command]
pub fn set_navigation_menu_enabled(
    app_handle: AppHandle,
    back_enabled: bool,
    forward_enabled: bool,
) -> Result<(), String> {
    let Some(menu) = app_handle.menu() else {
        return Ok(());
    };

    for (id, enabled) in [
        (NAVIGATE_BACK_MENU_ID, back_enabled),
        (NAVIGATE_FORWARD_MENU_ID, forward_enabled),
    ] {
        if let Some(item) = menu_item_by_id(&menu, id) {
            item.set_enabled(enabled).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

/// Inserts a File menu (after the app menu, before Edit/View) containing the
/// main webview commands that are also reachable via keyboard shortcuts.
fn insert_file_menu<R: Runtime>(app_handle: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    let new_conversation = MenuItem::with_id(
        app_handle,
        NEW_CONVERSATION_MENU_ID,
        "New Conversation",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let new_project = MenuItem::with_id(
        app_handle,
        NEW_PROJECT_MENU_ID,
        "New Project…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let open_in_ide = MenuItem::with_id(
        app_handle,
        OPEN_IN_IDE_MENU_ID,
        "Open in IDE",
        true,
        Some("CmdOrCtrl+Shift+I"),
    )?;

    // On macOS the default File menu is removed once its Close Window item is
    // stripped, but reuse it if a platform leaves it in place.
    if let Some(file_menu) = submenu_by_text(menu, "File")? {
        file_menu.insert(&new_conversation, 0)?;
        file_menu.insert(&new_project, 1)?;
        file_menu.insert(&PredefinedMenuItem::separator(app_handle)?, 2)?;
        file_menu.insert(&open_in_ide, 3)?;
        return Ok(());
    }

    let file_menu = Submenu::with_items(
        app_handle,
        "File",
        true,
        &[
            &new_conversation,
            &new_project,
            &PredefinedMenuItem::separator(app_handle)?,
            &open_in_ide,
        ],
    )?;

    // Insert after the app menu (index 0) and before whatever is at index 1.
    menu.insert(&file_menu, 1)?;
    Ok(())
}

/// Ensures a standard Edit menu (after File, before View) containing the
/// predefined text-editing commands. On macOS `Menu::default` already provides
/// a complete Edit menu, so this only creates one when it is missing.
fn insert_edit_menu<R: Runtime>(app_handle: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    if submenu_by_text(menu, "Edit")?.is_some() {
        return Ok(());
    }

    let edit_menu = Submenu::with_items(
        app_handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app_handle, None)?,
            &PredefinedMenuItem::redo(app_handle, None)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::cut(app_handle, None)?,
            &PredefinedMenuItem::copy(app_handle, None)?,
            &PredefinedMenuItem::paste(app_handle, None)?,
            &PredefinedMenuItem::select_all(app_handle, None)?,
        ],
    )?;

    // File is at index 1 after insert_file_menu; Edit goes right after it at 2.
    let insert_at = menu
        .items()?
        .iter()
        .position(|item| {
            item.as_submenu()
                .and_then(|submenu| submenu.text().ok())
                .is_some_and(|text| text == "File")
        })
        .map(|file_idx| file_idx + 1)
        .unwrap_or(2);
    menu.insert(&edit_menu, insert_at)?;
    Ok(())
}

pub fn theme_preference_for_menu_id(menu_id: &str) -> Option<DesktopThemePreference> {
    match menu_id {
        SET_SYSTEM_THEME_MENU_ID => Some(DesktopThemePreference::System),
        SET_LIGHT_THEME_MENU_ID => Some(DesktopThemePreference::Light),
        SET_DARK_THEME_MENU_ID => Some(DesktopThemePreference::Dark),
        _ => None,
    }
}

pub fn set_desktop_theme_preference_from_menu(
    app_handle: AppHandle,
    theme_preference: DesktopThemePreference,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = persist_desktop_theme_preference(&app_handle, theme_preference).await {
            eprintln!("failed to update desktop theme preference from menu: {err}");
        }
    });
}

async fn persist_desktop_theme_preference(
    app_handle: &AppHandle,
    theme_preference: DesktopThemePreference,
) -> Result<DesktopSettingsResponse, String> {
    let settings = set_theme_preference(read_settings(app_handle)?, theme_preference);
    write_and_emit_settings(app_handle, settings).await
}

fn append_appearance_menu_items<R: Runtime>(
    app_handle: &AppHandle<R>,
    view_menu: &Submenu<R>,
) -> tauri::Result<()> {
    let system = CheckMenuItem::with_id(
        app_handle,
        SET_SYSTEM_THEME_MENU_ID,
        "System",
        true,
        true,
        None::<&str>,
    )?;
    let theme_separator = PredefinedMenuItem::separator(app_handle)?;
    let light = CheckMenuItem::with_id(
        app_handle,
        SET_LIGHT_THEME_MENU_ID,
        "Light",
        true,
        false,
        Some("Cmd+Shift+K"),
    )?;
    let dark = CheckMenuItem::with_id(
        app_handle,
        SET_DARK_THEME_MENU_ID,
        "Dark",
        true,
        false,
        Some("Cmd+Shift+L"),
    )?;
    let appearance = Submenu::with_items(
        app_handle,
        "Appearance",
        true,
        &[&system, &theme_separator, &light, &dark],
    )?;

    append_separator_if_needed(app_handle, view_menu)?;
    view_menu.append(&appearance)?;

    Ok(())
}

fn append_desktop_tab_menu_items<R: Runtime>(
    app_handle: &AppHandle<R>,
    window_menu: &Submenu<R>,
) -> tauri::Result<()> {
    let new_tab = MenuItem::with_id(app_handle, NEW_TAB_MENU_ID, "New Tab", true, Some("Cmd+T"))?;
    let close_tab = MenuItem::with_id(
        app_handle,
        CLOSE_TAB_MENU_ID,
        "Close Tab",
        true,
        Some("Cmd+W"),
    )?;
    let reopen_closed_tab = MenuItem::with_id(
        app_handle,
        REOPEN_CLOSED_TAB_MENU_ID,
        "Reopen Closed Tab",
        true,
        Some("Cmd+Shift+T"),
    )?;
    let split_right = MenuItem::with_id(
        app_handle,
        SPLIT_RIGHT_MENU_ID,
        "Split Right",
        true,
        Some("Cmd+D"),
    )?;
    let split_down = MenuItem::with_id(
        app_handle,
        SPLIT_DOWN_MENU_ID,
        "Split Down",
        true,
        Some("Cmd+Shift+D"),
    )?;
    let toggle_left_sidebar = MenuItem::with_id(
        app_handle,
        TOGGLE_LEFT_SIDEBAR_MENU_ID,
        "Toggle sidebar",
        true,
        Some("Cmd+B"),
    )?;
    let toggle_right_sidebar = MenuItem::with_id(
        app_handle,
        TOGGLE_RIGHT_SIDEBAR_MENU_ID,
        "Toggle secondary sidebar",
        true,
        Some("Cmd+Alt+B"),
    )?;
    let toggle_bottom_panel = MenuItem::with_id(
        app_handle,
        TOGGLE_BOTTOM_PANEL_MENU_ID,
        "Toggle panel",
        true,
        Some("Cmd+J"),
    )?;
    let select_previous_tab = MenuItem::with_id(
        app_handle,
        SELECT_PREVIOUS_TAB_MENU_ID,
        "Select Previous Tab",
        true,
        Some("Cmd+Shift+["),
    )?;
    let select_next_tab = MenuItem::with_id(
        app_handle,
        SELECT_NEXT_TAB_MENU_ID,
        "Select Next Tab",
        true,
        Some("Cmd+Shift+]"),
    )?;
    let save_layout_as_default = MenuItem::with_id(
        app_handle,
        SAVE_LAYOUT_AS_DEFAULT_MENU_ID,
        "Save Layout as Default",
        true,
        None::<&str>,
    )?;

    append_separator_if_needed(app_handle, window_menu)?;
    window_menu.append(&new_tab)?;
    window_menu.append(&close_tab)?;
    window_menu.append(&reopen_closed_tab)?;
    window_menu.append(&PredefinedMenuItem::separator(app_handle)?)?;
    window_menu.append(&split_right)?;
    window_menu.append(&split_down)?;
    window_menu.append(&PredefinedMenuItem::separator(app_handle)?)?;
    window_menu.append(&toggle_left_sidebar)?;
    window_menu.append(&toggle_right_sidebar)?;
    window_menu.append(&toggle_bottom_panel)?;
    window_menu.append(&PredefinedMenuItem::separator(app_handle)?)?;
    window_menu.append(&select_previous_tab)?;
    window_menu.append(&select_next_tab)?;
    window_menu.append(&PredefinedMenuItem::separator(app_handle)?)?;
    window_menu.append(&save_layout_as_default)?;

    Ok(())
}

fn ensure_window_menu<R: Runtime>(
    app_handle: &AppHandle<R>,
    menu: &Menu<R>,
) -> tauri::Result<Submenu<R>> {
    if let Some(window_menu) = submenu_by_text(menu, "Window")? {
        return Ok(window_menu);
    }

    let window_menu = Submenu::with_items(app_handle, "Window", true, &[])?;
    let insert_at = menu
        .items()?
        .iter()
        .position(|item| {
            item.as_submenu()
                .and_then(|submenu| submenu.text().ok())
                .is_some_and(|text| text == "Help")
        })
        .unwrap_or_else(|| menu.items().map(|items| items.len()).unwrap_or(0));
    menu.insert(&window_menu, insert_at)?;

    Ok(window_menu)
}

fn ensure_view_menu<R: Runtime>(
    app_handle: &AppHandle<R>,
    menu: &Menu<R>,
) -> tauri::Result<Submenu<R>> {
    if let Some(view_menu) = submenu_by_text(menu, "View")? {
        return Ok(view_menu);
    }

    let view_menu = Submenu::with_items(app_handle, "View", true, &[])?;
    let insert_at = menu
        .items()?
        .iter()
        .position(|item| {
            item.as_submenu()
                .and_then(|submenu| submenu.text().ok())
                .is_some_and(|text| text == "Window")
        })
        .unwrap_or_else(|| menu.items().map(|items| items.len()).unwrap_or(0));
    menu.insert(&view_menu, insert_at)?;

    Ok(view_menu)
}

fn remove_default_close_window_items<R: Runtime>(menu: &Menu<R>) -> tauri::Result<()> {
    if let Some(file_menu) = submenu_by_text(menu, "File")? {
        remove_predefined_close_window_items(&file_menu)?;
        if file_menu.items()?.is_empty() {
            menu.remove(&file_menu)?;
        }
    }

    if let Some(window_menu) = submenu_by_text(menu, "Window")? {
        remove_predefined_close_window_items(&window_menu)?;
    }

    Ok(())
}

fn remove_predefined_close_window_items<R: Runtime>(submenu: &Submenu<R>) -> tauri::Result<()> {
    for item in submenu.items()? {
        if let Some(predefined) = item.as_predefined_menuitem() {
            let normalized_text = predefined.text()?.replace('&', "");
            if matches!(normalized_text.as_str(), "Close" | "Close Window") {
                submenu.remove(predefined)?;
            }
        }
    }
    Ok(())
}

fn append_separator_if_needed<R: Runtime>(
    app_handle: &AppHandle<R>,
    submenu: &Submenu<R>,
) -> tauri::Result<()> {
    let items = submenu.items()?;
    if items.is_empty() {
        return Ok(());
    }

    let has_trailing_separator = items
        .last()
        .and_then(|item| item.as_predefined_menuitem())
        .map(|item| item.text().map(|text| text.is_empty()))
        .transpose()?
        .unwrap_or(false);

    if !has_trailing_separator {
        submenu.append(&PredefinedMenuItem::separator(app_handle)?)?;
    }

    Ok(())
}

fn submenu_by_text<R: Runtime>(menu: &Menu<R>, text: &str) -> tauri::Result<Option<Submenu<R>>> {
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            if submenu.text()? == text {
                return Ok(Some(submenu.clone()));
            }
        }
    }
    Ok(None)
}

fn settings_path<R: Runtime>(app_handle: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app_handle
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?
        .join(SETTINGS_FILE_NAME))
}

pub fn read_settings<R: Runtime>(app_handle: &AppHandle<R>) -> Result<DesktopSettings, String> {
    let path = settings_path(app_handle)?;
    match fs::read_to_string(path) {
        Ok(contents) => Ok(settings_with_inferred_update_channel(
            &contents,
            &app_handle.package_info().version.to_string(),
        )),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(default_settings_for_version(
            &app_handle.package_info().version.to_string(),
        )),
        Err(err) => Err(err.to_string()),
    }
}

fn settings_with_inferred_update_channel(
    contents: &str,
    installed_version: &str,
) -> DesktopSettings {
    let has_persisted_channel = serde_json::from_str::<serde_json::Value>(contents)
        .ok()
        .and_then(|value| {
            value
                .as_object()
                .map(|object| object.contains_key("updateChannel"))
        })
        .unwrap_or(false);
    let mut settings: DesktopSettings = serde_json::from_str(contents).unwrap_or_default();
    if !has_persisted_channel {
        settings.update_channel = update_channel_for_version(installed_version);
    }
    normalize_persisted_font_families(settings)
}

fn default_settings_for_version(installed_version: &str) -> DesktopSettings {
    DesktopSettings {
        update_channel: update_channel_for_version(installed_version),
        ..DesktopSettings::default()
    }
}

fn update_channel_for_version(installed_version: &str) -> DesktopUpdateChannel {
    Version::parse(installed_version)
        .ok()
        .filter(|version| version.pre.is_empty() && version.build.is_empty())
        .map_or(DesktopUpdateChannel::Stable, |version| {
            if version.minor % 2 == 0 {
                DesktopUpdateChannel::Stable
            } else {
                DesktopUpdateChannel::Nightly
            }
        })
}

fn normalize_persisted_font_families(mut settings: DesktopSettings) -> DesktopSettings {
    settings.code_font_family = normalize_font_family_setting(&settings.code_font_family);
    settings.terminal_font_family = normalize_font_family_setting(&settings.terminal_font_family);
    settings
}

fn write_settings(app_handle: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    let path = settings_path(app_handle)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let contents = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    fs::write(path, contents).map_err(|err| err.to_string())
}

/// serde name of DesktopSettings::last_seen_changelog_version, used for the
/// key-level rewrite below (a test pins the two together).
const LAST_SEEN_CHANGELOG_VERSION_KEY: &str = "lastSeenChangelogVersion";

/// One-shot post-update announcement: returns the running version exactly once
/// after it changes from the last announced one, persisting the new baseline
/// immediately so a dismissed or missed toast never repeats. A first launch
/// (no recorded baseline) records silently, and unstamped local builds never
/// announce. Nightly updates are deliberately announced too.
///
/// Rewrites only its own settings.json key rather than serializing the full
/// DesktopSettings: a full write on every launch would persist values that are
/// inferred at read time — the update channel — as explicit choices, breaking
/// the version-parity inference for later manual channel switches.
#[tauri::command]
pub fn take_pending_update_announcement(app_handle: AppHandle) -> Result<Option<String>, String> {
    let current = app_handle.package_info().version.to_string();
    if current == "0.0.0" {
        return Ok(None);
    }
    let path = settings_path(&app_handle)?;
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => Some(contents),
        Err(err) if err.kind() == ErrorKind::NotFound => None,
        Err(err) => return Err(err.to_string()),
    };
    let (announce, updated) = take_pending_update_announcement_from(contents.as_deref(), &current);
    if let Some(updated) = updated {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::write(&path, updated).map_err(|err| err.to_string())?;
    }
    Ok(announce)
}

/// Pure core of take_pending_update_announcement: (version to announce,
/// rewritten settings.json contents if the baseline moved). Unreadable JSON is
/// treated as empty, matching read_settings' recovery with defaults.
fn take_pending_update_announcement_from(
    contents: Option<&str>,
    current_version: &str,
) -> (Option<String>, Option<String>) {
    let mut raw = contents
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(contents).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let previous = raw
        .get(LAST_SEEN_CHANGELOG_VERSION_KEY)
        .and_then(|value| value.as_str())
        .map(str::to_string);
    if previous.as_deref() == Some(current_version) {
        return (None, None);
    }
    raw.insert(
        LAST_SEEN_CHANGELOG_VERSION_KEY.to_string(),
        serde_json::Value::String(current_version.to_string()),
    );
    let updated = serde_json::to_string_pretty(&serde_json::Value::Object(raw))
        .expect("string-keyed JSON object serialization cannot fail");
    (previous.map(|_| current_version.to_string()), Some(updated))
}

pub(crate) fn persist_update_channel(
    app_handle: &AppHandle,
    update_channel: DesktopUpdateChannel,
) -> Result<(), String> {
    let settings = set_update_channel(read_settings(app_handle)?, update_channel);
    write_settings(app_handle, &settings)
}

async fn write_and_emit_settings(
    app_handle: &AppHandle,
    settings: DesktopSettings,
) -> Result<DesktopSettingsResponse, String> {
    write_settings(app_handle, &settings)?;
    sync_theme_menu_items(app_handle, settings.theme_preference);
    let file_opener_id = resolve_file_opener_id(app_handle).await;
    let response = settings_response(app_handle, settings, file_opener_id);
    app_handle
        .emit(SETTINGS_CHANGED_EVENT, response.clone())
        .map_err(|err| err.to_string())?;
    Ok(response)
}

/// Restore the saved icon tint at launch. Called from both `setup` and
/// `RunEvent::Ready` (like the camberqa dock icon) so it survives the
/// platform's own icon setup during launch.
pub fn apply_app_icon_tint_from_settings(app_handle: &AppHandle) {
    match read_settings(app_handle) {
        Ok(settings) => crate::app_icon::apply(app_handle, settings.app_icon_tint()),
        Err(err) => eprintln!("failed to read desktop app icon tint: {err}"),
    }
}

pub fn sync_theme_menu_items_from_settings(app_handle: &AppHandle) {
    match read_settings(app_handle) {
        Ok(settings) => sync_theme_menu_items(app_handle, settings.theme_preference),
        Err(err) => eprintln!("failed to sync desktop theme menu items: {err}"),
    }
}

fn sync_theme_menu_items(app_handle: &AppHandle, theme_preference: DesktopThemePreference) {
    let Some(menu) = app_handle.menu() else {
        return;
    };

    for (id, checked) in [
        (
            SET_SYSTEM_THEME_MENU_ID,
            theme_preference == DesktopThemePreference::System,
        ),
        (
            SET_LIGHT_THEME_MENU_ID,
            theme_preference == DesktopThemePreference::Light,
        ),
        (
            SET_DARK_THEME_MENU_ID,
            theme_preference == DesktopThemePreference::Dark,
        ),
    ] {
        if let Some(item) = check_menu_item_by_id(&menu, id) {
            if let Err(err) = item.set_checked(checked) {
                eprintln!("failed to update theme menu item {id}: {err}");
            }
        }
    }
}

fn check_menu_item_by_id<R: Runtime>(menu: &Menu<R>, id: &str) -> Option<CheckMenuItem<R>> {
    check_menu_item_by_id_in_items(menu.items().ok()?, id)
}

fn menu_item_by_id<R: Runtime>(menu: &Menu<R>, id: &str) -> Option<MenuItem<R>> {
    menu_item_by_id_in_items(menu.items().ok()?, id)
}

fn menu_item_by_id_in_submenu<R: Runtime>(submenu: &Submenu<R>, id: &str) -> Option<MenuItem<R>> {
    menu_item_by_id_in_items(submenu.items().ok()?, id)
}

fn menu_item_by_id_in_items<R: Runtime>(
    items: Vec<MenuItemKind<R>>,
    id: &str,
) -> Option<MenuItem<R>> {
    for item in items {
        if item.id() == &id {
            return item.as_menuitem().cloned();
        }
        if let Some(submenu) = item.as_submenu() {
            if let Some(menu_item) = menu_item_by_id_in_submenu(submenu, id) {
                return Some(menu_item);
            }
        }
    }
    None
}

fn check_menu_item_by_id_in_submenu<R: Runtime>(
    submenu: &Submenu<R>,
    id: &str,
) -> Option<CheckMenuItem<R>> {
    check_menu_item_by_id_in_items(submenu.items().ok()?, id)
}

fn check_menu_item_by_id_in_items<R: Runtime>(
    items: Vec<MenuItemKind<R>>,
    id: &str,
) -> Option<CheckMenuItem<R>> {
    for item in items {
        if item.id() == &id {
            return item.as_check_menuitem().cloned();
        }
        if let Some(submenu) = item.as_submenu() {
            if let Some(check_item) = check_menu_item_by_id_in_submenu(submenu, id) {
                return Some(check_item);
            }
        }
    }
    None
}

/// Reads the persisted file opener from the helper's ACP database, distinguishing
/// three outcomes:
/// - `Ok(Some(id))` — a value is stored,
/// - `Ok(None)` — the DB is reachable but has no stored value,
/// - `Err(())` — the read failed or timed out.
///
/// The caller must not treat a read error as "no value": doing so would let a
/// transient timeout trigger the legacy migration and overwrite an existing DB
/// choice with the stale settings.json value.
///
/// The helper round-trip is time-bounded so it never blocks the UI indefinitely:
/// `get_desktop_settings` is awaited during webview bootstrap and `open_file`
/// runs on every file open, and `helper_when_ready` would otherwise wait forever
/// for a slow-to-start or hung helper.
async fn file_opener_from_db(app_handle: &AppHandle) -> Result<Option<String>, ()> {
    let request = crate::helper::send_helper_request(
        app_handle,
        ACP_NAV_GET_FILE_OPENER_METHOD,
        serde_json::json!({}),
    );
    match tokio::time::timeout(FILE_OPENER_HELPER_TIMEOUT, request).await {
        Ok(Ok(value)) => {
            let id = value
                .get("fileOpener")
                .and_then(|opener| opener.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            Ok((!id.is_empty()).then_some(id))
        }
        Ok(Err(err)) => {
            eprintln!("failed to read file opener from helper: {err}");
            Err(())
        }
        Err(_) => {
            eprintln!("timed out reading file opener from helper");
            Err(())
        }
    }
}

/// Persists the file opener id in the helper's ACP database. Time-bounded for
/// the same reason as the read: this also runs on the bootstrap path via the
/// legacy migration in resolve_file_opener_id, so an unbounded write would
/// reintroduce the indefinite stall the read timeout prevents.
async fn persist_file_opener_in_db(
    app_handle: &AppHandle,
    file_opener_id: &str,
) -> Result<(), String> {
    let request = crate::helper::send_helper_request(
        app_handle,
        ACP_NAV_SET_FILE_OPENER_METHOD,
        serde_json::json!({ "fileOpener": file_opener_id }),
    );
    match tokio::time::timeout(FILE_OPENER_HELPER_TIMEOUT, request).await {
        Ok(result) => result.map(|_| ()).map_err(|err| err.to_string()),
        Err(_) => Err("timed out writing file opener to helper".to_string()),
    }
}

/// Reads a legacy `fileOpenerId` value straight from settings.json so a one-time
/// migration can move it into the ACP database.
fn legacy_file_opener_id(app_handle: &AppHandle) -> Option<String> {
    let path = settings_path(app_handle).ok()?;
    let contents = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let id = value.get("fileOpenerId")?.as_str()?.trim().to_string();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Resolves the active file opener id. The ACP database is the source of truth;
/// only when it is reachable and definitively empty is a legacy settings.json
/// value migrated into it. A read error/timeout falls back to the default
/// without migrating, so it can never overwrite an existing DB choice.
///
/// Every authoritative resolution refreshes the local cache file that
/// `resolve_file_opener_id_cached` serves, keeping the boot and file-open
/// paths off the helper round-trip.
async fn resolve_file_opener_id(app_handle: &AppHandle) -> String {
    match file_opener_from_db(app_handle).await {
        // A value is stored — use it.
        Ok(Some(id)) => {
            write_cached_file_opener_id(app_handle, &id);
            return id;
        }
        // Read failed or timed out — do not migrate; the picker and settings
        // panel re-read on mount once the helper is ready. Not cached either:
        // a transient failure must not pin the default.
        Err(()) => return default_file_opener_id(),
        // DB is reachable and empty — fall through to the one-time migration.
        Ok(None) => {}
    }
    if let Some(legacy) = legacy_file_opener_id(app_handle) {
        if legacy != default_file_opener_id() {
            if let Err(err) = persist_file_opener_in_db(app_handle, &legacy).await {
                eprintln!("failed to migrate file opener to helper: {err}");
            }
            write_cached_file_opener_id(app_handle, &legacy);
            return legacy;
        }
    }
    let id = default_file_opener_id_for_new_user(&detected_openers(app_handle));
    write_cached_file_opener_id(app_handle, &id);
    id
}

/// Serves the locally cached opener id, falling back to the authoritative
/// (helper-backed) resolution only when no cache exists yet — first launch,
/// or a cleared config dir. The webview bootstrap awaits this before the
/// first mount, so a cache hit keeps a slow-to-start helper (bounded by
/// FILE_OPENER_HELPER_TIMEOUT) entirely off the first-paint path. Divergence
/// self-heals: refresh_openers_cache_on_load re-resolves authoritatively
/// after every mount and rewrites the cache, emitting SETTINGS_CHANGED_EVENT.
async fn resolve_file_opener_id_cached(app_handle: &AppHandle) -> String {
    match read_cached_file_opener_id(app_handle) {
        Some(id) => id,
        None => resolve_file_opener_id(app_handle).await,
    }
}

const FILE_OPENER_CACHE_FILE_NAME: &str = "file-opener-id";

fn file_opener_cache_path(app_handle: &AppHandle) -> Option<PathBuf> {
    app_handle
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(FILE_OPENER_CACHE_FILE_NAME))
}

fn read_cached_file_opener_id(app_handle: &AppHandle) -> Option<String> {
    let id = fs::read_to_string(file_opener_cache_path(app_handle)?).ok()?;
    let id = id.trim().to_string();
    (!id.is_empty()).then_some(id)
}

fn write_cached_file_opener_id(app_handle: &AppHandle, id: &str) {
    let Some(path) = file_opener_cache_path(app_handle) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!("failed to create file opener cache dir: {err}");
            return;
        }
    }
    // Atomic replace so a crash mid-write cannot leave a torn cache; the
    // per-write temp name keeps concurrent writers (boot resolve, post-mount
    // refresh, user changes) from truncating each other's temp file.
    let tmp = crate::desktop_openers::unique_tmp_path(&path);
    if fs::write(&tmp, id).is_ok() {
        if let Err(err) = fs::rename(&tmp, &path) {
            let _ = fs::remove_file(&tmp);
            eprintln!("failed to write file opener cache: {err}");
        }
    }
}

fn default_file_opener_id_for_new_user(openers: &DetectedOpeners) -> String {
    if openers
        .file_openers
        .iter()
        .any(|opener| opener.id == "editor")
    {
        "editor".to_string()
    } else {
        default_file_opener_id()
    }
}

fn set_theme_preference(
    mut settings: DesktopSettings,
    theme_preference: DesktopThemePreference,
) -> DesktopSettings {
    settings.theme_preference = theme_preference;
    settings
}

fn set_chat_preferences(
    mut settings: DesktopSettings,
    chat_font_size: u16,
) -> Result<DesktopSettings, String> {
    settings.chat_font_size = normalize_chat_font_size(chat_font_size)?;
    Ok(settings)
}

fn set_tool_activity(
    mut settings: DesktopSettings,
    tool_activity: DesktopToolActivity,
) -> DesktopSettings {
    settings.tool_activity = tool_activity;
    settings
}

fn set_steer_with_enter(mut settings: DesktopSettings, steer_with_enter: bool) -> DesktopSettings {
    settings.steer_with_enter = steer_with_enter;
    settings
}

fn set_window_vibrancy(mut settings: DesktopSettings, window_vibrancy: bool) -> DesktopSettings {
    settings.window_vibrancy = window_vibrancy;
    settings
}

fn set_app_icon_tint(mut settings: DesktopSettings, app_icon_tint: AppIconTint) -> DesktopSettings {
    settings.app_icon_tint = app_icon_tint;
    settings
}

fn set_update_channel(
    mut settings: DesktopSettings,
    update_channel: DesktopUpdateChannel,
) -> DesktopSettings {
    settings.update_channel = update_channel;
    settings
}

fn set_code_preferences(
    mut settings: DesktopSettings,
    code_font_family: &str,
    code_font_size: u16,
) -> Result<DesktopSettings, String> {
    settings.code_font_family = normalize_code_font_family(code_font_family)?;
    settings.code_font_size = normalize_code_font_size(code_font_size)?;
    Ok(settings)
}

fn set_terminal_preferences(
    mut settings: DesktopSettings,
    terminal_font_family: &str,
    terminal_font_size: u16,
    terminal_cursor_style: DesktopTerminalCursorStyle,
) -> Result<DesktopSettings, String> {
    settings.terminal_font_family = normalize_terminal_font_family(terminal_font_family)?;
    settings.terminal_font_size = normalize_terminal_font_size(terminal_font_size)?;
    settings.terminal_cursor_style = terminal_cursor_style;
    Ok(settings)
}

fn validate_file_opener_id(
    file_opener_id: &str,
    openers: &[DesktopFileOpener],
) -> Result<String, String> {
    let normalized = file_opener_id.trim();
    if normalized.is_empty() {
        return Err("Please choose an application to open files".to_string());
    }

    if !openers.iter().any(|opener| opener.id == normalized) {
        return Err("That file opener is no longer available".to_string());
    }

    Ok(normalized.to_string())
}

fn settings_response(
    app_handle: &AppHandle,
    settings: DesktopSettings,
    file_opener_id: String,
) -> DesktopSettingsResponse {
    let detected = cached_detected_openers_or_default(app_handle);
    settings_response_with_openers(settings, file_opener_id, detected)
}

fn settings_response_with_openers(
    settings: DesktopSettings,
    file_opener_id: String,
    openers: DetectedOpeners,
) -> DesktopSettingsResponse {
    let file_openers = openers.file_openers;
    let desktop_openers = openers.desktop_openers;
    let file_opener_id = if file_openers
        .iter()
        .any(|opener| opener.id == file_opener_id)
    {
        file_opener_id
    } else {
        default_file_opener_id()
    };

    DesktopSettingsResponse {
        theme_preference: settings.theme_preference,
        chat_font_size: settings.chat_font_size,
        code_font_families: code_font_families_for_setting(&settings.code_font_family),
        code_font_family: settings.code_font_family,
        code_font_size: settings.code_font_size,
        terminal_font_families: code_font_families_for_setting(&settings.terminal_font_family),
        terminal_font_family: settings.terminal_font_family,
        terminal_font_size: settings.terminal_font_size,
        terminal_cursor_style: settings.terminal_cursor_style,
        tool_activity: settings.tool_activity,
        steer_with_enter: settings.steer_with_enter,
        window_vibrancy: settings.window_vibrancy,
        app_icon_tint: settings.app_icon_tint,
        update_channel: settings.update_channel,
        auto_install_updates: settings.auto_install_updates,
        file_opener_id,
        file_openers,
        desktop_openers,
    }
}

fn normalize_chat_font_size(chat_font_size: u16) -> Result<u16, String> {
    if !(MIN_CHAT_FONT_SIZE..=MAX_CHAT_FONT_SIZE).contains(&chat_font_size) {
        return Err(format!(
            "Chat font size must be between {MIN_CHAT_FONT_SIZE} and {MAX_CHAT_FONT_SIZE}"
        ));
    }
    Ok(chat_font_size)
}

fn normalize_code_font_family(code_font_family: &str) -> Result<String, String> {
    let normalized = normalize_font_family_setting(code_font_family);
    if normalized.is_empty() {
        return Err("Please enter a code font family".to_string());
    }
    if normalized.len() > MAX_CODE_FONT_FAMILY_LEN {
        return Err("Code font family is too long".to_string());
    }
    Ok(normalized)
}

fn normalize_code_font_size(code_font_size: u16) -> Result<u16, String> {
    if !(MIN_CODE_FONT_SIZE..=MAX_CODE_FONT_SIZE).contains(&code_font_size) {
        return Err(format!(
            "Code font size must be between {MIN_CODE_FONT_SIZE} and {MAX_CODE_FONT_SIZE}"
        ));
    }
    Ok(code_font_size)
}

fn normalize_terminal_font_family(terminal_font_family: &str) -> Result<String, String> {
    let normalized = normalize_font_family_setting(terminal_font_family);
    if normalized.is_empty() {
        return Err("Please enter a terminal font family".to_string());
    }
    if normalized.len() > MAX_TERMINAL_FONT_FAMILY_LEN {
        return Err("Terminal font family is too long".to_string());
    }
    Ok(normalized)
}

fn normalize_terminal_font_size(terminal_font_size: u16) -> Result<u16, String> {
    if !(MIN_TERMINAL_FONT_SIZE..=MAX_TERMINAL_FONT_SIZE).contains(&terminal_font_size) {
        return Err(format!(
            "Terminal font size must be between {MIN_TERMINAL_FONT_SIZE} and {MAX_TERMINAL_FONT_SIZE}"
        ));
    }
    Ok(terminal_font_size)
}

fn default_chat_font_size() -> u16 {
    DEFAULT_CHAT_FONT_SIZE
}

fn default_code_font_family() -> String {
    DEFAULT_CODE_FONT_FAMILY.to_string()
}

fn default_code_font_size() -> u16 {
    DEFAULT_CODE_FONT_SIZE
}

fn default_terminal_font_family() -> String {
    DEFAULT_TERMINAL_FONT_FAMILY.to_string()
}

fn default_terminal_font_size() -> u16 {
    DEFAULT_TERMINAL_FONT_SIZE
}

fn default_window_vibrancy() -> bool {
    true
}

fn code_font_families_for_setting(code_font_family: &str) -> Vec<String> {
    let mut families: BTreeMap<String, String> = BTreeMap::new();
    for family in CODE_FONT_FAMILIES
        .get_or_init(detect_code_font_families)
        .iter()
        .chain(split_font_family_list(code_font_family).iter())
    {
        add_code_font_family(&mut families, family);
    }
    if families.is_empty() {
        for family in fallback_code_font_families() {
            add_code_font_family(&mut families, family);
        }
    }
    families.into_values().collect()
}

fn detect_code_font_families() -> Vec<String> {
    let mut families = BTreeMap::new();

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        for family in detect_code_font_families_with_fc_list() {
            add_code_font_family(&mut families, &family);
        }
    }

    #[cfg(target_os = "macos")]
    {
        for family in detect_code_font_families_with_atsutil() {
            add_code_font_family(&mut families, &family);
        }
    }

    for family in fallback_code_font_families() {
        if is_system_likely_to_have_font(family) {
            add_code_font_family(&mut families, family);
        }
    }

    families.into_values().collect()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn detect_code_font_families_with_fc_list() -> Vec<String> {
    let Ok(output) = Command::new("fc-list")
        .arg(":spacing=mono")
        .arg("family")
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .flat_map(|line| line.split(','))
        .map(normalize_font_family_name)
        .filter(|family| is_likely_code_font_family(family))
        .collect()
}

#[cfg(target_os = "macos")]
fn detect_code_font_families_with_atsutil() -> Vec<String> {
    let Ok(output) = Command::new("atsutil").args(["fonts", "-list"]).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(normalize_font_family_name)
        .filter(|family| is_likely_code_font_family(family))
        .collect()
}

fn add_code_font_family(families: &mut BTreeMap<String, String>, family: &str) {
    let normalized = normalize_font_family_name(family);
    if normalized.is_empty()
        || is_generic_font_family(&normalized)
        || !is_likely_code_font_family(&normalized)
    {
        return;
    }
    families
        .entry(normalized.to_lowercase())
        .or_insert(normalized);
}

fn split_font_family_list(code_font_family: &str) -> Vec<String> {
    code_font_family
        .split(',')
        .map(normalize_font_family_name)
        .filter(|family| !family.is_empty() && !is_generic_font_family(family))
        .collect()
}

fn normalize_font_family_name(family: &str) -> String {
    let mut normalized = family
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();

    if let Some((head, _tail)) = normalized.split_once(" (") {
        normalized = head.trim().to_string();
    }

    normalized = normalize_postscript_font_name(&normalized);
    normalized.trim_start_matches('.').trim().to_string()
}

fn normalize_font_family_setting(font_family: &str) -> String {
    font_family
        .split(',')
        .map(normalize_font_family_name)
        .filter(|family| !family.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

fn normalize_postscript_font_name(name: &str) -> String {
    let trimmed = name.trim();
    let known = [
        ("AndaleMono", "Andale Mono"),
        ("CourierNewPS", "Courier New"),
        ("CourierNew", "Courier New"),
        ("SFMono", "SF Mono"),
        ("SFNSMono", "SF Mono"),
        ("SF NS Mono", "SF Mono"),
        ("PTMono", "PT Mono"),
        ("JetBrainsMono", "JetBrains Mono"),
        ("FiraCode", "Fira Code"),
        ("FiraMono", "Fira Mono"),
        ("SourceCodePro", "Source Code Pro"),
        ("CascadiaMono", "Cascadia Mono"),
        ("CascadiaCode", "Cascadia Code"),
        ("CommitMono", "CommitMono"),
        ("Commit Mono", "CommitMono"),
        ("DejaVuSansMono", "DejaVu Sans Mono"),
        ("LiberationMono", "Liberation Mono"),
        ("UbuntuMono", "Ubuntu Mono"),
        ("RobotoMono", "Roboto Mono"),
        ("NotoSansMono", "Noto Sans Mono"),
        ("AnonymousPro", "Anonymous Pro"),
    ];

    for (prefix, family) in known {
        if trimmed == prefix || trimmed.starts_with(&format!("{prefix}-")) {
            return family.to_string();
        }
    }

    strip_font_style_suffix(trimmed).to_string()
}

fn strip_font_style_suffix(name: &str) -> &str {
    const STYLE_SUFFIXES: &[&str] = &[
        "Regular",
        "Bold",
        "Italic",
        "BoldItalic",
        "Bold Italic",
        "Medium",
        "Medium Italic",
        "Light",
        "Light Italic",
        "Semibold",
        "Semibold Italic",
        "DemiBold",
        "DemiBold Italic",
        "Black",
        "Black Italic",
        "Heavy",
        "Heavy Italic",
        "Thin",
        "Thin Italic",
        "ExtraLight",
        "ExtraLight Italic",
        "Condensed",
    ];

    for suffix in STYLE_SUFFIXES {
        if let Some(head) = name.strip_suffix(&format!("-{suffix}")) {
            return head;
        }
        if let Some(head) = name.strip_suffix(&format!(" {suffix}")) {
            return head;
        }
    }
    name
}

fn is_likely_code_font_family(family: &str) -> bool {
    let normalized = family
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();

    matches!(
        normalized.as_str(),
        "menlo" | "monaco" | "consolas" | "courier" | "couriernew" | "hack" | "inconsolata"
    ) || normalized.contains("mono")
        || normalized.contains("monospace")
        || normalized.contains("sourcecode")
        || normalized.contains("cascadiacode")
        || normalized.contains("firacode")
        || normalized.contains("jetbrains")
        || normalized.contains("iosevka")
        || normalized.contains("anonymouspro")
}

fn is_generic_font_family(family: &str) -> bool {
    matches!(
        family.trim().to_ascii_lowercase().as_str(),
        "monospace" | "serif" | "sans-serif" | "sans serif" | "cursive" | "fantasy" | "system-ui"
    )
}

fn fallback_code_font_families() -> &'static [&'static str] {
    &[
        "Menlo",
        "Monaco",
        "Consolas",
        "Cascadia Mono",
        "Cascadia Code",
        "Courier New",
        "DejaVu Sans Mono",
        "Fira Code",
        "Hack",
        "Iosevka",
        "JetBrains Mono",
        "Liberation Mono",
        "Roboto Mono",
        "SF Mono",
        "Source Code Pro",
        "Ubuntu Mono",
    ]
}

fn is_system_likely_to_have_font(family: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        matches!(family, "Menlo" | "Monaco" | "Courier New" | "SF Mono")
    }
    #[cfg(target_os = "linux")]
    {
        matches!(
            family,
            "DejaVu Sans Mono" | "Liberation Mono" | "Ubuntu Mono"
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = family;
        false
    }
}

fn validate_external_url(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| "Please enter a valid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => Ok(()),
        _ => Err("Only http, https, and mailto URLs can be opened externally".to_string()),
    }
}

fn validate_file_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Please enter a valid file path".to_string());
    }

    if let Ok(parsed) = Url::parse(trimmed) {
        if parsed.scheme() != "file" {
            return Err("Only file paths can be opened".to_string());
        }
        return parsed
            .to_file_path()
            .map_err(|_| "Please enter a valid file path".to_string());
    }

    Ok(PathBuf::from(trimmed))
}

fn validate_existing_file_path(path: &str) -> Result<PathBuf, String> {
    let path = validate_file_path(path)?;
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => Ok(path),
        Ok(_) => Err("Only files can be opened".to_string()),
        Err(err) => Err(err.to_string()),
    }
}

pub(crate) enum ExistingOpenPath {
    File(PathBuf),
    Directory(PathBuf),
}

pub(crate) fn validate_existing_open_path(path: &str) -> Result<ExistingOpenPath, String> {
    let path = validate_file_path(path)?;
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => Ok(ExistingOpenPath::File(path)),
        Ok(metadata) if metadata.is_dir() => Ok(ExistingOpenPath::Directory(path)),
        Ok(_) => Err("Only files and directories can be opened".to_string()),
        Err(err) => Err(err.to_string()),
    }
}

pub(crate) fn validate_existing_directory_path(path: &str) -> Result<PathBuf, String> {
    let path = validate_file_path(path)?;
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_dir() => Ok(path),
        Ok(_) => Err("Only directories can be opened".to_string()),
        Err(err) => Err(err.to_string()),
    }
}

fn validate_desktop_file_tree_relative_directory_path(
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative_path = relative_path.trim_end_matches(['/', '\\']);
    if relative_path.is_empty() {
        return Ok(PathBuf::new());
    }

    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("Directory must be relative".to_string());
    }

    for component in path.components() {
        match component {
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            _ => return Err("Directory must stay inside the root".to_string()),
        }
    }

    Ok(path.to_path_buf())
}

fn validate_desktop_file_tree_subtree_directory(
    root: &Path,
    relative_path: &Path,
) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|err| err.to_string())?;
    let directory = root
        .join(relative_path)
        .canonicalize()
        .map_err(|err| err.to_string())?;

    if !directory.starts_with(&root) {
        return Err("Directory must stay inside the root".to_string());
    }

    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(directory),
        Ok(_) => Err("Only directories can be opened".to_string()),
        Err(err) => Err(err.to_string()),
    }
}

fn build_desktop_file_tree(
    root: &Path,
    include_git_ignored: bool,
) -> Result<DesktopFileTree, String> {
    build_desktop_file_tree_from(root, Path::new(""), include_git_ignored)
}

fn build_desktop_file_tree_from(
    root: &Path,
    relative_root: &Path,
    include_git_ignored: bool,
) -> Result<DesktopFileTree, String> {
    let mut children = desktop_file_tree_children(&root.join(relative_root), relative_root)?;
    let git_context = desktop_file_tree_git_context(root);
    let child_paths = children
        .iter()
        .map(|entry| {
            desktop_file_tree_relative_path(
                &entry.relative_path,
                entry.kind == DesktopFileTreeEntryKind::Directory,
            )
        })
        .collect::<Vec<_>>();
    let ignored_relative_paths = git_context
        .as_ref()
        .map(|context| git_ignored_relative_paths(context, &child_paths))
        .unwrap_or_default();

    filter_and_sort_desktop_file_tree_children(
        &mut children,
        &ignored_relative_paths,
        include_git_ignored,
    );

    let git_status = git_context
        .as_ref()
        .map(|context| {
            desktop_file_tree_git_status(context, relative_root, &children, include_git_ignored)
        })
        .unwrap_or_default();

    let mut deferred_directories = Vec::new();
    let entries = children
        .into_iter()
        .map(|child| {
            let is_directory = child.kind == DesktopFileTreeEntryKind::Directory;
            let relative_path = desktop_file_tree_relative_path(&child.relative_path, is_directory);
            if is_directory {
                deferred_directories.push(relative_path.clone());
            }

            DesktopFileTreeEntry {
                path: child.path.to_string_lossy().to_string(),
                relative_path,
                kind: child.kind,
                git_ignored: child.git_ignored,
            }
        })
        .collect();

    Ok(DesktopFileTree {
        root_path: root.to_string_lossy().to_string(),
        entries,
        deferred_directories,
        git_status,
    })
}

fn desktop_file_tree_children(
    directory: &Path,
    relative_directory: &Path,
) -> Result<Vec<DesktopFileTreeChildEntry>, String> {
    let read_dir = fs::read_dir(directory).map_err(|err| err.to_string())?;
    let mut children = Vec::new();

    for entry in read_dir.flatten() {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // Git internals are never user content: hide the repo's .git directory
        // (and the .git file of submodule/linked-worktree checkouts) at every
        // level, matching VS Code's default `**/.git` exclude.
        if name == ".git" {
            continue;
        }
        let child_relative_path = relative_directory.join(&name);
        let kind = if file_type.is_dir() && !file_type.is_symlink() {
            DesktopFileTreeEntryKind::Directory
        } else {
            DesktopFileTreeEntryKind::File
        };
        children.push(DesktopFileTreeChildEntry {
            path: entry.path(),
            relative_path: child_relative_path,
            name,
            kind,
            git_ignored: false,
        });
    }

    Ok(children)
}

fn filter_and_sort_desktop_file_tree_children(
    children: &mut Vec<DesktopFileTreeChildEntry>,
    ignored_relative_paths: &HashSet<String>,
    include_git_ignored: bool,
) {
    children.retain_mut(|entry| {
        entry.git_ignored = ignored_relative_paths.contains(&desktop_file_tree_relative_path(
            &entry.relative_path,
            entry.kind == DesktopFileTreeEntryKind::Directory,
        ));
        include_git_ignored || !entry.git_ignored
    });

    children.sort_by(|left, right| {
        match (
            left.kind == DesktopFileTreeEntryKind::Directory,
            right.kind == DesktopFileTreeEntryKind::Directory,
        ) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left
                .name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.name.cmp(&right.name)),
        }
    });
}

#[derive(Debug)]
struct DesktopFileTreeChildEntry {
    path: PathBuf,
    relative_path: PathBuf,
    name: String,
    kind: DesktopFileTreeEntryKind,
    git_ignored: bool,
}

#[derive(Debug)]
struct DesktopFileTreeGitContext {
    files_root: PathBuf,
    worktree_relative_prefix: String,
}

fn desktop_file_tree_git_context(root: &Path) -> Option<DesktopFileTreeGitContext> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .arg("--show-toplevel")
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    if lines.next()? != "true" {
        return None;
    }

    let worktree_root = PathBuf::from(lines.next()?.trim());
    let files_root = root.canonicalize().ok()?;
    let worktree_root = worktree_root.canonicalize().ok()?;
    let worktree_relative_path = files_root.strip_prefix(&worktree_root).ok()?;
    let worktree_relative_prefix = if worktree_relative_path.as_os_str().is_empty() {
        String::new()
    } else {
        desktop_file_tree_relative_path(worktree_relative_path, true)
    };

    Some(DesktopFileTreeGitContext {
        files_root,
        worktree_relative_prefix,
    })
}

fn git_ignored_relative_paths(
    context: &DesktopFileTreeGitContext,
    relative_paths: &[String],
) -> HashSet<String> {
    if relative_paths.is_empty() {
        return HashSet::new();
    }

    let mut child = match Command::new("git")
        .arg("-C")
        .arg(&context.files_root)
        .arg("check-ignore")
        .arg("--stdin")
        .arg("-z")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return HashSet::new(),
    };

    if let Some(mut stdin) = child.stdin.take() {
        for relative_path in relative_paths {
            let _ = stdin.write_all(relative_path.as_bytes());
            let _ = stdin.write_all(&[0]);
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(_) => return HashSet::new(),
    };

    if !output.status.success() && output.status.code() != Some(1) {
        return HashSet::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn desktop_file_tree_git_status(
    context: &DesktopFileTreeGitContext,
    relative_root: &Path,
    children: &[DesktopFileTreeChildEntry],
    include_git_ignored: bool,
) -> Vec<DesktopFileTreeGitStatusEntry> {
    let mut status_by_path = git_status_relative_paths(context, relative_root);

    if include_git_ignored {
        for child in children {
            if !child.git_ignored {
                continue;
            }

            let relative_path = desktop_file_tree_relative_path(
                &child.relative_path,
                child.kind == DesktopFileTreeEntryKind::Directory,
            );
            status_by_path.insert(relative_path, DesktopFileTreeGitStatus::Ignored);
        }
    }

    status_by_path
        .into_iter()
        .map(|(path, status)| DesktopFileTreeGitStatusEntry { path, status })
        .collect()
}

fn git_status_relative_paths(
    context: &DesktopFileTreeGitContext,
    relative_root: &Path,
) -> BTreeMap<String, DesktopFileTreeGitStatus> {
    let pathspec = if relative_root.as_os_str().is_empty() {
        ".".to_string()
    } else {
        desktop_file_tree_relative_path(relative_root, true)
    };

    let output = match Command::new("git")
        .arg("-C")
        .arg(&context.files_root)
        .arg("status")
        .arg("--porcelain=v1")
        .arg("-z")
        .arg("--renames")
        .arg("--untracked-files=normal")
        .arg("--")
        .arg(pathspec)
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(_) => return BTreeMap::new(),
    };

    if !output.status.success() {
        return BTreeMap::new();
    }

    parse_git_status_output(context, &output.stdout)
}

fn parse_git_status_output(
    context: &DesktopFileTreeGitContext,
    stdout: &[u8],
) -> BTreeMap<String, DesktopFileTreeGitStatus> {
    let mut status_by_path = BTreeMap::new();
    let records = stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut index = 0;

    while index < records.len() {
        let record = records[index];
        index += 1;

        if record.is_empty() || record.len() < 4 {
            continue;
        }

        let status = match git_status_from_porcelain_code(record[0], record[1]) {
            Some(status) => status,
            None => continue,
        };
        let path = String::from_utf8_lossy(&record[3..]).to_string();
        if matches!(status, DesktopFileTreeGitStatus::Renamed) {
            index += 1;
        }

        let Some(relative_path) = context.file_tree_relative_git_status_path(&path) else {
            continue;
        };
        status_by_path.insert(relative_path, status);
    }

    status_by_path
}

fn git_status_from_porcelain_code(
    index_status: u8,
    worktree_status: u8,
) -> Option<DesktopFileTreeGitStatus> {
    match (index_status, worktree_status) {
        (b'?', b'?') => Some(DesktopFileTreeGitStatus::Untracked),
        (b'!', b'!') => Some(DesktopFileTreeGitStatus::Ignored),
        (b'R', _) | (_, b'R') | (b'C', _) | (_, b'C') => Some(DesktopFileTreeGitStatus::Renamed),
        (b'D', _) | (_, b'D') => Some(DesktopFileTreeGitStatus::Deleted),
        (b'A', _) | (_, b'A') => Some(DesktopFileTreeGitStatus::Added),
        (b' ', b' ') => None,
        _ => Some(DesktopFileTreeGitStatus::Modified),
    }
}

impl DesktopFileTreeGitContext {
    fn file_tree_relative_git_status_path(&self, path: &str) -> Option<String> {
        if self.worktree_relative_prefix.is_empty() {
            return Some(path.to_string());
        }

        path.strip_prefix(&self.worktree_relative_prefix)
            .map(ToString::to_string)
    }
}

fn desktop_file_tree_relative_path(path: &Path, is_directory: bool) -> String {
    let mut relative = path.to_string_lossy().replace('\\', "/");
    if is_directory && !relative.ends_with('/') {
        relative.push('/');
    }
    relative
}

fn should_open_with_default_app(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some(
            // Images.
            "avif"
                | "bmp"
                | "gif"
                | "heic"
                | "heif"
                | "jpeg"
                | "jpg"
                | "png"
                | "svg"
                | "tif"
                | "tiff"
                | "webp"
                // Documents commonly handled by preview apps.
                | "pdf"
                // Audio.
                | "aac"
                | "aiff"
                | "flac"
                | "m4a"
                | "mp3"
                | "ogg"
                | "opus"
                | "wav"
                | "wma"
                // Video.
                | "avi"
                | "m4v"
                | "mkv"
                | "mov"
                | "mp4"
                | "mpeg"
                | "mpg"
                | "ogv"
                | "webm"
                | "wmv"
        )
    )
}

fn image_mime_type(path: &str) -> Option<&'static str> {
    let file_path = validate_file_path(path).ok()?;
    match file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("bmp") => Some("image/bmp"),
        Some("gif") => Some("image/gif"),
        Some("jpeg") | Some("jpg") => Some("image/jpeg"),
        Some("png") => Some("image/png"),
        Some("svg") => Some("image/svg+xml"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_seen_changelog_version_key_matches_serde_serialization() {
        let settings = DesktopSettings {
            last_seen_changelog_version: Some("1.2.3".to_string()),
            ..DesktopSettings::default()
        };
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(
            json.get(LAST_SEEN_CHANGELOG_VERSION_KEY)
                .and_then(|value| value.as_str()),
            Some("1.2.3")
        );
    }

    #[test]
    fn update_announcement_records_first_launch_silently() {
        let (announce, updated) = take_pending_update_announcement_from(None, "1.2.0");
        assert_eq!(announce, None);
        let updated = updated.expect("baseline must be recorded");
        assert!(updated.contains("\"lastSeenChangelogVersion\": \"1.2.0\""));
    }

    #[test]
    fn update_announcement_announces_a_version_change_once() {
        let contents = r#"{ "lastSeenChangelogVersion": "1.1.0" }"#;
        let (announce, updated) = take_pending_update_announcement_from(Some(contents), "1.2.0");
        assert_eq!(announce.as_deref(), Some("1.2.0"));
        let updated = updated.expect("baseline must move");
        let (announce_again, updated_again) =
            take_pending_update_announcement_from(Some(&updated), "1.2.0");
        assert_eq!(announce_again, None);
        assert_eq!(updated_again, None);
    }

    #[test]
    fn update_announcement_preserves_other_keys_and_never_persists_inferred_ones() {
        let contents = r#"{ "themePreference": "dark", "chatFontSize": 17 }"#;
        let (_, updated) = take_pending_update_announcement_from(Some(contents), "1.2.0");
        let updated: serde_json::Value = serde_json::from_str(&updated.unwrap()).unwrap();
        assert_eq!(
            updated
                .get("themePreference")
                .and_then(|value| value.as_str()),
            Some("dark")
        );
        assert_eq!(
            updated.get("chatFontSize").and_then(|value| value.as_u64()),
            Some(17)
        );
        // The channel stays absent so read-time version-parity inference keeps
        // working for installs that never chose one explicitly.
        assert!(updated.get("updateChannel").is_none());
    }

    #[test]
    fn update_announcement_treats_corrupt_settings_as_empty() {
        let (announce, updated) = take_pending_update_announcement_from(Some("not json"), "1.2.0");
        assert_eq!(announce, None);
        assert!(updated.is_some());
    }

    fn unique_temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "camber-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .arg("-c")
            .arg("commit.gpgsign=false")
            .arg("-c")
            .arg("user.name=Camber Test")
            .arg("-c")
            .arg("user.email=test@camber.local")
            .args(args)
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "git {:?} failed: {}{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_status_map(tree: &DesktopFileTree) -> BTreeMap<String, DesktopFileTreeGitStatus> {
        tree.git_status
            .iter()
            .map(|entry| (entry.path.clone(), entry.status))
            .collect()
    }

    #[test]
    fn accepts_browser_external_urls() {
        assert!(validate_external_url("https://api.poolsi.de/auth/login").is_ok());
        assert!(validate_external_url("mailto:hello@example.com").is_ok());
    }

    #[test]
    fn rejects_non_browser_external_urls() {
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("camber://auth/callback").is_err());
    }

    #[test]
    fn accepts_file_paths() {
        assert_eq!(
            validate_file_path("/tmp/camber.txt").unwrap(),
            PathBuf::from("/tmp/camber.txt")
        );
    }

    #[test]
    fn accepts_file_urls() {
        assert_eq!(
            validate_file_path("file:///tmp/camber.txt").unwrap(),
            PathBuf::from("/tmp/camber.txt")
        );
    }

    #[test]
    fn detects_image_mime_types() {
        assert_eq!(image_mime_type("/tmp/camber.PNG"), Some("image/png"));
        assert_eq!(
            image_mime_type("file:///tmp/camber.svg"),
            Some("image/svg+xml")
        );
        assert_eq!(image_mime_type("/tmp/camber.txt"), None);
    }

    #[test]
    fn opens_media_files_with_default_app() {
        for path in [
            "/tmp/camber.PNG",
            "/tmp/camber.pdf",
            "/tmp/camber.MP3",
            "/tmp/camber.mov",
        ] {
            assert!(should_open_with_default_app(&PathBuf::from(path)), "{path}");
        }
    }

    #[test]
    fn keeps_source_files_on_configured_opener() {
        for path in [
            "/tmp/camber.ts",
            "/tmp/camber.rs",
            "/tmp/camber.md",
            "/tmp/Makefile",
        ] {
            assert!(
                !should_open_with_default_app(&PathBuf::from(path)),
                "{path}"
            );
        }
    }

    #[test]
    fn text_file_command_reads_existing_utf8_file() {
        let path = std::env::temp_dir().join(format!(
            "camber-text-file-command-{}.txt",
            std::process::id()
        ));
        fs::write(&path, "before").unwrap();

        let text_file = read_text_file(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(text_file.contents, "before");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn text_file_command_rejects_binary_file() {
        let path = std::env::temp_dir().join(format!(
            "camber-text-file-command-{}.bin",
            std::process::id()
        ));
        fs::write(&path, [0, 1, 2, 3]).unwrap();

        let result = read_text_file(path.to_string_lossy().to_string());

        assert!(result.is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn text_file_command_reads_utf8_file_with_late_nul_byte() {
        let path = std::env::temp_dir().join(format!(
            "camber-text-file-command-{}-late-nul.ts",
            std::process::id()
        ));
        let mut contents = "a".repeat(BINARY_SNIFF_BYTES);
        contents.push_str("key\0separator");
        fs::write(&path, &contents).unwrap();

        let text_file = read_text_file(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(text_file.contents, contents);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_non_file_urls_as_file_paths() {
        assert!(validate_file_path("https://example.com/readme.md").is_err());
    }

    #[test]
    fn defaults_missing_theme_preference_to_system() {
        let settings: DesktopSettings = serde_json::from_str(r#"{}"#).unwrap();

        assert_eq!(settings.theme_preference, DesktopThemePreference::System);
    }

    #[test]
    fn defaults_missing_chat_preferences() {
        let settings: DesktopSettings = serde_json::from_str(r#"{}"#).unwrap();

        assert_eq!(settings.chat_font_size, DEFAULT_CHAT_FONT_SIZE);
    }

    #[test]
    fn chat_preferences_update_preserves_other_settings() {
        let settings = DesktopSettings {
            theme_preference: DesktopThemePreference::Dark,
            code_font_family: "JetBrains Mono".to_string(),
            ..DesktopSettings::default()
        };

        let updated = set_chat_preferences(settings, 16).unwrap();

        assert_eq!(updated.theme_preference, DesktopThemePreference::Dark);
        assert_eq!(updated.code_font_family, "JetBrains Mono");
        assert_eq!(updated.chat_font_size, 16);
    }

    #[test]
    fn chat_preferences_reject_font_size_outside_bounds() {
        assert!(set_chat_preferences(DesktopSettings::default(), MIN_CHAT_FONT_SIZE - 1).is_err());
        assert!(set_chat_preferences(DesktopSettings::default(), MAX_CHAT_FONT_SIZE + 1).is_err());
    }

    #[test]
    fn defaults_missing_code_preferences() {
        let settings: DesktopSettings = serde_json::from_str(r#"{}"#).unwrap();

        assert_eq!(settings.code_font_family, DEFAULT_CODE_FONT_FAMILY);
        assert_eq!(settings.code_font_size, DEFAULT_CODE_FONT_SIZE);
    }

    #[test]
    fn defaults_missing_terminal_preferences() {
        let settings: DesktopSettings = serde_json::from_str(r#"{}"#).unwrap();

        assert_eq!(settings.terminal_font_family, DEFAULT_TERMINAL_FONT_FAMILY);
        assert_eq!(settings.terminal_font_family, settings.code_font_family);
        assert_eq!(settings.terminal_font_size, DEFAULT_TERMINAL_FONT_SIZE);
        assert_eq!(
            settings.terminal_cursor_style,
            DesktopTerminalCursorStyle::Block
        );
    }

    #[test]
    fn defaults_missing_window_vibrancy_to_enabled() {
        let settings: DesktopSettings = serde_json::from_str(r#"{}"#).unwrap();

        assert!(settings.window_vibrancy);
    }

    #[test]
    fn defaults_missing_steer_with_enter_to_disabled() {
        let settings: DesktopSettings = serde_json::from_str(r#"{}"#).unwrap();

        assert!(!settings.steer_with_enter);
    }

    #[test]
    fn infers_preview_for_legacy_settings_on_an_odd_minor_build() {
        let settings =
            settings_with_inferred_update_channel(r#"{"themePreference":"dark"}"#, "0.7.0");

        assert_eq!(settings.update_channel, DesktopUpdateChannel::Nightly);
        assert_eq!(settings.theme_preference, DesktopThemePreference::Dark);
    }

    #[test]
    fn preserves_an_explicit_update_channel_across_version_parity() {
        let settings =
            settings_with_inferred_update_channel(r#"{"updateChannel":"stable"}"#, "0.7.0");

        assert_eq!(settings.update_channel, DesktopUpdateChannel::Stable);
    }

    #[test]
    fn persisted_inferred_preview_survives_installing_a_stable_version() {
        let inferred =
            settings_with_inferred_update_channel(r#"{"themePreference":"dark"}"#, "0.9.1");
        let persisted = set_update_channel(inferred.clone(), inferred.update_channel);
        let contents = serde_json::to_string(&persisted).unwrap();
        let after_stable_update = settings_with_inferred_update_channel(&contents, "0.10.0");

        assert_eq!(
            after_stable_update.update_channel,
            DesktopUpdateChannel::Nightly
        );
    }

    #[test]
    fn new_installs_follow_the_channel_encoded_by_version() {
        assert_eq!(
            default_settings_for_version("1.2.0").update_channel,
            DesktopUpdateChannel::Stable
        );
        assert_eq!(
            default_settings_for_version("1.3.0").update_channel,
            DesktopUpdateChannel::Nightly
        );
        assert_eq!(
            default_settings_for_version("invalid").update_channel,
            DesktopUpdateChannel::Stable
        );
    }

    #[test]
    fn window_vibrancy_update_preserves_other_settings() {
        let settings = DesktopSettings {
            theme_preference: DesktopThemePreference::Dark,
            ..DesktopSettings::default()
        };

        let updated = set_window_vibrancy(settings, false);

        assert!(!updated.window_vibrancy);
        assert_eq!(updated.theme_preference, DesktopThemePreference::Dark);
    }

    #[test]
    fn steer_with_enter_update_preserves_other_settings() {
        let settings = DesktopSettings {
            theme_preference: DesktopThemePreference::Dark,
            ..DesktopSettings::default()
        };

        let updated = set_steer_with_enter(settings, true);

        assert!(updated.steer_with_enter);
        assert_eq!(updated.theme_preference, DesktopThemePreference::Dark);
    }

    #[test]
    fn rejects_invalid_theme_preference() {
        let result = serde_json::from_str::<DesktopSettings>(r#"{"themePreference":"sepia"}"#);

        assert!(result.is_err());
    }

    #[test]
    fn rejects_invalid_terminal_cursor_style() {
        let result = serde_json::from_str::<DesktopSettings>(r#"{"terminalCursorStyle":"beam"}"#);

        assert!(result.is_err());
    }

    #[test]
    fn theme_preference_update_preserves_code_preferences() {
        let settings = DesktopSettings {
            theme_preference: DesktopThemePreference::System,
            code_font_family: "JetBrains Mono".to_string(),
            ..DesktopSettings::default()
        };

        let updated = set_theme_preference(settings, DesktopThemePreference::Light);

        assert_eq!(updated.code_font_family, "JetBrains Mono");
        assert_eq!(updated.theme_preference, DesktopThemePreference::Light);
    }

    #[test]
    fn theme_menu_ids_map_to_preferences() {
        assert_eq!(
            theme_preference_for_menu_id(SET_SYSTEM_THEME_MENU_ID),
            Some(DesktopThemePreference::System)
        );
        assert_eq!(
            theme_preference_for_menu_id(SET_LIGHT_THEME_MENU_ID),
            Some(DesktopThemePreference::Light)
        );
        assert_eq!(
            theme_preference_for_menu_id(SET_DARK_THEME_MENU_ID),
            Some(DesktopThemePreference::Dark)
        );
        assert_eq!(theme_preference_for_menu_id("camber-other"), None);
    }

    #[test]
    fn code_preferences_update_trims_and_preserves_other_settings() {
        let settings = DesktopSettings {
            theme_preference: DesktopThemePreference::Dark,
            ..DesktopSettings::default()
        };

        let updated = set_code_preferences(settings, "  JetBrains Mono, monospace  ", 15).unwrap();

        assert_eq!(updated.theme_preference, DesktopThemePreference::Dark);
        assert_eq!(updated.code_font_family, "JetBrains Mono, monospace");
        assert_eq!(updated.code_font_size, 15);
    }

    #[test]
    fn persisted_font_family_aliases_are_normalized_for_css() {
        let settings = DesktopSettings {
            code_font_family: "Commit Mono".to_string(),
            terminal_font_family: "Commit Mono, monospace".to_string(),
            ..DesktopSettings::default()
        };

        let normalized = normalize_persisted_font_families(settings);

        assert_eq!(normalized.code_font_family, "CommitMono");
        assert_eq!(normalized.terminal_font_family, "CommitMono, monospace");
    }

    #[test]
    fn code_preferences_reject_empty_font_family() {
        let result = set_code_preferences(DesktopSettings::default(), "  ", DEFAULT_CODE_FONT_SIZE);

        assert!(result.is_err());
    }

    #[test]
    fn code_preferences_reject_font_size_outside_bounds() {
        assert!(set_code_preferences(
            DesktopSettings::default(),
            DEFAULT_CODE_FONT_FAMILY,
            MIN_CODE_FONT_SIZE - 1,
        )
        .is_err());
        assert!(set_code_preferences(
            DesktopSettings::default(),
            DEFAULT_CODE_FONT_FAMILY,
            MAX_CODE_FONT_SIZE + 1,
        )
        .is_err());
    }

    #[test]
    fn terminal_preferences_update_trims_and_preserves_other_settings() {
        let settings = DesktopSettings {
            theme_preference: DesktopThemePreference::Dark,
            code_font_family: "Menlo".to_string(),
            code_font_size: 14,
            ..DesktopSettings::default()
        };

        let updated = set_terminal_preferences(
            settings,
            "  Menlo  ",
            15,
            DesktopTerminalCursorStyle::Underline,
        )
        .unwrap();

        assert_eq!(updated.theme_preference, DesktopThemePreference::Dark);
        assert_eq!(updated.code_font_family, "Menlo");
        assert_eq!(updated.code_font_size, 14);
        assert_eq!(updated.terminal_font_family, "Menlo");
        assert_eq!(updated.terminal_font_size, 15);
        assert_eq!(
            updated.terminal_cursor_style,
            DesktopTerminalCursorStyle::Underline
        );
    }

    #[test]
    fn terminal_preferences_reject_empty_font_family() {
        let result = set_terminal_preferences(
            DesktopSettings::default(),
            "  ",
            DEFAULT_TERMINAL_FONT_SIZE,
            DesktopTerminalCursorStyle::Block,
        );

        assert!(result.is_err());
    }

    #[test]
    fn terminal_preferences_reject_font_size_outside_bounds() {
        assert!(set_terminal_preferences(
            DesktopSettings::default(),
            DEFAULT_TERMINAL_FONT_FAMILY,
            MIN_TERMINAL_FONT_SIZE - 1,
            DesktopTerminalCursorStyle::Block,
        )
        .is_err());
        assert!(set_terminal_preferences(
            DesktopSettings::default(),
            DEFAULT_TERMINAL_FONT_FAMILY,
            MAX_TERMINAL_FONT_SIZE + 1,
            DesktopTerminalCursorStyle::Block,
        )
        .is_err());
    }

    #[test]
    fn code_font_family_list_splits_stacks_and_omits_generics() {
        let families = code_font_families_for_setting(
            r#"Menlo, Monaco, Consolas, "Liberation Mono", monospace"#,
        );

        assert!(families.contains(&"Menlo".to_string()));
        assert!(families.contains(&"Monaco".to_string()));
        assert!(families.contains(&"Consolas".to_string()));
        assert!(families.contains(&"Liberation Mono".to_string()));
        assert!(!families.contains(&"monospace".to_string()));
    }

    #[test]
    fn code_font_family_names_normalize_postscript_variants() {
        assert_eq!(normalize_font_family_name("Menlo-Regular"), "Menlo");
        assert_eq!(
            normalize_font_family_name("CourierNewPS-BoldMT"),
            "Courier New"
        );
        assert_eq!(
            normalize_font_family_name("JetBrainsMono-Regular"),
            "JetBrains Mono"
        );
        assert_eq!(
            normalize_font_family_name("CommitMono-Regular"),
            "CommitMono"
        );
        assert_eq!(normalize_font_family_name("Commit Mono"), "CommitMono");
        assert_eq!(
            normalize_font_family_name("Consolas (TrueType)"),
            "Consolas"
        );
    }

    #[test]
    fn code_font_family_filter_keeps_likely_monospace_fonts() {
        assert!(is_likely_code_font_family("Source Code Pro"));
        assert!(is_likely_code_font_family("Cascadia Mono"));
        assert!(!is_likely_code_font_family("Arial"));
        assert!(is_generic_font_family("monospace"));
    }

    #[test]
    fn file_opener_validation_rejects_empty_id() {
        let file_openers = vec![default_file_opener()];

        let result = validate_file_opener_id("   ", &file_openers);

        assert_eq!(
            result.unwrap_err(),
            "Please choose an application to open files"
        );
    }

    #[test]
    fn file_opener_validation_rejects_unknown_id() {
        let file_openers = vec![default_file_opener()];

        let result = validate_file_opener_id("app:not-installed", &file_openers);

        assert_eq!(
            result.unwrap_err(),
            "That file opener is no longer available"
        );
    }

    #[test]
    fn file_opener_validation_accepts_and_trims_known_id() {
        let file_openers = vec![default_file_opener()];

        let normalized =
            validate_file_opener_id(&format!("  {}  ", default_file_opener_id()), &file_openers)
                .unwrap();

        assert_eq!(normalized, default_file_opener_id());
    }

    #[test]
    fn helper_timeout_has_a_time_driver_in_tauri_runtime() {
        // file_opener_from_db wraps the helper round-trip in tokio::time::timeout
        // and runs both on async Tauri commands and via async_runtime::block_on
        // (refresh_openers_cache_on_load). tokio's time driver must be present in
        // that runtime or timeout/sleep would panic at runtime.
        let timed_out = tauri::async_runtime::block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(5), async {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            })
            .await
            .is_err()
        });
        assert!(timed_out);
    }

    #[test]
    fn response_resets_desktop_only_opener_selection() {
        use crate::desktop_openers::test_opener;
        let terminal = test_opener("terminal:dev.warp.Warp");
        let openers = DetectedOpeners {
            file_openers: vec![default_file_opener()],
            desktop_openers: vec![default_file_opener(), terminal],
        };
        let settings = DesktopSettings {
            theme_preference: DesktopThemePreference::System,
            ..DesktopSettings::default()
        };

        let response =
            settings_response_with_openers(settings, "terminal:dev.warp.Warp".to_string(), openers);

        assert_eq!(response.file_opener_id, default_file_opener_id());
    }

    #[test]
    fn response_preserves_file_only_in_app_opener_selection() {
        use crate::desktop_openers::in_app_file_opener;
        let in_app = in_app_file_opener();
        let openers = DetectedOpeners {
            file_openers: vec![in_app],
            desktop_openers: vec![default_file_opener()],
        };
        let settings = DesktopSettings::default();

        let response = settings_response_with_openers(settings, in_app_file_opener_id(), openers);

        assert_eq!(response.file_opener_id, in_app_file_opener_id());
    }

    #[test]
    fn response_falls_back_to_default_for_unknown_opener() {
        let openers = DetectedOpeners {
            file_openers: vec![default_file_opener()],
            desktop_openers: vec![default_file_opener()],
        };
        let settings = DesktopSettings::default();

        let response =
            settings_response_with_openers(settings, "app:not-installed".to_string(), openers);

        assert_eq!(response.file_opener_id, default_file_opener_id());
    }

    #[test]
    fn strip_opener_icons_clears_both_lists_and_nothing_else() {
        use crate::desktop_openers::test_opener_with_icon;
        let openers = DetectedOpeners {
            file_openers: vec![test_opener_with_icon(
                "editor",
                "data:image/png;base64,AAAA",
            )],
            desktop_openers: vec![test_opener_with_icon(
                "default",
                "data:image/png;base64,BBBB",
            )],
        };
        let full = settings_response_with_openers(
            DesktopSettings::default(),
            "editor".to_string(),
            openers,
        );

        // The non-boot path keeps icons: preferences and open-target controls
        // that call get_desktop_settings after boot depend on them.
        let full_json = serde_json::to_value(&full).unwrap();
        assert_eq!(
            full_json["fileOpeners"][0]["iconDataUri"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            full_json["desktopOpeners"][0]["iconDataUri"],
            "data:image/png;base64,BBBB"
        );

        let mut stripped = full.clone();
        strip_opener_icons(&mut stripped);
        let stripped_json = serde_json::to_value(&stripped).unwrap();
        assert!(stripped_json["fileOpeners"][0]["iconDataUri"].is_null());
        assert!(stripped_json["desktopOpeners"][0]["iconDataUri"].is_null());
        // Everything except the icons survives.
        assert_eq!(stripped_json["fileOpeners"][0]["id"], "editor");
        assert_eq!(stripped_json["fileOpenerId"], full_json["fileOpenerId"]);
    }

    #[test]
    fn new_user_file_opener_prefers_editor_env_when_available() {
        use crate::desktop_openers::test_opener;
        let openers = DetectedOpeners {
            file_openers: vec![default_file_opener(), test_opener("editor")],
            desktop_openers: vec![default_file_opener()],
        };

        assert_eq!(default_file_opener_id_for_new_user(&openers), "editor");
    }

    #[test]
    fn new_user_file_opener_falls_back_to_default_without_editor_env() {
        let openers = DetectedOpeners {
            file_openers: vec![default_file_opener()],
            desktop_openers: vec![default_file_opener()],
        };

        assert_eq!(
            default_file_opener_id_for_new_user(&openers),
            default_file_opener_id()
        );
    }

    #[test]
    fn settings_ignores_legacy_file_opener_id() {
        // Older settings.json files carried a `fileOpenerId`; it must parse
        // without error now that the field lives in the ACP database.
        let settings: DesktopSettings =
            serde_json::from_str(r#"{"themePreference":"dark","fileOpenerId":"editor"}"#).unwrap();

        assert_eq!(settings.theme_preference, DesktopThemePreference::Dark);
    }

    #[test]
    fn rejects_non_directory_paths_for_directory_openers() {
        assert!(validate_existing_directory_path("/definitely/not/a/camber/dir").is_err());
    }

    #[test]
    fn open_path_validation_accepts_existing_files_and_directories() {
        let temp_root = std::env::temp_dir().join(format!(
            "camber-open-path-validation-{}",
            std::process::id()
        ));
        let dir_path = temp_root.join("project");
        let file_path = dir_path.join("README.md");
        fs::create_dir_all(&dir_path).unwrap();
        fs::write(&file_path, "test").unwrap();

        match validate_existing_open_path(&file_path.to_string_lossy()).unwrap() {
            ExistingOpenPath::File(path) => assert_eq!(path, file_path),
            ExistingOpenPath::Directory(_) => panic!("expected file path"),
        }
        match validate_existing_open_path(&dir_path.to_string_lossy()).unwrap() {
            ExistingOpenPath::Directory(path) => assert_eq!(path, dir_path),
            ExistingOpenPath::File(_) => panic!("expected directory path"),
        }

        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn desktop_file_tree_lists_sorted_relative_paths() {
        let temp_root = std::env::temp_dir().join(format!(
            "camber-file-tree-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let src_path = temp_root.join("src");
        fs::create_dir_all(&src_path).unwrap();
        fs::write(temp_root.join("README.md"), "readme").unwrap();
        fs::write(src_path.join("lib.rs"), "test").unwrap();

        let tree = build_desktop_file_tree(&temp_root, false).unwrap();

        assert_eq!(tree.root_path, temp_root.to_string_lossy().to_string());
        assert_eq!(tree.deferred_directories, vec!["src/".to_string()]);
        assert!(tree.git_status.is_empty());
        assert_eq!(
            tree.entries
                .iter()
                .map(|entry| (entry.relative_path.clone(), entry.kind))
                .collect::<Vec<_>>(),
            vec![
                ("src/".to_string(), DesktopFileTreeEntryKind::Directory),
                ("README.md".to_string(), DesktopFileTreeEntryKind::File),
            ]
        );

        let subtree = build_desktop_file_tree_from(&temp_root, Path::new("src"), false).unwrap();
        assert!(subtree.deferred_directories.is_empty());
        assert!(subtree.git_status.is_empty());
        assert_eq!(
            subtree
                .entries
                .iter()
                .map(|entry| (entry.relative_path.clone(), entry.kind))
                .collect::<Vec<_>>(),
            vec![("src/lib.rs".to_string(), DesktopFileTreeEntryKind::File)]
        );

        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn desktop_file_tree_hides_git_internals() {
        let temp_root = std::env::temp_dir().join(format!(
            "camber-file-tree-git-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(temp_root.join(".git")).unwrap();
        fs::write(temp_root.join(".git").join("HEAD"), "ref: refs/heads/main").unwrap();
        fs::write(temp_root.join("README.md"), "readme").unwrap();
        // Submodule/linked-worktree checkouts have a .git *file* in subdirs.
        let sub_path = temp_root.join("sub");
        fs::create_dir_all(&sub_path).unwrap();
        fs::write(sub_path.join(".git"), "gitdir: ../.git/modules/sub").unwrap();
        fs::write(sub_path.join("main.rs"), "test").unwrap();

        let tree = build_desktop_file_tree(&temp_root, false).unwrap();
        assert_eq!(
            tree.entries
                .iter()
                .map(|entry| entry.relative_path.clone())
                .collect::<Vec<_>>(),
            vec!["sub/".to_string(), "README.md".to_string()]
        );

        let subtree = build_desktop_file_tree_from(&temp_root, Path::new("sub"), false).unwrap();
        assert_eq!(
            subtree
                .entries
                .iter()
                .map(|entry| entry.relative_path.clone())
                .collect::<Vec<_>>(),
            vec!["sub/main.rs".to_string()]
        );

        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn desktop_file_tree_loads_one_directory_level_at_a_time() {
        let temp_root = std::env::temp_dir().join(format!(
            "camber-file-tree-deferred-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let a_path = temp_root.join("a");
        let b_path = temp_root.join("b");
        let deep_path = a_path.join("deep");
        fs::create_dir_all(&deep_path).unwrap();
        fs::create_dir_all(&b_path).unwrap();
        fs::write(a_path.join("a.txt"), "a").unwrap();
        fs::write(b_path.join("b.txt"), "b").unwrap();
        fs::write(deep_path.join("nested.txt"), "nested").unwrap();

        let tree = build_desktop_file_tree(&temp_root, false).unwrap();

        assert_eq!(
            tree.entries
                .iter()
                .map(|entry| (entry.relative_path.clone(), entry.kind))
                .collect::<Vec<_>>(),
            vec![
                ("a/".to_string(), DesktopFileTreeEntryKind::Directory),
                ("b/".to_string(), DesktopFileTreeEntryKind::Directory),
            ]
        );
        assert_eq!(
            tree.deferred_directories,
            vec!["a/".to_string(), "b/".to_string()]
        );
        assert!(tree.git_status.is_empty());

        let subtree = build_desktop_file_tree_from(&temp_root, Path::new("a"), false).unwrap();

        assert_eq!(subtree.deferred_directories, vec!["a/deep/".to_string()]);
        assert!(subtree.git_status.is_empty());
        assert_eq!(
            subtree
                .entries
                .iter()
                .map(|entry| (entry.relative_path.clone(), entry.kind))
                .collect::<Vec<_>>(),
            vec![
                ("a/deep/".to_string(), DesktopFileTreeEntryKind::Directory),
                ("a/a.txt".to_string(), DesktopFileTreeEntryKind::File),
            ]
        );

        let nested = build_desktop_file_tree_from(&temp_root, Path::new("a/deep"), false).unwrap();
        assert!(nested.deferred_directories.is_empty());
        assert!(nested.git_status.is_empty());
        assert_eq!(
            nested
                .entries
                .iter()
                .map(|entry| (entry.relative_path.clone(), entry.kind))
                .collect::<Vec<_>>(),
            vec![(
                "a/deep/nested.txt".to_string(),
                DesktopFileTreeEntryKind::File,
            )]
        );

        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn desktop_file_tree_git_context_detects_worktree_roots_and_subdirectories() {
        if !git_available() {
            return;
        }

        let temp_root = unique_temp_root("file-tree-git-context");
        let subdirectory = temp_root.join("packages/app");
        fs::create_dir_all(&subdirectory).unwrap();
        git(&temp_root, &["init"]);

        let root_context = desktop_file_tree_git_context(&temp_root).unwrap();
        assert_eq!(root_context.worktree_relative_prefix, "");

        let subdirectory_context = desktop_file_tree_git_context(&subdirectory).unwrap();
        assert_eq!(
            subdirectory_context.worktree_relative_prefix,
            "packages/app/"
        );

        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn desktop_file_tree_git_context_returns_none_for_non_git_and_command_errors() {
        let temp_root = unique_temp_root("file-tree-no-git-context");
        fs::create_dir_all(&temp_root).unwrap();

        assert!(desktop_file_tree_git_context(&temp_root).is_none());
        assert!(desktop_file_tree_git_context(&temp_root.join("missing")).is_none());

        fs::remove_dir_all(temp_root).unwrap();
    }

    static CONFIG_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const CONFIG_ENV_VARS: [&str; 4] = [
        "CAMBER_ASSISTANT_CONFIG_PATH",
        "XDG_CONFIG_HOME",
        "HOME",
        "USERPROFILE",
    ];

    struct ConfigEnvGuard {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl ConfigEnvGuard {
        fn clear() -> Self {
            let saved = CONFIG_ENV_VARS
                .iter()
                .map(|name| {
                    let value = env::var_os(name);
                    env::remove_var(name);
                    (*name, value)
                })
                .collect();
            Self { saved }
        }
    }

    impl Drop for ConfigEnvGuard {
        fn drop(&mut self) {
            for (name, value) in self.saved.drain(..) {
                match value {
                    Some(value) => env::set_var(name, value),
                    None => env::remove_var(name),
                }
            }
        }
    }

    fn home_env_var() -> &'static str {
        "HOME"
    }

    #[test]
    fn assistant_config_path_prefers_env_override() {
        let _lock = CONFIG_ENV_LOCK
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let _guard = ConfigEnvGuard::clear();

        env::set_var("CAMBER_ASSISTANT_CONFIG_PATH", "/custom/assistant.json");
        env::set_var("XDG_CONFIG_HOME", "/ignored");
        assert_eq!(
            assistant_config_path().unwrap(),
            PathBuf::from("/custom/assistant.json")
        );

        // An empty override falls through to the regular resolution.
        env::set_var("CAMBER_ASSISTANT_CONFIG_PATH", "");
        assert_eq!(
            assistant_config_path().unwrap(),
            PathBuf::from("/ignored")
                .join("poolside")
                .join(ASSISTANT_CONFIG_FILE_NAME)
        );
    }

    #[test]
    fn assistant_config_path_uses_xdg_config_home() {
        let _lock = CONFIG_ENV_LOCK
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let _guard = ConfigEnvGuard::clear();

        env::set_var("XDG_CONFIG_HOME", "/xdg-config");
        env::set_var(home_env_var(), "/home/tester");
        assert_eq!(
            assistant_config_path().unwrap(),
            PathBuf::from("/xdg-config")
                .join("poolside")
                .join(ASSISTANT_CONFIG_FILE_NAME)
        );
    }

    #[test]
    fn assistant_config_path_falls_back_to_home_config_directory() {
        let _lock = CONFIG_ENV_LOCK
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let _guard = ConfigEnvGuard::clear();

        env::set_var(home_env_var(), "/home/tester");
        assert_eq!(
            assistant_config_path().unwrap(),
            PathBuf::from("/home/tester")
                .join(".config")
                .join("poolside")
                .join(ASSISTANT_CONFIG_FILE_NAME)
        );

        env::remove_var(home_env_var());
        assert!(assistant_config_path().is_err());
    }

    #[test]
    fn ensure_assistant_config_file_seeds_valid_empty_config() {
        let temp_root = unique_temp_root("assistant-config-seed");
        let path = temp_root.join("poolside").join(ASSISTANT_CONFIG_FILE_NAME);

        ensure_assistant_config_file(&path).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        let config: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            config.get("$schema").and_then(|value| value.as_str()),
            Some(ASSISTANT_CONFIG_SCHEMA_URL)
        );
        assert!(config
            .get("agent_servers")
            .is_some_and(|servers| servers.is_object()));

        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn ensure_assistant_config_file_preserves_existing_config() {
        let temp_root = unique_temp_root("assistant-config-existing");
        fs::create_dir_all(&temp_root).unwrap();
        let path = temp_root.join(ASSISTANT_CONFIG_FILE_NAME);
        let existing = r#"{"agent_servers":{"custom":{"command":"custom-agent"}}}"#;
        fs::write(&path, existing).unwrap();

        ensure_assistant_config_file(&path).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), existing);
        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn ensure_assistant_config_file_failure_creates_no_file() {
        let temp_root = unique_temp_root("assistant-config-failure");
        fs::create_dir_all(&temp_root).unwrap();
        let blocking_file = temp_root.join("blocker");
        fs::write(&blocking_file, "not a directory").unwrap();
        let path = blocking_file.join(ASSISTANT_CONFIG_FILE_NAME);

        assert!(ensure_assistant_config_file(&path).is_err());
        assert!(!path.exists());

        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn desktop_file_tree_parses_git_status_entries() {
        let context = DesktopFileTreeGitContext {
            files_root: PathBuf::from("/tmp/camber-files-root"),
            worktree_relative_prefix: "project/".to_string(),
        };
        let output = b" M project/modified.txt\0A  project/added.txt\0 D project/deleted.txt\0R  project/renamed.txt\0project/old.txt\0?? project/untracked.txt\0!! project/ignored.log\0 M other/outside.txt\0";

        let statuses = parse_git_status_output(&context, output);

        assert_eq!(
            statuses,
            BTreeMap::from([
                ("added.txt".to_string(), DesktopFileTreeGitStatus::Added),
                ("deleted.txt".to_string(), DesktopFileTreeGitStatus::Deleted),
                ("ignored.log".to_string(), DesktopFileTreeGitStatus::Ignored),
                (
                    "modified.txt".to_string(),
                    DesktopFileTreeGitStatus::Modified
                ),
                ("renamed.txt".to_string(), DesktopFileTreeGitStatus::Renamed),
                (
                    "untracked.txt".to_string(),
                    DesktopFileTreeGitStatus::Untracked
                ),
            ])
        );
    }

    #[test]
    fn desktop_file_tree_non_git_folders_skip_ignore_and_status_metadata() {
        let temp_root = unique_temp_root("file-tree-non-git");
        let ignored_path = temp_root.join("ignored");
        fs::create_dir_all(&ignored_path).unwrap();
        fs::write(temp_root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
        fs::write(temp_root.join("debug.log"), "debug").unwrap();
        fs::write(ignored_path.join("nested.txt"), "nested").unwrap();

        let tree = build_desktop_file_tree(&temp_root, false).unwrap();
        let paths = tree
            .entries
            .iter()
            .map(|entry| entry.relative_path.clone())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"ignored/".to_string()));
        assert!(paths.contains(&"debug.log".to_string()));
        assert!(tree.entries.iter().all(|entry| !entry.git_ignored));
        assert!(tree.git_status.is_empty());

        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn desktop_file_tree_reports_git_status_for_visible_children_and_descendants() {
        if !git_available() {
            return;
        }

        let temp_root = unique_temp_root("file-tree-git-status");
        let src_path = temp_root.join("src");
        fs::create_dir_all(&src_path).unwrap();
        fs::write(temp_root.join("modified.txt"), "original").unwrap();
        fs::write(temp_root.join("renamed-source.txt"), "rename").unwrap();
        fs::write(src_path.join("deleted.txt"), "deleted").unwrap();
        git(&temp_root, &["init"]);
        git(&temp_root, &["add", "."]);
        git(&temp_root, &["commit", "-m", "initial"]);

        fs::write(temp_root.join("modified.txt"), "changed").unwrap();
        fs::write(temp_root.join("added.txt"), "added").unwrap();
        git(&temp_root, &["add", "added.txt"]);
        git(
            &temp_root,
            &["mv", "renamed-source.txt", "renamed-dest.txt"],
        );
        fs::remove_file(src_path.join("deleted.txt")).unwrap();
        fs::write(temp_root.join("untracked.txt"), "untracked").unwrap();

        let tree = build_desktop_file_tree(&temp_root, false).unwrap();
        let statuses = git_status_map(&tree);

        assert_eq!(
            statuses.get("added.txt"),
            Some(&DesktopFileTreeGitStatus::Added)
        );
        assert_eq!(
            statuses.get("modified.txt"),
            Some(&DesktopFileTreeGitStatus::Modified)
        );
        assert_eq!(
            statuses.get("renamed-dest.txt"),
            Some(&DesktopFileTreeGitStatus::Renamed)
        );
        assert_eq!(
            statuses.get("src/deleted.txt"),
            Some(&DesktopFileTreeGitStatus::Deleted)
        );
        assert_eq!(
            statuses.get("untracked.txt"),
            Some(&DesktopFileTreeGitStatus::Untracked)
        );
        assert!(!tree
            .entries
            .iter()
            .any(|entry| entry.relative_path == "src/deleted.txt"));

        fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn desktop_file_tree_hides_and_marks_gitignored_entries() {
        if !git_available() {
            return;
        }

        let temp_root = std::env::temp_dir().join(format!(
            "camber-file-tree-ignored-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let ignored_path = temp_root.join("ignored");
        fs::create_dir_all(&ignored_path).unwrap();
        fs::write(temp_root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
        fs::write(temp_root.join("keep.txt"), "keep").unwrap();
        fs::write(temp_root.join("debug.log"), "debug").unwrap();
        fs::write(ignored_path.join("nested.txt"), "nested").unwrap();
        git(&temp_root, &["init"]);

        let filtered_tree = build_desktop_file_tree(&temp_root, false).unwrap();
        let filtered_paths = filtered_tree
            .entries
            .iter()
            .map(|entry| entry.relative_path.clone())
            .collect::<Vec<_>>();
        assert!(filtered_paths.contains(&".gitignore".to_string()));
        assert!(filtered_paths.contains(&"keep.txt".to_string()));
        assert!(!filtered_paths.contains(&"ignored/".to_string()));
        assert!(!filtered_paths.contains(&"debug.log".to_string()));
        assert!(!filtered_paths.contains(&"ignored/nested.txt".to_string()));
        assert!(filtered_tree.entries.iter().all(|entry| !entry.git_ignored));

        let full_tree = build_desktop_file_tree(&temp_root, true).unwrap();
        let full_ignored_paths = full_tree
            .entries
            .iter()
            .filter(|entry| entry.git_ignored)
            .map(|entry| entry.relative_path.clone())
            .collect::<Vec<_>>();
        assert!(full_ignored_paths.contains(&"ignored/".to_string()));
        assert!(full_ignored_paths.contains(&"debug.log".to_string()));
        let full_statuses = git_status_map(&full_tree);
        assert_eq!(
            full_statuses.get("ignored/"),
            Some(&DesktopFileTreeGitStatus::Ignored)
        );
        assert_eq!(
            full_statuses.get("debug.log"),
            Some(&DesktopFileTreeGitStatus::Ignored)
        );

        let ignored_subtree =
            build_desktop_file_tree_from(&temp_root, Path::new("ignored"), true).unwrap();
        assert!(ignored_subtree
            .entries
            .iter()
            .any(|entry| entry.relative_path == "ignored/nested.txt" && entry.git_ignored));
        assert_eq!(
            git_status_map(&ignored_subtree).get("ignored/nested.txt"),
            Some(&DesktopFileTreeGitStatus::Ignored)
        );

        fs::remove_dir_all(temp_root).unwrap();
    }
}
