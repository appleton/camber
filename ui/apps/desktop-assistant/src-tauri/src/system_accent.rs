//! The user's macOS accent colour, bridged into the webview.
//!
//! WebKit does not expose the accent to CSS: `AccentColor`,
//! `-webkit-focus-ring-color` and `Highlight` are all hardcoded blue in
//! WKWebView and stay blue when the user picks another accent in System
//! Settings. So the colours are read from AppKit here and pushed across as CSS
//! custom properties (see src/desktopAccent.ts).
//!
//! Rather than send one accent and derive tints in CSS, mirror the AppKit
//! colours that already carry Apple's own derivations:
//!
//! - `controlAccentColor` — the accent itself, for focus rings, switches and
//!   badges.
//! - `selectedTextBackgroundColor` — the tinted selection fill. Follows the
//!   separate "Highlight colour" setting, which tracks the accent unless the
//!   user overrides it, so it is read rather than mixed from the accent.
//!
//! Both are resolved under each appearance because they differ: a purple accent
//! is #953D96 in light and #A550A7 in dark. Sending both pairs lets the
//! stylesheet switch with the theme class instead of re-reading on every
//! appearance change.
//!
//! On-accent text (`foreground`) is computed here rather than taken from AppKit
//! or from CSS. `alternateSelectedControlTextColor` returns white for every
//! accent, including yellow (#FFC726) where white-on-accent is about 1.6:1. CSS
//! `contrast-color()` is no better: it maximises contrast, so it picks black on
//! the default blue (#007AFF gives 4.6:1 black against 4.5:1 white) where macOS
//! draws white. A luminance threshold reproduces what AppKit actually does —
//! white on every stock accent except yellow.

use serde::Serialize;
use tauri::AppHandle;

pub const SYSTEM_ACCENT_CHANGED_EVENT: &str = "camber:desktop-system-accent-changed";

/// The accent-derived colours for both appearances. `None` off macOS, where
/// there is no system accent to follow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAccentColors {
    light: SystemAccentPalette,
    dark: SystemAccentPalette,
}

/// One appearance's worth of accent colours, as CSS colour strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAccentPalette {
    /// `NSColor.controlAccentColor`.
    accent: String,
    /// Black or white, whichever AppKit would draw on top of `accent`.
    foreground: String,
    /// `NSColor.selectedTextBackgroundColor`.
    selection: String,
}

#[tauri::command]
pub fn get_system_accent_colors() -> Option<SystemAccentColors> {
    read_system_accent_colors()
}

/// An sRGB colour read off an `NSColor`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
struct Srgb {
    red: u8,
    green: u8,
    blue: u8,
    alpha: f64,
}

impl Srgb {
    /// Renders as a CSS colour. Both bridged colours are opaque today, but the
    /// alpha is emitted rather than silently dropped if that ever changes.
    fn to_css(self) -> String {
        let Self {
            red,
            green,
            blue,
            alpha,
        } = self;
        if alpha >= 1.0 {
            format!("#{red:02x}{green:02x}{blue:02x}")
        } else {
            format!("rgb({red} {green} {blue} / {:.1}%)", alpha * 100.0)
        }
    }

    /// WCAG relative luminance.
    fn relative_luminance(self) -> f64 {
        let linear = |channel: u8| {
            let value = f64::from(channel) / 255.0;
            if value <= 0.040_45 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * linear(self.red) + 0.7152 * linear(self.green) + 0.0722 * linear(self.blue)
    }
}

/// Black or white for text drawn on `accent`, matching what AppKit draws: white
/// on every stock accent (blue, purple, pink, red, orange, green, graphite) and
/// black only on yellow, which is the one light enough to need it. A plain
/// luminance threshold rather than a contrast maximiser, which would flip the
/// default blue to black — see the module comment.
const ON_ACCENT_LUMINANCE_THRESHOLD: f64 = 0.5;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn on_accent_color(accent: Srgb) -> &'static str {
    if accent.relative_luminance() > ON_ACCENT_LUMINANCE_THRESHOLD {
        "#000000"
    } else {
        "#ffffff"
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Srgb, SystemAccentColors, SystemAccentPalette, SYSTEM_ACCENT_CHANGED_EVENT};
    use block2::{RcBlock, StackBlock};
    use objc2_app_kit::{
        NSAppearance, NSAppearanceName, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSColor,
        NSColorSpace, NSSystemColorsDidChangeNotification,
    };
    use objc2_foundation::{NSNotificationCenter, NSOperationQueue};
    use std::cell::RefCell;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};

    /// Keeps the notification observer alive for the process lifetime. Removing
    /// the token would deregister the observer, and the accent must stay live
    /// for as long as the window is up.
    static ACCENT_OBSERVER: OnceLock<()> = OnceLock::new();

    pub fn read_system_accent_colors() -> Option<SystemAccentColors> {
        Some(SystemAccentColors {
            light: palette_for_appearance(unsafe { NSAppearanceNameAqua })?,
            dark: palette_for_appearance(unsafe { NSAppearanceNameDarkAqua })?,
        })
    }

    /// Emits [`SYSTEM_ACCENT_CHANGED_EVENT`] whenever the user changes the
    /// accent or highlight colour in System Settings. AppKit posts
    /// `NSSystemColorsDidChangeNotification` in-process once it has picked up
    /// the change, so there is no need to watch the distributed centre.
    pub fn observe_system_accent_changes(app_handle: &AppHandle) {
        if ACCENT_OBSERVER.set(()).is_err() {
            return;
        }

        let app_handle = app_handle.clone();
        let block = RcBlock::new(move |_notification| {
            let Some(colors) = read_system_accent_colors() else {
                return;
            };
            if let Err(err) = app_handle.emit(SYSTEM_ACCENT_CHANGED_EVENT, colors) {
                eprintln!("failed to emit system accent change: {err}");
            }
        });

        // SAFETY: the name and queue are valid AppKit globals, and the block is
        // an RcBlock that outlives the observer because both are leaked below.
        let observer = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSSystemColorsDidChangeNotification),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        };
        // The observer token and its block are intentionally leaked: the
        // observer lives as long as the process.
        std::mem::forget(observer);
        std::mem::forget(block);
    }

    /// Resolves the accent colours as the named appearance would draw them.
    /// `performAsCurrentDrawingAppearance` sets the drawing appearance for the
    /// duration of the block on the calling thread only, so this is safe to do
    /// without disturbing anything the window is drawing.
    fn palette_for_appearance(name: &NSAppearanceName) -> Option<SystemAccentPalette> {
        let appearance = NSAppearance::appearanceNamed(name)?;
        let palette: RefCell<Option<SystemAccentPalette>> = RefCell::new(None);

        appearance.performAsCurrentDrawingAppearance(&StackBlock::new(|| {
            let accent = srgb_color(&NSColor::controlAccentColor());
            let selection = srgb_color(&NSColor::selectedTextBackgroundColor());
            if let (Some(accent), Some(selection)) = (accent, selection) {
                *palette.borrow_mut() = Some(SystemAccentPalette {
                    foreground: super::on_accent_color(accent).to_string(),
                    accent: accent.to_css(),
                    selection: selection.to_css(),
                });
            }
        }));

        palette.into_inner()
    }

    /// Reads an `NSColor` as sRGB components. The conversion is required before
    /// touching the component accessors, which raise on catalog colours.
    fn srgb_color(color: &NSColor) -> Option<Srgb> {
        let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
        Some(Srgb {
            red: channel(srgb.redComponent()),
            green: channel(srgb.greenComponent()),
            blue: channel(srgb.blueComponent()),
            alpha: srgb.alphaComponent().clamp(0.0, 1.0),
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::SystemAccentColors;
    use tauri::AppHandle;

    pub fn read_system_accent_colors() -> Option<SystemAccentColors> {
        None
    }

    pub fn observe_system_accent_changes(_app_handle: &AppHandle) {}
}

pub use platform::read_system_accent_colors;

pub fn observe_system_accent_changes(app_handle: &AppHandle) {
    platform::observe_system_accent_changes(app_handle);
}

#[cfg(test)]
mod tests {
    use super::{on_accent_color, Srgb};

    fn opaque(red: u8, green: u8, blue: u8) -> Srgb {
        Srgb {
            red,
            green,
            blue,
            alpha: 1.0,
        }
    }

    /// The eight stock macOS accents, measured from `NSColor.controlAccentColor`
    /// under the light appearance (`AppleAccentColor` 0-6 and -1 for graphite).
    /// Every one takes white except yellow, which is what AppKit itself draws.
    #[test]
    fn on_accent_color_matches_appkit_for_stock_accents() {
        for (accent, expected, name) in [
            (opaque(0xe0, 0x38, 0x3e), "#ffffff", "red"),
            (opaque(0xf7, 0x82, 0x1b), "#ffffff", "orange"),
            (opaque(0xff, 0xc7, 0x26), "#000000", "yellow"),
            (opaque(0x62, 0xba, 0x46), "#ffffff", "green"),
            (opaque(0x00, 0x7a, 0xff), "#ffffff", "blue"),
            (opaque(0x95, 0x3d, 0x96), "#ffffff", "purple"),
            (opaque(0xf7, 0x4f, 0x9e), "#ffffff", "pink"),
            (opaque(0x98, 0x98, 0x98), "#ffffff", "graphite"),
        ] {
            assert_eq!(on_accent_color(accent), expected, "{name} accent");
        }
    }

    /// A contrast maximiser would pick black here (4.6:1 against white's 4.5:1);
    /// macOS draws white, and so must we, because it is the default accent.
    #[test]
    fn on_accent_color_keeps_white_on_the_default_blue() {
        assert_eq!(on_accent_color(opaque(0x00, 0x7a, 0xff)), "#ffffff");
    }

    #[test]
    fn to_css_emits_hex_for_opaque_colors() {
        assert_eq!(opaque(0x00, 0x7a, 0xff).to_css(), "#007aff");
        assert_eq!(opaque(0xb3, 0xd7, 0xff).to_css(), "#b3d7ff");
    }

    #[test]
    fn to_css_keeps_alpha_when_a_color_is_translucent() {
        let translucent = Srgb {
            red: 0x84,
            green: 0x26,
            blue: 0x85,
            alpha: 0.5,
        };
        assert_eq!(translucent.to_css(), "rgb(132 38 133 / 50.0%)");
    }
}
