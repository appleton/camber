use std::{
    collections::HashMap,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use notify::{
    event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode},
    Config, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde_json::{json, Value};
use tauri::{async_runtime, AppHandle, Emitter, Manager, Url};

use crate::helper;

pub(crate) const ACP_NAV_LIST_METHOD: &str = "camber/acpNav/list";
pub(crate) const DESKTOP_FILE_TREE_CHANGED_EVENT: &str = "camber:desktop-file-tree-changed";
const ACP_NAV_METHOD_PREFIX: &str = "camber/acpNav/";
const ACP_NAV_CREATE_WORKTREE_METHOD: &str = "camber/acpNav/createWorktree";
const ACP_NAV_UPSERT_PROJECT_METHOD: &str = "camber/acpNav/upsertProject";
const WATCH_DEBOUNCE: Duration = Duration::from_millis(150);
pub(crate) const FILE_CHANGE_CREATED: i32 = 1;
const FILE_CHANGE_CHANGED: i32 = 2;
pub(crate) const FILE_CHANGE_DELETED: i32 = 3;

#[derive(Clone, Default)]
pub struct FileWatcherState {
    inner: Arc<Mutex<FileWatcherInner>>,
}

#[derive(Default)]
struct FileWatcherInner {
    roots: Vec<PathBuf>,
    watcher: Option<RecommendedWatcher>,
    pending: Arc<Mutex<HashMap<String, i32>>>,
    scheduled: Arc<AtomicBool>,
}

pub fn sync_after_helper_result(app_handle: &AppHandle, method: &str, result: &Value) -> bool {
    if method != ACP_NAV_LIST_METHOD
        && (!method.starts_with(ACP_NAV_METHOD_PREFIX) || result.get("projects").is_none())
    {
        return false;
    }

    let roots = extract_acp_nav_project_paths(result);
    app_handle
        .state::<FileWatcherState>()
        .update_roots(app_handle, roots);
    true
}

pub fn should_refresh_acp_nav_roots(method: &str, result: &Value) -> bool {
    matches!(
        method,
        ACP_NAV_CREATE_WORKTREE_METHOD | ACP_NAV_UPSERT_PROJECT_METHOD
    ) && result.get("path").and_then(Value::as_str).is_some()
}

impl FileWatcherState {
    fn update_roots(&self, app_handle: &AppHandle, roots: Vec<PathBuf>) {
        let roots = clean_roots(roots);
        let mut inner = self.inner.lock().unwrap();
        if inner.roots == roots {
            return;
        }

        if roots.is_empty() {
            inner.watcher = None;
            inner.roots.clear();
            return;
        }

        let pending = inner.pending.clone();
        let scheduled = inner.scheduled.clone();
        let callback_app_handle = app_handle.clone();
        let mut watcher = match RecommendedWatcher::new(
            move |event| {
                handle_notify_event(
                    &callback_app_handle,
                    pending.clone(),
                    scheduled.clone(),
                    event,
                )
            },
            Config::default(),
        ) {
            Ok(watcher) => watcher,
            Err(err) => {
                eprintln!("failed to create desktop file watcher: {err}");
                return;
            }
        };

        let mut watched_roots = Vec::with_capacity(roots.len());
        for root in roots {
            if let Err(err) = watcher.watch(&root, RecursiveMode::Recursive) {
                eprintln!("failed to watch {}: {err}", root.display());
                continue;
            }
            watched_roots.push(root);
        }

        inner.roots = watched_roots;
        inner.watcher = Some(watcher);
    }
}

fn handle_notify_event(
    app_handle: &AppHandle,
    pending: Arc<Mutex<HashMap<String, i32>>>,
    scheduled: Arc<AtomicBool>,
    event: notify::Result<notify::Event>,
) {
    let event = match event {
        Ok(event) => event,
        Err(err) => {
            eprintln!("desktop file watcher error: {err}");
            return;
        }
    };

    let changes = event_changes(event);
    if changes.is_empty() {
        return;
    }

    {
        let mut pending = pending.lock().unwrap();
        for (path, typ) in changes {
            merge_pending_change(&mut pending, path, typ);
        }
    }

    if scheduled.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_handle = app_handle.clone();
    thread::spawn(move || {
        thread::sleep(WATCH_DEBOUNCE);
        async_runtime::spawn(async move {
            flush_pending_changes(app_handle, pending, scheduled).await;
        });
    });
}

async fn flush_pending_changes(
    app_handle: AppHandle,
    pending: Arc<Mutex<HashMap<String, i32>>>,
    scheduled: Arc<AtomicBool>,
) {
    let changes = {
        let mut pending = pending.lock().unwrap();
        let mut changes = pending
            .drain()
            .filter_map(|(path, typ)| {
                let path_ref = Path::new(&path);
                let typ = classify_pending_change(path_ref, typ);
                Url::from_file_path(path_ref)
                    .ok()
                    .map(|uri| (path, typ, uri.to_string()))
            })
            .collect::<Vec<_>>();
        changes.sort_by(|a, b| a.2.cmp(&b.2));
        scheduled.store(false, Ordering::SeqCst);
        changes
    };

    if changes.is_empty() {
        return;
    }

    let file_tree_changes = changes
        .iter()
        .map(|(path, typ, _)| desktop_file_tree_change_payload(Path::new(path), *typ))
        .collect::<Vec<_>>();
    if let Err(err) = app_handle.emit(
        DESKTOP_FILE_TREE_CHANGED_EVENT,
        json!({ "changes": file_tree_changes }),
    ) {
        eprintln!("failed to emit desktop file tree changes: {err}");
    }

    let helper_changes = changes
        .into_iter()
        .map(|(_, typ, uri)| {
            json!({
                "uri": uri,
                "type": typ,
            })
        })
        .collect::<Vec<_>>();

    if let Err(err) = helper::send_helper_notification(
        &app_handle,
        "workspace/didChangeWatchedFiles",
        json!({ "changes": helper_changes }),
    )
    .await
    {
        eprintln!("failed to send watched file changes to camber-helper: {err}");
    }
}

pub(crate) fn emit_desktop_file_tree_changes(
    app_handle: &AppHandle,
    changes: impl IntoIterator<Item = (PathBuf, i32)>,
) {
    let file_tree_changes = changes
        .into_iter()
        .map(|(path, typ)| desktop_file_tree_change_payload(&path, typ))
        .collect::<Vec<_>>();
    if file_tree_changes.is_empty() {
        return;
    }

    if let Err(err) = app_handle.emit(
        DESKTOP_FILE_TREE_CHANGED_EVENT,
        json!({ "changes": file_tree_changes }),
    ) {
        eprintln!("failed to emit desktop file tree changes: {err}");
    }
}

fn desktop_file_tree_change_payload(path: &Path, typ: i32) -> Value {
    let mut change = json!({
        "path": path.to_string_lossy().to_string(),
        "type": typ,
    });
    if typ != FILE_CHANGE_DELETED {
        change["kind"] = json!(if path.is_dir() { "directory" } else { "file" });
    }
    change
}

fn event_changes(event: notify::Event) -> Vec<(PathBuf, i32)> {
    match event.kind {
        EventKind::Create(CreateKind::File)
        | EventKind::Create(CreateKind::Folder)
        | EventKind::Create(CreateKind::Any)
        | EventKind::Create(CreateKind::Other) => {
            event_file_paths(event.paths, FILE_CHANGE_CREATED)
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            event_file_paths(event.paths, FILE_CHANGE_DELETED)
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            event_file_paths(event.paths, FILE_CHANGE_CREATED)
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => event
            .paths
            .into_iter()
            .enumerate()
            .filter_map(|(idx, path)| {
                let typ = if idx == 0 {
                    FILE_CHANGE_DELETED
                } else {
                    FILE_CHANGE_CREATED
                };
                should_send_path(&path, typ).then_some((path, typ))
            })
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Any))
        | EventKind::Modify(ModifyKind::Name(RenameMode::Other)) => {
            event_file_paths(event.paths, FILE_CHANGE_CHANGED)
        }
        EventKind::Modify(ModifyKind::Data(_))
        | EventKind::Modify(ModifyKind::Metadata(_))
        | EventKind::Modify(ModifyKind::Any) => event_file_paths(event.paths, FILE_CHANGE_CHANGED),
        EventKind::Remove(RemoveKind::File)
        | EventKind::Remove(RemoveKind::Folder)
        | EventKind::Remove(RemoveKind::Any)
        | EventKind::Remove(RemoveKind::Other) => {
            event_file_paths(event.paths, FILE_CHANGE_DELETED)
        }
        _ => Vec::new(),
    }
}

fn classify_pending_change(path: &Path, typ: i32) -> i32 {
    if typ == FILE_CHANGE_DELETED || path.exists() {
        typ
    } else {
        FILE_CHANGE_DELETED
    }
}

fn event_file_paths(paths: Vec<PathBuf>, typ: i32) -> Vec<(PathBuf, i32)> {
    paths
        .into_iter()
        .filter(|path| should_send_path(path, typ))
        .map(|path| (path, typ))
        .collect()
}

fn should_send_path(path: &Path, typ: i32) -> bool {
    if is_git_internal_noise(path) {
        return false;
    }
    if typ == FILE_CHANGE_DELETED {
        return true;
    }
    typ == FILE_CHANGE_CREATED || !path.is_dir()
}

/// Drops `.git` bookkeeping churn that carries no user-visible git mutation:
/// lock files (created and removed by every git read command), loose objects,
/// fsmonitor cookies (written on every git query when `core.fsmonitor` is
/// enabled), and FETCH_HEAD. Forwarding them lets a UI refresh retrigger
/// itself through the watcher forever. Real mutation signals — the index,
/// HEAD, and refs — still pass so external commits and staging refresh the
/// UI. The directory names are only classified at the gitdir's own top level:
/// deeper matches would misfire on legitimate names, like a branch called
/// "objects" (.git/refs/heads/objects) or a linked worktree by that name
/// (.git/worktrees/objects/index). Lock files match at any depth — git
/// forbids ref names ending in ".lock", so no real signal can collide.
fn is_git_internal_noise(path: &Path) -> bool {
    let mut components = path.components().map(|component| component.as_os_str());
    if !components.any(|component| component == OsStr::new(".git")) {
        return false;
    }
    let Some(first) = components.next() else {
        // The `.git` entry itself (e.g. a linked worktree's gitfile).
        return false;
    };
    if first == OsStr::new("objects") || first == OsStr::new("fsmonitor--daemon") {
        return true;
    }
    let Some(name) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    if name.ends_with(".lock") {
        return true;
    }
    // FETCH_HEAD only directly under .git — refs/heads/FETCH_HEAD is a
    // (questionable but) legal branch whose updates must pass.
    name == "FETCH_HEAD" && first == OsStr::new("FETCH_HEAD")
}

fn merge_pending_change(pending: &mut HashMap<String, i32>, path: PathBuf, typ: i32) {
    let key = path.to_string_lossy().into_owned();
    let next = match (pending.get(&key).copied(), typ) {
        (Some(FILE_CHANGE_CREATED), FILE_CHANGE_CHANGED) => FILE_CHANGE_CREATED,
        (Some(FILE_CHANGE_CREATED), FILE_CHANGE_DELETED) => {
            pending.remove(&key);
            return;
        }
        (Some(FILE_CHANGE_DELETED), FILE_CHANGE_CREATED) => FILE_CHANGE_CHANGED,
        (_, FILE_CHANGE_DELETED) => FILE_CHANGE_DELETED,
        (Some(existing), _) => existing,
        (None, change) => change,
    };
    pending.insert(key, next);
}

fn extract_acp_nav_project_paths(result: &Value) -> Vec<PathBuf> {
    result
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|project| project.get("path").and_then(Value::as_str))
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn clean_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut roots = roots
        .into_iter()
        .filter_map(|root| root.canonicalize().ok())
        .filter(|root| root.is_dir())
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();

    let mut out: Vec<PathBuf> = Vec::with_capacity(roots.len());
    for root in roots {
        if out.iter().any(|existing| root.starts_with(existing)) {
            continue;
        }
        out.push(root);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_acp_nav_project_paths() {
        assert_eq!(
            extract_acp_nav_project_paths(&json!({
                "projects": [
                    { "path": "/project" },
                    { "path": "" },
                    { "path": "/worktree", "isWorktree": true }
                ]
            })),
            vec![PathBuf::from("/project"), PathBuf::from("/worktree")]
        );
    }

    #[test]
    fn merge_created_then_changed_stays_created() {
        let mut pending = HashMap::new();

        merge_pending_change(&mut pending, PathBuf::from("/file"), FILE_CHANGE_CREATED);
        merge_pending_change(&mut pending, PathBuf::from("/file"), FILE_CHANGE_CHANGED);

        assert_eq!(pending.get("/file"), Some(&FILE_CHANGE_CREATED));
    }

    #[test]
    fn merge_created_then_deleted_drops_change() {
        let mut pending = HashMap::new();

        merge_pending_change(&mut pending, PathBuf::from("/file"), FILE_CHANGE_CREATED);
        merge_pending_change(&mut pending, PathBuf::from("/file"), FILE_CHANGE_DELETED);

        assert!(pending.is_empty());
    }

    #[test]
    fn merge_deleted_then_created_becomes_changed() {
        let mut pending = HashMap::new();

        merge_pending_change(&mut pending, PathBuf::from("/file"), FILE_CHANGE_DELETED);
        merge_pending_change(&mut pending, PathBuf::from("/file"), FILE_CHANGE_CREATED);

        assert_eq!(pending.get("/file"), Some(&FILE_CHANGE_CHANGED));
    }

    #[test]
    fn classify_missing_changed_path_as_deleted() {
        let path = std::env::temp_dir().join(format!("camber-missing-file-{}", std::process::id()));

        assert_eq!(
            classify_pending_change(&path, FILE_CHANGE_CHANGED),
            FILE_CHANGE_DELETED
        );
    }

    #[test]
    fn classify_existing_changed_path_stays_changed() {
        let path = std::env::current_dir().unwrap();

        assert_eq!(
            classify_pending_change(&path, FILE_CHANGE_CHANGED),
            FILE_CHANGE_CHANGED
        );
    }

    #[test]
    fn event_changes_handles_ambiguous_name_events() {
        let path = std::env::temp_dir().join(format!("camber-name-event-{}", std::process::id()));
        let event = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
            .add_path(path.clone());

        assert_eq!(event_changes(event), vec![(path, FILE_CHANGE_CHANGED)]);
    }

    #[test]
    fn event_changes_handles_other_remove_events() {
        let path = PathBuf::from("/file");
        let event = notify::Event::new(EventKind::Remove(RemoveKind::Other)).add_path(path.clone());

        assert_eq!(event_changes(event), vec![(path, FILE_CHANGE_DELETED)]);
    }

    #[test]
    fn git_internal_noise_is_filtered() {
        for noise in [
            "/repo/.git/index.lock",
            "/repo/.git/config.lock",
            "/repo/.git/refs/heads/main.lock",
            "/repo/.git/objects/ab/cdef0123",
            "/repo/.git/objects/pack/pack-abc.idx",
            "/repo/.git/fsmonitor--daemon/cookies/1-2",
            "/repo/.git/FETCH_HEAD",
            "/main/.git/worktrees/feature/index.lock",
        ] {
            assert!(is_git_internal_noise(Path::new(noise)), "{noise}");
        }
    }

    #[test]
    fn git_mutation_signals_are_kept() {
        for signal in [
            "/repo/.git/index",
            "/repo/.git/HEAD",
            "/repo/.git/ORIG_HEAD",
            "/repo/.git/refs/heads/main",
            "/main/.git/worktrees/feature/index",
            "/repo/.git",
            "/repo/src/main.rs",
            "/repo/yarn.lock",
            "/repo/packages/objects/model.ts",
            // Legal user-chosen names that collide with gitdir internals must
            // still pass: a branch or worktree named "objects", and a branch
            // named FETCH_HEAD.
            "/repo/.git/refs/heads/objects",
            "/main/.git/worktrees/objects/index",
            "/repo/.git/refs/heads/FETCH_HEAD",
        ] {
            assert!(!is_git_internal_noise(Path::new(signal)), "{signal}");
        }
    }

    #[test]
    fn event_changes_drops_deleted_git_lock_files() {
        // A lock delete that straddles two debounce windows escapes the
        // created+deleted merge; it must still not reach listeners, or every
        // git read command could retrigger the UI refresh that ran it.
        let event = notify::Event::new(EventKind::Remove(RemoveKind::File))
            .add_path(PathBuf::from("/repo/.git/index.lock"));

        assert_eq!(event_changes(event), Vec::new());
    }
}
