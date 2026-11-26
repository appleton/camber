use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::WebviewWindow;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaPopoverRequest {
    id: String,
    anchor: AnchorRect,
    content: QuotaPopoverContent,
    hover_background: Option<String>,
    hover_border: Option<String>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaPopoverContent {
    buckets: Vec<QuotaBucket>,
    message: Option<String>,
    usage_link_label: Option<String>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Deserialize)]
struct AnchorRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaBucket {
    label: String,
    used_percent: f64,
    value_label: String,
    reset_label: Option<String>,
}

/// Returns true when the usage link was selected, false on dismissal.
#[tauri::command]
pub async fn show_native_quota_popover(
    window: WebviewWindow,
    request: QuotaPopoverRequest,
    on_shown: Channel<()>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        macos::show(window, request, on_shown).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, request, on_shown);
        Err("Native quota popovers require macOS".into())
    }
}

#[tauri::command]
pub async fn update_native_quota_popover(
    window: WebviewWindow,
    id: String,
    content: QuotaPopoverContent,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::update(window, id, content)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, id, content);
        Err("Native quota popovers require macOS".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{AnchorRect, QuotaPopoverContent, QuotaPopoverRequest};
    use crate::native_menu::{
        draw_menu_row_highlight, ns_color_from_hex, optional_border, ROW_INSET_X,
    };
    use objc2::rc::{Retained, Weak};
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{
        define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_app_kit::{
        NSBezelStyle, NSBox, NSBoxType, NSButton, NSButtonType, NSCellImagePosition, NSColor,
        NSControlSize, NSEvent, NSFont, NSFontWeightSemibold, NSImage, NSPopover,
        NSPopoverBehavior, NSPopoverDelegate, NSProgressIndicator, NSProgressIndicatorStyle,
        NSScrollView, NSTextAlignment, NSTextField, NSTrackingArea, NSTrackingAreaOptions, NSView,
        NSViewController,
    };
    use objc2_foundation::{NSNotification, NSPoint, NSRect, NSRectEdge, NSSize, NSString};
    use std::cell::{Cell, RefCell};
    use tauri::ipc::Channel;
    use tauri::WebviewWindow;
    use tokio::sync::oneshot;

    const WIDTH: f64 = 260.0;
    const PADDING: f64 = 14.0;
    const MAX_HEIGHT: f64 = 360.0;

    thread_local! {
        // NSPopover's delegate and NSButton's target are weak. Retain the
        // delegate, which owns the popover, until AppKit reports dismissal.
        static ACTIVE: RefCell<Option<Retained<QuotaPopover>>> = const { RefCell::new(None) };
    }

    struct PopoverState {
        id: String,
        window_label: String,
        anchor_view: Weak<NSView>,
        popover: Retained<NSPopover>,
        link_highlight: LinkHighlight,
        selected: Cell<bool>,
        done: RefCell<Option<oneshot::Sender<Result<bool, String>>>>,
    }

    define_class!(
        // SAFETY: all AppKit interaction and delegate callbacks are main-thread only.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = PopoverState]
        struct QuotaPopover;

        impl QuotaPopover {
            #[unsafe(method(openUsagePage:))]
            fn open_usage_page(&self, _sender: &NSButton) {
                self.ivars().selected.set(true);
                self.ivars().popover.close();
            }
        }

        unsafe impl NSObjectProtocol for QuotaPopover {}

        unsafe impl NSPopoverDelegate for QuotaPopover {
            #[unsafe(method(popoverDidShow:))]
            fn popover_did_show(&self, _notification: &NSNotification) {
                if let Some(controller) = self.ivars().popover.contentViewController() {
                    if let Some(window) = controller.view().window() {
                        // The label and meters are informational. Leave the
                        // usage button available for deliberate keyboard focus.
                        window.makeFirstResponder(None);
                    }
                }
            }

            #[unsafe(method(popoverDidClose:))]
            fn popover_did_close(&self, _notification: &NSNotification) {
                if let Some(done) = self.ivars().done.take() {
                    let _ = done.send(Ok(self.ivars().selected.get()));
                }
                ACTIVE.with(|active| active.take());
            }
        }
    );

    #[derive(Clone)]
    struct LinkHighlight {
        background: Retained<NSColor>,
        border: Option<Retained<NSColor>>,
    }

    struct UsageLinkState {
        highlight: LinkHighlight,
        hovered: Cell<bool>,
    }

    define_class!(
        // SAFETY: the button and its tracking callbacks stay on the AppKit main thread.
        #[unsafe(super(NSButton))]
        #[thread_kind = MainThreadOnly]
        #[ivars = UsageLinkState]
        struct UsageLink;

        impl UsageLink {
            #[unsafe(method(mouseEntered:))]
            fn mouse_entered(&self, _event: &NSEvent) {
                self.ivars().hovered.set(true);
                NSView::setNeedsDisplay(self, true);
            }

            #[unsafe(method(mouseExited:))]
            fn mouse_exited(&self, _event: &NSEvent) {
                self.ivars().hovered.set(false);
                NSView::setNeedsDisplay(self, true);
            }

            #[unsafe(method(drawRect:))]
            fn draw_rect(&self, _dirty_rect: NSRect) {
                let state = self.ivars();
                let bounds = self.bounds();
                if state.hovered.get() {
                    draw_menu_row_highlight(
                        bounds,
                        &state.highlight.background,
                        state.highlight.border.as_deref(),
                    );
                }
                if let Some(cell) = self.cell() {
                    cell.drawWithFrame_inView(
                        rect(
                            bounds.origin.x + ROW_INSET_X,
                            bounds.origin.y,
                            (bounds.size.width - 2.0 * ROW_INSET_X).max(0.0),
                            bounds.size.height,
                        ),
                        self,
                    );
                }
            }
        }
    );

    impl UsageLink {
        fn new(
            frame: NSRect,
            title: &str,
            delegate: &QuotaPopover,
            mtm: MainThreadMarker,
        ) -> Retained<NSButton> {
            let button = Self::alloc(mtm).set_ivars(UsageLinkState {
                highlight: delegate.ivars().link_highlight.clone(),
                hovered: Cell::new(false),
            });
            // SAFETY: initWithFrame: is NSButton's designated initializer.
            let button: Retained<Self> = unsafe { msg_send![super(button), initWithFrame: frame] };
            button.setButtonType(NSButtonType::MomentaryPushIn);
            button.setTitle(&NSString::from_str(title));
            button.setBezelStyle(NSBezelStyle::AccessoryBarAction);
            button.setBordered(false);
            let target: &AnyObject = delegate;
            // SAFETY: the delegate lives until dismissal and implements this action.
            unsafe {
                button.setTarget(Some(target));
                button.setAction(Some(sel!(openUsagePage:)));
            }
            // SAFETY: the weak tracking owner implements mouseEntered: and mouseExited:.
            let area = unsafe {
                NSTrackingArea::initWithRect_options_owner_userInfo(
                    NSTrackingArea::alloc(),
                    NSRect::ZERO,
                    NSTrackingAreaOptions::MouseEnteredAndExited
                        | NSTrackingAreaOptions::ActiveAlways
                        | NSTrackingAreaOptions::InVisibleRect,
                    Some(&button),
                    None,
                )
            };
            button.addTrackingArea(&area);
            Retained::into_super(button)
        }
    }

    pub async fn show(
        window: WebviewWindow,
        request: QuotaPopoverRequest,
        on_shown: Channel<()>,
    ) -> Result<bool, String> {
        let (tx, rx) = oneshot::channel();
        let anchor_window = window.clone();
        window
            .run_on_main_thread(move || {
                if let Err(error) = present(&anchor_window, request, tx, on_shown) {
                    let (tx, reason) = error;
                    let _ = tx.send(Err(reason));
                }
            })
            .map_err(|err| err.to_string())?;
        rx.await.map_err(|err| err.to_string())?
    }

    pub fn update(
        window: WebviewWindow,
        id: String,
        content: QuotaPopoverContent,
    ) -> Result<(), String> {
        let window_label = window.label().to_owned();
        window
            .run_on_main_thread(move || {
                let delegate = ACTIVE.with(|active| active.borrow().clone());
                let Some(delegate) = delegate else { return };
                let state = delegate.ivars();
                if state.id != id || state.window_label != window_label || !state.popover.isShown()
                {
                    return;
                }
                let mtm = delegate.mtm();
                let popover = &state.popover;
                let anchor = popover.positioningRect();
                let old_size = popover.contentSize();
                let link_focused = popover
                    .contentViewController()
                    .and_then(|controller| controller.view().window())
                    .and_then(|window| window.firstResponder())
                    .is_some_and(|responder| responder.downcast::<NSButton>().is_ok());
                let animates = popover.animates();
                popover.setAnimates(false);
                let (view, link) = set_content(popover, &content, &delegate, mtm);
                if popover.contentSize() != old_size {
                    if let Some(anchor_view) = state
                        .anchor_view
                        .load()
                        .filter(|view| view.window().is_some())
                    {
                        // Resizing a visible popover can move its arrow. Reposition
                        // the same popover against its anchor after sizing the content.
                        position_popover(popover, anchor, &anchor_view);
                    }
                }
                popover.setAnimates(animates);
                if let Some(window) = view.window() {
                    if let Some(link) = link.as_deref().filter(|_| link_focused) {
                        window.makeFirstResponder(Some(link));
                    } else {
                        window.makeFirstResponder(None);
                    }
                }
            })
            .map_err(|err| err.to_string())
    }

    type ShowSender = oneshot::Sender<Result<bool, String>>;

    fn present(
        window: &WebviewWindow,
        request: QuotaPopoverRequest,
        tx: ShowSender,
        on_shown: Channel<()>,
    ) -> Result<(), (ShowSender, String)> {
        let prepared = (|| {
            let mtm = MainThreadMarker::new().ok_or("Popover must run on the main thread")?;
            if ACTIVE.with(|active| active.borrow().is_some()) {
                return Err("Another quota popover is open");
            }
            let view = window
                .ns_view()
                .map_err(|_| "Missing window content view")?
                as *const NSView;
            // SAFETY: Tauri's content view is borrowed while the window is
            // retained and this function runs on the AppKit main thread.
            let view = unsafe { view.as_ref() }.ok_or("Missing window content view")?;
            if view.window().is_none() {
                return Err("Popover anchor is no longer in a window");
            }
            Ok((mtm, view, position(&request.anchor, view)?))
        })();
        let (mtm, anchor_view, anchor) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => return Err((tx, error.into())),
        };
        let popover = NSPopover::new(mtm);
        popover.setBehavior(NSPopoverBehavior::Transient);
        let delegate = QuotaPopover::alloc(mtm).set_ivars(PopoverState {
            id: request.id,
            window_label: window.label().to_owned(),
            anchor_view: Weak::new(anchor_view),
            popover: popover.clone(),
            link_highlight: LinkHighlight {
                background: request
                    .hover_background
                    .as_deref()
                    .and_then(ns_color_from_hex)
                    .unwrap_or_else(NSColor::quaternaryLabelColor),
                border: optional_border(request.hover_border.as_deref()),
            },
            selected: Cell::new(false),
            done: RefCell::new(Some(tx)),
        });
        // SAFETY: NSObject's initializer is the designated superclass initializer.
        let delegate: Retained<QuotaPopover> = unsafe { msg_send![super(delegate), init] };
        set_content(&popover, &request.content, &delegate, mtm);
        popover.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        ACTIVE.with(|active| active.replace(Some(delegate)));
        position_popover(&popover, anchor, anchor_view);
        if popover.isShown() {
            let _ = on_shown.send(());
        } else {
            ACTIVE.with(|active| {
                if let Some(delegate) = active.take() {
                    if let Some(done) = delegate.ivars().done.take() {
                        let _ = done.send(Err("Native quota popover did not open".into()));
                    }
                }
            });
        }
        Ok(())
    }

    fn position_popover(popover: &NSPopover, anchor: NSRect, anchor_view: &NSView) {
        let edge = if anchor_view.isFlipped() {
            NSRectEdge::MinY
        } else {
            NSRectEdge::MaxY
        };
        popover.showRelativeToRect_ofView_preferredEdge(anchor, anchor_view, edge);
    }

    fn position(anchor: &AnchorRect, view: &NSView) -> Result<NSRect, &'static str> {
        let AnchorRect {
            x,
            y,
            width,
            height,
        } = *anchor;
        let bounds = view.bounds();
        if ![x, y, width, height].into_iter().all(f64::is_finite)
            || width <= 0.0
            || height <= 0.0
            || x >= bounds.size.width
            || y >= bounds.size.height
            || x + width <= 0.0
            || y + height <= 0.0
        {
            return Err("Popover anchor is outside the webview");
        }
        // DOM rectangles are measured from the top of the window content view.
        let anchor_y = if view.isFlipped() {
            y
        } else {
            bounds.size.height - y - height
        };
        Ok(rect(
            bounds.origin.x + x,
            bounds.origin.y + anchor_y,
            width,
            height,
        ))
    }

    fn set_content(
        popover: &NSPopover,
        content: &QuotaPopoverContent,
        delegate: &QuotaPopover,
        mtm: MainThreadMarker,
    ) -> (Retained<NSView>, Option<Retained<NSButton>>) {
        let row_height = |bucket: &super::QuotaBucket| {
            if bucket.reset_label.is_some() {
                58.0
            } else {
                41.0
            }
        };
        let height = 2.0 * PADDING
            + 24.0
            + content.buckets.iter().map(row_height).sum::<f64>()
            + if content.message.is_some() { 24.0 } else { 0.0 }
            + if content.usage_link_label.is_some() {
                29.0
            } else {
                0.0
            };
        let panel = NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, 0.0, WIDTH, height));
        let inner_width = WIDTH - 2.0 * PADDING;
        let title = label("Account usage", 13.0, mtm);
        // SAFETY: AppKit exports this font weight as a process-lifetime constant.
        title.setFont(Some(&NSFont::systemFontOfSize_weight(13.0, unsafe {
            NSFontWeightSemibold
        })));
        let mut top = height - PADDING;
        title.setFrame(rect(PADDING, top - 17.0, inner_width, 17.0));
        panel.addSubview(&title);
        top -= 24.0;

        for bucket in &content.buckets {
            let name = label(&bucket.label, 12.0, mtm);
            name.setFrame(rect(PADDING, top - 16.0, inner_width - 66.0, 16.0));
            panel.addSubview(&name);

            let used = label(&bucket.value_label, 11.0, mtm);
            used.setAlignment(NSTextAlignment::Right);
            used.setTextColor(Some(&NSColor::secondaryLabelColor()));
            used.setFrame(rect(WIDTH - PADDING - 64.0, top - 16.0, 64.0, 16.0));
            panel.addSubview(&used);

            let progress = NSProgressIndicator::initWithFrame(
                NSProgressIndicator::alloc(mtm),
                rect(PADDING, top - 29.0, inner_width, 10.0),
            );
            progress.setStyle(NSProgressIndicatorStyle::Bar);
            progress.setControlSize(NSControlSize::Small);
            progress.setIndeterminate(false);
            progress.setMinValue(0.0);
            progress.setMaxValue(100.0);
            progress.setDoubleValue(bucket.used_percent.clamp(0.0, 100.0));
            panel.addSubview(&progress);

            if let Some(reset_label) = &bucket.reset_label {
                let reset = label(reset_label, 11.0, mtm);
                reset.setTextColor(Some(&NSColor::secondaryLabelColor()));
                reset.setFrame(rect(PADDING, top - 46.0, inner_width, 15.0));
                panel.addSubview(&reset);
            }
            top -= row_height(bucket);
        }

        if let Some(message) = &content.message {
            let status = label(message, 12.0, mtm);
            status.setTextColor(Some(&NSColor::secondaryLabelColor()));
            status.setFrame(rect(PADDING, top - 17.0, inner_width, 16.0));
            panel.addSubview(&status);
            top -= 24.0;
        }
        let link = content.usage_link_label.as_ref().map(|text| {
            let divider =
                NSBox::initWithFrame(NSBox::alloc(mtm), rect(PADDING, top, inner_width, 1.0));
            divider.setBoxType(NSBoxType::Separator);
            panel.addSubview(&divider);

            let link = UsageLink::new(
                rect(PADDING, top - 28.0, inner_width, 24.0),
                text,
                delegate,
                mtm,
            );
            link.setAlignment(NSTextAlignment::Left);
            if let Some(arrow) = NSImage::imageWithSystemSymbolName_accessibilityDescription(
                &NSString::from_str("arrow.up.right"),
                None,
            ) {
                link.setImage(Some(&arrow));
                link.setImagePosition(NSCellImagePosition::ImageRight);
            }
            panel.addSubview(&link);
            link
        });

        let view = if height <= MAX_HEIGHT {
            panel
        } else {
            let scroller = NSScrollView::initWithFrame(
                NSScrollView::alloc(mtm),
                rect(0.0, 0.0, WIDTH, MAX_HEIGHT),
            );
            scroller.setDrawsBackground(false);
            scroller.setHasVerticalScroller(true);
            scroller.setDocumentView(Some(&panel));
            scroller
                .contentView()
                .scrollToPoint(NSPoint::new(0.0, height - MAX_HEIGHT));
            Retained::into_super(scroller)
        };
        let controller = NSViewController::new(mtm);
        controller.setView(&view);
        popover.setContentViewController(Some(&controller));
        popover.setContentSize(view.frame().size);
        (view, link)
    }

    fn label(text: &str, size: f64, mtm: MainThreadMarker) -> Retained<NSTextField> {
        let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
        field.setFont(Some(&NSFont::systemFontOfSize(size)));
        field
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
    }
}
