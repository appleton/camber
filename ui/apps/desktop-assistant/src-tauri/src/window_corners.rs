//! Bridges AppKit's live window corner radii to the desktop webview.

use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[cfg(target_os = "macos")]
const CORNERS_CHANGED_EVENT: &str = "camber:desktop-window-corners-changed";

#[derive(Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCorners {
    bottom_left: Option<f64>,
    bottom_right: Option<f64>,
}

#[derive(Default)]
pub struct WindowCornerState(Mutex<WindowCorners>);

#[tauri::command]
pub fn get_desktop_window_corners(state: State<'_, WindowCornerState>) -> WindowCorners {
    *state.0.lock().unwrap()
}

#[cfg(target_os = "macos")]
fn expanded_corners(
    top_left: f64,
    top_right: f64,
    bottom_left: f64,
    bottom_right: f64,
) -> WindowCorners {
    // AppKit expands the bottom corner adjacent to the rounded display. Use
    // the larger top radius as the window's normal radius since a titlebar
    // accessory can reduce one of the resolved top radii.
    let normal_radius = top_left.max(top_right);
    WindowCorners {
        bottom_left: (bottom_left > normal_radius).then_some(bottom_left),
        bottom_right: (bottom_right > normal_radius).then_some(bottom_right),
    }
}

#[cfg(target_os = "macos")]
pub use macos::observe;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow};
    use objc2_foundation::{NSPoint, NSRect};
    use tauri::{Emitter, EventTarget, Manager, Runtime, WebviewWindow};

    struct CornerProbeIvars {
        configuration: Retained<AnyObject>,
        publish: Box<dyn Fn(WindowCorners)>,
    }

    define_class!(
        // SAFETY: The view uses NSView's designated initializer and is
        // created, owned by the content view, and called on the main thread.
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[ivars = CornerProbeIvars]
        struct CornerProbe;

        impl CornerProbe {
            #[unsafe(method_id(cornerConfiguration))]
            fn corner_configuration(&self) -> Retained<AnyObject> {
                self.ivars().configuration.clone()
            }

            #[unsafe(method(viewDidChangeEffectiveCornerRadii))]
            fn view_did_change_effective_corner_radii(&self) {
                unsafe { let _: () = msg_send![super(self), viewDidChangeEffectiveCornerRadii]; }
                self.publish_corners();
            }

            #[unsafe(method_id(hitTest:))]
            fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> {
                None
            }
        }
    );

    impl CornerProbe {
        fn publish_corners(&self) {
            let corners = unsafe {
                let radii: Option<Retained<AnyObject>> = msg_send![self, effectiveCornerRadii];
                radii.map(|radii| {
                    expanded_corners(
                        msg_send![&radii, topLeft],
                        msg_send![&radii, topRight],
                        msg_send![&radii, bottomLeft],
                        msg_send![&radii, bottomRight],
                    )
                })
            };
            (self.ivars().publish)(corners.unwrap_or_default());
        }
    }

    pub fn observe<R: Runtime>(window: &WebviewWindow<R>) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        // Resolve the public macOS 27 API at runtime so earlier versions use
        // the existing CSS radii and builds can still use an older SDK.
        let (Some(configuration_class), Some(radius_class)) = (
            AnyClass::get(c"NSViewCornerConfiguration"),
            AnyClass::get(c"NSViewCornerRadius"),
        ) else {
            return;
        };
        let Ok(native_window) = window.ns_window() else {
            return;
        };
        let native_window = unsafe { &*native_window.cast::<NSWindow>() };
        let Some(content_view) = native_window.contentView() else {
            return;
        };
        let app = window.app_handle().clone();
        let label = window.label().to_owned();
        let probe: Retained<CornerProbe> = unsafe {
            let radius: Retained<AnyObject> = msg_send![radius_class, containerConcentricRadius];
            let configuration = msg_send![configuration_class, configurationWithRadius: &*radius];
            let probe = CornerProbe::alloc(mtm).set_ivars(CornerProbeIvars {
                configuration,
                publish: Box::new(move |corners| {
                    let state = app.state::<WindowCornerState>();
                    {
                        let mut previous = state.0.lock().unwrap();
                        if *previous == corners {
                            return;
                        }
                        *previous = corners;
                    }
                    let _ = app.emit_to(
                        EventTarget::webview_window(&label),
                        CORNERS_CHANGED_EVENT,
                        corners,
                    );
                }),
            });
            let frame: NSRect = content_view.bounds();
            msg_send![super(probe), initWithFrame: frame]
        };
        // A transparent, input-pass-through view filling the content area
        // resolves the four corners against the native window's own shape.
        probe.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        content_view.addSubview(&probe);
        probe.publish_corners();
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn reports_only_bottom_corners_larger_than_the_normal_radius() {
        let normal = expanded_corners(16.0, 1.0, 16.0, 16.0);
        assert_eq!(normal.bottom_left, None);
        assert_eq!(normal.bottom_right, None);

        let left = expanded_corners(16.0, 1.0, 37.5, 16.0);
        assert_eq!(left.bottom_left, Some(37.5));
        assert_eq!(left.bottom_right, None);

        let right = expanded_corners(16.0, 1.0, 16.0, 42.0);
        assert_eq!(right.bottom_left, None);
        assert_eq!(right.bottom_right, Some(42.0));
    }
}
