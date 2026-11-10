import type { ImageFileData } from "@camber/rpc";
import type { DesktopContextMenuSpecItem } from "./desktopContextMenu";
import type { DesktopImageAttachmentEventDetail } from "./desktopFilePromptChip";
import {
  buildOpenInContextMenuSpec,
  decodeFileTreeActionId,
  fileTreeSpecToGenericSpec,
  type DesktopFileTreeContextMenuOpener,
} from "./desktopFilesTreeContextMenu";

export interface DesktopImageContextMenuState {
  currentOpenerId: string;
  fileOpeners: DesktopFileTreeContextMenuOpener[];
  /** File-only actions are omitted for embedded or remote images. */
  hasPath?: boolean;
}

export interface DesktopImageContextMenuRPC {
  getImageFileData(path: string): Promise<ImageFileData | undefined>;
  openPathWithOpener(path: string, openerId: string): Promise<void>;
  revealPathInFinder(path: string): Promise<void>;
  writeImageToPasteboard(path: string): Promise<void>;
  writeImageDataToPasteboard(data: string): Promise<void>;
  writeToClipboard(text: string): void | Promise<void>;
}

export interface DesktopImageData {
  data: string;
  mimeType: string;
}

export interface PerformDesktopImageContextMenuActionOptions {
  actionId: string;
  path?: string;
  relativePath?: string;
  name?: string;
  loadImageData?: () => Promise<DesktopImageData | undefined>;
  rpc: DesktopImageContextMenuRPC;
  attachImage: (detail: DesktopImageAttachmentEventDetail) => boolean;
}

export function buildDesktopImageContextMenuItems(
  state: DesktopImageContextMenuState,
): DesktopContextMenuSpecItem[] {
  if (state.hasPath === false) {
    return [
      { kind: "action", id: "addImageToChat", label: "Add Image to Chat" },
      { kind: "separator" },
      {
        kind: "action",
        id: "copyImage",
        label: "Copy Image",
        accelerator: "Cmd+C",
      },
    ];
  }

  const [openIn] = fileTreeSpecToGenericSpec([
    buildOpenInContextMenuSpec(state.fileOpeners, state.currentOpenerId),
  ]);

  return [
    openIn,
    {
      kind: "action",
      id: "revealInFinder",
      label: "Reveal In Finder",
      accelerator: "Cmd+Alt+R",
    },
    { kind: "action", id: "addImageToChat", label: "Add Image to Chat" },
    { kind: "separator" },
    {
      kind: "action",
      id: "copyImage",
      label: "Copy Image",
      accelerator: "Cmd+C",
    },
    { kind: "separator" },
    {
      kind: "action",
      id: "copyPath",
      label: "Copy Path",
      accelerator: "Cmd+Alt+C",
    },
    {
      kind: "action",
      id: "copyRelativePath",
      label: "Copy Relative Path",
      accelerator: "Cmd+Shift+Alt+C",
    },
  ];
}

export async function performDesktopImageContextMenuAction({
  actionId,
  path,
  relativePath,
  name,
  loadImageData,
  rpc,
  attachImage,
}: PerformDesktopImageContextMenuActionOptions): Promise<void> {
  const openWith = decodeFileTreeActionId(actionId);
  if (openWith.action === "openWith" && openWith.openerId) {
    await rpc.openPathWithOpener(requirePath(path), openWith.openerId);
    return;
  }

  switch (actionId) {
    case "revealInFinder":
      await rpc.revealPathInFinder(requirePath(path));
      return;
    case "addImageToChat": {
      const image = await resolveImageData(path, loadImageData, rpc);
      if (!image) throw new Error("Image files of this type cannot be added to chat.");
      if (
        !attachImage({
          name: name || (path ? fileNameFromPath(path) : "image"),
          data: image.data,
          mimeType: image.mimeType,
        })
      ) {
        throw new Error("Unable to add image: no active prompt");
      }
      return;
    }
    case "copyImage": {
      if (path) {
        try {
          await rpc.writeImageToPasteboard(path);
          return;
        } catch (error) {
          if (!loadImageData) throw error;
        }
      }
      const image = await loadImageData?.();
      if (!image) throw new Error("Unable to read image data for copying.");
      await rpc.writeImageDataToPasteboard(image.data);
      return;
    }
    case "copyPath":
      await rpc.writeToClipboard(requirePath(path));
      return;
    case "copyRelativePath":
      await rpc.writeToClipboard(relativePath || requirePath(path));
      return;
  }
}

async function resolveImageData(
  path: string | undefined,
  loadImageData: (() => Promise<DesktopImageData | undefined>) | undefined,
  rpc: DesktopImageContextMenuRPC,
): Promise<DesktopImageData | undefined> {
  if (path) {
    const image = await rpc.getImageFileData(path);
    if (image) return image;
  }
  return await loadImageData?.();
}

function requirePath(path: string | undefined): string {
  if (!path) throw new Error("This image does not have a local file path.");
  return path;
}

function fileNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || "image";
}
