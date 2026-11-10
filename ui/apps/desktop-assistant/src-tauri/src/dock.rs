//! Per-worktree dock identity for camberqa-launched desktop instances.
//!
//! The app icon is compiled into the binary via `generate_context!()`, so the
//! `--config` overlay camberqa passes cannot change it. When several worktree
//! instances run side by side we instead set the dock icon and the dock-hover
//! (process) name at runtime from environment variables provided by camberqa:
//!
//!   CAMBERQA_DOCK_ICON_COLOR  hex colour the app icon is tinted with
//!   CAMBERQA_APP_NAME         name shown in the menu bar / when hovering the dock
//!
//! A normal (non-camberqa) launch sets neither, so the shipped purple icon and
//! "Camber" name are left untouched. The recolouring itself lives in
//! app_icon.rs, shared with the user-facing icon tint setting.

use tauri::AppHandle;

/// Make the Dock-hover tooltip show the worktree name.
///
/// For an unbundled `tauri dev` binary, macOS derives the Dock tooltip from the
/// executable's filename on disk (the resolved path basename — `desktop-assistant`),
/// which `setProcessName` and `CFBundleName` overrides do not affect. To change
/// it we re-exec the process once through a hard link named after the worktree,
/// so the kernel's executable path basename becomes that name. Hard links are
/// cheap (no copy) and live in the same directory as the build, so they share a
/// filesystem with the original.
///
/// Best effort and idempotent: a guard env var prevents an exec loop, and any
/// failure falls through to run normally under the original name. Must be the
/// first thing in `run()`, before AppKit (and anything else) starts.
pub fn rename_executable_for_dock() {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        use std::process::Command;

        if std::env::var_os("CAMBERQA_DOCK_REEXEC").is_some() {
            return; // already re-exec'd
        }
        let name = match std::env::var("CAMBERQA_APP_NAME") {
            Ok(value) if !value.is_empty() => value.replace('/', "-"),
            _ => return,
        };
        let exe = match std::env::current_exe() {
            Ok(path) => path,
            Err(_) => return,
        };
        if exe.file_name().and_then(|n| n.to_str()) == Some(name.as_str()) {
            return; // already running under the desired name
        }
        let Some(dir) = exe.parent() else {
            return;
        };
        let link = dir.join(&name);
        // Refresh the link so it always points at the current build.
        let _ = std::fs::remove_file(&link);
        if std::fs::hard_link(&exe, &link).is_err() {
            return;
        }
        let err = Command::new(&link)
            .args(std::env::args_os().skip(1))
            .env("CAMBERQA_DOCK_REEXEC", "1")
            .exec();
        // exec() only returns on failure; continue with the original image.
        eprintln!("camberqa: dock re-exec failed: {err}");
    }
}

/// Set the process name used by the Dock and menu bar.
///
/// Must run **before** AppKit finishes launching — once `NSApplication` caches
/// the name (from the compiled-in `CFBundleName`) it is too late, which is why
/// this is called as the very first thing in `run()`, before the Tauri builder.
/// macOS only; a no-op elsewhere.
pub fn set_process_name() {
    #[cfg(target_os = "macos")]
    {
        if let Ok(name) = std::env::var("CAMBERQA_APP_NAME") {
            if !name.is_empty() {
                use objc2::runtime::AnyObject;
                use objc2::{class, msg_send, sel};
                use objc2_foundation::NSString;

                let ns_name = NSString::from_str(&name);
                unsafe {
                    // Process name — Activity Monitor, crash reports, some menus.
                    let process_info: *mut AnyObject =
                        msg_send![class!(NSProcessInfo), processInfo];
                    if !process_info.is_null() {
                        let _: () = msg_send![process_info, setProcessName: &*ns_name];
                    }

                    // Bundle display name — this is what the menu bar and Dock
                    // actually show. In `tauri dev` there is no .app wrapper, so
                    // without this AppKit falls back to the executable name
                    // ("desktop-assistant"). The main bundle's info dictionary is
                    // mutable, so we override it before AppKit reads it.
                    let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
                    if !bundle.is_null() {
                        let info: *mut AnyObject = msg_send![bundle, infoDictionary];
                        if !info.is_null() {
                            // Guard: only mutate if the dictionary is actually
                            // mutable, otherwise the message would raise.
                            let mutable: bool =
                                msg_send![info, respondsToSelector: sel!(setObject:forKey:)];
                            if mutable {
                                let key_name = NSString::from_str("CFBundleName");
                                let key_display = NSString::from_str("CFBundleDisplayName");
                                let _: () =
                                    msg_send![info, setObject: &*ns_name, forKey: &*key_name];
                                let _: () =
                                    msg_send![info, setObject: &*ns_name, forKey: &*key_display];
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Tint the dock icon from `CAMBERQA_DOCK_ICON_COLOR`. Safe to call after the
/// app has launched (Tauri `setup` and `RunEvent::Ready` both run on the main
/// thread). macOS only; a no-op elsewhere.
pub fn set_dock_icon(app_handle: &AppHandle) {
    if let Some(color) = crate::app_icon::camberqa_tint() {
        crate::app_icon::apply_color(app_handle, Some(color));
    }
}
