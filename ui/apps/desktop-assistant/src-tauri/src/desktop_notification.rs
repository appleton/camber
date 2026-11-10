#![cfg_attr(target_os = "macos", allow(deprecated))]

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyObject, NSObject, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSImage;
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSNumber, NSObjectNSKeyValueCoding, NSObjectProtocol, NSString, NSUserNotification,
    NSUserNotificationCenter, NSUserNotificationCenterDelegate,
};
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

#[cfg(not(target_os = "macos"))]
const CLICKABLE_NOTIFICATIONS_UNSUPPORTED: &str = "CLICKABLE_NOTIFICATIONS_UNSUPPORTED";
#[cfg(target_os = "macos")]
pub const DESKTOP_NOTIFICATION_CLICK_EVENT: &str = "camber:desktop-notification-click";
#[cfg(target_os = "macos")]
const NOTIFICATION_IDENTIFIER_PREFIX: &str = "camber-desktop-assistant-";

#[cfg(target_os = "macos")]
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
#[cfg(target_os = "macos")]
static NOTIFICATION_APPLICATION_CONFIGURED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
#[cfg(target_os = "macos")]
static NOTIFICATION_DELEGATE_INSTALLED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
define_class!(
    // SAFETY:
    // - The superclass NSObject does not have additional subclassing requirements.
    // - The delegate carries no ivars and is intentionally leaked for the app lifetime because
    //   NSUserNotificationCenter keeps a weak delegate reference.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct DesktopNotificationDelegate;

    // SAFETY: NSObjectProtocol has no extra safety requirements.
    unsafe impl NSObjectProtocol for DesktopNotificationDelegate {}

    // SAFETY: NSUserNotificationCenterDelegate has no extra safety requirements.
    unsafe impl NSUserNotificationCenterDelegate for DesktopNotificationDelegate {
        #[unsafe(method(userNotificationCenter:didActivateNotification:))]
        fn user_notification_center_did_activate_notification(
            &self,
            center: &NSUserNotificationCenter,
            notification: &NSUserNotification,
        ) {
            if let Some(identifier) = notification
                .identifier()
                .map(|identifier| identifier.to_string())
            {
                if let Some(app) = APP_HANDLE.get() {
                    center.removeDeliveredNotification(notification);

                    if let Some(id) = notification_id_from_identifier(&identifier) {
                        focus_desktop_app(app);
                        if let Err(err) = app.emit(DESKTOP_NOTIFICATION_CLICK_EVENT, id) {
                            eprintln!("failed to emit desktop notification click: {err}");
                        }
                    } else {
                        eprintln!(
                            "ignoring desktop notification click with unexpected identifier: {identifier}"
                        );
                    }
                }
            }
        }

        #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
        fn user_notification_center_should_present_notification(
            &self,
            _center: &NSUserNotificationCenter,
            _notification: &NSUserNotification,
        ) -> bool {
            true
        }
    }
);

#[cfg(target_os = "macos")]
impl DesktopNotificationDelegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: NSObject's init method is valid for this NSObject subclass.
        unsafe { msg_send![super(this), init] }
    }
}

#[tauri::command]
pub async fn send_clickable_notification(
    app: tauri::AppHandle,
    id: u32,
    title: String,
    body: String,
) -> Result<(), String> {
    send_clickable_notification_impl(app, id, title, body).await
}

#[tauri::command]
pub async fn cancel_clickable_notification(id: u32) -> Result<(), String> {
    cancel_clickable_notification_impl(id).await
}

#[cfg(target_os = "macos")]
async fn send_clickable_notification_impl(
    app: tauri::AppHandle,
    id: u32,
    title: String,
    body: String,
) -> Result<(), String> {
    APP_HANDLE.get_or_init(|| app.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let app_for_notification = app.clone();
        run_on_main_thread_sync(&app, move || {
            configure_notification_application(&app_for_notification);
            install_notification_delegate()?;

            let identifier = notification_identifier(id);
            let notification = NSUserNotification::new();
            notification.setIdentifier(Some(&NSString::from_str(&identifier)));
            notification.setTitle(Some(&NSString::from_str(&title)));
            notification.setInformativeText(Some(&NSString::from_str(&body)));
            notification.setHasActionButton(false);
            apply_notification_icon(&notification);

            let center = NSUserNotificationCenter::defaultUserNotificationCenter();
            center.deliverNotification(&notification);
            Ok(())
        })
    })
    .await
    .map_err(|err| format!("clickable desktop notification task failed: {err}"))?
}

#[cfg(target_os = "macos")]
async fn cancel_clickable_notification_impl(id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(app) = APP_HANDLE.get() else {
            return Ok(());
        };

        run_on_main_thread_sync(app, move || {
            remove_notification_with_identifier(&notification_identifier(id));
            Ok(())
        })
    })
    .await
    .map_err(|err| format!("clickable desktop notification cancel task failed: {err}"))?
}

#[cfg(target_os = "macos")]
fn run_on_main_thread_sync<F>(app: &tauri::AppHandle, f: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|err| format!("failed to schedule desktop notification main-thread work: {err}"))?;
    rx.recv()
        .map_err(|err| format!("desktop notification main-thread work did not complete: {err}"))?
}

#[cfg(target_os = "macos")]
fn configure_notification_application(app: &tauri::AppHandle) {
    if NOTIFICATION_APPLICATION_CONFIGURED.get().is_some() {
        return;
    }

    let bundle_identifier = if running_inside_app_bundle() {
        app.config().identifier.clone()
    } else {
        "com.apple.Terminal".to_string()
    };

    if let Err(err) = mac_notification_sys::set_application(&bundle_identifier) {
        eprintln!("failed to set desktop notification application to {bundle_identifier}: {err:?}");
    }
    let _ = NOTIFICATION_APPLICATION_CONFIGURED.set(());
}

#[cfg(target_os = "macos")]
fn install_notification_delegate() -> Result<(), String> {
    if NOTIFICATION_DELEGATE_INSTALLED.get().is_some() {
        return Ok(());
    }

    let Some(mtm) = MainThreadMarker::new() else {
        return Err(
            "failed to install desktop notification delegate off the main thread".to_string(),
        );
    };
    let center = NSUserNotificationCenter::defaultUserNotificationCenter();
    let delegate = DesktopNotificationDelegate::new(mtm);
    // SAFETY: The notification center keeps a weak delegate reference; the retained delegate is
    // intentionally leaked for the app lifetime below.
    unsafe {
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    }
    let _leaked_for_weak_delegate = Retained::into_raw(delegate);
    let _ = NOTIFICATION_DELEGATE_INSTALLED.set(());
    Ok(())
}

#[cfg(target_os = "macos")]
fn remove_notification_with_identifier(identifier: &str) {
    let center = NSUserNotificationCenter::defaultUserNotificationCenter();
    let delivered_notifications = center.deliveredNotifications();
    for index in 0..delivered_notifications.count() {
        let notification = delivered_notifications.objectAtIndex(index);
        if notification
            .identifier()
            .is_some_and(|notification_identifier| {
                notification_identifier.to_string() == identifier
            })
        {
            center.removeDeliveredNotification(&notification);
        }
    }
}

#[cfg(target_os = "macos")]
fn running_inside_app_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.to_str().map(str::to_owned))
        .is_some_and(|path| path.contains(".app/Contents/MacOS/"))
}

#[cfg(target_os = "macos")]
fn apply_notification_icon(notification: &NSUserNotification) {
    let Some(icon) = notification_icon_image() else {
        return;
    };

    // `NSUserNotification` does not publicly expose the left-side identity image. This mirrors
    // mac-notification-sys' existing implementation so camberqa notifications keep their icon.
    unsafe {
        let icon_object: &AnyObject = &icon;
        let has_border = NSNumber::numberWithBool(false);
        let has_border_object: &AnyObject = &has_border;
        notification.setValue_forKey(Some(icon_object), &NSString::from_str("_identityImage"));
        notification.setValue_forKey(
            Some(has_border_object),
            &NSString::from_str("_identityImageHasBorder"),
        );
    }
}

/// The app's live icon, including any tint applied by app_icon.rs.
///
/// Notification Center resolves the notification icon from its own per-bundle-id cache, which
/// keeps showing an outdated icon after the bundled app icon changes. Passing the running app's
/// current icon explicitly sidesteps that cache; AppKit renders it from the bundle's asset
/// catalog, so it also tracks the system icon appearance where supported.
#[cfg(target_os = "macos")]
pub(crate) fn notification_icon_image() -> Option<Retained<NSImage>> {
    // objc2-app-kit's typed NSApplication bindings need extra crate features; use the runtime
    // directly like dock.rs does.
    // SAFETY: only called on the main thread; the autoreleased icon is retained before use.
    unsafe {
        use objc2::class;

        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if app.is_null() {
            return None;
        }
        let icon: *mut AnyObject = msg_send![app, applicationIconImage];
        Retained::retain(icon.cast::<NSImage>())
    }
}

#[cfg(target_os = "macos")]
fn notification_identifier(id: u32) -> String {
    format!("{NOTIFICATION_IDENTIFIER_PREFIX}{id}")
}

#[cfg(target_os = "macos")]
fn notification_id_from_identifier(identifier: &str) -> Option<u32> {
    identifier
        .strip_prefix(NOTIFICATION_IDENTIFIER_PREFIX)?
        .parse()
        .ok()
}

#[cfg(target_os = "macos")]
fn focus_desktop_app(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.show() {
            eprintln!("failed to show desktop window from notification: {err}");
        }
        if let Err(err) = window.unminimize() {
            eprintln!("failed to unminimize desktop window from notification: {err}");
        }
        if let Err(err) = window.set_focus() {
            eprintln!("failed to focus desktop window from notification: {err}");
        }
    }

    if let Err(err) = app.run_on_main_thread(|| unsafe {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};

        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if !app.is_null() {
            let _: () = msg_send![app, activateIgnoringOtherApps: true];
        }
    }) {
        eprintln!("failed to schedule desktop app activation from notification: {err}");
    }
}

#[cfg(not(target_os = "macos"))]
async fn send_clickable_notification_impl(
    _app: tauri::AppHandle,
    _id: u32,
    _title: String,
    _body: String,
) -> Result<(), String> {
    Err(CLICKABLE_NOTIFICATIONS_UNSUPPORTED.to_string())
}

#[cfg(not(target_os = "macos"))]
async fn cancel_clickable_notification_impl(_id: u32) -> Result<(), String> {
    Err(CLICKABLE_NOTIFICATIONS_UNSUPPORTED.to_string())
}
