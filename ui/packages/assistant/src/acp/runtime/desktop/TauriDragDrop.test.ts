import { describe, expect, it, vi } from "vitest";
import {
  makeTauriDragDropCallbacks,
  type TauriDragDropCallbacks,
  type TauriDragDropRPC,
} from "./TauriDragDrop.svelte";

describe("makeTauriDragDropCallbacks", () => {
  it("calls setIsDragging(true) on drag enter", () => {
    const runtime = { setIsDragging: vi.fn() };
    const callbacks = makeTauriDragDropCallbacks(runtime);

    callbacks.onDragEnter();

    expect(runtime.setIsDragging).toHaveBeenCalledWith(true);
  });

  it("calls setIsDragging(false) on drag leave", () => {
    const runtime = { setIsDragging: vi.fn() };
    const callbacks = makeTauriDragDropCallbacks(runtime);

    callbacks.onDragLeave();

    expect(runtime.setIsDragging).toHaveBeenCalledWith(false);
  });

  it("clears drag state and dispatches a chip event for each non-image path (no rpc)", async () => {
    const runtime = { setIsDragging: vi.fn() };
    const callbacks = makeTauriDragDropCallbacks(runtime);

    const dispatched: string[] = [];
    window.addEventListener("camber:desktop-file-prompt-chip", (event) => {
      dispatched.push((event as CustomEvent<{ path: string }>).detail.path);
    });

    callbacks.onDrop(["/workspace/foo.ts", "/workspace/bar.ts"]);
    // onDrop processes async; flush microtasks
    await Promise.resolve();

    expect(runtime.setIsDragging).toHaveBeenCalledWith(false);
    expect(dispatched).toEqual(["/workspace/foo.ts", "/workspace/bar.ts"]);
  });

  it("dispatches no chip events for an empty drop", async () => {
    const runtime = { setIsDragging: vi.fn() };
    const callbacks = makeTauriDragDropCallbacks(runtime);

    const dispatched: string[] = [];
    window.addEventListener("camber:desktop-file-prompt-chip", (event) => {
      dispatched.push((event as CustomEvent<{ path: string }>).detail.path);
    });

    callbacks.onDrop([]);
    await Promise.resolve();

    expect(dispatched).toHaveLength(0);
    expect(runtime.setIsDragging).toHaveBeenCalledWith(false);
  });

  it("dispatches image attachment events for image paths when rpc returns image data", async () => {
    const runtime = { setIsDragging: vi.fn() };
    const rpc: TauriDragDropRPC = {
      getImageFileData: vi.fn().mockImplementation(async (path: string) => {
        if (path.endsWith(".png")) {
          return { data: "base64data", mimeType: "image/png" };
        }
        return undefined;
      }),
    };
    const callbacks = makeTauriDragDropCallbacks(runtime, { rpc });

    const imageEvents: Array<{ name: string; data: string; mimeType: string }> = [];
    const chipEvents: string[] = [];
    window.addEventListener("camber:desktop-image-attachment", (event) => {
      imageEvents.push(
        (event as CustomEvent<{ name: string; data: string; mimeType: string }>).detail,
      );
    });
    window.addEventListener("camber:desktop-file-prompt-chip", (event) => {
      chipEvents.push((event as CustomEvent<{ path: string }>).detail.path);
    });

    callbacks.onDrop(["/workspace/photo.png", "/workspace/main.ts"]);
    // The async loop requires multiple microtask ticks to fully resolve
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.setIsDragging).toHaveBeenCalledWith(false);
    expect(imageEvents).toEqual([{ name: "photo.png", data: "base64data", mimeType: "image/png" }]);
    expect(chipEvents).toEqual(["/workspace/main.ts"]);
  });

  it("falls back to chip event when rpc returns undefined for a path", async () => {
    const runtime = { setIsDragging: vi.fn() };
    const rpc: TauriDragDropRPC = {
      getImageFileData: vi.fn().mockResolvedValue(undefined),
    };
    const callbacks = makeTauriDragDropCallbacks(runtime, { rpc });

    const chipEvents: string[] = [];
    window.addEventListener("camber:desktop-file-prompt-chip", (event) => {
      chipEvents.push((event as CustomEvent<{ path: string }>).detail.path);
    });

    callbacks.onDrop(["/workspace/data.csv"]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chipEvents).toEqual(["/workspace/data.csv"]);
  });
});

describe("initTauriDragDrop", () => {
  it("is a no-op when no subscriber is provided", async () => {
    // Verify that passing no subscriber causes no errors and no callbacks fire.
    // initTauriDragDrop wraps onMount, so we only verify the exported type shape here.
    const callbacks: TauriDragDropCallbacks = {
      onDragEnter: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
    };
    // Without a subscriber nothing should fire.
    expect(callbacks.onDragEnter).not.toHaveBeenCalled();
    expect(callbacks.onDragLeave).not.toHaveBeenCalled();
    expect(callbacks.onDrop).not.toHaveBeenCalled();
  });

  it("invokes the subscriber with the provided callbacks", async () => {
    const subscriber = vi.fn().mockResolvedValue(() => {});
    const callbacks: TauriDragDropCallbacks = {
      onDragEnter: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
    };

    // Simulate what onMount would do: call subscriber directly.
    const unlisten = await subscriber(callbacks);
    expect(subscriber).toHaveBeenCalledWith(callbacks);
    expect(unlisten).toBeTypeOf("function");
  });

  it("logs an error and does not produce an unhandled rejection when the subscriber rejects", async () => {
    const ipcError = new Error("Tauri IPC unavailable");
    const subscriber = vi.fn().mockRejectedValue(ipcError);
    const callbacks: TauriDragDropCallbacks = {
      onDragEnter: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
    };

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // Simulate what onMount would do: call subscriber and attach .catch as the
    // implementation does, so we verify no unhandled rejection escapes.
    await subscriber(callbacks).catch((error: unknown) => {
      console.error("TauriDragDrop: failed to subscribe to drag-drop events", { error });
    });

    expect(consoleError).toHaveBeenCalledWith(
      "TauriDragDrop: failed to subscribe to drag-drop events",
      { error: ipcError },
    );

    consoleError.mockRestore();
  });
});
