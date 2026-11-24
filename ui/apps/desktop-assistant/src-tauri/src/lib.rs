mod app_icon;
mod bundle_guard;
mod control;
mod desktop_notification;
mod desktop_openers;
mod dock;
mod file_tree_context_menu;
mod file_watcher;
mod helper;
mod native_dialog;
mod native_menu;
mod navigation;
mod settings;
mod shell_env;
mod startup_timing;
mod system_accent;
mod terminal;
#[cfg(unix)]
mod terminal_locale;
mod terminal_shell_integration;
mod updater;
#[cfg(target_os = "macos")]
mod window_chrome;
mod window_state;

use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    startup_timing::mark("native.runBegin");

    // Re-exec under a worktree-named hard link so the Dock-hover tooltip shows
    // the worktree name (the tooltip follows the executable filename). Must be
    // first: on success this replaces the process image.
    dock::rename_executable_for_dock();

    // Set the per-worktree dock/menu name before AppKit launches; once
    // NSApplication caches the name it can't be changed.
    dock::set_process_name();

    // Finder launches provide launchd's minimal environment; recover the
    // user's login-shell environment (PATH, EDITOR, ...) before anything —
    // openers detection, the helper sidecar, terminals — reads or inherits it.
    shell_env::apply_user_shell_env();
    startup_timing::mark("native.shellEnvApplied");

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
            .plugin(window_state::plugin())
            .menu(settings::build_menu)
            .on_menu_event(|app, event| {
                if event.id() == settings::OPEN_SETTINGS_MENU_ID {
                    if let Err(err) = app.emit(settings::OPEN_SETTINGS_PANEL_EVENT, ()) {
                        eprintln!("failed to open settings panel: {err}");
                    }
                } else if event.id() == settings::OPEN_HELPER_LOGS_MENU_ID {
                    if let Err(err) = helper::open_helper_logs(app) {
                        eprintln!("failed to open helper logs: {err}");
                    }
                } else if let Some(theme_preference) =
                    settings::theme_preference_for_menu_id(event.id().as_ref())
                {
                    settings::set_desktop_theme_preference_from_menu(app.clone(), theme_preference);
                } else if event.id() == settings::NEW_CONVERSATION_MENU_ID {
                    if let Err(err) = app.emit(settings::NEW_CONVERSATION_EVENT, ()) {
                        eprintln!("failed to emit new conversation command: {err}");
                    }
                } else if event.id() == settings::NEW_PROJECT_MENU_ID {
                    if let Err(err) = app.emit(settings::NEW_PROJECT_EVENT, ()) {
                        eprintln!("failed to emit new project command: {err}");
                    }
                } else if event.id() == settings::OPEN_IN_IDE_MENU_ID {
                    if let Err(err) = app.emit(settings::OPEN_IN_IDE_EVENT, ()) {
                        eprintln!("failed to emit open in IDE command: {err}");
                    }
                } else if event.id() == settings::NEW_TAB_MENU_ID {
                    if let Err(err) = app.emit(settings::NEW_TAB_EVENT, ()) {
                        eprintln!("failed to emit new tab command: {err}");
                    }
                } else if event.id() == settings::CLOSE_TAB_MENU_ID {
                    if let Err(err) = navigation::handle_close_shortcut(app) {
                        eprintln!("failed to handle close shortcut: {err}");
                    }
                } else if event.id() == settings::REOPEN_CLOSED_TAB_MENU_ID {
                    if let Err(err) = app.emit(settings::REOPEN_CLOSED_TAB_EVENT, ()) {
                        eprintln!("failed to emit reopen closed tab command: {err}");
                    }
                } else if event.id() == settings::SPLIT_RIGHT_MENU_ID {
                    if let Err(err) = app.emit(settings::SPLIT_RIGHT_EVENT, ()) {
                        eprintln!("failed to emit split right command: {err}");
                    }
                } else if event.id() == settings::SPLIT_DOWN_MENU_ID {
                    if let Err(err) = app.emit(settings::SPLIT_DOWN_EVENT, ()) {
                        eprintln!("failed to emit split down command: {err}");
                    }
                } else if event.id() == settings::TOGGLE_LEFT_SIDEBAR_MENU_ID {
                    if let Err(err) = app.emit(settings::TOGGLE_LEFT_SIDEBAR_EVENT, ()) {
                        eprintln!("failed to emit toggle left sidebar command: {err}");
                    }
                } else if event.id() == settings::TOGGLE_RIGHT_SIDEBAR_MENU_ID {
                    if let Err(err) = app.emit(settings::TOGGLE_RIGHT_SIDEBAR_EVENT, ()) {
                        eprintln!("failed to emit toggle right sidebar command: {err}");
                    }
                } else if event.id() == settings::TOGGLE_BOTTOM_PANEL_MENU_ID {
                    if let Err(err) = app.emit(settings::TOGGLE_BOTTOM_PANEL_EVENT, ()) {
                        eprintln!("failed to emit toggle bottom panel command: {err}");
                    }
                } else if event.id() == settings::SELECT_PREVIOUS_TAB_MENU_ID {
                    if let Err(err) = app.emit(settings::SELECT_PREVIOUS_TAB_EVENT, ()) {
                        eprintln!("failed to emit select previous tab command: {err}");
                    }
                } else if event.id() == settings::SELECT_NEXT_TAB_MENU_ID {
                    if let Err(err) = app.emit(settings::SELECT_NEXT_TAB_EVENT, ()) {
                        eprintln!("failed to emit select next tab command: {err}");
                    }
                } else if event.id() == settings::SAVE_LAYOUT_AS_DEFAULT_MENU_ID {
                    if let Err(err) = app.emit(settings::SAVE_LAYOUT_AS_DEFAULT_EVENT, ()) {
                        eprintln!("failed to emit save layout as default command: {err}");
                    }
                } else if event.id() == settings::NAVIGATE_BACK_MENU_ID {
                    if let Err(err) = app.emit(settings::NAVIGATE_BACK_EVENT, ()) {
                        eprintln!("failed to emit navigate back command: {err}");
                    }
                } else if event.id() == settings::NAVIGATE_FORWARD_MENU_ID {
                    if let Err(err) = app.emit(settings::NAVIGATE_FORWARD_EVENT, ()) {
                        eprintln!("failed to emit navigate forward command: {err}");
                    }
                } else if event.id() == settings::CHECK_FOR_UPDATES_MENU_ID {
                    if let Err(err) = app.emit(settings::CHECK_FOR_UPDATES_EVENT, ()) {
                        eprintln!("failed to emit check for updates command: {err}");
                    }
                } else if event.id() == settings::CHANGELOG_MENU_ID {
                    if let Err(err) = navigation::open_changelog_window(app) {
                        eprintln!("failed to open Changelog window: {err}");
                    }
                }
            });
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_shell::init())
        .manage(file_watcher::FileWatcherState::default())
        .manage(helper::HelperState::default())
        .manage(control::ControlState::default())
        .manage(terminal::TerminalState::default())
        .manage(updater::DesktopUpdaterState::default())
        .invoke_handler(tauri::generate_handler![
            desktop_notification::cancel_clickable_notification,
            desktop_notification::send_clickable_notification,
            helper::helper_jsonrpc,
            helper::helper_jsonrpc_notify,
            helper::helper_jsonrpc_notification_batch_ack,
            helper::helper_jsonrpc_notification_bridge_ready,
            helper::helper_jsonrpc_respond,
            helper::helper_logs,
            helper::record_startup_diagnostic,
            helper::restart_helper,
            helper::restart_helper_debug,
            helper::show_helper_logs,
            native_dialog::show_confirm_dialog,
            native_dialog::show_error_dialog,
            native_menu::file_icon_png,
            native_menu::show_native_menu,
            navigation::open_changelog,
            navigation::open_third_party_licenses,
            settings::get_desktop_settings,
            settings::refresh_desktop_openers_cache,
            settings::take_pending_update_announcement,
            settings::set_desktop_theme_preference,
            settings::set_desktop_chat_preferences,
            settings::set_desktop_code_preferences,
            settings::set_desktop_terminal_preferences,
            settings::set_desktop_tool_activity,
            settings::set_desktop_steer_with_enter,
            settings::set_desktop_window_vibrancy,
            settings::set_desktop_app_icon_tint,
            settings::set_desktop_update_channel,
            settings::set_desktop_auto_install_updates,
            system_accent::get_system_accent_colors,
            bundle_guard::desktop_bundle_replaced,
            updater::check_and_stage_desktop_update,
            updater::install_staged_desktop_update,
            updater::switch_desktop_to_stable,
            settings::set_desktop_file_opener,
            settings::set_navigation_menu_enabled,
            settings::open_external_url,
            settings::check_file_exists,
            settings::write_text_file,
            settings::open_file,
            settings::open_assistant_config_with_opener,
            settings::open_path_with_opener,
            settings::read_text_file,
            settings::list_directory_tree,
            settings::list_directory_subtree,
            settings::get_image_file_data,
            file_tree_context_menu::file_url_pasteboard_has_files,
            file_tree_context_menu::reveal_path_in_finder,
            file_tree_context_menu::write_file_url_to_pasteboard,
            file_tree_context_menu::write_text_to_pasteboard,
            file_tree_context_menu::write_image_data_to_pasteboard,
            file_tree_context_menu::write_image_to_pasteboard,
            file_tree_context_menu::trash_path,
            file_tree_context_menu::paste_files_into_directory,
            terminal::list_assistant_terminals,
            terminal::create_assistant_terminal,
            terminal::write_assistant_terminal,
            terminal::clear_assistant_terminal,
            terminal::resize_assistant_terminal,
            terminal::delete_assistant_terminal,
            terminal::close_assistant_terminals_for_worktree,
            terminal::close_assistant_terminals_for_project,
        ])
        .setup(|app| {
            startup_timing::mark("native.setupBegin");

            // Sampled before anything can replace the bundle on disk; the file
            // panels in rpc/host.ts consult it (see bundle_guard.rs).
            bundle_guard::record_launch_identity();

            // Self-updater (CrabNebula Cloud feed). Desktop-only; the JS side in
            // src/updater.ts drives the check/download, then the Update button
            // installs the staged download and relaunches.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            navigation::create_main_window(app)?;
            startup_timing::mark("native.windowCreated");
            settings::warm_boot_caches(app.handle());
            settings::sync_theme_menu_items_from_settings(app.handle());
            system_accent::observe_system_accent_changes(app.handle());

            // Apply the per-worktree dock icon tint for camberqa launches.
            // Re-applied on RunEvent::Ready below so it survives the platform's
            // own icon setup during launch.
            dock::set_dock_icon(app.handle());
            settings::apply_app_icon_tint_from_settings(app.handle());

            control::start_on_setup(app);
            helper::start_on_setup(app);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Camber");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::Ready => {
            startup_timing::mark("native.appReady");
            dock::set_dock_icon(app_handle);
            settings::apply_app_icon_tint_from_settings(app_handle);
        }
        tauri::RunEvent::ExitRequested { .. } => {
            use tauri::Manager;
            app_handle.state::<control::ControlState>().shutdown();
            helper::shutdown_from_run_event(app_handle);
        }
        // macOS open-URL events (e.g. camber:// deep links). Tauri v2 delivers
        // these via RunEvent::Opened when the app is already running or at launch.
        // We focus the main window and forward the URLs to the webview so the
        // frontend can react (auth callbacks, navigation targets, etc.).
        tauri::RunEvent::Opened { urls } => {
            use tauri::Manager;

            let mut forwarded_urls = Vec::new();
            for url in urls {
                if navigation::is_third_party_licenses_deep_link(&url) {
                    if let Err(err) = navigation::open_third_party_licenses_window(app_handle) {
                        eprintln!("failed to open Third Party Licenses window: {err}");
                    }
                } else if navigation::is_changelog_deep_link(&url) {
                    if let Err(err) = navigation::open_changelog_window(app_handle) {
                        eprintln!("failed to open Changelog window: {err}");
                    }
                } else {
                    forwarded_urls.push(url.to_string());
                }
            }

            if !forwarded_urls.is_empty() {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                if let Err(err) = app_handle.emit(settings::DEEP_LINK_EVENT, &forwarded_urls) {
                    eprintln!("failed to emit deep-link event: {err}");
                }
            }
        }
        _ => {}
    });
}
