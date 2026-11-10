use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{async_runtime, AppHandle, Emitter, Manager, State};

use crate::terminal_shell_integration::zsh_terminal_env;

const TERMINAL_DID_OPEN_EVENT: &str = "camber:assistant-terminal-did-open";
const TERMINAL_DID_UPDATE_EVENT: &str = "camber:assistant-terminal-did-update";
const TERMINAL_DID_WRITE_EVENT: &str = "camber:assistant-terminal-did-write";
const TERMINAL_DID_EXIT_EVENT: &str = "camber:assistant-terminal-did-exit";
const TERMINAL_DID_CLOSE_EVENT: &str = "camber:assistant-terminal-did-close";
const MAX_TERMINAL_BUFFER_BYTES: usize = 200_000;
const MAX_TERMINAL_METADATA_TEXT_BYTES: usize = 512;
const MAX_PENDING_OSC_BYTES: usize = 4096;

#[derive(Default)]
pub struct TerminalState {
    terminals: tauri::async_runtime::Mutex<HashMap<String, TerminalRecord>>,
}

struct TerminalRecord {
    tab: AssistantTerminalTab,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    buffer: Arc<Mutex<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTerminalTab {
    id: String,
    title: String,
    cwd: String,
    worktree_path: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    buffer: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AssistantTerminalCommandMode {
    Interactive,
    NonInteractive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWritePayload {
    terminal_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalUpdatePayload {
    terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalClosePayload {
    terminal_id: String,
}

#[tauri::command]
pub async fn list_assistant_terminals(
    state: State<'_, TerminalState>,
    worktree_path: String,
) -> Result<Vec<AssistantTerminalTab>, String> {
    let terminals = state.terminals.lock().await;
    Ok(terminals
        .values()
        .filter(|record| record.tab.worktree_path == worktree_path)
        .map(tab_with_buffer)
        .collect())
}

#[tauri::command]
pub async fn create_assistant_terminal(
    app: AppHandle,
    state: State<'_, TerminalState>,
    worktree_path: String,
    command: Option<String>,
    env: Option<HashMap<String, String>>,
    command_mode: Option<AssistantTerminalCommandMode>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<AssistantTerminalTab, String> {
    let id = next_terminal_id();
    // A restored layout may ask for the directory the shell was last in; prefer
    // it when it still exists, otherwise the worktree root, otherwise nothing
    // (let the shell start wherever it defaults). Each candidate is probed once.
    let spawn_cwd = cwd
        .filter(|path| !path.is_empty() && Path::new(path).exists())
        .or_else(|| {
            Some(worktree_path.clone()).filter(|path| !path.is_empty() && Path::new(path).exists())
        });
    let title = {
        let terminals = state.terminals.lock().await;
        let count = terminals
            .values()
            .filter(|record| record.tab.worktree_path == worktree_path)
            .count();
        format!("Terminal {}", count + 1)
    };
    let tab = AssistantTerminalTab {
        id: id.clone(),
        title,
        // Report the directory we intend to start in, falling back to the
        // worktree root even when neither path exists on disk yet.
        cwd: spawn_cwd.clone().unwrap_or_else(|| worktree_path.clone()),
        worktree_path: worktree_path.clone(),
        created_at: created_at_millis().to_string(),
        exit_code: None,
        buffer: None,
    };

    let pty_system = native_pty_system();
    // Spawn at the size the caller measured from the pane that will display the
    // terminal, so the shell paints its first prompt at the correct width and
    // no compensating clear (with its visible `^L` flash) is needed. Callers
    // without a measurable pane (e.g. command runners) fall back to 80x24.
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.filter(|&rows| rows > 0).unwrap_or(24),
            cols: cols.filter(|&cols| cols > 0).unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let startup_command = command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty());
    let login_shell = crate::shell_env::login_shell();
    let shell = shell_for_terminal(
        login_shell.clone(),
        startup_command,
        command_mode.unwrap_or(AssistantTerminalCommandMode::Interactive),
    );
    let ShellSpec {
        program,
        args,
        write_startup_command,
        use_zsh_integration,
    } = shell;
    let mut shell_command = CommandBuilder::new(program);
    shell_command.args(args);
    shell_command.env("TERM", "xterm-256color");
    shell_command.env("COLORTERM", "truecolor");
    shell_command.env("FORCE_COLOR", "1");
    shell_command.env("PROMPT_EOL_MARK", "");
    // The inherited $SHELL can be stale (launchd replays the login-time
    // value), and command tabs may run a POSIX fallback rather than the login
    // shell itself. Either way programs inside the terminal — including the
    // keep-alive wrapper's `exec "${SHELL:-/bin/sh}"` hand-off — should see
    // the user's real shell.
    #[cfg(unix)]
    shell_command.env("SHELL", &login_shell);
    // Without a locale, pagers and other locale-aware programs render UTF-8
    // as <E2><94><82>-style byte escapes (PE-2444). See terminal_locale.rs.
    #[cfg(unix)]
    if let Some((key, value)) = crate::terminal_locale::utf8_locale_env() {
        shell_command.env(key, value);
    }
    if let Some(terminal_env) = env.as_ref() {
        for (key, value) in terminal_env {
            shell_command.env(key, value);
        }
    }
    if use_zsh_integration {
        match zsh_terminal_env(&app, env.as_ref()) {
            Ok(integration_env) => {
                for (key, value) in integration_env {
                    shell_command.env(key, value);
                }
            }
            Err(error) => {
                // Natural text navigation is additive. A cache-directory
                // failure must not prevent the user's terminal from opening.
                eprintln!("zsh terminal integration unavailable: {error}");
            }
        }
    }
    if let Some(ref dir) = spawn_cwd {
        shell_command.cwd(dir);
    }
    let child = pair
        .slave
        .spawn_command(shell_command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);

    if write_startup_command {
        let command = startup_command.unwrap_or_default();
        writer
            .write_all(format!("{}\n", command.trim_end()).as_bytes())
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
    }

    let child = Arc::new(Mutex::new(child));
    let writer = Arc::new(Mutex::new(writer));
    let output_buffer = Arc::new(Mutex::new(String::new()));
    {
        let mut terminals = state.terminals.lock().await;
        terminals.insert(
            id.clone(),
            TerminalRecord {
                tab: tab.clone(),
                master: pair.master,
                writer: writer.clone(),
                child: child.clone(),
                buffer: output_buffer.clone(),
            },
        );
    }

    spawn_reader(app.clone(), id.clone(), reader, child, output_buffer);
    let _ = app.emit(TERMINAL_DID_OPEN_EVENT, tab.clone());
    Ok(tab)
}

#[tauri::command]
pub async fn write_assistant_terminal(
    state: State<'_, TerminalState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let terminals = state.terminals.lock().await;
    let record = terminals
        .get(&terminal_id)
        .ok_or_else(|| "Terminal not found".to_string())?;
    let mut writer = record.writer.lock().map_err(|error| error.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn clear_assistant_terminal(
    state: State<'_, TerminalState>,
    terminal_id: String,
) -> Result<(), String> {
    let terminals = state.terminals.lock().await;
    let record = terminals
        .get(&terminal_id)
        .ok_or_else(|| "Terminal not found".to_string())?;
    // Drop the replay buffer so the cleared state is permanent, not just visual.
    if let Ok(mut buffer) = record.buffer.lock() {
        buffer.clear();
    }
    // Ask a live shell to clear its screen and reprint the prompt (Ctrl+L). The
    // redraw flows back through the normal reader, repopulating the now-empty
    // buffer with just the fresh prompt. Skip if the shell already exited.
    if record.tab.exit_code.is_none() {
        let writer = record.writer.clone();
        // Duplicate the master fd for the poll task: it may outlive this
        // record (terminal deleted mid-wait), and a raw fd number could be
        // reused by an unrelated file in that window. The dup pins this PTY
        // and is closed when the OwnedFd drops at the end of the task. The
        // write itself is safe regardless — the Arc keeps the writer alive.
        #[cfg(unix)]
        let master_fd = record.master.as_raw_fd().and_then(dup_master_fd);
        #[cfg(not(unix))]
        let master_fd: Option<()> = None;
        // Deliver the Ctrl+L off this task: if the shell is still sourcing its
        // rc files the PTY is in canonical mode with echo, and the kernel
        // would echo the byte as a literal `^L` on screen. Waiting until the
        // line editor flips the PTY to raw mode makes it a silent
        // clear-screen instead. The buffer wipe above already happened, so
        // the caller doesn't need to wait for the repaint.
        async_runtime::spawn(async move {
            wait_for_pty_raw_mode(master_fd).await;
            if let Ok(mut writer) = writer.lock() {
                let _ = writer.write_all(b"\x0c");
                let _ = writer.flush();
            }
        });
    }
    Ok(())
}

/// Duplicates the master PTY fd so the deferred-clear task can inspect it
/// without racing terminal deletion: the dup keeps this PTY's termios
/// reachable even after the record's own fd closes, so a reused fd number
/// can never be mistaken for it.
#[cfg(unix)]
fn dup_master_fd(fd: i32) -> Option<std::os::fd::OwnedFd> {
    use std::os::fd::FromRawFd;
    // Safety: fd is a valid open descriptor here (the record holding the
    // master is borrowed for the duration of this call).
    let duped = unsafe { libc::dup(fd) };
    if duped < 0 {
        return None;
    }
    // Safety: duped is a freshly created descriptor we exclusively own.
    Some(unsafe { std::os::fd::OwnedFd::from_raw_fd(duped) })
}

/// Waits (bounded) until the PTY behind `master_fd` has left canonical mode —
/// i.e. the shell's line editor (zle/readline) is active and control bytes
/// are interpreted rather than caret-echoed. Freshly spawned shells sit in
/// canonical mode until their rc files finish. Polling is the only option:
/// there is no event a process on the master side can wait on for "the slave's
/// termios changed", and the ioctl is cheap. Falls through on timeout, on
/// non-unix hosts, or when the fd cannot be inspected; the worst case is
/// today's behavior (a briefly visible `^L`).
#[cfg(unix)]
async fn wait_for_pty_raw_mode(master_fd: Option<std::os::fd::OwnedFd>) {
    use std::os::fd::AsRawFd;
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
    let Some(fd) = master_fd else { return };
    let deadline = std::time::Instant::now() + TIMEOUT;
    while std::time::Instant::now() < deadline {
        match pty_in_canonical_mode(fd.as_raw_fd()) {
            Some(true) => tokio::time::sleep(POLL_INTERVAL).await,
            // Raw mode reached, or the PTY went away (terminal deleted).
            Some(false) | None => return,
        }
    }
}

#[cfg(not(unix))]
async fn wait_for_pty_raw_mode(_master_fd: Option<()>) {}

#[cfg(unix)]
fn pty_in_canonical_mode(fd: i32) -> Option<bool> {
    let mut termios = std::mem::MaybeUninit::<libc::termios>::uninit();
    // Safety: tcgetattr only writes into the out-param on success, which is
    // exactly when we assume_init.
    let result = unsafe { libc::tcgetattr(fd, termios.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    let termios = unsafe { termios.assume_init() };
    Some(termios.c_lflag & libc::ICANON != 0)
}

#[tauri::command]
pub async fn resize_assistant_terminal(
    state: State<'_, TerminalState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.terminals.lock().await;
    let record = terminals
        .get(&terminal_id)
        .ok_or_else(|| "Terminal not found".to_string())?;
    record
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_assistant_terminal(
    app: AppHandle,
    state: State<'_, TerminalState>,
    terminal_id: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().await;
    if let Some(record) = terminals.remove(&terminal_id) {
        kill_record(&record)?;
        emit_close(&app, &terminal_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn close_assistant_terminals_for_worktree(
    app: AppHandle,
    state: State<'_, TerminalState>,
    worktree_path: String,
) -> Result<(), String> {
    close_matching(app, state, |record| {
        record.tab.worktree_path == worktree_path
    })
    .await
}

#[tauri::command]
pub async fn close_assistant_terminals_for_project(
    app: AppHandle,
    state: State<'_, TerminalState>,
    project_path: String,
) -> Result<(), String> {
    let prefix = format!("{}/", project_path.trim_end_matches('/'));
    close_matching(app, state, |record| {
        record.tab.worktree_path == project_path || record.tab.worktree_path.starts_with(&prefix)
    })
    .await
}

async fn close_matching(
    app: AppHandle,
    state: State<'_, TerminalState>,
    predicate: impl Fn(&TerminalRecord) -> bool,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().await;
    let ids = terminals
        .iter()
        .filter_map(|(id, record)| predicate(record).then_some(id.clone()))
        .collect::<Vec<_>>();
    for id in ids {
        if let Some(record) = terminals.remove(&id) {
            kill_record(&record)?;
            emit_close(&app, &id);
        }
    }
    Ok(())
}

fn kill_record(record: &TerminalRecord) -> Result<(), String> {
    let mut child = record.child.lock().map_err(|error| error.to_string())?;
    let _ = child.kill();
    Ok(())
}

fn spawn_reader(
    app: AppHandle,
    terminal_id: String,
    mut reader: Box<dyn Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    output_buffer: Arc<Mutex<String>>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut metadata_parser = TerminalMetadataParser::default();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    if let Some(update) = metadata_parser.process(&data) {
                        apply_terminal_metadata_update(&app, &terminal_id, update);
                    }
                    append_terminal_buffer(&output_buffer, &data);
                    let _ = app.emit(
                        TERMINAL_DID_WRITE_EVENT,
                        TerminalWritePayload {
                            terminal_id: terminal_id.clone(),
                            data,
                        },
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let exit_code = child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code() as i32);
        {
            let state = app.state::<TerminalState>();
            let mut terminals = async_runtime::block_on(state.terminals.lock());
            if let Some(record) = terminals.get_mut(&terminal_id) {
                record.tab.exit_code = exit_code;
            }
        }
        let _ = app.emit(
            TERMINAL_DID_EXIT_EVENT,
            TerminalExitPayload {
                terminal_id,
                exit_code,
            },
        );
    });
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct TerminalMetadataUpdate {
    title: Option<String>,
    cwd: Option<String>,
}

impl TerminalMetadataUpdate {
    fn is_empty(&self) -> bool {
        self.title.is_none() && self.cwd.is_none()
    }
}

#[derive(Default)]
struct TerminalMetadataParser {
    pending_osc: String,
}

impl TerminalMetadataParser {
    fn process(&mut self, data: &str) -> Option<TerminalMetadataUpdate> {
        let mut input = String::new();
        input.push_str(&self.pending_osc);
        input.push_str(data);
        self.pending_osc.clear();

        let mut index = 0;
        let mut update = TerminalMetadataUpdate::default();
        while let Some(start_offset) = input[index..].find("\x1b]") {
            let start = index + start_offset;
            let payload_start = start + 2;
            let Some((payload_len, terminator_len)) = find_osc_terminator(&input[payload_start..])
            else {
                let pending = &input[start..];
                if pending.len() <= MAX_PENDING_OSC_BYTES {
                    self.pending_osc = pending.to_string();
                }
                break;
            };

            let payload = &input[payload_start..payload_start + payload_len];
            apply_osc_payload(payload, &mut update);
            index = payload_start + payload_len + terminator_len;
        }

        (!update.is_empty()).then_some(update)
    }
}

fn find_osc_terminator(input: &str) -> Option<(usize, usize)> {
    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\x07' {
            return Some((index, 1));
        }
        if bytes[index] == b'\x1b' && bytes.get(index + 1) == Some(&b'\\') {
            return Some((index, 2));
        }
        index += 1;
    }
    None
}

fn apply_osc_payload(payload: &str, update: &mut TerminalMetadataUpdate) {
    let Some((command, value)) = payload.split_once(';') else {
        return;
    };

    match command {
        "0" | "2" => {
            if let Some(title) = clean_terminal_metadata_text(value) {
                update.title = Some(title);
            }
        }
        "7" => {
            if let Some(cwd) = parse_osc7_cwd(value) {
                update.cwd = Some(cwd);
            }
        }
        _ => {}
    }
}

fn clean_terminal_metadata_text(value: &str) -> Option<String> {
    let mut text = value
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    if text.is_empty() {
        return None;
    }
    if text.len() > MAX_TERMINAL_METADATA_TEXT_BYTES {
        let mut truncate_to = MAX_TERMINAL_METADATA_TEXT_BYTES;
        while truncate_to > 0 && !text.is_char_boundary(truncate_to) {
            truncate_to -= 1;
        }
        text.truncate(truncate_to);
    }
    Some(text)
}

fn parse_osc7_cwd(value: &str) -> Option<String> {
    let uri = value.trim();
    let rest = uri.strip_prefix("file://")?;
    let path_start = rest.find('/')?;
    let mut path = percent_decode(&rest[path_start..]);

    if path.len() >= 3
        && path.as_bytes()[0] == b'/'
        && path.as_bytes()[1].is_ascii_alphabetic()
        && path.as_bytes()[2] == b':'
    {
        path.remove(0);
    }

    (!path.is_empty()).then_some(path)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                output.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn apply_terminal_metadata_update(
    app: &AppHandle,
    terminal_id: &str,
    update: TerminalMetadataUpdate,
) {
    let state = app.state::<TerminalState>();
    let mut payload = TerminalUpdatePayload {
        terminal_id: terminal_id.to_string(),
        title: None,
        cwd: None,
    };

    {
        let mut terminals = async_runtime::block_on(state.terminals.lock());
        let Some(record) = terminals.get_mut(terminal_id) else {
            return;
        };

        if let Some(title) = update.title {
            if record.tab.title != title {
                record.tab.title = title.clone();
                payload.title = Some(title);
            }
        }
        if let Some(cwd) = update.cwd {
            if record.tab.cwd != cwd {
                record.tab.cwd = cwd.clone();
                payload.cwd = Some(cwd);
            }
        }
    }

    if payload.title.is_some() || payload.cwd.is_some() {
        let _ = app.emit(TERMINAL_DID_UPDATE_EVENT, payload);
    }
}

fn tab_with_buffer(record: &TerminalRecord) -> AssistantTerminalTab {
    let mut tab = record.tab.clone();
    tab.buffer = record.buffer.lock().ok().map(|buffer| buffer.clone());
    tab
}

fn append_terminal_buffer(buffer: &Arc<Mutex<String>>, data: &str) {
    let Ok(mut buffer) = buffer.lock() else {
        return;
    };
    buffer.push_str(data);
    if buffer.len() <= MAX_TERMINAL_BUFFER_BYTES {
        return;
    }

    let mut trim_to = buffer.len() - MAX_TERMINAL_BUFFER_BYTES;
    while trim_to < buffer.len() && !buffer.is_char_boundary(trim_to) {
        trim_to += 1;
    }
    buffer.drain(..trim_to);
}

fn emit_close(app: &AppHandle, terminal_id: &str) {
    let _ = app.emit(
        TERMINAL_DID_CLOSE_EVENT,
        TerminalClosePayload {
            terminal_id: terminal_id.to_string(),
        },
    );
}

struct ShellSpec {
    program: String,
    args: Vec<String>,
    write_startup_command: bool,
    use_zsh_integration: bool,
}

/// Chooses the program and argv for a terminal tab. `login_shell` is the
/// user's shell resolved from the user database (`shell_env::login_shell`);
/// it is ignored on Windows, where cmd/PowerShell run commands natively.
fn shell_for_terminal(
    login_shell: String,
    command: Option<&str>,
    command_mode: AssistantTerminalCommandMode,
) -> ShellSpec {
    if cfg!(windows) {
        if let Some(command) = command {
            if let Ok(comspec) = env::var("COMSPEC") {
                return ShellSpec {
                    program: comspec,
                    args: vec!["/Q".to_string(), "/C".to_string(), command.to_string()],
                    write_startup_command: command_mode
                        == AssistantTerminalCommandMode::Interactive,
                    use_zsh_integration: false,
                };
            }
            return ShellSpec {
                program: "powershell.exe".to_string(),
                args: vec![
                    "-NoLogo".to_string(),
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    command.to_string(),
                ],
                write_startup_command: command_mode == AssistantTerminalCommandMode::Interactive,
                use_zsh_integration: false,
            };
        }
        if let Ok(comspec) = env::var("COMSPEC") {
            return ShellSpec {
                program: comspec,
                args: vec!["/Q".to_string()],
                write_startup_command: false,
                use_zsh_integration: false,
            };
        }
        return ShellSpec {
            program: "powershell.exe".to_string(),
            args: vec!["-NoLogo".to_string()],
            write_startup_command: false,
            use_zsh_integration: false,
        };
    }

    // Terminal commands are POSIX by cross-host contract: `runCommandAndWait`
    // wraps them in a POSIX done-marker (`commandWithDoneMarker` in
    // AssistantTerminalRepository.svelte.ts), and raw startup commands follow
    // the same contract. So command terminals need a shell that parses POSIX
    // syntax; a non-POSIX login shell (fish, nushell, ...) falls back to the
    // platform shell for those tabs. Plain interactive tabs always get the
    // login shell — a keep-alive command tab still hands off to it afterwards
    // via the wrapper's `exec "$SHELL"`.
    let program = if command.is_some() && !is_posix_shell(&login_shell) {
        crate::shell_env::default_shell().to_string()
    } else {
        login_shell
    };
    let shell_name = Path::new(&program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let use_zsh_integration = cfg!(target_os = "macos") && shell_name == "zsh";

    // Keep this shell→argv mapping in sync with `assistantTerminalCommandLaunch`
    // which implements the same `nonInteractive` contract for the VS Code host
    // (with one intentional divergence: this host runs cmd/PowerShell commands
    // natively above, while the VS Code host falls back to sendText for them).
    if command_mode == AssistantTerminalCommandMode::NonInteractive && command.is_some() {
        let command = command.unwrap_or_default();
        let args = if shell_name == "bash" || shell_name == "zsh" {
            vec!["-ilc".to_string(), command.to_string()]
        } else {
            vec!["-ic".to_string(), command.to_string()]
        };
        return ShellSpec {
            program,
            args,
            write_startup_command: false,
            use_zsh_integration: false,
        };
    }

    // Interactive login shells, matching what Terminal.app and iTerm2 spawn
    // (fish parses grouped short flags like getopt, so `-il` is safe there).
    let args = if shell_name == "bash" || shell_name == "zsh" || shell_name == "fish" {
        vec!["-il".to_string()]
    } else {
        vec!["-i".to_string()]
    };
    ShellSpec {
        program,
        args,
        write_startup_command: command.is_some(),
        use_zsh_integration,
    }
}

/// Shells known to parse the POSIX done-marker wrapper delivered with
/// command terminals. Keep in sync with `POSIX_SHELLS` in
fn is_posix_shell(shell: &str) -> bool {
    let name = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    matches!(name, "bash" | "dash" | "sh" | "zsh")
}

fn created_at_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

// A timestamp alone is not unique: terminals created in the same millisecond
// (e.g. several tabs restored from a saved layout at once) would collide and
// silently overwrite each other's records, crossing their output streams.
static TERMINAL_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn next_terminal_id() -> String {
    let sequence = TERMINAL_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("terminal-{}-{}", created_at_millis(), sequence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(windows))]
    fn command_terminals_start_interactive_shell() {
        let shell = shell_for_terminal(
            "/bin/zsh".to_string(),
            Some("pnpm clean\nexit"),
            AssistantTerminalCommandMode::Interactive,
        );

        assert_eq!(shell.program, "/bin/zsh");
        assert_eq!(shell.args, vec!["-il".to_string()]);
        assert!(shell.write_startup_command);
        assert_eq!(shell.use_zsh_integration, cfg!(target_os = "macos"));
    }

    #[test]
    #[cfg(not(windows))]
    fn non_interactive_command_terminals_run_command_without_stdin_write() {
        let shell = shell_for_terminal(
            "/bin/zsh".to_string(),
            Some("pnpm clean\nexit"),
            AssistantTerminalCommandMode::NonInteractive,
        );

        assert_eq!(shell.program, "/bin/zsh");
        assert_eq!(
            shell.args,
            vec!["-ilc".to_string(), "pnpm clean\nexit".to_string()]
        );
        assert!(!shell.write_startup_command);
        assert!(!shell.use_zsh_integration);
    }

    #[test]
    #[cfg(not(windows))]
    fn empty_command_terminals_remain_interactive() {
        let shell = shell_for_terminal(
            "/bin/zsh".to_string(),
            None,
            AssistantTerminalCommandMode::Interactive,
        );

        assert_eq!(shell.program, "/bin/zsh");
        assert_eq!(shell.args, vec!["-il".to_string()]);
        assert!(!shell.write_startup_command);
        assert_eq!(shell.use_zsh_integration, cfg!(target_os = "macos"));
    }

    #[test]
    #[cfg(not(windows))]
    fn interactive_terminals_use_the_login_shell() {
        let shell = shell_for_terminal(
            "/opt/homebrew/bin/fish".to_string(),
            None,
            AssistantTerminalCommandMode::Interactive,
        );

        assert_eq!(shell.program, "/opt/homebrew/bin/fish");
        assert_eq!(shell.args, vec!["-il".to_string()]);
        assert!(!shell.write_startup_command);
        assert!(!shell.use_zsh_integration);
    }

    #[test]
    #[cfg(not(windows))]
    fn command_terminals_fall_back_to_a_posix_shell_for_non_posix_login_shells() {
        for mode in [
            AssistantTerminalCommandMode::Interactive,
            AssistantTerminalCommandMode::NonInteractive,
        ] {
            let shell = shell_for_terminal(
                "/opt/homebrew/bin/fish".to_string(),
                Some("pnpm clean\nexit"),
                mode,
            );

            assert_eq!(shell.program, crate::shell_env::default_shell());
        }
    }

    #[test]
    fn parses_terminal_title_and_cwd_osc_sequences() {
        let mut parser = TerminalMetadataParser::default();

        let update = parser
            .process("\x1b]2;pnpm test\x07\x1b]7;file://host/Users/poolie/camber%20assistant\x07")
            .expect("metadata update");

        assert_eq!(
            update,
            TerminalMetadataUpdate {
                title: Some("pnpm test".to_string()),
                cwd: Some("/Users/poolie/camber assistant".to_string()),
            },
        );
    }

    #[test]
    fn parses_split_osc_sequences() {
        let mut parser = TerminalMetadataParser::default();

        assert_eq!(parser.process("\x1b]7;file://host/Users/poolie"), None);
        let update = parser.process("/assistant\x1b\\").expect("metadata update");

        assert_eq!(
            update,
            TerminalMetadataUpdate {
                title: None,
                cwd: Some("/Users/poolie/assistant".to_string()),
            },
        );
    }

    #[test]
    fn terminal_ids_are_unique_within_a_millisecond() {
        let ids: Vec<String> = (0..1000).map(|_| next_terminal_id()).collect();
        let unique: std::collections::HashSet<&String> = ids.iter().collect();

        assert_eq!(unique.len(), ids.len());
    }

    #[test]
    fn parses_windows_osc7_paths() {
        let mut parser = TerminalMetadataParser::default();

        let update = parser
            .process("\x1b]7;file://host/C:/Users/poolie/project\x07")
            .expect("metadata update");

        assert_eq!(update.cwd, Some("C:/Users/poolie/project".to_string()));
    }
}
