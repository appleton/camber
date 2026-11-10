//! Recovers the environment a user's login shell would provide.
//!
//! Finder-launched apps inherit launchd's minimal environment: PATH is just
//! the system directories and none of the user's shell-profile exports
//! (EDITOR, VISUAL, version-manager paths, ...) exist, while a terminal
//! launch provides all of them. That asymmetry makes features work in dev and
//! silently break in the released bundle. Capturing the login shell's
//! environment once at startup and folding it into the process closes the gap
//! for this process and for everything it spawns, including camber-helper.

use std::{
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MARKER_START: &str = "__CAMBER_ENV_START__";
const MARKER_END: &str = "__CAMBER_ENV_END__";
/// Generous on purpose: shell inits that source version managers (nvm in
/// particular) routinely take over two seconds, and this runs once at startup.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// Folds the user's login-shell environment into this process: shell values
/// win (they are the inherited values plus whatever the shell profile
/// exports), and PATH becomes the shell PATH merged with the current one.
/// Also repairs a stale inherited $SHELL to the user's login shell, on every
/// launch shape. Call before anything reads the environment or spawns
/// children.
///
/// The capture itself (a login-shell subprocess) routinely costs hundreds of
/// milliseconds to seconds on the cold-launch path, so its result is cached on
/// disk keyed by the shell and its rc files. A cache hit applies instantly and
/// re-captures in the background, rewriting the cache for the next launch —
/// staleness the fingerprint cannot see lasts at most one session. The
/// background refresh never mutates this process's environment: setenv while
/// other threads may call getenv is undefined behavior.
///
/// Known staleness cost: values an rc file *materializes* per shell startup
/// (command substitution against a secret manager, short-TTL cloud tokens)
/// were re-derived fresh by every live capture but replay one launch old
/// from the cache. Session-bound values launchd itself provides
/// (SSH_AUTH_SOCK and friends) are unaffected — cached entries only fill
/// keys missing from the inherited environment. Terminals are unaffected
/// too; they source the rc files themselves.
pub fn apply_user_shell_env() {
    let shell = login_shell();
    // launchd replays the $SHELL recorded when the login session started, so
    // a `chsh` since then (zsh → fish, say) leaves every GUI launch with a
    // stale value. Repair it before anything inherits it — terminals,
    // camber-helper, and the keep-alive `exec "$SHELL"` hand-off all
    // consult it. Unlike the capture below, this is independent of how the
    // app was launched: a customized GUI PATH does not make $SHELL fresh.
    if env::var("SHELL").ok().as_deref() != Some(shell.as_str()) {
        env::set_var("SHELL", &shell);
    }

    // A terminal launch already carries the full shell environment; only pay
    // the capture (bounded by CAPTURE_TIMEOUT, on the startup path) when the
    // inherited PATH has launchd's minimal GUI shape.
    if !path_looks_minimal(&env::var("PATH").unwrap_or_default()) {
        return;
    }

    let fingerprint = shell_fingerprint(&shell);
    if let Some(cached) = load_cached_env(&fingerprint) {
        apply_env(&cached, /* preserve_existing */ true);
        refresh_cache_in_background(shell, fingerprint, cached);
        return;
    }

    let Some(output) = capture_login_shell_output(&shell) else {
        return;
    };
    let captured = parse_marked_env(&output);
    store_cached_env(&fingerprint, &captured);
    apply_env(&captured, /* preserve_existing */ false);
}

/// Applies captured or cached env entries to this process.
fn apply_env(entries: &[(String, String)], preserve_existing: bool) {
    for (key, value) in env_updates(entries, preserve_existing, |key| env::var(key).ok()) {
        env::set_var(key, value);
    }
}

/// Computes the entries to set. PATH always merges shell-first. For other
/// keys, a live capture overwrites (the shell inherited this launch's values,
/// so differences are real shell-profile exports), while a cached capture
/// (`preserve_existing`) only fills in missing keys: values recorded in an
/// earlier login session may name per-session resources (SSH_AUTH_SOCK and
/// friends) that launchd has since re-issued, and the fresh value must win.
fn env_updates(
    entries: &[(String, String)],
    preserve_existing: bool,
    current: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let mut updates = Vec::new();
    for (key, value) in entries {
        if key == "PATH" {
            let current_path = current("PATH").unwrap_or_default();
            let merged = merge_path_lists(value, &current_path);
            if merged != current_path {
                updates.push(("PATH".to_string(), merged));
            }
        } else if preserve_existing {
            if current(key).is_none() {
                updates.push((key.clone(), value.clone()));
            }
        } else if current(key).as_deref() != Some(value.as_str()) {
            updates.push((key.clone(), value.clone()));
        }
    }
    updates
}

/// Every PATH entry is a stock system directory — the shape launchd hands GUI
/// apps. Any other entry means a shell already shaped this environment.
fn path_looks_minimal(path: &str) -> bool {
    const SYSTEM_DIRS: &[&str] = &[
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/System/Cryptexes/App/usr/bin",
    ];
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .all(|dir| SYSTEM_DIRS.contains(&dir))
}

/// The user's login shell: the user-database entry (what `chsh` writes)
/// first, then $SHELL, then the platform default. $SHELL alone is not
/// enough — launchd hands GUI apps the value recorded at login, so a later
/// `chsh` is invisible to it until the next login. Terminal.app, iTerm2,
/// and VS Code all resolve the shell from the user database this way.
pub(crate) fn login_shell() -> String {
    passwd_shell()
        .filter(|shell| is_usable_shell(shell))
        .or_else(|| {
            env::var("SHELL")
                .ok()
                .filter(|shell| is_usable_shell(shell))
        })
        .unwrap_or_else(|| default_shell().to_string())
}

/// Reads the current user's shell from the user database (`pw_shell`).
#[cfg(unix)]
fn passwd_shell() -> Option<String> {
    use std::ffi::CStr;

    let mut buffer = vec![0u8; 1024];
    loop {
        let mut passwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: getpwuid_r writes only into `passwd` and `buffer`; on
        // success `pw_shell` points into `buffer`, which outlives the CStr
        // read below.
        let status = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                &mut passwd,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE && buffer.len() < 64 * 1024 {
            let doubled = buffer.len() * 2;
            buffer.resize(doubled, 0);
            continue;
        }
        if status != 0 || result.is_null() || passwd.pw_shell.is_null() {
            return None;
        }
        let shell = unsafe { CStr::from_ptr(passwd.pw_shell) }.to_str().ok()?;
        return (!shell.is_empty()).then(|| shell.to_string());
    }
}

#[cfg(not(unix))]
fn passwd_shell() -> Option<String> {
    None
}

fn capture_login_shell_output(shell: &str) -> Option<String> {
    let script = format!("printf '%s\\n' {MARKER_START}; env; printf '%s\\n' {MARKER_END}");

    let mut child = Command::new(shell)
        .args(shell_args(shell, &script))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| eprintln!("shell env capture: spawn {shell}: {err}"))
        .ok()?;

    // Drain stdout on a separate thread so a large environment can't fill the
    // pipe buffer and deadlock against the try_wait loop below.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buffer = String::new();
        let _ = stdout.read_to_string(&mut buffer);
        buffer
    });

    let deadline = Instant::now() + CAPTURE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = reader.join().ok()?;
                if !status.success() {
                    eprintln!("shell env capture: {shell} exited with {status}");
                    return None;
                }
                return Some(output);
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    eprintln!("shell env capture: {shell} timed out");
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => {
                eprintln!("shell env capture: wait {shell}: {err}");
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return None;
            }
        }
    }
}

/// Requires an absolute path to an existing non-directory, so a bogus $SHELL
/// (empty, relative, missing) falls back to the platform default instead of
/// failing the capture or running something unintended.
fn is_usable_shell(shell: &str) -> bool {
    let path = Path::new(shell);
    path.is_absolute() && path.is_file()
}

pub(crate) fn default_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/sh"
    }
}

fn shell_args(shell: &str, script: &str) -> Vec<String> {
    let name = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    match name {
        "fish" => vec!["-l".to_string(), "-c".to_string(), script.to_string()],
        "sh" => vec!["-ic".to_string(), script.to_string()],
        _ => vec!["-ilc".to_string(), script.to_string()],
    }
}

fn parse_marked_env(output: &str) -> Vec<(String, String)> {
    let Some(start) = output.rfind(MARKER_START).map(|i| i + MARKER_START.len()) else {
        return Vec::new();
    };
    let Some(end) = output[start..].find(MARKER_END).map(|i| i + start) else {
        return Vec::new();
    };
    let block = output[start..end].trim();
    if block.is_empty() {
        return Vec::new();
    }
    parse_env_block(block)
}

fn parse_env_block(block: &str) -> Vec<(String, String)> {
    block
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            let (key, value) = line.split_once('=')?;
            if key.is_empty() || should_drop_key(key) {
                return None;
            }
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

fn should_drop_key(key: &str) -> bool {
    // SHELL is dropped so a capture (which inherits this launch's possibly
    // stale value) can never overwrite the login-shell repair above.
    matches!(key, "_" | "OLDPWD" | "PWD" | "SHELL" | "SHLVL")
}

/// Identifies the inputs that shape a login shell's environment: the shell
/// binary and the rc files it sources, by mtime and size (absence included).
/// Any edit changes the fingerprint and forces a fresh synchronous capture.
/// Inputs the fingerprint cannot see (a version manager resolving differently,
/// command substitution against external state) are covered by the background
/// refresh instead: at most one launch runs on the previous environment.
fn shell_fingerprint(shell: &str) -> String {
    let home = env::var("HOME").unwrap_or_default();
    let home = Path::new(&home);
    let shell_name = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let mut files: Vec<PathBuf> = vec![PathBuf::from("/etc/profile")];
    match shell_name {
        "zsh" => {
            for name in ["zshenv", "zprofile", "zshrc", "zlogin"] {
                files.push(PathBuf::from(format!("/etc/{name}")));
                files.push(home.join(format!(".{name}")));
            }
        }
        "bash" => {
            for name in [".bash_profile", ".bash_login", ".profile", ".bashrc"] {
                files.push(home.join(name));
            }
        }
        "fish" => {
            files.push(PathBuf::from("/etc/fish/config.fish"));
            files.push(home.join(".config/fish/config.fish"));
        }
        _ => files.push(home.join(".profile")),
    }

    let mut fingerprint = format!("v1;shell={shell}");
    for file in files {
        match std::fs::metadata(&file) {
            Ok(meta) => {
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or_default();
                fingerprint.push_str(&format!(";{}={mtime_ms}:{}", file.display(), meta.len()));
            }
            Err(_) => fingerprint.push_str(&format!(";{}=-", file.display())),
        }
    }
    fingerprint
}

/// Overridable so tests and the measurement harness can isolate the cache.
/// The default lives in the shared camber cache dir rather than a
/// per-identifier app dir: the login-shell environment is a property of the
/// user, not of one app bundle.
fn cache_path() -> Option<PathBuf> {
    if let Ok(path) = env::var("CAMBER_SHELL_ENV_CACHE_PATH") {
        return Some(PathBuf::from(path));
    }
    let home = env::var("HOME").ok()?;
    Some(
        Path::new(&home)
            .join("Library/Caches/camber")
            .join("shell-env.json"),
    )
}

fn load_cached_env(fingerprint: &str) -> Option<Vec<(String, String)>> {
    load_cached_env_from(&cache_path()?, fingerprint)
}

fn load_cached_env_from(path: &Path, fingerprint: &str) -> Option<Vec<(String, String)>> {
    let contents = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    if value.get("fingerprint")?.as_str()? != fingerprint {
        return None;
    }
    let env = value
        .get("env")?
        .as_array()?
        .iter()
        .filter_map(|entry| {
            Some((
                entry.get(0)?.as_str()?.to_string(),
                entry.get(1)?.as_str()?.to_string(),
            ))
        })
        .collect::<Vec<_>>();
    (!env.is_empty()).then_some(env)
}

fn store_cached_env(fingerprint: &str, entries: &[(String, String)]) {
    if let Some(path) = cache_path() {
        store_cached_env_at(&path, fingerprint, entries);
    }
}

fn store_cached_env_at(path: &Path, fingerprint: &str, entries: &[(String, String)]) {
    if entries.is_empty() {
        return;
    }
    let payload = serde_json::json!({
        "fingerprint": fingerprint,
        "env": entries
            .iter()
            .map(|(k, v)| serde_json::json!([k, v]))
            .collect::<Vec<_>>(),
    });
    let Some(parent) = path.parent() else {
        return;
    };
    if let Err(err) = std::fs::create_dir_all(parent) {
        eprintln!("shell env cache: create {}: {err}", parent.display());
        return;
    }
    // Atomic replace so a crash mid-write cannot leave a torn cache. The temp
    // name is per-write (pid + nonce): the cache lives in a shared location,
    // so concurrently launching builds must not truncate each other's temp
    // file — and a within-process nonce keeps any future second writer safe.
    // Created owner-only from the first byte — the captured login-shell
    // environment routinely carries secrets (API keys and tokens exported
    // from shell profiles), so there must be no 0644 window before a chmod.
    let tmp = crate::desktop_openers::unique_tmp_path(&path);
    if let Err(err) = write_owner_only(&tmp, payload.to_string().as_bytes()) {
        eprintln!("shell env cache: write {}: {err}", tmp.display());
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    if let Err(err) = std::fs::rename(&tmp, &path) {
        eprintln!("shell env cache: rename {}: {err}", path.display());
        let _ = std::fs::remove_file(&tmp);
    }
}

fn write_owner_only(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    // The mode only applies on create; remove any stale leftover (a crashed
    // earlier run, possibly pre-dating the restrictive mode) so the open
    // below always creates fresh with 0600.
    let _ = std::fs::remove_file(path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(contents)
}

/// How long the background refresh waits before spawning the login shell.
/// Long enough that startup (native boot, webview load, first helper RPCs)
/// has finished; a login shell forked mid-boot measurably slows those phases.
const REFRESH_DELAY: Duration = Duration::from_secs(15);

/// Re-captures the login-shell environment off the startup path and rewrites
/// the cache when it drifted, so the next launch picks up changes the
/// fingerprint cannot observe. Never touches this process's environment.
fn refresh_cache_in_background(shell: String, fingerprint: String, cached: Vec<(String, String)>) {
    std::thread::spawn(move || {
        std::thread::sleep(REFRESH_DELAY);
        let Some(output) = capture_login_shell_output(&shell) else {
            return;
        };
        let captured = parse_marked_env(&output);
        if captured.is_empty() || captured == cached {
            return;
        }
        eprintln!("shell env cache: environment drifted, cache refreshed for next launch");
        store_cached_env(&fingerprint, &captured);
    });
}

/// Joins PATH lists in order, dropping empty entries and duplicates (first
/// occurrence wins).
fn merge_path_lists(first: &str, second: &str) -> String {
    let mut seen = std::collections::HashSet::<&str>::new();
    let mut merged = Vec::new();
    for dir in first.split(':').chain(second.split(':')) {
        if dir.is_empty() || !seen.insert(dir) {
            continue;
        }
        merged.push(dir);
    }
    merged.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_marked_env_and_drops_shell_bookkeeping_keys() {
        let output = [
            "shell startup noise",
            MARKER_START,
            "PATH=/shell/bin:/usr/bin",
            "EDITOR=nvim",
            "PWD=/Users/test",
            "SHELL=/bin/zsh",
            "SHLVL=2",
            "VALUE_WITH_EQUALS=a=b",
            MARKER_END,
            "shell shutdown noise",
        ]
        .join("\n");

        assert_eq!(
            parse_marked_env(&output),
            vec![
                ("PATH".to_string(), "/shell/bin:/usr/bin".to_string()),
                ("EDITOR".to_string(), "nvim".to_string()),
                ("VALUE_WITH_EQUALS".to_string(), "a=b".to_string()),
            ]
        );
    }

    #[test]
    fn parse_returns_empty_without_markers() {
        assert!(parse_marked_env("no markers here").is_empty());
        assert!(parse_marked_env(&format!("{MARKER_START}\nA=1")).is_empty());
    }

    #[test]
    fn merges_paths_shell_first_without_duplicates() {
        assert_eq!(
            merge_path_lists("/shell/bin:/usr/bin", "/app/bin:/usr/bin:"),
            "/shell/bin:/usr/bin:/app/bin"
        );
    }

    #[test]
    fn minimal_path_detection() {
        assert!(path_looks_minimal("/usr/bin:/bin:/usr/sbin:/sbin"));
        assert!(path_looks_minimal(""));
        assert!(!path_looks_minimal("/usr/bin:/bin:/opt/homebrew/bin"));
        assert!(!path_looks_minimal("/Users/test/.local/bin:/usr/bin"));
    }

    #[test]
    #[cfg(unix)]
    fn login_shell_resolves_to_a_usable_shell() {
        let shell = login_shell();
        assert!(is_usable_shell(&shell), "login_shell() = {shell}");
    }

    #[test]
    fn rejects_unusable_shells() {
        assert!(is_usable_shell("/bin/sh"));
        assert!(!is_usable_shell(""));
        assert!(!is_usable_shell("zsh"));
        assert!(!is_usable_shell("/nonexistent-camber-test-shell"));
        assert!(!is_usable_shell("/tmp"));
    }

    #[test]
    fn picks_shell_flags_by_shell_name() {
        assert_eq!(shell_args("/bin/zsh", "env")[0], "-ilc");
        assert_eq!(shell_args("/usr/local/bin/fish", "env")[0], "-l");
        assert_eq!(shell_args("/bin/sh", "env")[0], "-ic");
    }

    fn lookup<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn live_capture_overwrites_but_cached_apply_preserves_existing() {
        let entries = vec![
            ("EDITOR".to_string(), "nvim".to_string()),
            (
                "SSH_AUTH_SOCK".to_string(),
                "/old/session/agent".to_string(),
            ),
        ];
        let current = [("SSH_AUTH_SOCK", "/fresh/session/agent")];

        let live = env_updates(&entries, false, lookup(&current));
        assert_eq!(
            live,
            vec![
                ("EDITOR".to_string(), "nvim".to_string()),
                (
                    "SSH_AUTH_SOCK".to_string(),
                    "/old/session/agent".to_string()
                ),
            ]
        );

        let cached = env_updates(&entries, true, lookup(&current));
        assert_eq!(cached, vec![("EDITOR".to_string(), "nvim".to_string())]);
    }

    #[test]
    fn env_updates_always_merges_path_shell_first() {
        for preserve_existing in [false, true] {
            let updates = env_updates(
                &[("PATH".to_string(), "/shell/bin:/usr/bin".to_string())],
                preserve_existing,
                lookup(&[("PATH", "/usr/bin:/bin")]),
            );
            assert_eq!(
                updates,
                vec![("PATH".to_string(), "/shell/bin:/usr/bin:/bin".to_string())]
            );
        }
    }

    #[test]
    fn cache_round_trips_and_rejects_stale_fingerprints() {
        let dir = std::env::temp_dir().join(format!("shell-env-cache-test-{}", std::process::id()));
        let path = dir.join("nested/shell-env.json");
        let entries = vec![("EDITOR".to_string(), "nvim".to_string())];

        store_cached_env_at(&path, "fp-a", &entries);
        assert_eq!(load_cached_env_from(&path, "fp-a"), Some(entries));
        assert_eq!(load_cached_env_from(&path, "fp-b"), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn cache_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("shell-env-perm-test-{}", std::process::id()));
        let path = dir.join("shell-env.json");

        store_cached_env_at(
            &path,
            "fp",
            &[("SECRET_TOKEN".to_string(), "s".to_string())],
        );

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "captured env can carry secrets");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_capture_is_never_cached() {
        let dir = std::env::temp_dir().join(format!("shell-env-empty-test-{}", std::process::id()));
        let path = dir.join("shell-env.json");
        store_cached_env_at(&path, "fp", &[]);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fingerprint_tracks_shell_identity() {
        let zsh = shell_fingerprint("/bin/zsh");
        assert!(zsh.starts_with("v1;shell=/bin/zsh"));
        assert!(zsh.contains("/etc/zprofile"));
        assert_ne!(zsh, shell_fingerprint("/bin/bash"));
    }
}
