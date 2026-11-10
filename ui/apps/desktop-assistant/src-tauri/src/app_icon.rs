//! Runtime recolouring of the app icon.
//!
//! The icon ships as an Icon Composer asset (`icons/icon.icon`, compiled to
//! `Assets.car`), and nothing in AppKit will re-render that catalog with a
//! different plate colour. Rather than ship a pre-rendered PNG per colour, we
//! take the icon macOS itself renders for our bundle — liquid glass, mask and
//! all — and rotate its hue to the chosen colour.
//!
//! Hue rotation is the right operation for this artwork: the parasol glyph is
//! near-white glass with almost no saturation, so it comes through untouched,
//! while the saturated plate carries all of the colour. Saturation is rescaled
//! to the target's own so the mid-dark camberqa colours don't land as pastel
//! versions of the brand purple. The user-facing green and cyan tints also
//! lower the plate's value slightly without dulling the glass.
//!
//! Only the running app's icon changes — Dock, app switcher, and (via
//! desktop_notification.rs) notifications. The bundle on disk is never touched,
//! so Finder and Launchpad keep showing the shipped purple icon.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// The Dock never draws the icon larger than this.
#[cfg(target_os = "macos")]
const ICON_SIZE: usize = 512;

/// A tint the user can apply to the app icon.
///
/// The colours are based on `SLOT_COLORS` in
/// `ui/packages/camberqa/src/worktree/shared.ts`. Green and cyan are darkened
/// slightly for the user-facing palette.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppIconTint {
    #[default]
    #[serde(alias = "purple")]
    Default,
    Blue,
    Green,
    Pink,
    Orange,
    Yellow,
    Cyan,
    Red,
}

impl AppIconTint {
    /// `None` for [`AppIconTint::Default`], which is the shipped icon as-is.
    pub fn color(self) -> Option<&'static str> {
        match self {
            Self::Default => None,
            Self::Blue => Some("#2563eb"),
            Self::Green => Some("#18794e"),
            Self::Pink => Some("#db2777"),
            Self::Orange => Some("#ea580c"),
            Self::Yellow => Some("#ca8a04"),
            Self::Cyan => Some("#0891b2"),
            Self::Red => Some("#dc2626"),
        }
    }

    fn brightness(self) -> f32 {
        match self {
            Self::Green => 0.80,
            Self::Cyan => 0.86,
            _ => 1.0,
        }
    }
}

/// Apply the user's chosen `tint`. Best effort; macOS only.
///
/// A camberqa launch tints the icon per worktree so a fleet of instances stays
/// tellable apart, and that has to win over a personal preference — otherwise
/// every window in the fleet goes back to looking identical.
pub fn apply(app_handle: &AppHandle, tint: AppIconTint) {
    if camberqa_tint().is_some() {
        return;
    }
    apply_tint(
        app_handle,
        tint.color().map(str::to_owned),
        tint.brightness(),
    );
}

/// Tint the icon with an arbitrary colour, or restore the shipped icon with
/// `None`. Used for the per-worktree camberqa icons, whose colours come from
/// the slot palette rather than this enum.
pub fn apply_color(app_handle: &AppHandle, color: Option<String>) {
    apply_tint(app_handle, color, 1.0);
}

fn apply_tint(app_handle: &AppHandle, color: Option<String>, brightness: f32) {
    on_main_thread(app_handle, move || {
        platform::apply(color.as_deref(), brightness)
    });
}

/// The colour camberqa launched this instance with, if any.
pub fn camberqa_tint() -> Option<String> {
    std::env::var("CAMBERQA_DOCK_ICON_COLOR")
        .ok()
        .filter(|value| !value.is_empty())
}

/// AppKit image work has to happen on the main thread; Tauri commands do not.
fn on_main_thread<F: FnOnce() + Send + 'static>(app_handle: &AppHandle, work: F) {
    if let Err(err) = app_handle.run_on_main_thread(work) {
        eprintln!("failed to schedule app icon work on the main thread: {err}");
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn apply(_color: Option<&str>, _brightness: f32) {}
}

#[cfg(target_os = "macos")]
mod platform {
    use super::ICON_SIZE;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, AllocAnyThread};
    use objc2_app_kit::{
        NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace, NSGraphicsContext,
        NSImage, NSWorkspace,
    };
    use objc2_foundation::{NSData, NSPoint, NSRect, NSSize, NSString};

    /// The icon Tauri bundles, embedded so an unbundled `tauri dev` build — what
    /// camberqa launches — still has artwork to tint.
    const EMBEDDED_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

    /// Apple's icon grid puts the artwork in an 824px area on a 1024px canvas.
    /// A bundle-rendered icon already carries that inset; the embedded PNG is
    /// full-bleed, so it needs the padding added or the Dock draws it larger
    /// than every neighbouring app.
    const MACOS_SAFE_AREA_RATIO: f64 = 824.0 / 1024.0;

    pub fn apply(color: Option<&str>, brightness: f32) {
        let image = match color {
            None => None,
            Some(color) => match tinted_icon(color, ICON_SIZE, brightness) {
                Some(image) => Some(image),
                // Nothing to recolour: leave the icon be rather than blanking it.
                None => return,
            },
        };

        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if app.is_null() {
                return;
            }
            // Passing nil restores the icon compiled into the bundle.
            let icon: *const NSImage = image
                .as_deref()
                .map_or(std::ptr::null(), |image| image as *const NSImage);
            let _: () = msg_send![app, setApplicationIconImage: icon];
        }
    }

    fn tinted_icon(color: &str, size: usize, brightness: f32) -> Option<Retained<NSImage>> {
        let rep = tinted_representation(color, size, brightness)?;
        let side = size as f64;
        let image = NSImage::initWithSize(NSImage::alloc(), NSSize::new(side, side));
        image.addRepresentation(&rep);
        Some(image)
    }

    fn tinted_representation(
        color: &str,
        size: usize,
        brightness: f32,
    ) -> Option<Retained<NSBitmapImageRep>> {
        let (icon, artwork_scale) = base_icon()?;
        let rep = draw(&icon, size, artwork_scale)?;
        recolor(&rep, hex_to_hue_saturation(color)?, brightness);
        Some(rep)
    }

    /// The artwork every tint is derived from.
    ///
    /// Prefers what macOS renders for our bundle, which is the full Icon
    /// Composer treatment; falls back to the embedded PNG when there is no
    /// bundle to read (an unbundled dev build).
    fn base_icon() -> Option<(Retained<NSImage>, f64)> {
        match shipped_icon() {
            Some(icon) => Some((icon, 1.0)),
            None => Some((embedded_icon()?, MACOS_SAFE_AREA_RATIO)),
        }
    }

    fn embedded_icon() -> Option<Retained<NSImage>> {
        NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(EMBEDDED_ICON_PNG))
    }

    /// The icon macOS renders for our bundle.
    ///
    /// Read from the bundle on disk rather than from `applicationIconImage`, so
    /// it stays the pristine shipped artwork no matter how many times the user
    /// switches tints in a session.
    fn shipped_icon() -> Option<Retained<NSImage>> {
        let path = main_bundle_path()?;
        // An unbundled `tauri dev` binary has no .app to read an icon from, and
        // asking anyway would hand back a generic folder icon.
        if !path.ends_with(".app") {
            return None;
        }
        let path = NSString::from_str(&path);
        Some(NSWorkspace::sharedWorkspace().iconForFile(&path))
    }

    fn main_bundle_path() -> Option<String> {
        unsafe {
            let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
            if bundle.is_null() {
                return None;
            }
            let path: *const NSString = msg_send![bundle, bundlePath];
            path.as_ref().map(|path| path.to_string())
        }
    }

    /// Rasterise `image` into a `size` x `size` RGBA bitmap we can edit, with the
    /// artwork centred at `artwork_scale` of the canvas.
    fn draw(
        image: &NSImage,
        size: usize,
        artwork_scale: f64,
    ) -> Option<Retained<NSBitmapImageRep>> {
        let side = size as f64;
        let artwork = side * artwork_scale;
        let inset = (side - artwork) / 2.0;
        let rep = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                size as isize,
                size as isize,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )
        }?;

        rep.setSize(NSSize::new(side, side));
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(
            NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep).as_deref(),
        );
        image.drawInRect_fromRect_operation_fraction(
            NSRect::new(NSPoint::new(inset, inset), NSSize::new(artwork, artwork)),
            NSRect::ZERO,
            NSCompositingOperation::SourceOver,
            1.0,
        );
        NSGraphicsContext::restoreGraphicsState_class();
        Some(rep)
    }

    /// Rotate every pixel's hue onto `target_hue`, rescale saturation, and
    /// apply the requested plate brightness.
    ///
    /// The rotation is measured from the artwork's own dominant hue rather than
    /// a hardcoded purple, so a redesigned icon keeps tinting correctly.
    fn recolor(
        rep: &NSBitmapImageRep,
        (target_hue, target_saturation): (f32, f32),
        brightness: f32,
    ) {
        let width = rep.pixelsWide() as usize;
        let height = rep.pixelsHigh() as usize;
        let stride = rep.bytesPerRow() as usize;
        let data = rep.bitmapData();
        if data.is_null() || width == 0 || height == 0 {
            return;
        }

        // The rep is 8-bit RGBA, so every pixel is 4 bytes from the row start.
        let pixels = unsafe { std::slice::from_raw_parts_mut(data, stride * height) };
        let Some((source_hue, source_saturation)) =
            dominant_hue_saturation(pixels, width, height, stride)
        else {
            return;
        };

        let rotation = target_hue - source_hue;
        let saturation_scale = if source_saturation > 0.0 {
            target_saturation / source_saturation
        } else {
            1.0
        };

        for row in 0..height {
            for column in 0..width {
                let offset = row * stride + column * 4;
                let (hue, saturation, value) = rgb_to_hsv(
                    pixels[offset] as f32 / 255.0,
                    pixels[offset + 1] as f32 / 255.0,
                    pixels[offset + 2] as f32 / 255.0,
                );
                let saturation = (saturation * saturation_scale).clamp(0.0, 1.0);
                // Weight the adjustment by saturation so the coloured plate
                // darkens without dulling the near-white glass glyph.
                let value = value * (1.0 - (1.0 - brightness) * saturation);
                let (red, green, blue) =
                    hsv_to_rgb((hue + rotation).rem_euclid(1.0), saturation, value);
                pixels[offset] = (red * 255.0).round() as u8;
                pixels[offset + 1] = (green * 255.0).round() as u8;
                pixels[offset + 2] = (blue * 255.0).round() as u8;
            }
        }
    }

    /// Median hue and saturation of the plate — the opaque, saturated pixels.
    ///
    /// Median rather than mean so the glass highlights and the anti-aliased
    /// edges, which sit at every hue, cannot drag the result off the plate.
    fn dominant_hue_saturation(
        pixels: &[u8],
        width: usize,
        height: usize,
        stride: usize,
    ) -> Option<(f32, f32)> {
        const BUCKETS: usize = 360;
        const MIN_ALPHA: u8 = 128;
        const MIN_SATURATION: f32 = 0.25;

        let mut hues = [0u32; BUCKETS];
        let mut saturations = [0u32; BUCKETS];
        let mut counted = 0u32;

        for row in 0..height {
            for column in 0..width {
                let offset = row * stride + column * 4;
                if pixels[offset + 3] < MIN_ALPHA {
                    continue;
                }
                let (hue, saturation, _) = rgb_to_hsv(
                    pixels[offset] as f32 / 255.0,
                    pixels[offset + 1] as f32 / 255.0,
                    pixels[offset + 2] as f32 / 255.0,
                );
                if saturation < MIN_SATURATION {
                    continue;
                }
                hues[bucket::<BUCKETS>(hue)] += 1;
                saturations[bucket::<BUCKETS>(saturation)] += 1;
                counted += 1;
            }
        }

        if counted == 0 {
            return None;
        }
        Some((
            median::<BUCKETS>(&hues, counted),
            median::<BUCKETS>(&saturations, counted),
        ))
    }

    fn bucket<const BUCKETS: usize>(value: f32) -> usize {
        ((value * BUCKETS as f32) as usize).min(BUCKETS - 1)
    }

    fn median<const BUCKETS: usize>(histogram: &[u32; BUCKETS], total: u32) -> f32 {
        let mut seen = 0u32;
        for (index, count) in histogram.iter().enumerate() {
            seen += count;
            if seen * 2 >= total {
                return (index as f32 + 0.5) / BUCKETS as f32;
            }
        }
        0.0
    }

    fn hex_to_hue_saturation(hex: &str) -> Option<(f32, f32)> {
        let hex = hex.strip_prefix('#').unwrap_or(hex);
        if hex.len() != 6 {
            return None;
        }
        let channel = |index: usize| {
            u8::from_str_radix(&hex[index..index + 2], 16)
                .ok()
                .map(|value| value as f32 / 255.0)
        };
        let (hue, saturation, _) = rgb_to_hsv(channel(0)?, channel(2)?, channel(4)?);
        Some((hue, saturation))
    }

    fn rgb_to_hsv(red: f32, green: f32, blue: f32) -> (f32, f32, f32) {
        let max = red.max(green).max(blue);
        let min = red.min(green).min(blue);
        let delta = max - min;

        let hue = if delta == 0.0 {
            0.0
        } else if max == red {
            ((green - blue) / delta).rem_euclid(6.0)
        } else if max == green {
            (blue - red) / delta + 2.0
        } else {
            (red - green) / delta + 4.0
        } / 6.0;

        let saturation = if max == 0.0 { 0.0 } else { delta / max };
        (hue, saturation, max)
    }

    fn hsv_to_rgb(hue: f32, saturation: f32, value: f32) -> (f32, f32, f32) {
        if saturation == 0.0 {
            return (value, value, value);
        }
        let sector = hue * 6.0;
        let index = sector.floor();
        let fraction = sector - index;
        let p = value * (1.0 - saturation);
        let q = value * (1.0 - fraction * saturation);
        let t = value * (1.0 - (1.0 - fraction) * saturation);

        match index as i32 % 6 {
            0 => (value, t, p),
            1 => (q, value, p),
            2 => (p, value, t),
            3 => (p, q, value),
            4 => (t, p, value),
            _ => (value, p, q),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AppIconTint;

    #[test]
    fn legacy_purple_tint_migrates_to_default() {
        let tint: AppIconTint = serde_json::from_str("\"purple\"").unwrap();

        assert_eq!(tint, AppIconTint::Default);
    }

    #[test]
    fn green_and_cyan_are_slightly_darker() {
        assert_eq!(AppIconTint::Green.brightness(), 0.80);
        assert_eq!(AppIconTint::Cyan.brightness(), 0.86);
        assert_eq!(AppIconTint::Blue.brightness(), 1.0);
    }
}
