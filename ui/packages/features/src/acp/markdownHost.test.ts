import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "./hostAdapter";
import { markdownHost } from "./markdownHost";

const rpc = vi.hoisted(() => ({
  openFile: vi.fn(),
  openPathWithOpener: vi.fn(),
  getDesktopSettings: vi.fn(async () => ({ fileOpenerId: "app:code" })),
}));

vi.mock("./hostRpc", () => ({ rpc }));

describe("Markdown host file opening", () => {
  const initialState = get(appState);

  beforeEach(() => {
    appState.update((state) => ({
      ...state,
      environment: { ...state.environment, assistantHost: "desktop" },
    }));
  });

  afterEach(() => {
    appState.set(initialState);
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it.each(["/tmp/Option Agreement.pdf", "/tmp/REPORT.PDF"])(
    "opens PDF documents in the system viewer: %s",
    async (path) => {
      const dispatch = vi.spyOn(window, "dispatchEvent");
      await markdownHost.openFile?.(path);
      expect(rpc.openPathWithOpener).toHaveBeenCalledWith(path, "default", undefined, undefined);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("keeps text files in the desktop viewer", async () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    await markdownHost.openFile?.("/tmp/notes.md", 12);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "camber:desktop-open-file-tab",
        detail: { path: "/tmp/notes.md", line: 12, column: undefined },
      }),
    );
    expect(rpc.openPathWithOpener).not.toHaveBeenCalled();
  });

  it("preserves explicit preferred-editor clicks for PDFs", async () => {
    await markdownHost.openFile?.("/tmp/terms.pdf", undefined, undefined, {
      preferredEditor: true,
    });
    expect(rpc.openPathWithOpener).toHaveBeenCalledWith(
      "/tmp/terms.pdf",
      "app:code",
      undefined,
      undefined,
    );
  });

  it("delegates PDF opening to IDE hosts", async () => {
    appState.update((state) => ({
      ...state,
      environment: { ...state.environment, assistantHost: "vscode" },
    }));
    await markdownHost.openFile?.("/tmp/terms.pdf");
    expect(rpc.openFile).toHaveBeenCalledWith("/tmp/terms.pdf", undefined, undefined);
    expect(rpc.openPathWithOpener).not.toHaveBeenCalled();
  });
});
