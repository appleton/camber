import { InfoMessageType } from "@camber/rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  performDesktopFilesTreeAction,
  terminalCwdForEntry,
  type DesktopFilesTreeActionOptions,
  type DesktopFilesTreeActionRPC,
  type DesktopFilesTreeEntry,
} from "./desktopFilesTreeActions";

describe("desktop file tree actions", () => {
  let rpc: DesktopFilesTreeActionRPC;
  let openTerminal: ReturnType<typeof vi.fn>;
  let insertFileChip: ReturnType<typeof vi.fn>;

  const fileEntry: DesktopFilesTreeEntry = {
    path: "/workspace/src/app.ts",
    relativePath: "src/app.ts",
    kind: "file",
  };
  const directoryEntry: DesktopFilesTreeEntry = {
    path: "/workspace/src",
    relativePath: "src/",
    kind: "directory",
  };

  beforeEach(() => {
    rpc = {
      openPathWithOpener: vi.fn().mockResolvedValue(undefined),
      revealPathInFinder: vi.fn().mockResolvedValue(undefined),
      writeFileUrlToPasteboard: vi.fn().mockResolvedValue(undefined),
      pasteFilesIntoDirectory: vi.fn().mockResolvedValue({ pasted: 1 }),
      trashPath: vi.fn().mockResolvedValue(undefined),
      writeToClipboard: vi.fn(),
      showInfoMessage: vi.fn(),
    };
    openTerminal = vi.fn().mockResolvedValue(undefined);
    insertFileChip = vi.fn().mockReturnValue(true);
  });

  it("opens with the selected opener", async () => {
    await perform("openWith", fileEntry, { openerId: "app:code" });

    expect(rpc.openPathWithOpener).toHaveBeenCalledWith(fileEntry.path, "app:code");
  });

  it("opens terminal at a file parent", async () => {
    await perform("openInTerminal", fileEntry);

    expect(openTerminal).toHaveBeenCalledWith("/workspace/src");
  });

  it("opens terminal at a directory", async () => {
    await perform("openInTerminal", directoryEntry);

    expect(openTerminal).toHaveBeenCalledWith(directoryEntry.path);
  });

  it("requests prompt chip insertion for files", async () => {
    await perform("addFileToChat", fileEntry);

    expect(insertFileChip).toHaveBeenCalledWith(fileEntry.path);
  });

  it("does not request prompt chip insertion for folders", async () => {
    await perform("addFileToChat", directoryEntry);

    expect(insertFileChip).not.toHaveBeenCalled();
  });

  it("shows an error when no prompt handles chip insertion", async () => {
    insertFileChip.mockReturnValue(false);

    await perform("addFileToChat", fileEntry);

    expect(rpc.showInfoMessage).toHaveBeenCalledWith(
      "Unable to add file: no active prompt",
      InfoMessageType.error,
    );
  });

  it("copies and cuts file URLs through the pasteboard command", async () => {
    await perform("copy", fileEntry);
    await perform("cut", fileEntry);

    expect(rpc.writeFileUrlToPasteboard).toHaveBeenNthCalledWith(1, fileEntry.path, "copy");
    expect(rpc.writeFileUrlToPasteboard).toHaveBeenNthCalledWith(2, fileEntry.path, "cut");
  });

  it("pastes into folders and lets the file watcher update the tree", async () => {
    await perform("paste", directoryEntry);

    expect(rpc.pasteFilesIntoDirectory).toHaveBeenCalledWith(directoryEntry.path);
  });

  it("moves deleted items to trash and lets the file watcher update the tree", async () => {
    await perform("delete", fileEntry);

    expect(rpc.trashPath).toHaveBeenCalledWith(fileEntry.path);
  });

  it("copies absolute and relative paths", async () => {
    await perform("copyPath", fileEntry);
    await perform("copyRelativePath", fileEntry);

    expect(rpc.writeToClipboard).toHaveBeenNthCalledWith(1, fileEntry.path);
    expect(rpc.writeToClipboard).toHaveBeenNthCalledWith(2, fileEntry.relativePath);
  });

  it("shows an error toast when a command fails", async () => {
    vi.mocked(rpc.revealPathInFinder).mockRejectedValue(new Error("denied"));

    await perform("revealInFinder", fileEntry);

    expect(rpc.showInfoMessage).toHaveBeenCalledWith(
      "Unable to reveal in Finder: denied",
      InfoMessageType.error,
    );
  });

  it("computes terminal cwd for folders and files", () => {
    expect(terminalCwdForEntry(directoryEntry)).toBe(directoryEntry.path);
    expect(terminalCwdForEntry(fileEntry)).toBe("/workspace/src");
  });

  async function perform(
    action: DesktopFilesTreeActionOptions["payload"]["action"],
    entry: DesktopFilesTreeEntry,
    options: {
      openerId?: string;
    } = {},
  ) {
    await performDesktopFilesTreeAction({
      payload: {
        requestId: "request-1",
        action,
        ...(options.openerId ? { openerId: options.openerId } : {}),
      },
      entry,
      currentFileOpenerId: "default",
      rpc,
      openTerminal,
      insertFileChip,
    });
  }
});
