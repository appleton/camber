use std::{sync::mpsc, thread, time::Duration};

use tauri::{Manager, Runtime, WebviewWindow, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const DEFAULT_WINDOW_STATE_FILENAME: &str = ".window-state.json";
const BOUNDS_SAVE_DEBOUNCE: Duration = Duration::from_millis(250);

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_window_state::Builder::default()
        .with_filename(filename_from_env())
        .build()
}

pub fn save_on_bounds_changes<R: Runtime>(window: &WebviewWindow<R>) {
    let app_handle = window.app_handle().clone();
    let bounds_save_tx = start_bounds_save_worker(app_handle.clone());
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let _ = bounds_save_tx.send(());
        }
        WindowEvent::CloseRequested { .. } => {
            save_bounds(&app_handle);
        }
        _ => {}
    });
}

fn start_bounds_save_worker<R: Runtime>(app_handle: tauri::AppHandle<R>) -> mpsc::Sender<()> {
    start_bounds_save_worker_with_scheduler(BOUNDS_SAVE_DEBOUNCE, move || {
        schedule_save_bounds(&app_handle)
    })
}

fn start_bounds_save_worker_with_scheduler<F>(
    debounce: Duration,
    mut schedule_save_bounds: F,
) -> mpsc::Sender<()>
where
    F: FnMut() + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(debounce) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        schedule_save_bounds();
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    });
    tx
}

fn schedule_save_bounds<R: Runtime>(app_handle: &tauri::AppHandle<R>) {
    let save_app_handle = app_handle.clone();
    schedule_save_bounds_with_runner(
        |save_bounds| app_handle.run_on_main_thread(save_bounds),
        move || save_bounds(&save_app_handle),
    );
}

fn schedule_save_bounds_with_runner<RunOnMainThread, SaveBounds, Error>(
    run_on_main_thread: RunOnMainThread,
    save_bounds: SaveBounds,
) where
    RunOnMainThread: FnOnce(SaveBounds) -> Result<(), Error>,
    SaveBounds: FnOnce() + Send + 'static,
    Error: std::fmt::Display,
{
    if let Err(err) = run_on_main_thread(save_bounds) {
        eprintln!("failed to schedule window state save after bounds change: {err}");
    }
}

fn save_bounds<R: Runtime>(app_handle: &tauri::AppHandle<R>) {
    if let Err(err) = app_handle.save_window_state(StateFlags::all()) {
        eprintln!("failed to save window state after bounds change: {err}");
    }
}

fn filename_from_env() -> String {
    filename_for_slot(std::env::var("CAMBER_WORKTREE_SLOT").ok().as_deref())
}

fn filename_for_slot(slot: Option<&str>) -> String {
    let Some(slot) = slot.map(str::trim).filter(|slot| !slot.is_empty()) else {
        return DEFAULT_WINDOW_STATE_FILENAME.to_string();
    };

    format!(".window-state-camberqa-s{slot}.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn uses_default_filename_without_camberqa_slot() {
        assert_eq!(filename_for_slot(None), DEFAULT_WINDOW_STATE_FILENAME);
        assert_eq!(filename_for_slot(Some("")), DEFAULT_WINDOW_STATE_FILENAME);
        assert_eq!(
            filename_for_slot(Some("   ")),
            DEFAULT_WINDOW_STATE_FILENAME
        );
    }

    #[test]
    fn scopes_window_state_to_camberqa_slot() {
        assert_eq!(
            filename_for_slot(Some("0")),
            ".window-state-camberqa-s0.json"
        );
        assert_eq!(
            filename_for_slot(Some("3")),
            ".window-state-camberqa-s3.json"
        );
    }

    #[test]
    fn trims_slot_env_value() {
        assert_eq!(
            filename_for_slot(Some(" 2\n")),
            ".window-state-camberqa-s2.json"
        );
    }

    #[test]
    fn background_bounds_save_enqueues_main_thread_save_without_running_it() {
        let window_state_cache = Arc::new(Mutex::new(()));
        let main_thread_event_guard = window_state_cache.lock().unwrap();
        let (queued_save_tx, queued_save_rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let (save_ran_tx, save_ran_rx) = mpsc::channel();
        let cache_for_save = Arc::clone(&window_state_cache);

        let bounds_save_tx =
            start_bounds_save_worker_with_scheduler(Duration::from_millis(1), move || {
                let cache_for_save = Arc::clone(&cache_for_save);
                let save_ran_tx = save_ran_tx.clone();
                schedule_save_bounds_with_runner(
                    |save_bounds| {
                        queued_save_tx
                            .send(Box::new(save_bounds) as Box<dyn FnOnce() + Send>)
                            .unwrap();
                        Ok::<(), &str>(())
                    },
                    move || {
                        let _cache_guard = cache_for_save.lock().unwrap();
                        save_ran_tx.send(()).unwrap();
                    },
                );
            });

        bounds_save_tx.send(()).unwrap();
        let queued_save = queued_save_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("bounds save worker blocked instead of enqueueing the save");

        assert!(
            save_ran_rx.try_recv().is_err(),
            "background worker ran the save instead of enqueueing it"
        );

        drop(main_thread_event_guard);
        queued_save();
        save_ran_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("queued save did not run after the main-thread lock was released");
    }
}
