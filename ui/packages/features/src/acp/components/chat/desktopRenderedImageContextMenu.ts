import { getUnknownErrorMessage } from "@camber/lib/errors";
import { normalize, relative } from "@camber/lib/path";
import { InfoMessageType } from "@camber/rpc";
import { get } from "svelte/store";
import { appState } from "../../hostAdapter";
import { rpc, type RPCClient } from "../../hostRpc";
import { showDesktopContextMenu } from "./desktopContextMenu";
import { requestDesktopImageAttachment } from "./desktopFilePromptChip";
import {
  buildDesktopImageContextMenuItems,
  performDesktopImageContextMenuAction,
  type DesktopImageContextMenuRPC,
  type DesktopImageData,
} from "./desktopImageContextMenu";

interface DesktopRenderedImageSettings {
  fileOpeners: Array<{
    id: string;
    label: string;
    kind: "inApp" | "default" | "editorEnv" | "application" | "terminal";
  }>;
}

type DesktopRenderedImageRPC = RPCClient &
  DesktopImageContextMenuRPC & {
    getDesktopSettings(): Promise<DesktopRenderedImageSettings>;
  };

export interface DesktopRenderedImageTarget {
  src: string;
  name: string;
  path?: string;
  relativePath?: string;
}

const desktopRpc = rpc as DesktopRenderedImageRPC;

/** Returns the rendered image under a bubbling transcript context-menu event. */
export function imageFromContextMenuEvent(event: MouseEvent): HTMLImageElement | undefined {
  const target = event.target;
  if (target instanceof HTMLImageElement) return target;
  if (!(target instanceof Element)) return;
  return target.closest("img") ?? undefined;
}

/** Captures the information needed after the native menu has been dismissed. */
export function desktopRenderedImageTarget(
  image: HTMLImageElement,
  workspacePaths = get(appState).workspaces.map(({ path }) => path),
): DesktopRenderedImageTarget | undefined {
  const src = image.currentSrc || image.src;
  if (!src) return;

  const path = image.dataset["camberImagePath"]?.trim() || undefined;
  const name =
    (path ? fileNameFromPath(path) : undefined) ||
    image.dataset["camberImageName"]?.trim() ||
    image.alt.trim() ||
    fileNameFromSource(src) ||
    "image";

  return {
    src,
    name,
    path,
    relativePath: path ? relativePathForFile(path, workspacePaths) : undefined,
  };
}

/** Reads base64 image bytes from a rendered data/blob/web URL. */
export async function loadRenderedImageData(
  src: string,
  fetchImage: typeof fetch = fetch,
): Promise<DesktopImageData | undefined> {
  const embedded = imageDataFromDataUrl(src);
  if (embedded) return embedded;

  const response = await fetchImage(src);
  if (!response.ok) throw new Error(`Unable to load image (${response.status})`);
  const mimeType =
    response.headers.get("content-type")?.split(";", 1)[0] || imageMimeTypeFromSource(src);
  if (!mimeType?.startsWith("image/")) {
    throw new Error("The rendered resource is not an image.");
  }
  return {
    data: arrayBufferToBase64(await response.arrayBuffer()),
    mimeType,
  };
}

export async function showDesktopRenderedImageContextMenu(
  image: HTMLImageElement,
  position: { x: number; y: number },
): Promise<void> {
  const target = desktopRenderedImageTarget(image);
  if (!target) return;

  try {
    const settings = await desktopRpc.getDesktopSettings();
    const inAppOpenerId =
      settings.fileOpeners.find((opener) => opener.kind === "inApp")?.id ?? "poolside";
    const actionId = await showDesktopContextMenu(
      buildDesktopImageContextMenuItems({
        currentOpenerId: inAppOpenerId,
        fileOpeners: settings.fileOpeners.map(({ id, label }) => ({ id, label })),
        hasPath: target.path !== undefined,
      }),
      position,
    );
    if (!actionId) return;

    await performDesktopImageContextMenuAction({
      actionId,
      path: target.path,
      relativePath: target.relativePath,
      name: target.name,
      loadImageData: () => loadRenderedImageData(target.src),
      rpc: desktopRpc,
      attachImage: requestDesktopImageAttachment,
    });
  } catch (error) {
    desktopRpc.showInfoMessage(
      `Image action failed: ${getUnknownErrorMessage(error)}`,
      InfoMessageType.error,
    );
  }
}

function imageDataFromDataUrl(src: string): DesktopImageData | undefined {
  if (!src.startsWith("data:")) return;
  const comma = src.indexOf(",");
  if (comma < 0) throw new Error("The embedded image data is invalid.");

  const metadata = src.slice("data:".length, comma).split(";");
  const mimeType = metadata[0] || "application/octet-stream";
  if (!mimeType.startsWith("image/")) throw new Error("The embedded resource is not an image.");
  if (!metadata.includes("base64")) return;

  return {
    data: decodeURIComponent(src.slice(comma + 1)).replace(/\s/g, ""),
    mimeType,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function relativePathForFile(path: string, workspacePaths: string[]): string {
  const normalizedPath = normalize(path);
  const workspacePath = workspacePaths
    .map(normalize)
    .filter(
      (candidate) => normalizedPath === candidate || normalizedPath.startsWith(`${candidate}/`),
    )
    .sort((left, right) => right.length - left.length)[0];
  if (!workspacePath) return path;

  const nextRelativePath = normalize(relative(workspacePath, normalizedPath));
  return nextRelativePath && nextRelativePath !== "." && !nextRelativePath.startsWith("../")
    ? nextRelativePath
    : path;
}

function fileNameFromPath(path: string): string | undefined {
  return path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
}

function fileNameFromSource(src: string): string | undefined {
  if (src.startsWith("data:") || src.startsWith("blob:")) return;
  try {
    const pathname = new URL(src).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "") || undefined;
  } catch {
    return fileNameFromPath(src);
  }
}

function imageMimeTypeFromSource(src: string): string | undefined {
  const extension = fileNameFromSource(src)?.split(".").at(-1)?.toLowerCase();
  return (
    {
      apng: "image/apng",
      avif: "image/avif",
      gif: "image/gif",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      webp: "image/webp",
    } as Record<string, string>
  )[extension ?? ""];
}
