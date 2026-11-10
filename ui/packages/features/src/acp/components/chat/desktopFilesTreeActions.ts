import { getUnknownErrorMessage } from "@camber/lib/errors";
import { dirname } from "@camber/lib/path";
import { InfoMessageType } from "@camber/rpc";

export type DesktopFileTreeContextMenuAction =
  | "open"
  | "openWith"
  | "revealInFinder"
  | "openInTerminal"
  | "addFileToChat"
  | "viewDiff"
  | "cut"
  | "copy"
  | "paste"
  | "copyPath"
  | "copyRelativePath"
  | "delete"
  // Git actions offered by the changes-list variant of the menu. The changes
  // list handles these itself; performDesktopFilesTreeAction ignores them.
  | "gitStage"
  | "gitUnstage"
  | "gitDiscard";

export interface DesktopFileTreeContextMenuActionPayload {
  requestId: string;
  action: DesktopFileTreeContextMenuAction;
  openerId?: string;
}

export interface DesktopFilesTreeEntry {
  path: string;
  relativePath: string;
  kind: "directory" | "file";
}

export type DesktopFilePasteboardOperation = "copy" | "cut";

export interface DesktopFilesTreeActionRPC {
  openPathWithOpener(path: string, openerId: string, line?: number, column?: number): Promise<void>;
  revealPathInFinder(path: string): Promise<void>;
  writeFileUrlToPasteboard(path: string, operation: DesktopFilePasteboardOperation): Promise<void>;
  pasteFilesIntoDirectory(destination: string): Promise<unknown>;
  trashPath(path: string): Promise<void>;
  writeToClipboard(text: string): void | Promise<void>;
  showInfoMessage(message: string, type?: InfoMessageType): void;
}

export interface DesktopFilesTreeActionOptions {
  payload: DesktopFileTreeContextMenuActionPayload;
  entry: DesktopFilesTreeEntry;
  currentFileOpenerId: string;
  rpc: DesktopFilesTreeActionRPC;
  openTerminal: (cwd: string) => void | Promise<void>;
  insertFileChip: (path: string) => boolean;
  /** Opens the git Changes panel with the given repo-relative file preselected. */
  viewDiff?: (relativePath: string) => void;
}

export async function performDesktopFilesTreeAction({
  payload,
  entry,
  currentFileOpenerId,
  rpc,
  openTerminal,
  insertFileChip,
  viewDiff,
}: DesktopFilesTreeActionOptions): Promise<void> {
  try {
    switch (payload.action) {
      case "open":
        await rpc.openPathWithOpener(entry.path, payload.openerId ?? currentFileOpenerId);
        return;
      case "openWith":
        if (!payload.openerId) return;
        await rpc.openPathWithOpener(entry.path, payload.openerId);
        return;
      case "revealInFinder":
        await rpc.revealPathInFinder(entry.path);
        return;
      case "openInTerminal":
        await openTerminal(terminalCwdForEntry(entry));
        return;
      case "addFileToChat":
        if (entry.kind !== "file") return;
        if (!insertFileChip(entry.path)) {
          rpc.showInfoMessage("Unable to add file: no active prompt", InfoMessageType.error);
        }
        return;
      case "viewDiff":
        if (entry.kind !== "file") return;
        viewDiff?.(entry.relativePath);
        return;
      case "cut":
        await rpc.writeFileUrlToPasteboard(entry.path, "cut");
        return;
      case "copy":
        await rpc.writeFileUrlToPasteboard(entry.path, "copy");
        return;
      case "paste":
        if (entry.kind !== "directory") return;
        await rpc.pasteFilesIntoDirectory(entry.path);
        return;
      case "copyPath":
        await rpc.writeToClipboard(entry.path);
        return;
      case "copyRelativePath":
        await rpc.writeToClipboard(entry.relativePath);
        return;
      case "delete":
        await rpc.trashPath(entry.path);
        return;
      case "gitStage":
      case "gitUnstage":
      case "gitDiscard":
        // Owned by the changes list (it needs its own git state); no-op here.
        return;
    }
  } catch (error) {
    rpc.showInfoMessage(actionErrorMessage(payload.action, error), InfoMessageType.error);
  }
}

export function terminalCwdForEntry(entry: DesktopFilesTreeEntry): string {
  return entry.kind === "directory" ? entry.path : dirname(entry.path);
}

function actionErrorMessage(action: DesktopFileTreeContextMenuAction, error: unknown): string {
  const detail = getUnknownErrorMessage(error);
  switch (action) {
    case "open":
    case "openWith":
      return `Unable to open path: ${detail}`;
    case "revealInFinder":
      return `Unable to reveal in Finder: ${detail}`;
    case "openInTerminal":
      return `Unable to open terminal: ${detail}`;
    case "addFileToChat":
      return `Unable to add file: ${detail}`;
    case "viewDiff":
      return `Unable to view diff: ${detail}`;
    case "cut":
    case "copy":
      return `Unable to update pasteboard: ${detail}`;
    case "paste":
      return `Unable to paste: ${detail}`;
    case "copyPath":
    case "copyRelativePath":
      return `Unable to copy path: ${detail}`;
    case "delete":
      return `Unable to delete: ${detail}`;
    case "gitStage":
    case "gitUnstage":
    case "gitDiscard":
      return `Git operation failed: ${detail}`;
  }
}
