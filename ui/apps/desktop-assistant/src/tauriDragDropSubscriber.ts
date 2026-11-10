import type { TauriDragDropCallbacks } from "@camber/assistant/tauri-drag-drop";
import { getCurrentWebview } from "@tauri-apps/api/webview";

// Subscribe to Tauri's native drag-drop events and forward them to the
// provided callbacks. Returns the Tauri unlisten function for cleanup.
//
// This lives in desktop-assistant (not the shared assistant package) because
// @tauri-apps/api is only a dependency here. DesktopRuntime accepts this as an
// injected subscriber so the assistant package stays Tauri-free.
export async function tauriDragDropSubscriber(
  callbacks: TauriDragDropCallbacks,
): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent((event) => {
    switch (event.payload.type) {
      case "enter":
        callbacks.onDragEnter();
        break;
      case "leave":
        callbacks.onDragLeave();
        break;
      case "drop":
        callbacks.onDragLeave();
        callbacks.onDrop(event.payload.paths);
        break;
      // "over" events carry no useful information to act on.
    }
  });
}
