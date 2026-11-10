import { requestDesktopFilePromptChip, requestDesktopImageAttachment } from "@camber/features/acp";
import { onMount } from "svelte";

export interface TauriDragDropCallbacks {
  // Called when file paths enter the window (drag started hovering).
  onDragEnter(): void;
  // Called when the drag leaves the window or is cancelled.
  onDragLeave(): void;
  // Called with the dropped file paths when the user releases.
  onDrop(paths: string[]): void;
}

// A function that subscribes to native drag-drop events and forwards them to
// the provided callbacks. Returns a cleanup/unlisten function. This type is
// intentionally loose so that the `assistant` package does not depend on
// `@tauri-apps/api` directly — the `desktop-assistant` app injects the real
// implementation; tests and non-Tauri hosts supply a no-op.
export type TauriDragDropSubscriber = (callbacks: TauriDragDropCallbacks) => Promise<() => void>;

// Svelte integration: wire drag-drop events during component init.
// Drives `setIsDragging` for the visual affordance and dispatches
// `requestDesktopFilePromptChip` for each dropped path so the active
// conversation's composer picks them up.
//
// Pass a `subscriber` that wraps `getCurrentWebview().onDragDropEvent(…)` from
// the desktop app. When no subscriber is provided (non-Tauri hosts, tests),
// the function is a safe no-op.
export function initTauriDragDrop(
  callbacks: TauriDragDropCallbacks,
  subscriber?: TauriDragDropSubscriber,
): void {
  if (!subscriber) return;

  onMount(() => {
    let cleanup: (() => void) | undefined;
    let disposed = false;

    void subscriber(callbacks)
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        cleanup = unlisten;
      })
      .catch((error: unknown) => {
        console.error("TauriDragDrop: failed to subscribe to drag-drop events", { error });
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  });
}

// Minimal RPC surface needed for image-file detection on drop.
export interface TauriDragDropRPC {
  getImageFileData(path: string): Promise<{ data: string; mimeType: string } | undefined>;
}

// Default callback implementation: drives drag state on the runtime and
// inserts file chips into the active prompt. Dropped image files are attached
// as base64 image attachments (like pasted images) when an rpc is provided;
// non-image files and paths whose type cannot be determined fall back to a
// file-path chip.
export function makeTauriDragDropCallbacks(
  runtime: { setIsDragging(value: boolean): void },
  { rpc }: { rpc?: TauriDragDropRPC } = {},
): TauriDragDropCallbacks {
  return {
    onDragEnter() {
      runtime.setIsDragging(true);
    },
    onDragLeave() {
      runtime.setIsDragging(false);
    },
    onDrop(paths) {
      runtime.setIsDragging(false);
      // Process asynchronously so the drag-state reset is not blocked, but
      // sequential to preserve drop order.
      void (async () => {
        for (const path of paths) {
          if (rpc) {
            const image = await rpc.getImageFileData(path);
            if (image) {
              const name = path.split("/").pop() ?? path;
              requestDesktopImageAttachment({ name, data: image.data, mimeType: image.mimeType });
              continue;
            }
          }
          requestDesktopFilePromptChip(path);
        }
      })();
    },
  };
}
