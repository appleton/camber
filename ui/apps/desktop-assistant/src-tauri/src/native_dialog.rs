//! Native confirmation and error dialogs for the webview's ConfirmationDialog.
//!
//! macOS only: shows an `NSAlert` carrying the app icon (the per-worktree
//! camberqa icon when launched under camberqa) and a red destructive-styled
//! confirm button where requested — neither of which `tauri-plugin-dialog`'s
//! `ask()` supports. Other platforms return an error and the webview falls
//! back to the plugin dialog.
//!
//! objc2-app-kit's typed `NSAlert`/`NSButton` bindings need extra crate
//! features; use the runtime directly like dock.rs does.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmDialogRequest {
    pub title: String,
    pub description: String,
    pub confirm_label: String,
    #[serde(default)]
    pub destructive: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDialogRequest {
    pub title: String,
    pub message: String,
}

#[cfg(not(target_os = "macos"))]
const NATIVE_DIALOGS_UNSUPPORTED: &str = "NATIVE_DIALOGS_UNSUPPORTED";

#[tauri::command]
pub async fn show_confirm_dialog(
    app: tauri::AppHandle,
    request: ConfirmDialogRequest,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        run_alert_on_main_thread(app, move || unsafe {
            let alert = new_alert(&request.title, &request.description);
            let confirm: Retained<AnyObject> = msg_send![
                &*alert,
                addButtonWithTitle: &*NSString::from_str(&request.confirm_label)
            ];
            let _cancel: Retained<AnyObject> =
                msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("Cancel")];
            if request.destructive {
                // Red confirm text, and no Return-key default: a destructive
                // action must be clicked deliberately. Cancel keeps the
                // Escape key equivalent AppKit assigns it by title.
                let _: () = msg_send![&*confirm, setHasDestructiveAction: true];
                let _: () = msg_send![&*confirm, setKeyEquivalent: &*NSString::from_str("")];
            }
            let response: isize = msg_send![&*alert, runModal];
            Ok(response == NS_ALERT_FIRST_BUTTON_RETURN)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Err(NATIVE_DIALOGS_UNSUPPORTED.to_string())
    }
}

#[tauri::command]
pub async fn show_error_dialog(
    app: tauri::AppHandle,
    request: ErrorDialogRequest,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        run_alert_on_main_thread(app, move || unsafe {
            let alert = new_alert(&request.title, &request.message);
            let _ok: Retained<AnyObject> =
                msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("OK")];
            let _: isize = msg_send![&*alert, runModal];
            Ok(())
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Err(NATIVE_DIALOGS_UNSUPPORTED.to_string())
    }
}

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2::{class, msg_send};
#[cfg(target_os = "macos")]
use objc2_foundation::NSString;

#[cfg(target_os = "macos")]
const NS_ALERT_FIRST_BUTTON_RETURN: isize = 1000;

/// A titled alert carrying the running app's icon.
///
/// SAFETY: must be called on the main thread.
#[cfg(target_os = "macos")]
unsafe fn new_alert(title: &str, description: &str) -> Retained<AnyObject> {
    let alert: Retained<AnyObject> = msg_send![class!(NSAlert), new];
    let _: () = msg_send![&*alert, setMessageText: &*NSString::from_str(title)];
    let _: () = msg_send![&*alert, setInformativeText: &*NSString::from_str(description)];
    // NSAlert falls back to a generic icon for unbundled dev binaries; set the
    // live app icon explicitly (the camberqa per-worktree icon when set).
    if let Some(icon) = crate::desktop_notification::notification_icon_image() {
        let icon_ref: &AnyObject = &icon;
        let _: () = msg_send![&*alert, setIcon: icon_ref];
    }
    alert
}

/// Runs `show` on the main thread (NSAlert requires it) without blocking the
/// async runtime, mirroring desktop_notification's dispatch pattern.
#[cfg(target_os = "macos")]
async fn run_alert_on_main_thread<T, F>(app: tauri::AppHandle, show: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(show());
        })
        .map_err(|err| format!("failed to schedule native dialog: {err}"))?;
        rx.recv()
            .map_err(|err| format!("native dialog did not complete: {err}"))?
    })
    .await
    .map_err(|err| format!("native dialog task failed: {err}"))?
}
