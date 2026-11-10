//! Runtime correction for the legacy macOS traffic light inset (macOS <=15).
//!
//! `trafficLightPosition` in `tauri.conf.json` is implemented by tao/wry by
//! re-framing `NSTitlebarContainerView` around the standard window buttons.
//! That math places the buttons' visual center `y - frame.y + height / 2`
//! points below the top of the window, where `frame.y`/`height` are the
//! native metrics of the close button inside the titlebar view. The configured
//! `y: 26` is tuned for Tahoe chrome and is the source-of-truth position.
//!
//! Production builds patch the Mach-O SDK metadata to 26.0
//! (`scripts/set-macos-build-sdk.mjs`), so on macOS 26 AppKit activates the
//! Tahoe "Liquid Glass" chrome whose buttons are smaller and sit lower in the
//! titlebar view. Measured metrics per chrome (close button):
//!
//! | chrome              | frame.y | height | center for y: 26    |
//! | ------------------- | ------- | ------ | ------------------- |
//! | legacy (macOS <=15) | 6       | 16     | 26 - 6 + 8 = 28pt   |
//! | Tahoe (macOS 26)    | 9       | 14     | 26 - 9 + 7 = 24pt   |
//!
//! The legacy artwork needs its own optical correction relative to the Tahoe
//! default. Its initial -1pt offset preserves the previous effective `y: 25`
//! placement. Set `CAMBER_LEGACY_TRAFFIC_LIGHT_Y_OFFSET` to try other values
//! at launch (run the app binary directly; `open` does not forward the
//! environment).
//!
//! Which chrome is active depends on both the OS version and the *linked SDK*
//! of the running binary (Apple gates the new chrome on SDK >= 26), so an OS
//! version check would mis-handle dev builds linked against an older SDK
//! running on macOS 26. Instead we measure the active chrome directly:
//! `+[NSWindow standardWindowButton:forStyleMask:]` returns a 14pt-high close
//! button under Tahoe chrome and a 16pt-high one under the legacy chrome.

use objc2::runtime::AnyObject;
use objc2::{class, msg_send, MainThreadMarker};
use objc2_foundation::NSRect;
use tauri::utils::config::{LogicalPosition, WindowConfig};

/// Preserves the legacy chrome's previous effective `y: 25` position while the
/// configured Tahoe-default position is `y: 26`.
const LEGACY_TRAFFIC_LIGHT_Y_OFFSET: f64 = -4.0;

/// Launch-time override for [`LEGACY_TRAFFIC_LIGHT_Y_OFFSET`], for tuning the
/// offset against real builds without recompiling.
const LEGACY_Y_OFFSET_ENV: &str = "CAMBER_LEGACY_TRAFFIC_LIGHT_Y_OFFSET";

/// Close button height that separates Tahoe chrome (14pt) from the legacy
/// chrome (16pt).
const TAHOE_CLOSE_BUTTON_MAX_HEIGHT: f64 = 15.0;

/// `NSWindowButton::NSWindowCloseButton`.
const NS_WINDOW_CLOSE_BUTTON: usize = 0;

/// `NSWindowStyleMask` titled | closable | miniaturizable | resizable — the
/// mask of the main window, so the probe measures the same button set.
const MAIN_WINDOW_STYLE_MASK: usize = 0b1111;

/// Corrects `trafficLightPosition` for the active window chrome. Must run on
/// the main thread before the main window is built; the corrected config
/// feeds both tao's window-builder inset and wry's `drawRect` reapplication.
pub fn adjust_traffic_light_position(config: &mut WindowConfig) {
    let Some(position) = config.traffic_light_position.as_ref() else {
        return;
    };

    if !legacy_window_chrome_active() {
        return;
    }

    config.traffic_light_position = Some(legacy_traffic_light_position(position));
}

fn legacy_traffic_light_position(position: &LogicalPosition) -> LogicalPosition {
    LogicalPosition {
        x: position.x,
        y: position.y + legacy_y_offset(),
    }
}

fn legacy_y_offset() -> f64 {
    y_offset_from_env(std::env::var(LEGACY_Y_OFFSET_ENV).ok().as_deref())
}

fn y_offset_from_env(value: Option<&str>) -> f64 {
    value
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|offset| offset.is_finite())
        .unwrap_or(LEGACY_TRAFFIC_LIGHT_Y_OFFSET)
}

fn legacy_window_chrome_active() -> bool {
    close_button_height().is_some_and(|height| !is_tahoe_close_button_height(height))
}

fn is_tahoe_close_button_height(height: f64) -> bool {
    height < TAHOE_CLOSE_BUTTON_MAX_HEIGHT
}

/// Measures the standard close button height for the main window's style mask
/// without creating a window. Returns `None` off the main thread (AppKit is
/// main-thread-only; the Tahoe-default position is retained) or if AppKit does
/// not vend a button (never expected for a titled mask).
fn close_button_height() -> Option<f64> {
    MainThreadMarker::new()?;

    unsafe {
        let button: *mut AnyObject = msg_send![
            class!(NSWindow),
            standardWindowButton: NS_WINDOW_CLOSE_BUTTON,
            forStyleMask: MAIN_WINDOW_STYLE_MASK
        ];
        if button.is_null() {
            return None;
        }
        let frame: NSRect = msg_send![button, frame];
        Some(frame.size.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_position(position: Option<LogicalPosition>) -> WindowConfig {
        WindowConfig {
            traffic_light_position: position,
            ..Default::default()
        }
    }

    #[test]
    fn shifts_the_configured_inset_by_the_legacy_offset() {
        let adjusted = legacy_traffic_light_position(&LogicalPosition { x: 16.0, y: 26.0 });
        assert_eq!(adjusted.x, 16.0);
        assert_eq!(adjusted.y, 26.0 + LEGACY_TRAFFIC_LIGHT_Y_OFFSET);
    }

    #[test]
    fn parses_the_env_override_and_falls_back_to_the_default() {
        assert_eq!(y_offset_from_env(Some("3.5")), 3.5);
        assert_eq!(y_offset_from_env(Some(" -2 ")), -2.0);
        assert_eq!(
            y_offset_from_env(Some("nope")),
            LEGACY_TRAFFIC_LIGHT_Y_OFFSET
        );
        assert_eq!(
            y_offset_from_env(Some("inf")),
            LEGACY_TRAFFIC_LIGHT_Y_OFFSET
        );
        assert_eq!(y_offset_from_env(None), LEGACY_TRAFFIC_LIGHT_Y_OFFSET);
    }

    #[test]
    fn detects_tahoe_chrome_from_the_close_button_height() {
        assert!(is_tahoe_close_button_height(14.0));
        assert!(!is_tahoe_close_button_height(16.0));
    }

    #[test]
    fn leaves_configs_without_a_traffic_light_position_unchanged() {
        let mut config = config_with_position(None);
        adjust_traffic_light_position(&mut config);
        assert_eq!(config.traffic_light_position, None);
    }
}
