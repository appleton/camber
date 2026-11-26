//! Fully native macOS context menus for the webview.
//!
//! `show_native_menu` pops an NSMenu built directly with objc2 — not
//! tauri::menu/muda — at a webview position and resolves with the selected
//! action id, or `None` when the menu is dismissed without a selection.
//!
//! The NSMenu is only an escape hatch from the window bounds: every item is a
//! custom view row with the app's dropdown layout (theme colors from the wire
//! request, a "SELECTED" pill instead of a checkmark, hand-drawn separators
//! and accelerator strings). Highlighted rows use the macOS selection fill
//! and text colors by default. Pickers can opt into the app's outlined
//! highlight, retaining their original text and icon colors.
//!
//! Action items carrying `star` additionally render the app's per-row "use by
//! default" star toggle: a trailing star button drawn from the request's
//! pre-rasterized `starIcons` artwork that toggles the default
//! (radio-with-toggle scoped to rows sharing the item's `starGroup`;
//! ungrouped rows toggle alone) without closing the menu.
//! Star clicks emit [`NATIVE_MENU_SET_DEFAULT_EVENT`] to the calling window;
//! the webview owns persistence, the open menu only updates optimistically.

#[cfg(target_os = "macos")]
use std::cell::{Cell, RefCell};

use serde::Deserialize;
#[cfg(target_os = "macos")]
use serde::Serialize;
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2::{
    define_class, msg_send, sel, AnyThread, ClassType, DefinedClass, MainThreadMarker,
    MainThreadOnly, Message,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSAttributedStringNSStringDrawing, NSAutoresizingMaskOptions, NSBezierPath,
    NSBitmapImageFileType, NSBitmapImageRep, NSButton, NSButtonType, NSCellImagePosition, NSColor,
    NSCompositingOperation, NSDeviceRGBColorSpace, NSEvent, NSEventModifierFlags, NSFont,
    NSFontAttributeName, NSFontWeightSemibold, NSForegroundColorAttributeName, NSGraphicsContext,
    NSImage, NSImageScaling, NSImageView, NSLineBreakMode, NSMenu, NSMenuDelegate, NSMenuItem,
    NSTextField, NSTrackingArea, NSTrackingAreaOptions, NSView, NSWorkspace,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSAttributedString, NSCopying, NSData, NSDataBase64DecodingOptions, NSDictionary,
    NSMutableAttributedString, NSPoint, NSRange, NSRect, NSSize, NSString,
};
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

/// Pops a native menu at `request.position` (webview logical coordinates) in
/// the calling window and resolves once the menu closes: `Some(action id)`
/// when an action item was picked, `None` when the menu was dismissed.
#[tauri::command]
pub async fn show_native_menu(
    window: WebviewWindow,
    request: NativeMenuRequest,
) -> Result<Option<String>, String> {
    show_native_menu_impl(window, request).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMenuRequest {
    position: MenuPosition,
    align: Option<MenuAlign>,
    #[serde(default)]
    highlight_style: MenuHighlightStyle,
    items: Vec<WireItem>,
    /// Opaque caller correlation token, echoed verbatim in
    /// [`NATIVE_MENU_SET_DEFAULT_EVENT`] payloads.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    token: Option<String>,
    /// The star button's artwork, pre-rasterized webview-side; see
    /// [`WireStarIcons`]. Absent degrades star-carrying rows to no star
    /// button.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    star_icons: Option<WireStarIcons>,
    /// The app's dropdown colors. Optional for robustness: without it the
    /// menu falls back to system-derived colors.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    theme: Option<WireTheme>,
    /// Minimum menu content width in points. When present, sublabels wrap to
    /// at most two lines instead of widening the menu.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    min_width: Option<f64>,
}

/// Event emitted to the calling window when a star row's star is clicked.
/// The payload is [`NativeMenuSetDefault`]; `starred` is the NEW state after
/// the click.
#[cfg(target_os = "macos")]
const NATIVE_MENU_SET_DEFAULT_EVENT: &str = "native-menu:set-default";

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Serialize)]
struct NativeMenuSetDefault {
    token: Option<String>,
    id: String,
    starred: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, Deserialize)]
struct MenuPosition {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MenuAlign {
    Start,
    End,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MenuHighlightStyle {
    #[default]
    System,
    Themed,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WireItem {
    #[serde(rename_all = "camelCase")]
    Action {
        id: String,
        label: String,
        sublabel: Option<String>,
        icon: Option<WireIcon>,
        checked: Option<bool>,
        enabled: Option<bool>,
        accelerator: Option<String>,
        tool_tip: Option<String>,
        destructive: Option<bool>,
        /// Presence turns the action into a star row (needs the request's
        /// `starIcons` artwork to actually render the button).
        star: Option<WireStar>,
        /// The star's radio scope: starring this row clears only other star
        /// rows carrying the same group. Absent makes the row its own
        /// singleton group — toggling it never clears another row, and no
        /// other row's star click clears it.
        star_group: Option<String>,
        /// Nesting depth in levels; each level shifts the icon and label by
        /// [`INDENT_LEVEL_POINTS`] (worktree rows under their parent project).
        indent: Option<u32>,
        /// Reserve the icon slot even though this row carries no icon, so
        /// its label aligns with icon-bearing siblings (e.g. the prompt
        /// picker's extras openers beside Fast Mode/Effort). Absent/false
        /// keeps the label flush-left, as before the flag existed.
        reserve_icon_slot: Option<bool>,
    },
    Separator {
        label: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Submenu {
        label: String,
        icon: Option<WireIcon>,
        enabled: Option<bool>,
        /// The submenu's current selection (e.g. "On", "Extra High"), drawn
        /// right-aligned before the chevron like the DOM panel rows.
        detail: Option<String>,
        /// As on `Action`: reserve the icon slot for an icon-less parent row.
        reserve_icon_slot: Option<bool>,
        /// Minimum content width in points for this submenu's own level, with
        /// the same semantics as the request-level `min_width`: the level lays
        /// out at least this wide and its sublabels wrap to at most two lines
        /// instead of widening the menu. Absent keeps the natural width.
        min_width: Option<f64>,
        items: Vec<WireItem>,
    },
}

/// Marks an action item as a star row: the current default renders the
/// pinned (vibrant) star always; other star rows reveal the normal star
/// while their row is highlighted.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireStar {
    starred: bool,
}

/// The star glyph pre-rasterized webview-side at 2x in the exact theme
/// colors, one base64 PNG per state: `pinned` (vibrant brand color),
/// `normal` (tertiary text), `hover` (primary text). Rust never picks star
/// artwork itself; it only renders these at [`STAR_GLYPH_POINTS`] centered in
/// the [`STAR_BUTTON_SIZE`] button.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireStarIcons {
    pinned: String,
    normal: String,
    hover: String,
}

/// The webview dropdown palette, all colors as `#rrggbb` or `#rrggbbaa`
/// (sRGB). Unparsable colors degrade per-field to the system fallback.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireTheme {
    is_dark: bool,
    text_primary: String,
    text_secondary: String,
    text_tertiary: String,
    /// Themed row highlight and star-button hover fill.
    hover_background: String,
    /// Separator line color.
    separator: String,
    /// SELECTED pill fill.
    badge_background: String,
    /// SELECTED pill text.
    badge_text: String,
    destructive_text: String,
    /// Deserialized for wire completeness (the webview always sends it); the
    /// native rows use the pre-colored artwork, tinting a template copy only
    /// for the system selection highlight.
    #[allow(dead_code)]
    icon_color: String,
    /// Optional ring around the themed row highlight.
    hover_border: Option<String>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireIcon {
    /// Absolute filesystem path whose OS icon to show (NSWorkspace), e.g. the
    /// real macOS folder icon for a project directory. Takes precedence over
    /// `pngBase64` and renders full color when the row is not highlighted.
    file_path: Option<String>,
    /// Base64 PNG bytes, pre-rasterized in color by the webview.
    png_base64: Option<String>,
}

#[cfg(target_os = "macos")]
async fn show_native_menu_impl(
    window: WebviewWindow,
    request: NativeMenuRequest,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_handle = window.app_handle().clone();
    // popUpMenuPositioningItem:atLocation:inView: runs its own tracking loop
    // on the main thread and returns once the menu closes; awaiting the
    // oneshot keeps the command from blocking an async runtime thread for the
    // menu's lifetime.
    app_handle
        .run_on_main_thread(move || {
            let _ = tx.send(present_menu_on_main_thread(&window, request));
        })
        .map_err(|err| err.to_string())?;
    rx.await
        .map_err(|err| format!("native menu did not report a result: {err}"))?
}

#[cfg(not(target_os = "macos"))]
async fn show_native_menu_impl(
    _window: WebviewWindow,
    _request: NativeMenuRequest,
) -> Result<Option<String>, String> {
    Err("native menus are only supported on macOS".to_string())
}

/// The OS's own icon for the file at `path` (as Finder shows it), rendered at
/// [`FILE_ICON_PIXELS`] square and returned as base64 PNG bytes for webview
/// `<img>` use — e.g. the real macOS folder icon on the project picker's
/// trigger, which lives in the DOM where the native menu's NSWorkspace icons
/// cannot render directly. `None` when encoding fails, and always off macOS.
#[tauri::command]
pub async fn file_icon_png(app: tauri::AppHandle, path: String) -> Option<String> {
    file_icon_png_impl(app, path).await
}

/// Pixel edge of the PNG `file_icon_png` returns: 2x a 16pt display box, so
/// the icon stays sharp on retina displays.
#[cfg(target_os = "macos")]
const FILE_ICON_PIXELS: usize = 32;

#[cfg(target_os = "macos")]
async fn file_icon_png_impl(app: tauri::AppHandle, path: String) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // AppKit image lookup and drawing happen on the main thread, like the
    // menu presentation above; awaiting the oneshot keeps the command off it.
    app.run_on_main_thread(move || {
        let _ = tx.send(file_icon_png_on_main_thread(&path));
    })
    .ok()?;
    rx.await.ok().flatten()
}

#[cfg(not(target_os = "macos"))]
async fn file_icon_png_impl(_app: tauri::AppHandle, _path: String) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn file_icon_png_on_main_thread(path: &str) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path));
    let side = FILE_ICON_PIXELS as f64;
    // An editable RGBA bitmap to rasterize into, mirroring app_icon.rs::draw.
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            FILE_ICON_PIXELS as isize,
            FILE_ICON_PIXELS as isize,
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
    icon.drawInRect_fromRect_operation_fraction(
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(side, side)),
        NSRect::ZERO,
        NSCompositingOperation::SourceOver,
        1.0,
    );
    NSGraphicsContext::restoreGraphicsState_class();
    // SAFETY: PNG encoding needs no properties; an empty dictionary is valid.
    let data = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(STANDARD.encode(data.to_vec()))
}

#[cfg(target_os = "macos")]
fn present_menu_on_main_thread(
    window: &WebviewWindow,
    request: NativeMenuRequest,
) -> Result<Option<String>, String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "native menus must be presented on the main thread".to_string())?;

    // The same view tauri's Menu::popup hands to muda: the window content
    // view, which the webview fills (overlay titlebar, full-size content
    // view), so the webview's top-left origin is the view's top-left corner
    // and CSS pixels equal AppKit points.
    let view = window.ns_view().map_err(|err| err.to_string())? as *const NSView;
    // SAFETY: ns_view() returns the window's content view, valid while
    // `window` is alive; menu presentation happens on its main thread.
    let view =
        unsafe { view.as_ref() }.ok_or_else(|| "window is missing its NSView".to_string())?;

    let theme = MenuTheme::resolve(request.theme.as_ref(), request.highlight_style);
    let star_images = StarImages::resolve(request.star_icons.as_ref());
    let handler = MenuActionHandler::new(mtm, window.clone(), request.token.clone());
    let menu = build_menu(
        &request.items,
        &handler,
        &theme,
        star_images.as_ref(),
        request.min_width,
        mtm,
    );

    // The view is not flipped: convert the webview's top-left-origin y to
    // AppKit's bottom-left origin, mirroring muda's Menu::popup conversion.
    let bounds = view.bounds();
    let mut x = bounds.origin.x + request.position.x;
    let y = bounds.origin.y + bounds.size.height - request.position.y;
    if request.align == Some(MenuAlign::End) {
        x -= menu.size().width;
    }

    let selected_something =
        menu.popUpMenuPositioningItem_atLocation_inView(None, NSPoint::new(x, y), Some(view));
    // The tracking loop has ended; the handler (kept retained above, since
    // NSMenuItem targets are weak) observed any selection.
    let _ = selected_something;
    // Each star button's tracking area strongly retains its owner (the row
    // view), a cycle through the button; break it now that the menu closed.
    handler.remove_star_tracking_areas();
    Ok(handler.take_selection())
}

/// The wire theme resolved to NSColors, with per-field system fallbacks so a
/// missing or unparsable theme keeps existing callers working.
#[cfg(target_os = "macos")]
struct MenuTheme {
    highlight_style: MenuHighlightStyle,
    /// darkAqua/aqua from `theme.isDark`; `None` inherits the app appearance.
    appearance: Option<Retained<NSAppearance>>,
    text_primary: Retained<NSColor>,
    /// Submenu detail text (the current selection shown before the chevron).
    text_secondary: Retained<NSColor>,
    text_tertiary: Retained<NSColor>,
    hover_background: Retained<NSColor>,
    hover_border: Option<Retained<NSColor>>,
    separator: Retained<NSColor>,
    badge_background: Retained<NSColor>,
    badge_text: Retained<NSColor>,
    destructive_text: Retained<NSColor>,
}

#[cfg(target_os = "macos")]
impl MenuTheme {
    fn resolve(wire: Option<&WireTheme>, highlight_style: MenuHighlightStyle) -> Self {
        fn themed(
            hex: Option<&String>,
            fallback: impl FnOnce() -> Retained<NSColor>,
        ) -> Retained<NSColor> {
            hex.and_then(|hex| ns_color_from_hex(hex))
                .unwrap_or_else(fallback)
        }
        let appearance = wire.and_then(|theme| {
            // SAFETY: reading AppKit's constant appearance-name statics.
            let name = unsafe {
                if theme.is_dark {
                    NSAppearanceNameDarkAqua
                } else {
                    NSAppearanceNameAqua
                }
            };
            NSAppearance::appearanceNamed(name)
        });
        MenuTheme {
            highlight_style,
            appearance,
            text_primary: themed(wire.map(|t| &t.text_primary), NSColor::labelColor),
            text_secondary: themed(
                wire.map(|t| &t.text_secondary),
                NSColor::secondaryLabelColor,
            ),
            text_tertiary: themed(wire.map(|t| &t.text_tertiary), NSColor::tertiaryLabelColor),
            hover_background: themed(
                wire.map(|t| &t.hover_background),
                NSColor::quaternaryLabelColor,
            ),
            separator: themed(wire.map(|t| &t.separator), NSColor::separatorColor),
            badge_background: themed(
                wire.map(|t| &t.badge_background),
                NSColor::quaternaryLabelColor,
            ),
            badge_text: themed(wire.map(|t| &t.badge_text), NSColor::secondaryLabelColor),
            destructive_text: themed(wire.map(|t| &t.destructive_text), NSColor::systemRedColor),
            hover_border: if highlight_style == MenuHighlightStyle::Themed {
                optional_border(wire.and_then(|t| t.hover_border.as_deref()))
            } else {
                None
            },
        }
    }
}

/// Keep the original artwork alongside a template copy for the selection
/// foreground. Copy before changing template mode: file icons and star images
/// can be shared with other rows or controls.
#[cfg(target_os = "macos")]
#[derive(Clone)]
struct MenuImage {
    original: Retained<NSImage>,
    highlighted: Retained<NSImage>,
}

#[cfg(target_os = "macos")]
impl MenuImage {
    fn new(original: Retained<NSImage>) -> Self {
        let highlighted = original.copy();
        highlighted.setTemplate(true);
        Self {
            original,
            highlighted,
        }
    }

    fn image(&self, highlighted: bool) -> &NSImage {
        if highlighted {
            &self.highlighted
        } else {
            &self.original
        }
    }
}

/// The request's pre-rasterized star artwork (`starIcons`), decoded once and
/// shared by every star row; see [`WireStarIcons`] for the color contract.
/// All three states must decode — a missing or partial set degrades to no
/// star buttons at all rather than inconsistent artwork.
#[cfg(target_os = "macos")]
#[derive(Clone)]
struct StarImages {
    pinned: MenuImage,
    normal: MenuImage,
    hover: MenuImage,
}

#[cfg(target_os = "macos")]
impl StarImages {
    fn resolve(wire: Option<&WireStarIcons>) -> Option<Self> {
        let wire = wire?;
        Some(StarImages {
            pinned: MenuImage::new(star_png_image(&wire.pinned)?),
            normal: MenuImage::new(star_png_image(&wire.normal)?),
            hover: MenuImage::new(star_png_image(&wire.hover)?),
        })
    }
}

/// Resolves an optional border color: absent, unparsable, or fully
/// transparent values draw no border.
#[cfg(target_os = "macos")]
pub(crate) fn optional_border(hex: Option<&str>) -> Option<Retained<NSColor>> {
    let (red, green, blue, alpha) = parse_visible_hex_color(hex?)?;
    Some(NSColor::colorWithSRGBRed_green_blue_alpha(
        red, green, blue, alpha,
    ))
}

#[cfg(target_os = "macos")]
pub(crate) fn ns_color_from_hex(hex: &str) -> Option<Retained<NSColor>> {
    let (red, green, blue, alpha) = parse_hex_color(hex)?;
    Some(NSColor::colorWithSRGBRed_green_blue_alpha(
        red, green, blue, alpha,
    ))
}

/// Parses `#rrggbb` / `#rrggbbaa` into sRGB components in 0–1. Pure so it can
/// be unit-tested without AppKit.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_hex_color(hex: &str) -> Option<(f64, f64, f64, f64)> {
    let digits = hex.strip_prefix('#')?;
    if !matches!(digits.len(), 6 | 8) || !digits.is_ascii() {
        return None;
    }
    let channel = |index: usize| -> Option<f64> {
        let value = u8::from_str_radix(&digits[2 * index..2 * index + 2], 16).ok()?;
        Some(f64::from(value) / 255.0)
    };
    let alpha = if digits.len() == 8 { channel(3)? } else { 1.0 };
    Some((channel(0)?, channel(1)?, channel(2)?, alpha))
}

/// Like [`parse_hex_color`] but treats fully transparent colors as absent —
/// used for optional borders, where `#rrggbb00` means "no border".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_visible_hex_color(hex: &str) -> Option<(f64, f64, f64, f64)> {
    parse_hex_color(hex).filter(|&(_, _, _, alpha)| alpha > 0.0)
}

/// An item prepared for a menu: the NSMenuItem plus its custom view, held
/// unlaid-out until the whole menu's content width is known.
#[cfg(target_os = "macos")]
enum PreparedItem {
    Row {
        item: Retained<NSMenuItem>,
        view: Retained<MenuRowView>,
    },
    Separator {
        item: Retained<NSMenuItem>,
        view: Retained<MenuSeparatorView>,
    },
}

#[cfg(target_os = "macos")]
impl PreparedItem {
    fn natural_width(&self) -> f64 {
        match self {
            PreparedItem::Row { view, .. } => view.natural_width(),
            PreparedItem::Separator { view, .. } => view.natural_width(),
        }
    }
}

/// Builds one menu level. Two passes: rows are prepared (subviews created and
/// measured), then laid out at the shared content width — the widest row, or
/// `min_width` if larger. `min_width` also switches sublabels to two-line
/// wrapping; each submenu level uses its own wire `minWidth` (natural width
/// when absent).
///
/// Icon-less rows stay flush-left unless their wire item opts into the icon
/// slot via `reserveIconSlot` (see [`RowSpec::reserve_icon_slot`]): the
/// webview decides per row which labels should align with icon-bearing
/// siblings — e.g. the prompt picker's extras openers beside Fast
/// Mode/Effort, but NOT its inline model rows at the same level.
#[cfg(target_os = "macos")]
fn build_menu(
    items: &[WireItem],
    handler: &MenuActionHandler,
    theme: &MenuTheme,
    star_images: Option<&StarImages>,
    min_width: Option<f64>,
    mtm: MainThreadMarker,
) -> Retained<NSMenu> {
    let menu = NSMenu::new(mtm);
    // Autoenabling would re-derive enabled states from the responder chain;
    // the wire request is the single source of truth.
    menu.setAutoenablesItems(false);
    // NSMenu does not reliably redraw custom item views on highlight change;
    // the handler doubles as the menu delegate and repaints rows from
    // menu:willHighlightItem: (mouse and keyboard both go through it). The
    // delegate reference is weak; the handler outlives the tracking loop.
    menu.setDelegate(Some(ProtocolObject::from_ref(handler)));

    let wrap_sublabels = min_width.is_some();
    let prepared: Vec<PreparedItem> = items
        .iter()
        .map(|item| prepare_wire_item(item, handler, theme, star_images, wrap_sublabels, mtm))
        .collect();
    let width = prepared
        .iter()
        .map(PreparedItem::natural_width)
        .fold(min_width.unwrap_or(0.0), f64::max);

    for prepared in prepared {
        match prepared {
            PreparedItem::Row { item, view } => {
                view.finalize_layout(width);
                item.setView(Some(&view));
                menu.addItem(&item);
            }
            PreparedItem::Separator { item, view } => {
                view.finalize_layout(width);
                item.setView(Some(&view));
                menu.addItem(&item);
            }
        }
    }
    menu
}

#[cfg(target_os = "macos")]
fn prepare_wire_item(
    item: &WireItem,
    handler: &MenuActionHandler,
    theme: &MenuTheme,
    star_images: Option<&StarImages>,
    wrap_sublabels: bool,
    mtm: MainThreadMarker,
) -> PreparedItem {
    match item {
        WireItem::Action {
            id,
            label,
            sublabel,
            icon,
            checked,
            enabled,
            accelerator,
            tool_tip,
            destructive,
            star,
            star_group,
            indent,
            reserve_icon_slot,
        } => {
            let menu_item = NSMenuItem::new(mtm);
            // The view draws the row; the title stays for type-select and
            // accessibility.
            menu_item.setTitle(&NSString::from_str(label));
            // SAFETY: the handler outlives the popup (the caller keeps it
            // retained until the tracking loop returns), itemSelected: matches
            // the handler's method signature, and the represented object is a
            // plain NSString.
            unsafe {
                let target: &AnyObject = handler;
                menu_item.setTarget(Some(target));
                menu_item.setAction(Some(sel!(itemSelected:)));
                menu_item.setRepresentedObject(Some(&NSString::from_str(id)));
            }
            menu_item.setEnabled(enabled.unwrap_or(true));
            if let Some(tool_tip) = tool_tip {
                menu_item.setToolTip(Some(&NSString::from_str(tool_tip)));
            }
            // Keep the key equivalent for the shortcut itself; the native
            // shortcut column is suppressed by the custom view, which draws
            // the display string instead.
            let parsed_accelerator = accelerator.as_deref().and_then(parse_accelerator);
            if let Some(parsed) = &parsed_accelerator {
                menu_item.setKeyEquivalent(&NSString::from_str(&parsed.key_equivalent));
                menu_item.setKeyEquivalentModifierMask(key_equivalent_modifier_mask(parsed));
            }

            // The star button needs the request's pre-rasterized artwork; a
            // `star` field without `starIcons` degrades to no button.
            let star_state = star_images.and(star.as_ref().map(|star| star.starred));
            let view = MenuRowView::new(
                &RowSpec {
                    label,
                    sublabel: sublabel.as_deref(),
                    icon: icon.as_ref(),
                    checked: checked.unwrap_or(false),
                    enabled: enabled.unwrap_or(true),
                    destructive: destructive.unwrap_or(false),
                    accelerator: parsed_accelerator.as_ref().map(accelerator_display_string),
                    star: star_state,
                    star_images,
                    detail: None,
                    chevron: false,
                    wrap_sublabel: wrap_sublabels,
                    indent: indent.unwrap_or(0),
                    reserve_icon_slot: reserve_icon_slot.unwrap_or(false),
                },
                theme,
                mtm,
            );
            handler.register_row(&menu_item, &view);
            if star_state.is_some() {
                let tag = handler.register_star_row(id, star_group.as_deref(), &view);
                view.wire_star_button(handler, tag);
            }
            PreparedItem::Row {
                item: menu_item,
                view,
            }
        }
        WireItem::Separator { label } => {
            let menu_item = NSMenuItem::new(mtm);
            menu_item.setEnabled(false);
            let view = MenuSeparatorView::new(label.as_deref(), theme, mtm);
            PreparedItem::Separator {
                item: menu_item,
                view,
            }
        }
        WireItem::Submenu {
            label,
            icon,
            enabled,
            detail,
            reserve_icon_slot,
            min_width,
            items,
        } => {
            let submenu = build_menu(items, handler, theme, star_images, *min_width, mtm);
            submenu.setTitle(&NSString::from_str(label));
            let menu_item = NSMenuItem::new(mtm);
            menu_item.setTitle(&NSString::from_str(label));
            menu_item.setEnabled(enabled.unwrap_or(true));
            menu_item.setSubmenu(Some(&submenu));
            let view = MenuRowView::new(
                &RowSpec {
                    label,
                    sublabel: None,
                    icon: icon.as_ref(),
                    checked: false,
                    enabled: enabled.unwrap_or(true),
                    destructive: false,
                    accelerator: None,
                    star: None,
                    star_images: None,
                    detail: detail.as_deref(),
                    chevron: true,
                    wrap_sublabel: false,
                    indent: 0,
                    reserve_icon_slot: reserve_icon_slot.unwrap_or(false),
                },
                theme,
                mtm,
            );
            handler.register_row(&menu_item, &view);
            PreparedItem::Row {
                item: menu_item,
                view,
            }
        }
    }
}

/// Points used for both dimensions of menu icons.
#[cfg(target_os = "macos")]
const MENU_ICON_POINTS: f64 = 16.0;

/// Font size of sublabel, accelerator, and separator-label text.
#[cfg(target_os = "macos")]
const SMALL_MENU_FONT_SIZE: f64 = 11.0;

// Row layout metrics mirroring the DOM dropdown (`menu-surface p-1`, row
// `px-2`). Named so they are easy to tune after visual QA.

/// Horizontal padding of the menu surface (DOM `p-1`); rows inset their
/// highlight by this much from the menu edges.
#[cfg(target_os = "macos")]
const MENU_PADDING_X: f64 = 4.0;
/// Row content inset inside the highlight (DOM row `px-2`).
#[cfg(target_os = "macos")]
pub(crate) const ROW_INSET_X: f64 = 8.0;
/// Corner radius of the hover-fill highlight.
#[cfg(target_os = "macos")]
const ROW_HIGHLIGHT_CORNER_RADIUS: f64 = 6.0;
/// Minimum height of a single-line row: the DOM rows are 13px text on a 16px
/// line-height with 6px vertical padding (`py-1.5`), i.e. 28.
#[cfg(target_os = "macos")]
const ROW_HEIGHT: f64 = 28.0;
/// Vertical content padding for rows that grow beyond the minimum height
/// (DOM row `py-1.5`).
#[cfg(target_os = "macos")]
const ROW_VERTICAL_PADDING: f64 = 6.0;
/// Vertical gap between the label and sublabel lines. The DOM sublabel is
/// 12px text at ~16px effective line height; the native 11pt sublabel
/// measures ~14pt, so a 2pt gap keeps the line pitch close.
#[cfg(target_os = "macos")]
const ROW_LINE_GAP: f64 = 2.0;
/// Gap between an item icon and the label.
#[cfg(target_os = "macos")]
const ICON_LABEL_GAP: f64 = 6.0;
/// Horizontal shift per indent level of a nested action row (worktrees under
/// their parent project); applied before the icon so the whole icon+label
/// block steps in.
#[cfg(target_os = "macos")]
const INDENT_LEVEL_POINTS: f64 = 16.0;
/// Minimum gap between the label/sublabel text and the trailing zone.
#[cfg(target_os = "macos")]
const LABEL_TRAILING_GAP: f64 = 8.0;
/// Gap between adjacent trailing elements (accelerator, detail, star,
/// pill/chevron).
#[cfg(target_os = "macos")]
const TRAILING_ITEM_GAP: f64 = 6.0;
/// Square size of the trailing star button (DOM `size-5`, 20px).
#[cfg(target_os = "macos")]
const STAR_BUTTON_SIZE: f64 = 20.0;
/// Display size of the star glyph inside the button (DOM `<Icon size={13}>`).
#[cfg(target_os = "macos")]
const STAR_GLYPH_POINTS: f64 = 13.0;
/// Corner radius of the star button's hover fill (DOM `rounded`, 4px).
#[cfg(target_os = "macos")]
const STAR_HOVER_CORNER_RADIUS: f64 = 4.0;
/// SELECTED pill text size (semibold).
#[cfg(target_os = "macos")]
const PILL_FONT_SIZE: f64 = 9.0;
/// SELECTED pill horizontal text padding.
#[cfg(target_os = "macos")]
const PILL_PADDING_X: f64 = 6.0;
/// SELECTED pill vertical text padding.
#[cfg(target_os = "macos")]
const PILL_PADDING_Y: f64 = 2.0;
/// Square size of the submenu chevron glyph.
#[cfg(target_os = "macos")]
const CHEVRON_SIZE: f64 = 10.0;
/// Vertical margin above and below the separator line.
#[cfg(target_os = "macos")]
const SEPARATOR_MARGIN_Y: f64 = 4.0;
/// Separator line thickness.
#[cfg(target_os = "macos")]
const SEPARATOR_THICKNESS: f64 = 1.0;
/// Gap between the separator line and its label, and below the label.
#[cfg(target_os = "macos")]
const SEPARATOR_LABEL_GAP: f64 = 3.0;

/// Wire-derived configuration for one row view.
#[cfg(target_os = "macos")]
struct RowSpec<'a> {
    label: &'a str,
    sublabel: Option<&'a str>,
    icon: Option<&'a WireIcon>,
    /// Renders the trailing "SELECTED" pill.
    checked: bool,
    enabled: bool,
    destructive: bool,
    /// Pre-formatted accelerator display string (e.g. "⇧⌘R").
    accelerator: Option<String>,
    /// `Some(starred)` renders the trailing star button. Only ever set
    /// together with `star_images`; a wire `star` without request artwork is
    /// filtered out upstream.
    star: Option<bool>,
    /// The request-level star artwork shared by every star row.
    star_images: Option<&'a StarImages>,
    /// Submenu current-selection text, drawn right-aligned before the
    /// chevron.
    detail: Option<&'a str>,
    /// Renders the trailing submenu chevron.
    chevron: bool,
    /// Allow the sublabel to wrap to two lines at the final width.
    wrap_sublabel: bool,
    /// Nesting depth in levels ([`INDENT_LEVEL_POINTS`] each).
    indent: u32,
    /// Reserve the icon slot ([`MENU_ICON_POINTS`] + [`ICON_LABEL_GAP`]) even
    /// when this row has no icon of its own — the wire item's explicit
    /// `reserveIconSlot` opt-in, for icon-less rows whose labels should
    /// align with icon-bearing siblings. Composes additively with `indent`.
    reserve_icon_slot: bool,
}

/// Subviews, measurements, and mutable display state of a row.
#[cfg(target_os = "macos")]
struct MenuRowViewIvars {
    highlight_style: MenuHighlightStyle,
    enabled: bool,
    wrap_sublabel: bool,
    /// Leading inset from the row's indent level, in points; shifts the
    /// icon+label block and participates in the natural width.
    indent_points: f64,
    /// Start the label after the icon slot even without an icon (the wire
    /// item opted in); participates in the natural width.
    reserve_icon_slot: bool,
    /// Current star state, flipped optimistically on star clicks.
    starred: Cell<bool>,
    /// Whether the pointer is over the star button itself (tracking-area
    /// driven); lifts the unpinned glyph and paints the button hover fill.
    star_hovered: Cell<bool>,
    highlighted: Cell<bool>,
    natural_label_size: NSSize,
    natural_sublabel_size: Option<NSSize>,
    natural_accel_size: Option<NSSize>,
    natural_detail_size: Option<NSSize>,
    /// The size the menu should give this row: shared content width (incl.
    /// `minWidth`) by computed row height. Reported via intrinsicContentSize
    /// so the table-backed menu representation (macOS 14+) sizes the menu to
    /// our width instead of its own guess.
    intrinsic_size: Cell<NSSize>,
    /// Sublabel display height measured at the shared width during build; it
    /// sticks even if the representation later resizes the row (widths keep
    /// tracking bounds, truncation absorbs small deviations). 0 = unmeasured.
    sublabel_display_height: Cell<f64>,
    /// Capsule size including padding; drawn in drawRect at the trailing edge.
    pill_box_size: Option<NSSize>,
    pill_text: Option<Retained<NSAttributedString>>,
    icon: Option<Retained<NSImageView>>,
    icon_images: Option<MenuImage>,
    label: Retained<NSTextField>,
    sublabel: Option<Retained<NSTextField>>,
    accel: Option<Retained<NSTextField>>,
    star_button: Option<Retained<NSButton>>,
    /// The request's decoded star artwork; present iff `star_button` is.
    star_images: Option<StarImages>,
    detail: Option<Retained<NSTextField>>,
    chevron: Option<Retained<NSImageView>>,
    label_color: Retained<NSColor>,
    text_secondary: Retained<NSColor>,
    text_tertiary: Retained<NSColor>,
    hover_background: Retained<NSColor>,
    hover_border: Option<Retained<NSColor>>,
    badge_background: Retained<NSColor>,
}

/// X-positions and text budget for a row's content at a given width. The
/// trailing zone is reserved right-to-left: pill/chevron, star, detail,
/// accelerator.
#[cfg(target_os = "macos")]
struct RowGeometry {
    label_x: f64,
    text_available: f64,
    accel_x: Option<f64>,
    star_x: Option<f64>,
    /// Detail x-position and display width. The width is clamped so the
    /// label keeps its natural width when the row is squeezed: the detail
    /// truncates first.
    detail: Option<(f64, f64)>,
    chevron_x: Option<f64>,
}

#[cfg(target_os = "macos")]
define_class!(
    // SAFETY:
    // - NSView has no additional subclassing requirements beyond designated
    //   initializers, and the view is created through initWithFrame:.
    // - The view is only created and messaged on the main thread while the
    //   popup tracking loop runs.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = MenuRowViewIvars]
    struct MenuRowView;

    /// A menu row with a system or themed highlight, optional icon/sublabel,
    /// hand-drawn accelerator, SELECTED pill, submenu detail text, submenu
    /// chevron, and the optional "use by default" star toggle.
    impl MenuRowView {
        // Lay out top-down so text rows read like the wire order.
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        // The table-backed menu representation (macOS 14+) sizes item views
        // from intrinsicContentSize and ignores preset frames; report the
        // shared content width (incl. minWidth) and the row height.
        #[unsafe(method(intrinsicContentSize))]
        fn intrinsic_content_size(&self) -> NSSize {
            self.ivars().intrinsic_size.get()
        }

        // The representation resizes rows to a width of its own choosing;
        // every size change re-derives subview placement from the new bounds
        // so nothing is left anchored at build-time coordinates.
        #[unsafe(method(setFrameSize:))]
        fn set_frame_size(&self, new_size: NSSize) {
            // SAFETY: forwarding to NSView's own setFrameSize:.
            unsafe {
                let _: () = msg_send![super(self), setFrameSize: new_size];
            }
            self.place_subviews();
        }

        // Draws the hover highlight and the SELECTED pill; everything else is
        // a subview.
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty_rect: NSRect) {
            self.draw_impl();
        }

        // Route clicks on passive subviews (labels, image views) to the row
        // itself so they behave as row-body clicks; only the enabled star
        // button keeps handling its own clicks.
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> Option<Retained<NSView>> {
            self.hit_test_impl(point)
        }

        // The star button's tracking area names this row view as its owner,
        // so button hover enters/exits arrive here (the row itself adds no
        // other tracking areas).
        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, _event: &NSEvent) {
            self.set_star_hovered(true);
        }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) {
            self.set_star_hovered(false);
        }

        // Row-body click: dismiss the whole menu tree, then resolve the
        // command through the item's regular target/action (the same path as
        // pressing Return on the highlighted row).
        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {
            if !self.ivars().enabled {
                return;
            }
            let Some(item) = self.enclosingMenuItem() else {
                return;
            };
            // Submenu parents open on highlight; a body click on them should
            // not tear the menu down.
            if item.hasSubmenu() {
                return;
            }
            // SAFETY: reading the menu chain on the main thread while the
            // menu tree is alive (the tracking loop is running).
            if let Some(menu) = unsafe { item.menu() } {
                root_menu(menu).cancelTracking();
            }
            if let (Some(target), Some(action)) = (item.target(), item.action()) {
                // SAFETY: the target is the retained MenuActionHandler and the
                // action is itemSelected:, which takes the item and returns
                // nothing; the ignored id return slot of performSelector: is
                // never read.
                unsafe {
                    let _: *mut AnyObject =
                        msg_send![&*target, performSelector: action, withObject: &*item];
                }
            }
        }
    }

    // SAFETY: NSObjectProtocol has no extra safety requirements.
    unsafe impl NSObjectProtocol for MenuRowView {}
);

#[cfg(target_os = "macos")]
impl MenuRowView {
    fn new(spec: &RowSpec<'_>, theme: &MenuTheme, mtm: MainThreadMarker) -> Retained<Self> {
        let label = NSTextField::labelWithString(&NSString::from_str(spec.label), mtm);
        label.setFont(Some(&NSFont::menuFontOfSize(0.0)));
        label.setTextColor(Some(if spec.destructive {
            &theme.destructive_text
        } else {
            &theme.text_primary
        }));
        label.setUsesSingleLineMode(true);
        label.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        label.sizeToFit();
        let natural_label_size = label.frame().size;

        let sublabel = spec.sublabel.map(|text| {
            let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
            field.setFont(Some(&NSFont::menuFontOfSize(SMALL_MENU_FONT_SIZE)));
            field.setTextColor(Some(&theme.text_tertiary));
            // Measure the single-line natural size first; the wrap
            // configuration below would make sizeToFit wrap at the current
            // frame width.
            field.setUsesSingleLineMode(true);
            field.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
            field.sizeToFit();
            if spec.wrap_sublabel {
                // DOM line-clamp-2: wrap to two lines, then ellipsize. The
                // truncating line-break modes make the cell non-wrapping
                // (sizeThatFits would ignore the proposed width and report a
                // single line — verified against the live menu), so wrapping
                // needs ByWordWrapping plus truncatesLastVisibleLine for the
                // trailing ellipsis.
                field.setUsesSingleLineMode(false);
                field.setLineBreakMode(NSLineBreakMode::ByWordWrapping);
                field.setMaximumNumberOfLines(2);
                if let Some(cell) = field.cell() {
                    cell.setTruncatesLastVisibleLine(true);
                }
            } else {
                field.setMaximumNumberOfLines(1);
            }
            field
        });
        let natural_sublabel_size = sublabel.as_ref().map(|field| field.frame().size);

        let accel = spec.accelerator.as_deref().map(|display| {
            let field = NSTextField::labelWithString(&NSString::from_str(display), mtm);
            field.setFont(Some(&NSFont::menuFontOfSize(SMALL_MENU_FONT_SIZE)));
            field.setTextColor(Some(&theme.text_tertiary));
            field.setUsesSingleLineMode(true);
            field.sizeToFit();
            field
        });
        let natural_accel_size = accel.as_ref().map(|field| field.frame().size);

        let detail = spec.detail.map(|text| {
            let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
            field.setFont(Some(&NSFont::menuFontOfSize(SMALL_MENU_FONT_SIZE)));
            field.setTextColor(Some(&theme.text_secondary));
            field.setUsesSingleLineMode(true);
            // The detail is the first thing to give way when the row is
            // squeezed; ellipsize whatever no longer fits.
            field.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
            field.sizeToFit();
            field
        });
        let natural_detail_size = detail.as_ref().map(|field| field.frame().size);

        let icon_images = spec.icon.and_then(row_icon_image).map(MenuImage::new);
        let icon = icon_images.as_ref().map(|images| {
            let view = NSImageView::new(mtm);
            view.setImage(Some(images.image(false)));
            view.setImageScaling(NSImageScaling::ScaleProportionallyDown);
            view
        });

        let chevron = spec.chevron.then(|| {
            let view = NSImageView::new(mtm);
            if let Some(image) = system_symbol_image("chevron.right") {
                view.setImage(Some(&image));
            }
            view.setImageScaling(NSImageScaling::ScaleProportionallyDown);
            view.setContentTintColor(Some(&theme.text_tertiary));
            view
        });

        let star_button = spec.star.and(spec.star_images).map(|_| {
            let button = NSButton::new(mtm);
            button.setTitle(&NSString::from_str(""));
            button.setBordered(false);
            // MomentaryChange keeps the borderless image from drawing a
            // pressed-in bezel or swapped image while clicked.
            button.setButtonType(NSButtonType::MomentaryChange);
            button.setImagePosition(NSCellImagePosition::ImageOnly);
            button.setEnabled(spec.enabled);
            button
        });

        let (pill_text, pill_box_size) = if spec.checked {
            let attributed = NSMutableAttributedString::initWithString(
                NSMutableAttributedString::alloc(),
                &NSString::from_str("SELECTED"),
            );
            // SAFETY: reading AppKit's constant font-weight static.
            let weight = unsafe { NSFontWeightSemibold };
            add_text_attributes(
                &attributed,
                NSRange::new(0, attributed.length()),
                &NSFont::systemFontOfSize_weight(PILL_FONT_SIZE, weight),
                Some(&theme.badge_text),
            );
            let attributed: Retained<NSAttributedString> = Retained::into_super(attributed);
            let text_size = attributed.size();
            let box_size = NSSize::new(
                text_size.width + 2.0 * PILL_PADDING_X,
                text_size.height + 2.0 * PILL_PADDING_Y,
            );
            (Some(attributed), Some(box_size))
        } else {
            (None, None)
        };

        let this = Self::alloc(mtm).set_ivars(MenuRowViewIvars {
            highlight_style: theme.highlight_style,
            enabled: spec.enabled,
            wrap_sublabel: spec.wrap_sublabel,
            indent_points: f64::from(spec.indent) * INDENT_LEVEL_POINTS,
            reserve_icon_slot: spec.reserve_icon_slot,
            starred: Cell::new(spec.star.unwrap_or(false)),
            star_hovered: Cell::new(false),
            highlighted: Cell::new(false),
            natural_label_size,
            natural_sublabel_size,
            natural_accel_size,
            natural_detail_size,
            intrinsic_size: Cell::new(NSSize::new(0.0, ROW_HEIGHT)),
            sublabel_display_height: Cell::new(0.0),
            pill_box_size,
            pill_text,
            icon,
            icon_images,
            label,
            sublabel,
            accel,
            star_button,
            star_images: spec.star.and(spec.star_images).cloned(),
            detail,
            chevron,
            label_color: if spec.destructive {
                theme.destructive_text.clone()
            } else {
                theme.text_primary.clone()
            },
            text_secondary: theme.text_secondary.clone(),
            text_tertiary: theme.text_tertiary.clone(),
            hover_background: theme.hover_background.clone(),
            hover_border: theme.hover_border.clone(),
            badge_background: theme.badge_background.clone(),
        });
        // SAFETY: initWithFrame: is NSView's designated initializer.
        let this: Retained<Self> = unsafe {
            msg_send![super(this), initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, ROW_HEIGHT))]
        };
        // NSMenu stretches width-sizable item views to the final menu width.
        this.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable);
        if let Some(appearance) = &theme.appearance {
            this.setAppearance(Some(appearance));
        }
        if !spec.enabled {
            // DOM disabled rows: the whole content at half opacity.
            this.setAlphaValue(0.5);
        }

        let ivars = this.ivars();
        if let Some(icon) = &ivars.icon {
            this.addSubview(icon);
        }
        this.addSubview(&ivars.label);
        if let Some(field) = &ivars.sublabel {
            this.addSubview(field);
        }
        if let Some(field) = &ivars.accel {
            this.addSubview(field);
        }
        if let Some(field) = &ivars.detail {
            this.addSubview(field);
        }
        if let Some(chevron) = &ivars.chevron {
            this.addSubview(chevron);
        }
        if let Some(button) = &ivars.star_button {
            this.addSubview(button);
            // Button hover drives the DOM star's color lift and hover fill.
            // The area lives on the button with InVisibleRect, so its rect
            // tracks the button frame; the owner (this row view) receives
            // mouseEntered:/mouseExited:. ActiveAlways because menu tracking
            // runs its own modal loop. The area retains its owner — the
            // handler breaks the resulting cycle after the popup ends.
            // SAFETY: initWithRect:options:owner:userInfo: is NSTrackingArea's
            // designated initializer; the owner implements mouseEntered:/
            // mouseExited: and outlives the area (it is removed before the
            // row view is released).
            let area = unsafe {
                NSTrackingArea::initWithRect_options_owner_userInfo(
                    NSTrackingArea::alloc(),
                    NSRect::ZERO,
                    NSTrackingAreaOptions::MouseEnteredAndExited
                        | NSTrackingAreaOptions::ActiveAlways
                        | NSTrackingAreaOptions::InVisibleRect,
                    Some(&this),
                    None,
                )
            };
            button.addTrackingArea(&area);
        }

        // Best-effort accessibility: the row reads as its text (including a
        // submenu's current selection). setAccessibilityLabel: exists on all
        // supported macOS.
        let mut row_ax_label = match spec.sublabel {
            Some(sublabel) => format!("{}, {}", spec.label, sublabel),
            None => spec.label.to_string(),
        };
        if let Some(detail) = spec.detail {
            row_ax_label = format!("{row_ax_label}, {detail}");
        }
        // SAFETY: setAccessibilityLabel: takes an NSString and returns
        // nothing on both NSView and NSButton.
        unsafe {
            let _: () =
                msg_send![&*this, setAccessibilityLabel: &*NSString::from_str(&row_ax_label)];
            if let Some(button) = &this.ivars().star_button {
                let _: () = msg_send![
                    &**button,
                    setAccessibilityLabel: &*NSString::from_str("Use by default")
                ];
            }
        }

        this.refresh_star_visuals();
        this
    }

    /// The width this row needs to render without truncation. Wrapping rows
    /// exclude the sublabel — it adapts to the final width instead of
    /// widening the menu.
    fn natural_width(&self) -> f64 {
        let ivars = self.ivars();
        let mut width = MENU_PADDING_X + ROW_INSET_X + ivars.indent_points;
        if ivars.icon.is_some() || ivars.reserve_icon_slot {
            width += MENU_ICON_POINTS + ICON_LABEL_GAP;
        }
        let mut text_width = ivars.natural_label_size.width;
        if !ivars.wrap_sublabel {
            if let Some(size) = ivars.natural_sublabel_size {
                text_width = text_width.max(size.width);
            }
        }
        width += text_width;

        let mut trailing = 0.0;
        let mut trailing_count = 0u32;
        if let Some(size) = ivars.pill_box_size {
            trailing += size.width;
            trailing_count += 1;
        }
        if ivars.chevron.is_some() {
            trailing += CHEVRON_SIZE;
            trailing_count += 1;
        }
        if ivars.star_button.is_some() {
            trailing += STAR_BUTTON_SIZE;
            trailing_count += 1;
        }
        if let Some(size) = ivars.natural_detail_size {
            trailing += size.width;
            trailing_count += 1;
        }
        if let Some(size) = ivars.natural_accel_size {
            trailing += size.width;
            trailing_count += 1;
        }
        if trailing_count > 0 {
            width +=
                LABEL_TRAILING_GAP + trailing + TRAILING_ITEM_GAP * f64::from(trailing_count - 1);
        }
        width + ROW_INSET_X + MENU_PADDING_X
    }

    /// Fixes the row's negotiated size at the menu's shared content width:
    /// measures the (possibly wrapped) sublabel there, records the intrinsic
    /// size the menu representation should honor, and runs a first placement.
    fn finalize_layout(&self, width: f64) {
        let ivars = self.ivars();
        let geometry = self.geometry_for_width(width);
        let sublabel_height = ivars.natural_sublabel_size.map(|natural| {
            if ivars.wrap_sublabel && natural.width > geometry.text_available {
                let field = ivars
                    .sublabel
                    .as_ref()
                    .expect("sublabel field exists when its natural size does");
                field
                    .sizeThatFits(NSSize::new(geometry.text_available, 10_000.0))
                    .height
            } else {
                natural.height
            }
        });
        ivars
            .sublabel_display_height
            .set(sublabel_height.unwrap_or(0.0));

        let content_height = ivars.natural_label_size.height
            + sublabel_height.map_or(0.0, |height| ROW_LINE_GAP + height);
        let height = ROW_HEIGHT.max(content_height + 2.0 * ROW_VERTICAL_PADDING);
        ivars.intrinsic_size.set(NSSize::new(width, height));
        // Pre-table path (before macOS 14): the representation takes this
        // frame directly and stretches it via autoresizing. setFrame triggers
        // setFrameSize:, which re-places the subviews from the new bounds.
        self.setFrame(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(width, height),
        ));
        self.place_subviews();
    }

    /// Computes the trailing-zone x-positions and text budget for `width`,
    /// using the same insets/gaps everywhere so measurement and placement
    /// can never disagree.
    fn geometry_for_width(&self, width: f64) -> RowGeometry {
        let ivars = self.ivars();
        let content_x = MENU_PADDING_X + ROW_INSET_X + ivars.indent_points;
        // A reserved (empty) icon slot indents the label exactly like a real
        // icon would, so icon-less rows align with their icon-bearing
        // siblings; the icon itself, when present, still draws at content_x.
        let label_x = if ivars.icon.is_some() || ivars.reserve_icon_slot {
            content_x + MENU_ICON_POINTS + ICON_LABEL_GAP
        } else {
            content_x
        };
        let mut cursor = width - MENU_PADDING_X - ROW_INSET_X;
        let mut has_trailing = false;
        if let Some(size) = ivars.pill_box_size {
            // The pill is drawn from bounds in drawRect; only its
            // reservation matters here.
            cursor -= size.width + TRAILING_ITEM_GAP;
            has_trailing = true;
        }
        let chevron_x = ivars.chevron.as_ref().map(|_| {
            cursor -= CHEVRON_SIZE;
            let x = cursor;
            cursor -= TRAILING_ITEM_GAP;
            has_trailing = true;
            x
        });
        // The star sits between the accelerator and the pill/chevron, as in
        // the DOM rows.
        let star_x = ivars.star_button.as_ref().map(|_| {
            cursor -= STAR_BUTTON_SIZE;
            let x = cursor;
            cursor -= TRAILING_ITEM_GAP;
            has_trailing = true;
            x
        });
        let detail = ivars.natural_detail_size.map(|size| {
            // The detail gives way before the label: cap it so the label
            // keeps its natural width when the row is squeezed.
            let max_width =
                (cursor - LABEL_TRAILING_GAP - label_x - ivars.natural_label_size.width).max(0.0);
            let display_width = size.width.min(max_width);
            cursor -= display_width;
            let x = cursor;
            cursor -= TRAILING_ITEM_GAP;
            has_trailing = true;
            (x, display_width)
        });
        let accel_x = ivars.natural_accel_size.map(|size| {
            cursor -= size.width;
            let x = cursor;
            cursor -= TRAILING_ITEM_GAP;
            has_trailing = true;
            x
        });
        let text_right = if has_trailing {
            cursor + TRAILING_ITEM_GAP - LABEL_TRAILING_GAP
        } else {
            cursor
        };
        RowGeometry {
            label_x,
            text_available: (text_right - label_x).max(1.0),
            accel_x,
            star_x,
            detail,
            chevron_x,
        }
    }

    /// Places every subview from the CURRENT bounds. The menu representation
    /// may resize the row to a width of its own choosing (the table-backed
    /// menus on macOS 14+ do, ignoring preset frames and autoresizing), so
    /// placement never trusts build-time coordinates; setFrameSize: reruns it
    /// on every size change. The icon and the trailing zone center on the
    /// label's first line (see [`Self::first_line_box`]), not the row.
    fn place_subviews(&self) {
        let ivars = self.ivars();
        let bounds = self.bounds();
        let height = bounds.size.height;
        let geometry = self.geometry_for_width(bounds.size.width);
        let (first_line_top, first_line_height) = self.first_line_box(height);

        let label_size = NSSize::new(
            ivars.natural_label_size.width.min(geometry.text_available),
            ivars.natural_label_size.height,
        );
        let sublabel_size = ivars
            .natural_sublabel_size
            .zip(self.displayed_sublabel_height())
            .map(|(natural, display_height)| {
                let display_width = if ivars.wrap_sublabel {
                    geometry.text_available
                } else {
                    natural.width.min(geometry.text_available)
                };
                NSSize::new(display_width, display_height)
            });

        let content_x = MENU_PADDING_X + ROW_INSET_X + ivars.indent_points;

        if let Some(icon) = &ivars.icon {
            icon.setFrame(NSRect::new(
                NSPoint::new(
                    content_x,
                    first_line_top + (first_line_height - MENU_ICON_POINTS) / 2.0,
                ),
                NSSize::new(MENU_ICON_POINTS, MENU_ICON_POINTS),
            ));
        }
        ivars.label.setFrame(NSRect::new(
            NSPoint::new(geometry.label_x, first_line_top),
            label_size,
        ));
        if let (Some(field), Some(size)) = (&ivars.sublabel, sublabel_size) {
            field.setFrame(NSRect::new(
                NSPoint::new(
                    geometry.label_x,
                    first_line_top + label_size.height + ROW_LINE_GAP,
                ),
                size,
            ));
        }
        if let (Some(field), Some(size), Some(x)) =
            (&ivars.accel, ivars.natural_accel_size, geometry.accel_x)
        {
            field.setFrame(NSRect::new(
                NSPoint::new(x, first_line_top + (first_line_height - size.height) / 2.0),
                size,
            ));
        }
        if let (Some(field), Some(size), Some((x, display_width))) =
            (&ivars.detail, ivars.natural_detail_size, geometry.detail)
        {
            field.setFrame(NSRect::new(
                NSPoint::new(x, first_line_top + (first_line_height - size.height) / 2.0),
                NSSize::new(display_width, size.height),
            ));
        }
        if let (Some(button), Some(x)) = (&ivars.star_button, geometry.star_x) {
            // Like the rest of the trailing zone, the star centers on the
            // label's first line, not the (possibly two-line) row.
            button.setFrame(NSRect::new(
                NSPoint::new(
                    x,
                    first_line_top + (first_line_height - STAR_BUTTON_SIZE) / 2.0,
                ),
                NSSize::new(STAR_BUTTON_SIZE, STAR_BUTTON_SIZE),
            ));
        }
        if let (Some(chevron), Some(x)) = (&ivars.chevron, geometry.chevron_x) {
            chevron.setFrame(NSRect::new(
                NSPoint::new(x, first_line_top + (first_line_height - CHEVRON_SIZE) / 2.0),
                NSSize::new(CHEVRON_SIZE, CHEVRON_SIZE),
            ));
        }
        self.setNeedsDisplay(true);
    }

    /// The sublabel's display height: measured at the shared content width in
    /// [`Self::finalize_layout`], falling back to the natural single-line
    /// height before the first layout pass. `None` when the row has no
    /// sublabel.
    fn displayed_sublabel_height(&self) -> Option<f64> {
        let ivars = self.ivars();
        ivars.natural_sublabel_size.map(|natural| {
            let stored = ivars.sublabel_display_height.get();
            if stored > 0.0 {
                stored
            } else {
                natural.height
            }
        })
    }

    /// The vertical box of the label's first text line for a row of `height`,
    /// as `(top, height)` in flipped coordinates. The DOM dropdown anchors
    /// the leading icon and the whole trailing zone (accelerator, detail,
    /// SELECTED pill, chevron) to this box — `items-start` plus
    /// line-height-tall wrappers — so on two-line rows those elements center
    /// on the first line, not the row. Single-line rows are unaffected: the
    /// box spans the whole content, so centering within it equals centering
    /// within the row.
    fn first_line_box(&self, height: f64) -> (f64, f64) {
        let label_height = self.ivars().natural_label_size.height;
        let content_height = label_height
            + self
                .displayed_sublabel_height()
                .map_or(0.0, |sublabel| ROW_LINE_GAP + sublabel);
        (((height - content_height) / 2.0).max(0.0), label_height)
    }

    fn draw_impl(&self) {
        let ivars = self.ivars();
        let bounds = self.bounds();
        if ivars.highlighted.get() && ivars.enabled {
            let highlight_rect = NSRect::new(
                NSPoint::new(MENU_PADDING_X, 0.0),
                NSSize::new(
                    (bounds.size.width - 2.0 * MENU_PADDING_X).max(0.0),
                    bounds.size.height,
                ),
            );
            let background = match ivars.highlight_style {
                MenuHighlightStyle::System => NSColor::selectedContentBackgroundColor(),
                MenuHighlightStyle::Themed => ivars.hover_background.clone(),
            };
            draw_menu_row_highlight(highlight_rect, &background, ivars.hover_border.as_deref());
        }
        if let Some(button) = &ivars.star_button {
            // The DOM star button's own hover fill (`hover:bg-…`, `rounded`):
            // painted under the glyph subview while the pointer is on the
            // button, in both pinned and unpinned states.
            if ivars.star_hovered.get() && ivars.enabled && !button.isHidden() {
                ivars.hover_background.set();
                NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
                    button.frame(),
                    STAR_HOVER_CORNER_RADIUS,
                    STAR_HOVER_CORNER_RADIUS,
                )
                .fill();
            }
        }
        if let (Some(pill_text), Some(pill_size)) = (&ivars.pill_text, ivars.pill_box_size) {
            // Like the rest of the trailing zone, the pill centers on the
            // label's first line, not the (possibly two-line) row.
            let (first_line_top, first_line_height) = self.first_line_box(bounds.size.height);
            let pill_rect = NSRect::new(
                NSPoint::new(
                    bounds.size.width - MENU_PADDING_X - ROW_INSET_X - pill_size.width,
                    first_line_top + (first_line_height - pill_size.height) / 2.0,
                ),
                pill_size,
            );
            ivars.badge_background.set();
            let radius = pill_size.height / 2.0;
            NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(pill_rect, radius, radius)
                .fill();
            let text_size = pill_text.size();
            pill_text.drawAtPoint(NSPoint::new(
                pill_rect.origin.x + (pill_size.width - text_size.width) / 2.0,
                pill_rect.origin.y + (pill_size.height - text_size.height) / 2.0,
            ));
        }
    }

    fn hit_test_impl(&self, point: NSPoint) -> Option<Retained<NSView>> {
        // SAFETY: forwarding to NSView's hitTest: with the superview-space
        // point it handed us.
        let hit: Option<Retained<NSView>> = unsafe { msg_send![super(self), hitTest: point] };
        let hit = hit?;
        if let Some(star_button) = &self.ivars().star_button {
            let star_button: &NSView = star_button;
            if self.ivars().enabled && hit.isDescendantOf(star_button) {
                return Some(hit);
            }
        }
        Some(Retained::into_super(self.retain()))
    }

    /// Points the star button at the handler; `tag` is the row's index in the
    /// handler's star-row registry.
    fn wire_star_button(&self, handler: &MenuActionHandler, tag: usize) {
        let Some(star_button) = &self.ivars().star_button else {
            return;
        };
        // SAFETY: the handler outlives the popup (NSControl targets are
        // weak), and starClicked: matches the handler's method signature.
        unsafe {
            let target: &AnyObject = handler;
            star_button.setTarget(Some(target));
            star_button.setAction(Some(sel!(starClicked:)));
        }
        star_button.setTag(tag as isize);
    }

    fn starred(&self) -> bool {
        self.ivars().starred.get()
    }

    fn set_starred(&self, starred: bool) {
        if self.ivars().starred.replace(starred) != starred {
            self.refresh_star_visuals();
        }
    }

    fn set_star_hovered(&self, hovered: bool) {
        if self.ivars().star_hovered.replace(hovered) != hovered {
            self.refresh_star_visuals();
        }
    }

    /// Use the system menu foreground on the selection fill, restoring the
    /// themed colors (including destructive labels) when the highlight leaves.
    fn set_highlighted(&self, highlighted: bool) {
        let ivars = self.ivars();
        let highlighted = highlighted && ivars.enabled;
        if ivars.highlighted.replace(highlighted) != highlighted {
            if ivars.highlight_style == MenuHighlightStyle::Themed {
                self.refresh_star_visuals();
                return;
            }
            let selected_text = NSColor::selectedMenuItemTextColor();
            if let (Some(icon), Some(images)) = (&ivars.icon, &ivars.icon_images) {
                icon.setImage(Some(images.image(highlighted)));
                icon.setContentTintColor(highlighted.then_some(&selected_text));
            }
            ivars.label.setTextColor(Some(if highlighted {
                &selected_text
            } else {
                &ivars.label_color
            }));
            let secondary = if highlighted {
                &selected_text
            } else {
                &ivars.text_secondary
            };
            let tertiary = if highlighted {
                &selected_text
            } else {
                &ivars.text_tertiary
            };
            for field in [&ivars.sublabel, &ivars.accel].into_iter().flatten() {
                field.setTextColor(Some(tertiary));
            }
            if let Some(detail) = &ivars.detail {
                detail.setTextColor(Some(secondary));
            }
            if let Some(chevron) = &ivars.chevron {
                chevron.setContentTintColor(Some(tertiary));
            }
            self.refresh_star_visuals();
        }
    }

    /// Applies the DOM star-button state model, then repaints. The button is
    /// hidden unless the row is highlighted or the star is pinned. The pinned
    /// or unpinned shape uses the selection foreground on highlighted rows,
    /// restoring the original artwork when the highlight leaves. No-star rows
    /// fall through to the plain repaint.
    fn refresh_star_visuals(&self) {
        let ivars = self.ivars();
        if let (Some(button), Some(images)) = (&ivars.star_button, &ivars.star_images) {
            let starred = ivars.starred.get();
            let highlighted = ivars.highlighted.get() && ivars.enabled;
            let visible = highlighted || starred;
            button.setHidden(!visible);
            if !visible {
                // A hidden button receives no mouseExited:; drop the hover
                // state so it does not stick to the next reveal.
                ivars.star_hovered.set(false);
            }
            let image = if starred {
                &images.pinned
            } else if ivars.star_hovered.get() && ivars.enabled {
                &images.hover
            } else {
                &images.normal
            };
            let tint = highlighted && ivars.highlight_style == MenuHighlightStyle::System;
            button.setImage(Some(image.image(tint)));
            button.setContentTintColor(
                tint.then(|| NSColor::selectedMenuItemTextColor())
                    .as_deref(),
            );
        }
        self.setNeedsDisplay(true);
    }

    /// Detaches the star button's tracking area. The area strongly retains
    /// its owner (this row view), a retain cycle through the button; called
    /// once the popup's tracking loop ends so closed menus free their rows.
    fn remove_star_tracking(&self) {
        let Some(button) = &self.ivars().star_button else {
            return;
        };
        for area in button.trackingAreas().iter() {
            button.removeTrackingArea(&area);
        }
    }
}

/// The separator's line color and optional label.
#[cfg(target_os = "macos")]
struct MenuSeparatorViewIvars {
    color: Retained<NSColor>,
    label: Option<Retained<NSTextField>>,
    /// Shared content width by separator height, reported via
    /// intrinsicContentSize for the table-backed menu representation.
    intrinsic_size: Cell<NSSize>,
}

#[cfg(target_os = "macos")]
define_class!(
    // SAFETY:
    // - NSView has no additional subclassing requirements beyond designated
    //   initializers, and the view is created through initWithFrame:.
    // - The view is only created and messaged on the main thread while the
    //   popup tracking loop runs.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = MenuSeparatorViewIvars]
    struct MenuSeparatorView;

    /// Mirrors the DOM DropdownSeparator: a 1pt line with small vertical
    /// margins, optionally followed by a left-aligned section label.
    impl MenuSeparatorView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        // The table-backed menu representation (macOS 14+) sizes item views
        // from intrinsicContentSize and ignores preset frames.
        #[unsafe(method(intrinsicContentSize))]
        fn intrinsic_content_size(&self) -> NSSize {
            self.ivars().intrinsic_size.get()
        }

        // The line is drawn from bounds and the label is left-anchored, so a
        // resize only needs a repaint.
        #[unsafe(method(setFrameSize:))]
        fn set_frame_size(&self, new_size: NSSize) {
            // SAFETY: forwarding to NSView's own setFrameSize:.
            unsafe {
                let _: () = msg_send![super(self), setFrameSize: new_size];
            }
            self.setNeedsDisplay(true);
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty_rect: NSRect) {
            let bounds = self.bounds();
            self.ivars().color.set();
            NSBezierPath::fillRect(NSRect::new(
                NSPoint::new(MENU_PADDING_X, SEPARATOR_MARGIN_Y),
                NSSize::new(
                    (bounds.size.width - 2.0 * MENU_PADDING_X).max(0.0),
                    SEPARATOR_THICKNESS,
                ),
            ));
        }
    }

    // SAFETY: NSObjectProtocol has no extra safety requirements.
    unsafe impl NSObjectProtocol for MenuSeparatorView {}
);

#[cfg(target_os = "macos")]
impl MenuSeparatorView {
    fn new(label: Option<&str>, theme: &MenuTheme, mtm: MainThreadMarker) -> Retained<Self> {
        let label = label.map(|text| {
            let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
            field.setFont(Some(&NSFont::menuFontOfSize(SMALL_MENU_FONT_SIZE)));
            field.setTextColor(Some(&theme.text_tertiary));
            field.setUsesSingleLineMode(true);
            field.sizeToFit();
            field
        });
        let height = match &label {
            Some(field) => {
                SEPARATOR_MARGIN_Y
                    + SEPARATOR_THICKNESS
                    + SEPARATOR_LABEL_GAP
                    + field.frame().size.height
                    + SEPARATOR_LABEL_GAP
            }
            None => 2.0 * SEPARATOR_MARGIN_Y + SEPARATOR_THICKNESS,
        };

        let this = Self::alloc(mtm).set_ivars(MenuSeparatorViewIvars {
            color: theme.separator.clone(),
            label,
            intrinsic_size: Cell::new(NSSize::new(0.0, height)),
        });
        // SAFETY: initWithFrame: is NSView's designated initializer.
        let this: Retained<Self> = unsafe {
            msg_send![super(this), initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, height))]
        };
        this.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable);
        if let Some(appearance) = &theme.appearance {
            this.setAppearance(Some(appearance));
        }
        if let Some(field) = &this.ivars().label {
            field.setFrameOrigin(NSPoint::new(
                MENU_PADDING_X + ROW_INSET_X,
                SEPARATOR_MARGIN_Y + SEPARATOR_THICKNESS + SEPARATOR_LABEL_GAP,
            ));
            this.addSubview(field);
        }
        this
    }

    fn natural_width(&self) -> f64 {
        match &self.ivars().label {
            Some(field) => {
                MENU_PADDING_X
                    + ROW_INSET_X
                    + field.frame().size.width
                    + ROW_INSET_X
                    + MENU_PADDING_X
            }
            None => 2.0 * (MENU_PADDING_X + ROW_INSET_X),
        }
    }

    fn finalize_layout(&self, width: f64) {
        let height = self.frame().size.height;
        self.ivars().intrinsic_size.set(NSSize::new(width, height));
        self.setFrame(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(width, height),
        ));
        self.setNeedsDisplay(true);
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn draw_menu_row_highlight(
    rect: NSRect,
    background: &NSColor,
    border: Option<&NSColor>,
) {
    let radius = ROW_HIGHLIGHT_CORNER_RADIUS;
    background.set();
    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect, radius, radius).fill();
    if let Some(border) = border {
        stroke_rounded_border(inset_rect(rect, 0.5), radius - 0.5, border);
    }
}

#[cfg(target_os = "macos")]
fn inset_rect(rect: NSRect, inset: f64) -> NSRect {
    NSRect::new(
        NSPoint::new(rect.origin.x + inset, rect.origin.y + inset),
        NSSize::new(
            (rect.size.width - 2.0 * inset).max(0.0),
            (rect.size.height - 2.0 * inset).max(0.0),
        ),
    )
}

/// Strokes a 1px rounded-rect hairline in `color` (used for the optional
/// hover ring and pill border).
#[cfg(target_os = "macos")]
fn stroke_rounded_border(rect: NSRect, radius: f64, color: &NSColor) {
    color.set();
    let path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
        rect,
        radius.max(0.0),
        radius.max(0.0),
    );
    path.setLineWidth(1.0);
    path.stroke();
}

#[cfg(target_os = "macos")]
fn add_text_attributes(
    attributed: &NSMutableAttributedString,
    range: NSRange,
    font: &NSFont,
    color: Option<&NSColor>,
) {
    // SAFETY: NSFontAttributeName expects an NSFont value and
    // NSForegroundColorAttributeName an NSColor value, which is what is
    // passed; the ranges are computed from the string's own UTF-16 lengths.
    unsafe {
        attributed.addAttribute_value_range(NSFontAttributeName, font, range);
        if let Some(color) = color {
            attributed.addAttribute_value_range(NSForegroundColorAttributeName, color, range);
        }
    }
}

/// Builds a row icon: a file's own OS icon when `filePath` is present, else
/// raw PNG data. Any decode or lookup failure degrades to no icon rather
/// than an error. PNGs arrive pre-colored from the webview; [`MenuImage`]
/// preserves that artwork and supplies a template copy for highlighted rows.
#[cfg(target_os = "macos")]
fn row_icon_image(icon: &WireIcon) -> Option<Retained<NSImage>> {
    if let Some(path) = icon.file_path.as_deref() {
        return Some(file_icon_image(path));
    }
    icon.png_base64.as_deref().and_then(png_image)
}

/// The OS's own icon for the file at `path`, as Finder shows it. NSWorkspace
/// always returns an image — missing or unreadable paths get a generic icon —
/// so this never fails. Full color, never template.
#[cfg(target_os = "macos")]
fn file_icon_image(path: &str) -> Retained<NSImage> {
    let image = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path));
    image.setSize(NSSize::new(MENU_ICON_POINTS, MENU_ICON_POINTS));
    image
}

#[cfg(target_os = "macos")]
fn system_symbol_image(name: &str) -> Option<Retained<NSImage>> {
    let symbol_name = NSString::from_str(name);
    // imageWithSystemSymbolName:accessibilityDescription: exists on macOS 11+.
    let supported: bool = unsafe {
        msg_send![
            NSImage::class(),
            respondsToSelector: sel!(imageWithSystemSymbolName:accessibilityDescription:)
        ]
    };
    if !supported {
        return None;
    }
    NSImage::imageWithSystemSymbolName_accessibilityDescription(&symbol_name, None)
}

#[cfg(target_os = "macos")]
fn png_image(base64: &str) -> Option<Retained<NSImage>> {
    let data = NSData::initWithBase64EncodedString_options(
        NSData::alloc(),
        &NSString::from_str(base64.trim()),
        NSDataBase64DecodingOptions::IgnoreUnknownCharacters,
    )?;
    let image = NSImage::initWithData(NSImage::alloc(), &data)?;
    image.setSize(NSSize::new(MENU_ICON_POINTS, MENU_ICON_POINTS));
    Some(image)
}

/// Decodes one of the request's pre-rasterized star glyphs. The webview
/// renders them at 2x in the exact theme colors, so the fixed point size pins
/// the glyph to the DOM's 13px while the doubled pixel backing keeps it sharp
/// on retina displays. The original retains its state color; [`MenuImage`]
/// makes a separate template copy for the selection foreground.
#[cfg(target_os = "macos")]
fn star_png_image(base64: &str) -> Option<Retained<NSImage>> {
    let data = NSData::initWithBase64EncodedString_options(
        NSData::alloc(),
        &NSString::from_str(base64.trim()),
        NSDataBase64DecodingOptions::IgnoreUnknownCharacters,
    )?;
    let image = NSImage::initWithData(NSImage::alloc(), &data)?;
    image.setSize(NSSize::new(STAR_GLYPH_POINTS, STAR_GLYPH_POINTS));
    Some(image)
}

/// Walks the supermenu chain to the root so cancelTracking dismisses the
/// whole tree, not just an open submenu.
#[cfg(target_os = "macos")]
fn root_menu(menu: Retained<NSMenu>) -> Retained<NSMenu> {
    let mut root = menu;
    // SAFETY: reading the supermenu chain on the main thread while the menu
    // tree is alive.
    while let Some(parent) = unsafe { root.supermenu() } {
        root = parent;
    }
    root
}

/// Registry indices of the star rows sharing `clicked`'s star group, in
/// registry order and always including `clicked` itself. A row without a
/// group is its own singleton group: it selects only itself, and no other
/// row's click ever selects it. Out-of-range clicks select nothing.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn star_group_members(groups: &[Option<&str>], clicked: usize) -> Vec<usize> {
    match groups.get(clicked) {
        None => Vec::new(),
        Some(None) => vec![clicked],
        Some(Some(group)) => groups
            .iter()
            .enumerate()
            .filter(|(_, candidate)| **candidate == Some(*group))
            .map(|(index, _)| index)
            .collect(),
    }
}

/// Computes one star group's next starred states after a star click on the
/// group row at `clicked` (`current` holds that group's rows in registry
/// order). Radio-with-toggle: starring a row clears every other row of the
/// group, and clicking an already-starred row's star clears it. Out-of-range
/// clicks leave the states unchanged.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn next_star_states(current: &[bool], clicked: usize) -> Vec<bool> {
    if clicked >= current.len() {
        return current.to_vec();
    }
    let starring = !current[clicked];
    (0..current.len())
        .map(|index| starring && index == clicked)
        .collect()
}

#[cfg(target_os = "macos")]
fn key_equivalent_modifier_mask(accelerator: &ParsedAccelerator) -> NSEventModifierFlags {
    let mut flags = NSEventModifierFlags::empty();
    if accelerator.command {
        flags |= NSEventModifierFlags::Command;
    }
    if accelerator.control {
        flags |= NSEventModifierFlags::Control;
    }
    if accelerator.option {
        flags |= NSEventModifierFlags::Option;
    }
    if accelerator.shift {
        flags |= NSEventModifierFlags::Shift;
    }
    flags
}

/// An accelerator string parsed into an NSMenuItem key equivalent and its
/// modifier set. Pure so it can be unit-tested without AppKit.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedAccelerator {
    key_equivalent: String,
    command: bool,
    control: bool,
    option: bool,
    shift: bool,
}

// AppKit's NSUpArrowFunctionKey..NSRightArrowFunctionKey code points.
const UP_ARROW_FUNCTION_KEY: char = '\u{F700}';
const DOWN_ARROW_FUNCTION_KEY: char = '\u{F701}';
const LEFT_ARROW_FUNCTION_KEY: char = '\u{F702}';
const RIGHT_ARROW_FUNCTION_KEY: char = '\u{F703}';

/// Parses strings like "Cmd+Shift+R" or "Alt+Enter". Returns `None` — the
/// item then simply shows no key equivalent — when any modifier or the key
/// is unrecognized.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_accelerator(accelerator: &str) -> Option<ParsedAccelerator> {
    let mut tokens = accelerator.split('+').map(str::trim);
    let key_token = tokens.next_back()?;
    let mut parsed = ParsedAccelerator {
        key_equivalent: key_equivalent_for_token(key_token)?,
        command: false,
        control: false,
        option: false,
        shift: false,
    };
    for token in tokens {
        match token.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "cmdorctrl" | "commandorcontrol" => parsed.command = true,
            "ctrl" | "control" => parsed.control = true,
            "alt" | "option" => parsed.option = true,
            "shift" => parsed.shift = true,
            _ => return None,
        }
    }
    Some(parsed)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn key_equivalent_for_token(token: &str) -> Option<String> {
    let named = match token.to_ascii_lowercase().as_str() {
        "enter" | "return" => Some('\r'),
        "tab" => Some('\t'),
        "escape" | "esc" => Some('\u{1b}'),
        "backspace" => Some('\u{8}'),
        "delete" => Some('\u{7f}'),
        "space" => Some(' '),
        "up" | "arrowup" => Some(UP_ARROW_FUNCTION_KEY),
        "down" | "arrowdown" => Some(DOWN_ARROW_FUNCTION_KEY),
        "left" | "arrowleft" => Some(LEFT_ARROW_FUNCTION_KEY),
        "right" | "arrowright" => Some(RIGHT_ARROW_FUNCTION_KEY),
        _ => None,
    };
    if let Some(named) = named {
        return Some(named.to_string());
    }

    let mut chars = token.chars();
    let first = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    Some(first.to_lowercase().collect())
}

/// Formats a parsed accelerator the way macOS renders shortcuts (⌃⌥⇧⌘ +
/// key), for the hand-drawn shortcut column. Pure so it can be unit-tested
/// without AppKit.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn accelerator_display_string(accelerator: &ParsedAccelerator) -> String {
    let mut display = String::new();
    if accelerator.control {
        display.push('⌃');
    }
    if accelerator.option {
        display.push('⌥');
    }
    if accelerator.shift {
        display.push('⇧');
    }
    if accelerator.command {
        display.push('⌘');
    }
    display.push_str(&key_display(&accelerator.key_equivalent));
    display
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn key_display(key_equivalent: &str) -> String {
    let named = match key_equivalent {
        "\r" => "↩",
        "\t" => "⇥",
        "\u{1b}" => "⎋",
        "\u{8}" => "⌫",
        "\u{7f}" => "⌦",
        " " => "Space",
        "\u{f700}" => "↑",
        "\u{f701}" => "↓",
        "\u{f702}" => "←",
        "\u{f703}" => "→",
        _ => return key_equivalent.to_uppercase(),
    };
    named.to_string()
}

/// One registered row: the item/view pair the delegate needs to repaint
/// highlights.
#[cfg(target_os = "macos")]
struct RowEntry {
    item: Retained<NSMenuItem>,
    view: Retained<MenuRowView>,
}

/// One registered star row: the action id, its radio scope, and the view
/// whose star to flip.
#[cfg(target_os = "macos")]
struct StarRow {
    id: String,
    /// The wire `starGroup`; `None` keeps the row a singleton group (see
    /// [`star_group_members`]).
    group: Option<String>,
    view: Retained<MenuRowView>,
}

#[cfg(target_os = "macos")]
struct MenuActionHandlerIvars {
    selection: RefCell<Option<String>>,
    /// Every highlightable custom row in the whole menu tree.
    rows: RefCell<Vec<RowEntry>>,
    /// The star subset; a star button's tag indexes this list.
    star_rows: RefCell<Vec<StarRow>>,
    window: WebviewWindow,
    token: Option<String>,
}

#[cfg(target_os = "macos")]
define_class!(
    // SAFETY:
    // - The superclass NSObject does not have additional subclassing
    //   requirements.
    // - The handler is only created and messaged on the main thread while the
    //   popup tracking loop runs.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = MenuActionHandlerIvars]
    struct MenuActionHandler;

    // The pop-up menu's target: records the represented action id of the item
    // the user picked so the command can resolve after the menu closes.
    impl MenuActionHandler {
        #[unsafe(method(itemSelected:))]
        fn item_selected(&self, sender: &NSMenuItem) {
            let selected = sender
                .representedObject()
                .and_then(|object| object.downcast::<NSString>().ok())
                .map(|id| id.to_string());
            if selected.is_some() {
                self.ivars().selection.replace(selected);
            }
        }

        // A star button was clicked: flip the clicked row's star group
        // optimistically (radio-with-toggle scoped to rows sharing its
        // `starGroup`; other groups and singleton rows keep their stars) and
        // notify the webview, which owns persistence. Deliberately neither
        // records a selection nor cancels tracking — the menu stays open.
        #[unsafe(method(starClicked:))]
        fn star_clicked(&self, sender: &NSButton) {
            let Ok(index) = usize::try_from(sender.tag()) else {
                return;
            };
            let (id, starred) = {
                let rows = self.ivars().star_rows.borrow();
                if index >= rows.len() {
                    return;
                }
                let groups: Vec<Option<&str>> =
                    rows.iter().map(|row| row.group.as_deref()).collect();
                let members = star_group_members(&groups, index);
                let states: Vec<bool> = members
                    .iter()
                    .map(|&member| rows[member].view.starred())
                    .collect();
                let clicked = members
                    .iter()
                    .position(|&member| member == index)
                    .expect("star_group_members always includes the clicked row");
                let next = next_star_states(&states, clicked);
                for (&member, &next_starred) in members.iter().zip(&next) {
                    rows[member].view.set_starred(next_starred);
                }
                (rows[index].id.clone(), next[clicked])
            };
            // emit_to scopes the event to the calling window (the webview
            // listens via currentWindow.listen); other windows never see
            // this click.
            let window = &self.ivars().window;
            let _ = window.emit_to(
                window.label(),
                NATIVE_MENU_SET_DEFAULT_EVENT,
                NativeMenuSetDefault {
                    token: self.ivars().token.clone(),
                    id,
                    starred,
                },
            );
        }
    }

    // Highlight bookkeeping for the custom rows. NSMenu does not reliably
    // redraw item views when the highlight moves (mouse or keyboard), so the
    // delegate pushes the new state into every row of the affected menu.
    unsafe impl NSMenuDelegate for MenuActionHandler {
        #[unsafe(method(menu:willHighlightItem:))]
        fn menu_will_highlight_item(&self, menu: &NSMenu, item: Option<&NSMenuItem>) {
            for row in self.ivars().rows.borrow().iter() {
                // SAFETY: reading the item's menu on the main thread while
                // the menu tree is alive.
                let Some(row_menu) = (unsafe { row.item.menu() }) else {
                    continue;
                };
                if !std::ptr::eq::<NSMenu>(&*row_menu, menu) {
                    continue;
                }
                let highlighted =
                    item.is_some_and(|item| std::ptr::eq::<NSMenuItem>(item, &*row.item));
                row.view.set_highlighted(highlighted);
            }
        }

        // Clear stale highlights when a menu closes so a reopened submenu
        // does not briefly show the previous highlight.
        #[unsafe(method(menuDidClose:))]
        fn menu_did_close(&self, menu: &NSMenu) {
            for row in self.ivars().rows.borrow().iter() {
                // SAFETY: reading the item's menu on the main thread while
                // the menu tree is alive.
                let Some(row_menu) = (unsafe { row.item.menu() }) else {
                    continue;
                };
                if std::ptr::eq::<NSMenu>(&*row_menu, menu) {
                    row.view.set_highlighted(false);
                }
            }
        }
    }

    // SAFETY: NSObjectProtocol has no extra safety requirements.
    unsafe impl NSObjectProtocol for MenuActionHandler {}
);

#[cfg(target_os = "macos")]
impl MenuActionHandler {
    fn new(mtm: MainThreadMarker, window: WebviewWindow, token: Option<String>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(MenuActionHandlerIvars {
            selection: RefCell::new(None),
            rows: RefCell::new(Vec::new()),
            star_rows: RefCell::new(Vec::new()),
            window,
            token,
        });
        // SAFETY: NSObject's init method is valid for this NSObject subclass.
        unsafe { msg_send![super(this), init] }
    }

    fn take_selection(&self) -> Option<String> {
        self.ivars().selection.borrow_mut().take()
    }

    /// Adds a row to the highlight-repaint registry.
    fn register_row(&self, item: &NSMenuItem, view: &MenuRowView) {
        self.ivars().rows.borrow_mut().push(RowEntry {
            item: item.retain(),
            view: view.retain(),
        });
    }

    /// Adds a star row to the star registry and returns its index, which the
    /// row's star button carries as its tag.
    fn register_star_row(&self, id: &str, group: Option<&str>, view: &MenuRowView) -> usize {
        let mut rows = self.ivars().star_rows.borrow_mut();
        rows.push(StarRow {
            id: id.to_string(),
            group: group.map(str::to_string),
            view: view.retain(),
        });
        rows.len() - 1
    }

    /// Breaks every star button's tracking-area retain cycle (area → owner
    /// row view → button → area) after the popup's tracking loop ends.
    fn remove_star_tracking_areas(&self) {
        for row in self.ivars().star_rows.borrow().iter() {
            row.view.remove_star_tracking();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_the_wire_request() {
        // Double-hash raw string: the theme's "#rrggbb" values contain the
        // `"#` sequence that would close a plain r#"..."# literal.
        let request: NativeMenuRequest = serde_json::from_str(
            r##"{
                "position": { "x": 12.5, "y": 40 },
                "align": "end",
                "token": "menu-token-1",
                "starIcons": {
                    "pinned": "cGlubmVk",
                    "normal": "bm9ybWFs",
                    "hover": "aG92ZXI="
                },
                "minWidth": 260,
                "theme": {
                    "isDark": true,
                    "textPrimary": "#ffffff",
                    "textSecondary": "#cccccc",
                    "textTertiary": "#999999",
                    "hoverBackground": "#ffffff1a",
                    "separator": "#333333",
                    "badgeBackground": "#264f78",
                    "badgeText": "#9ccfff",
                    "destructiveText": "#ff6369",
                    "iconColor": "#aaaaaa",
                    "hoverBorder": "#ffffff26"
                },
                "items": [
                    {
                        "kind": "action",
                        "id": "delete",
                        "label": "Delete",
                        "sublabel": "Remove the file",
                        "icon": { "pngBase64": "aWNvbg==" },
                        "checked": true,
                        "enabled": false,
                        "accelerator": "Cmd+Backspace",
                        "toolTip": "Moves the file to the Trash",
                        "destructive": true,
                        "star": { "starred": true },
                        "starGroup": "models",
                        "indent": 1
                    },
                    { "kind": "separator", "label": "Danger zone" },
                    { "kind": "separator" },
                    {
                        "kind": "submenu",
                        "label": "More",
                        "icon": { "filePath": "/Users/me/Projects/app", "pngBase64": "aGVsbG8=" },
                        "enabled": true,
                        "detail": "Extra High",
                        "minWidth": 390,
                        "items": [{ "kind": "action", "id": "nested", "label": "Nested" }]
                    }
                ]
            }"##,
        )
        .expect("request should deserialize");

        assert_eq!(request.position.x, 12.5);
        assert_eq!(request.position.y, 40.0);
        assert_eq!(request.align, Some(MenuAlign::End));
        assert_eq!(request.token.as_deref(), Some("menu-token-1"));
        let star_icons = request
            .star_icons
            .as_ref()
            .expect("starIcons should deserialize");
        assert_eq!(star_icons.pinned, "cGlubmVk");
        assert_eq!(star_icons.normal, "bm9ybWFs");
        assert_eq!(star_icons.hover, "aG92ZXI=");
        assert_eq!(request.min_width, Some(260.0));

        let theme = request.theme.as_ref().expect("theme should deserialize");
        assert!(theme.is_dark);
        assert_eq!(theme.text_primary, "#ffffff");
        assert_eq!(theme.text_secondary, "#cccccc");
        assert_eq!(theme.text_tertiary, "#999999");
        assert_eq!(theme.hover_background, "#ffffff1a");
        assert_eq!(theme.separator, "#333333");
        assert_eq!(theme.badge_background, "#264f78");
        assert_eq!(theme.badge_text, "#9ccfff");
        assert_eq!(theme.destructive_text, "#ff6369");
        assert_eq!(theme.icon_color, "#aaaaaa");
        assert_eq!(theme.hover_border.as_deref(), Some("#ffffff26"));

        assert_eq!(request.items.len(), 4);

        let WireItem::Action {
            id,
            label,
            sublabel,
            icon,
            checked,
            enabled,
            accelerator,
            tool_tip,
            destructive,
            star,
            star_group,
            indent,
            reserve_icon_slot,
        } = &request.items[0]
        else {
            panic!("expected an action item, got {:?}", request.items[0]);
        };
        assert_eq!(id, "delete");
        assert_eq!(label, "Delete");
        assert_eq!(sublabel.as_deref(), Some("Remove the file"));
        let icon = icon.as_ref().expect("icon should deserialize");
        assert_eq!(icon.file_path, None);
        assert_eq!(icon.png_base64.as_deref(), Some("aWNvbg=="));
        assert_eq!(*checked, Some(true));
        assert_eq!(*enabled, Some(false));
        assert_eq!(accelerator.as_deref(), Some("Cmd+Backspace"));
        assert_eq!(tool_tip.as_deref(), Some("Moves the file to the Trash"));
        assert_eq!(*destructive, Some(true));
        assert!(star.as_ref().expect("star should deserialize").starred);
        assert_eq!(star_group.as_deref(), Some("models"));
        assert_eq!(*indent, Some(1));
        assert_eq!(*reserve_icon_slot, None);

        let WireItem::Separator { label } = &request.items[1] else {
            panic!("expected a labeled separator, got {:?}", request.items[1]);
        };
        assert_eq!(label.as_deref(), Some("Danger zone"));

        let WireItem::Separator { label } = &request.items[2] else {
            panic!("expected a bare separator, got {:?}", request.items[2]);
        };
        assert_eq!(*label, None);

        let WireItem::Submenu {
            label,
            icon,
            enabled,
            detail,
            reserve_icon_slot,
            min_width,
            items,
        } = &request.items[3]
        else {
            panic!("expected a submenu, got {:?}", request.items[3]);
        };
        assert_eq!(label, "More");
        let icon = icon.as_ref().expect("icon should deserialize");
        assert_eq!(icon.file_path.as_deref(), Some("/Users/me/Projects/app"));
        assert_eq!(icon.png_base64.as_deref(), Some("aGVsbG8="));
        assert_eq!(*enabled, Some(true));
        assert_eq!(detail.as_deref(), Some("Extra High"));
        assert_eq!(*reserve_icon_slot, None);
        assert_eq!(*min_width, Some(390.0));
        assert_eq!(items.len(), 1);
        assert!(matches!(&items[0], WireItem::Action { id, .. } if id == "nested"));
    }

    #[test]
    fn deserializes_a_minimal_request() {
        let request: NativeMenuRequest = serde_json::from_str(
            r#"{
                "position": { "x": 0, "y": 0 },
                "items": [{ "kind": "action", "id": "a", "label": "A" }]
            }"#,
        )
        .expect("request should deserialize");

        assert_eq!(request.align, None);
        assert_eq!(request.highlight_style, MenuHighlightStyle::System);
        assert_eq!(request.token, None);
        assert!(request.star_icons.is_none());
        assert!(request.theme.is_none());
        assert_eq!(request.min_width, None);
        let WireItem::Action {
            sublabel,
            icon,
            checked,
            enabled,
            accelerator,
            tool_tip,
            destructive,
            star,
            star_group,
            indent,
            reserve_icon_slot,
            ..
        } = &request.items[0]
        else {
            panic!("expected an action item, got {:?}", request.items[0]);
        };
        assert_eq!(*sublabel, None);
        assert!(icon.is_none());
        assert_eq!(*checked, None);
        assert_eq!(*enabled, None);
        assert_eq!(*accelerator, None);
        assert_eq!(*tool_tip, None);
        assert_eq!(*destructive, None);
        assert!(star.is_none());
        assert_eq!(*star_group, None);
        assert_eq!(*indent, None);
        assert_eq!(*reserve_icon_slot, None);
    }

    #[test]
    fn submenu_detail_is_optional() {
        let request: NativeMenuRequest = serde_json::from_str(
            r#"{
                "position": { "x": 0, "y": 0 },
                "items": [
                    { "kind": "submenu", "label": "Effort", "items": [] }
                ]
            }"#,
        )
        .expect("request should deserialize");
        let WireItem::Submenu { detail, .. } = &request.items[0] else {
            panic!("expected a submenu, got {:?}", request.items[0]);
        };
        assert_eq!(*detail, None);
    }

    #[test]
    fn deserializes_per_submenu_min_width() {
        // A submenu may carry its own minimum content width (the webview's
        // fixed sub-panel width) so long sublabels wrap inside the submenu
        // instead of stretching it; absent keeps the natural-width layout.
        let request: NativeMenuRequest = serde_json::from_str(
            r#"{
                "position": { "x": 0, "y": 0 },
                "items": [
                    { "kind": "submenu", "label": "Claude", "minWidth": 390, "items": [] },
                    { "kind": "submenu", "label": "Effort", "items": [] }
                ]
            }"#,
        )
        .expect("request should deserialize");

        let WireItem::Submenu { min_width, .. } = &request.items[0] else {
            panic!("expected a submenu, got {:?}", request.items[0]);
        };
        assert_eq!(*min_width, Some(390.0));
        let WireItem::Submenu { min_width, .. } = &request.items[1] else {
            panic!("expected a submenu, got {:?}", request.items[1]);
        };
        assert_eq!(*min_width, None);
    }

    #[test]
    fn deserializes_star_rows() {
        // `starGroup` scopes the star radio; a star row without it stays a
        // singleton group, so the field must deserialize as absent.
        let request: NativeMenuRequest = serde_json::from_str(
            r#"{
                "position": { "x": 0, "y": 0 },
                "token": "config-picker",
                "items": [
                    {
                        "kind": "action",
                        "id": "a",
                        "label": "A",
                        "star": { "starred": true },
                        "starGroup": "models"
                    },
                    { "kind": "action", "id": "b", "label": "B", "star": { "starred": false } }
                ]
            }"#,
        )
        .expect("request should deserialize");

        assert_eq!(request.token.as_deref(), Some("config-picker"));
        let WireItem::Action {
            star, star_group, ..
        } = &request.items[0]
        else {
            panic!("expected an action item, got {:?}", request.items[0]);
        };
        assert!(star.as_ref().expect("star should deserialize").starred);
        assert_eq!(star_group.as_deref(), Some("models"));
        let WireItem::Action {
            star, star_group, ..
        } = &request.items[1]
        else {
            panic!("expected an action item, got {:?}", request.items[1]);
        };
        assert!(!star.as_ref().expect("star should deserialize").starred);
        assert_eq!(*star_group, None);
    }

    #[test]
    fn star_icons_are_optional() {
        // A star row without request-level `starIcons` must still
        // deserialize; presentation degrades to no star button, so the
        // wire request stays valid across webview/host version skew.
        let request: NativeMenuRequest = serde_json::from_str(
            r#"{
                "position": { "x": 0, "y": 0 },
                "items": [
                    { "kind": "action", "id": "a", "label": "A", "star": { "starred": true } }
                ]
            }"#,
        )
        .expect("request should deserialize");
        assert!(request.star_icons.is_none());
        let WireItem::Action { star, .. } = &request.items[0] else {
            panic!("expected an action item, got {:?}", request.items[0]);
        };
        assert!(star.as_ref().expect("star should deserialize").starred);
    }

    #[test]
    fn deserializes_reserve_icon_slot_on_actions_and_submenus() {
        // The webview's explicit opt-in for icon-less rows that should align
        // with icon-bearing siblings (e.g. the prompt picker's extras
        // openers). Absent means flush-left, as before the flag existed.
        let request: NativeMenuRequest = serde_json::from_str(
            r#"{
                "position": { "x": 0, "y": 0 },
                "items": [
                    { "kind": "action", "id": "a", "label": "A", "reserveIconSlot": true },
                    {
                        "kind": "submenu",
                        "label": "Provider",
                        "reserveIconSlot": true,
                        "items": []
                    },
                    { "kind": "action", "id": "b", "label": "B" }
                ]
            }"#,
        )
        .expect("request should deserialize");

        let WireItem::Action {
            reserve_icon_slot, ..
        } = &request.items[0]
        else {
            panic!("expected an action item, got {:?}", request.items[0]);
        };
        assert_eq!(*reserve_icon_slot, Some(true));
        let WireItem::Submenu {
            reserve_icon_slot, ..
        } = &request.items[1]
        else {
            panic!("expected a submenu, got {:?}", request.items[1]);
        };
        assert_eq!(*reserve_icon_slot, Some(true));
        let WireItem::Action {
            reserve_icon_slot, ..
        } = &request.items[2]
        else {
            panic!("expected an action item, got {:?}", request.items[2]);
        };
        assert_eq!(*reserve_icon_slot, None);
    }

    #[test]
    fn deserializes_start_alignment() {
        let request: NativeMenuRequest = serde_json::from_str(
            r#"{ "position": { "x": 1, "y": 2 }, "align": "start", "items": [] }"#,
        )
        .expect("request should deserialize");
        assert_eq!(request.align, Some(MenuAlign::Start));
    }

    #[test]
    fn parses_hex_colors() {
        assert_eq!(
            parse_hex_color("#3366ff"),
            Some((51.0 / 255.0, 102.0 / 255.0, 1.0, 1.0))
        );
        assert_eq!(
            parse_hex_color("#3366FF80"),
            Some((51.0 / 255.0, 102.0 / 255.0, 1.0, 128.0 / 255.0))
        );
        assert_eq!(parse_hex_color("#000000"), Some((0.0, 0.0, 0.0, 1.0)));
        assert_eq!(parse_hex_color("#ffffff00"), Some((1.0, 1.0, 1.0, 0.0)));
    }

    #[test]
    fn rejects_malformed_hex_colors() {
        assert_eq!(parse_hex_color(""), None);
        assert_eq!(parse_hex_color("3366ff"), None);
        assert_eq!(parse_hex_color("#fff"), None);
        assert_eq!(parse_hex_color("#3366fg"), None);
        assert_eq!(parse_hex_color("#3366ff8"), None);
        assert_eq!(parse_hex_color("#3366ff8080"), None);
        assert_eq!(parse_hex_color("#33éé00"), None);
    }

    #[test]
    fn treats_transparent_border_colors_as_absent() {
        assert_eq!(parse_visible_hex_color("#3366ff00"), None);
        assert_eq!(parse_visible_hex_color("not-a-color"), None);
        assert_eq!(
            parse_visible_hex_color("#3366ff"),
            Some((51.0 / 255.0, 102.0 / 255.0, 1.0, 1.0))
        );
        assert_eq!(
            parse_visible_hex_color("#3366ff01"),
            Some((51.0 / 255.0, 102.0 / 255.0, 1.0, 1.0 / 255.0))
        );
    }

    #[test]
    fn deserializes_themed_highlight() {
        let request: NativeMenuRequest = serde_json::from_str(
            r#"{
                "position": { "x": 0, "y": 0 },
                "highlightStyle": "themed",
                "items": []
            }"#,
        )
        .expect("request should deserialize");
        assert_eq!(request.highlight_style, MenuHighlightStyle::Themed);
    }

    #[test]
    fn theme_borders_are_optional() {
        // A theme without hoverBorder must still deserialize.
        let request: NativeMenuRequest = serde_json::from_str(
            r##"{
                "position": { "x": 0, "y": 0 },
                "theme": {
                    "isDark": false,
                    "textPrimary": "#111111",
                    "textSecondary": "#444444",
                    "textTertiary": "#777777",
                    "hoverBackground": "#0000000d",
                    "separator": "#dddddd",
                    "badgeBackground": "#dbe9ff",
                    "badgeText": "#1d4f93",
                    "destructiveText": "#c4262e",
                    "iconColor": "#555555"
                },
                "items": []
            }"##,
        )
        .expect("request should deserialize");
        let theme = request.theme.as_ref().expect("theme should deserialize");
        assert_eq!(theme.hover_border, None);
    }

    #[test]
    fn starring_a_row_clears_every_other_row_of_its_group() {
        assert_eq!(
            next_star_states(&[false, true, false], 0),
            vec![true, false, false]
        );
        assert_eq!(
            next_star_states(&[false, false, false], 2),
            vec![false, false, true]
        );
    }

    #[test]
    fn starring_an_already_starred_row_clears_it() {
        assert_eq!(
            next_star_states(&[false, true, false], 1),
            vec![false, false, false]
        );
        assert_eq!(next_star_states(&[true], 0), vec![false]);
    }

    #[test]
    fn out_of_range_star_clicks_change_nothing() {
        assert_eq!(next_star_states(&[true, false], 2), vec![true, false]);
        assert_eq!(next_star_states(&[], 0), Vec::<bool>::new());
    }

    #[test]
    fn star_group_members_selects_only_the_clicked_rows_group() {
        let groups = [Some("a"), Some("b"), Some("a"), None, Some("b")];
        assert_eq!(star_group_members(&groups, 0), vec![0, 2]);
        assert_eq!(star_group_members(&groups, 4), vec![1, 4]);
    }

    #[test]
    fn ungrouped_rows_are_singleton_star_groups() {
        let groups = [Some("a"), None, None];
        assert_eq!(star_group_members(&groups, 1), vec![1]);
        assert_eq!(star_group_members(&groups, 2), vec![2]);
    }

    #[test]
    fn out_of_range_star_clicks_select_no_group_members() {
        assert_eq!(
            star_group_members(&[Some("a"), None], 2),
            Vec::<usize>::new()
        );
        assert_eq!(star_group_members(&[], 0), Vec::<usize>::new());
    }

    /// Applies a star click the way `starClicked:` does — group membership
    /// from [`star_group_members`], the group's next states from
    /// [`next_star_states`] — and returns the whole registry's states.
    fn apply_star_click(rows: &[(Option<&str>, bool)], clicked: usize) -> Vec<bool> {
        let groups: Vec<Option<&str>> = rows.iter().map(|(group, _)| *group).collect();
        let mut states: Vec<bool> = rows.iter().map(|(_, starred)| *starred).collect();
        let members = star_group_members(&groups, clicked);
        let group_states: Vec<bool> = members.iter().map(|&member| states[member]).collect();
        let position = members
            .iter()
            .position(|&member| member == clicked)
            .expect("the clicked row is always in its own group");
        let next = next_star_states(&group_states, position);
        for (&member, &starred) in members.iter().zip(&next) {
            states[member] = starred;
        }
        states
    }

    #[test]
    fn starring_in_one_group_leaves_other_groups_untouched() {
        // Group a: rows 0-1; group b: rows 2-3; row 4 is a pinned singleton.
        let rows = [
            (Some("a"), false),
            (Some("a"), true),
            (Some("b"), true),
            (Some("b"), false),
            (None, true),
        ];
        assert_eq!(
            apply_star_click(&rows, 0),
            vec![true, false, true, false, true]
        );
    }

    #[test]
    fn unstarring_in_one_group_leaves_other_groups_untouched() {
        let rows = [
            (Some("a"), true),
            (Some("a"), false),
            (Some("b"), true),
            (None, true),
        ];
        assert_eq!(apply_star_click(&rows, 0), vec![false, false, true, true]);
    }

    #[test]
    fn singleton_rows_toggle_alone_and_clear_nothing() {
        let rows = [(Some("a"), true), (None, false), (None, true)];
        // Starring a singleton leaves the grouped star and the other
        // singleton pinned...
        assert_eq!(apply_star_click(&rows, 1), vec![true, true, true]);
        // ...and unstarring one clears only itself.
        assert_eq!(apply_star_click(&rows, 2), vec![true, false, false]);
    }

    fn parsed(
        key_equivalent: &str,
        command: bool,
        control: bool,
        option: bool,
        shift: bool,
    ) -> ParsedAccelerator {
        ParsedAccelerator {
            key_equivalent: key_equivalent.to_string(),
            command,
            control,
            option,
            shift,
        }
    }

    #[test]
    fn formats_accelerator_display_strings() {
        assert_eq!(
            accelerator_display_string(&parsed("r", true, false, false, true)),
            "⇧⌘R"
        );
        assert_eq!(
            accelerator_display_string(&parsed("\r", false, false, true, false)),
            "⌥↩"
        );
        assert_eq!(
            accelerator_display_string(&parsed("\u{f700}", false, true, false, false)),
            "⌃↑"
        );
        assert_eq!(
            accelerator_display_string(&parsed(" ", false, false, false, false)),
            "Space"
        );
        assert_eq!(
            accelerator_display_string(&parsed("/", true, false, false, false)),
            "⌘/"
        );
    }

    #[test]
    fn parses_modifier_combinations() {
        assert_eq!(
            parse_accelerator("Cmd+Shift+R"),
            Some(parsed("r", true, false, false, true))
        );
        assert_eq!(
            parse_accelerator("CmdOrCtrl+X"),
            Some(parsed("x", true, false, false, false))
        );
        assert_eq!(
            parse_accelerator("Alt+Enter"),
            Some(parsed("\r", false, false, true, false))
        );
        assert_eq!(
            parse_accelerator("Ctrl+Shift+Alt+C"),
            Some(parsed("c", false, true, true, true))
        );
        assert_eq!(
            parse_accelerator("Option+Space"),
            Some(parsed(" ", false, false, true, false))
        );
        assert_eq!(
            parse_accelerator("Command+Control+Shift+Option+K"),
            Some(parsed("k", true, true, true, true))
        );
    }

    #[test]
    fn parses_modifiers_case_insensitively() {
        assert_eq!(
            parse_accelerator("cmd+shift+r"),
            Some(parsed("r", true, false, false, true))
        );
        assert_eq!(
            parse_accelerator("CMDORCTRL+z"),
            Some(parsed("z", true, false, false, false))
        );
    }

    #[test]
    fn parses_named_keys() {
        assert_eq!(parse_accelerator("Enter").unwrap().key_equivalent, "\r");
        assert_eq!(parse_accelerator("Return").unwrap().key_equivalent, "\r");
        assert_eq!(parse_accelerator("Tab").unwrap().key_equivalent, "\t");
        assert_eq!(
            parse_accelerator("Escape").unwrap().key_equivalent,
            "\u{1b}"
        );
        assert_eq!(parse_accelerator("Esc").unwrap().key_equivalent, "\u{1b}");
        assert_eq!(
            parse_accelerator("Backspace").unwrap().key_equivalent,
            "\u{8}"
        );
        assert_eq!(
            parse_accelerator("Delete").unwrap().key_equivalent,
            "\u{7f}"
        );
        assert_eq!(parse_accelerator("Space").unwrap().key_equivalent, " ");
        assert_eq!(parse_accelerator("Up").unwrap().key_equivalent, "\u{f700}");
        assert_eq!(
            parse_accelerator("Down").unwrap().key_equivalent,
            "\u{f701}"
        );
        assert_eq!(
            parse_accelerator("Left").unwrap().key_equivalent,
            "\u{f702}"
        );
        assert_eq!(
            parse_accelerator("Right").unwrap().key_equivalent,
            "\u{f703}"
        );
        assert_eq!(
            parse_accelerator("ArrowUp").unwrap().key_equivalent,
            "\u{f700}"
        );
    }

    #[test]
    fn lowercases_single_character_keys() {
        assert_eq!(parse_accelerator("Cmd+R").unwrap().key_equivalent, "r");
        assert_eq!(parse_accelerator("Cmd+r").unwrap().key_equivalent, "r");
        assert_eq!(parse_accelerator("Cmd+/").unwrap().key_equivalent, "/");
        assert_eq!(parse_accelerator("Cmd+É").unwrap().key_equivalent, "é");
    }

    #[test]
    fn tolerates_whitespace_around_tokens() {
        assert_eq!(
            parse_accelerator(" Cmd + Shift + R "),
            Some(parsed("r", true, false, false, true))
        );
    }

    #[test]
    fn rejects_unknown_keys_and_modifiers() {
        assert_eq!(parse_accelerator(""), None);
        assert_eq!(parse_accelerator("Cmd+"), None);
        assert_eq!(parse_accelerator("Cmd+F5"), None);
        assert_eq!(parse_accelerator("Hyper+K"), None);
        assert_eq!(parse_accelerator("Cmd+Whatever"), None);
        assert_eq!(parse_accelerator("Cmd++"), None);
    }
}
