import type { ImageFileData } from "@camber/rpc";
import * as path from "path";
import * as vscode from "vscode";

const MIME_TYPES: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export async function getImageFileData(filePath: string): Promise<ImageFileData | undefined> {
  const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()];
  if (!mimeType) return;

  const uri = vscode.Uri.file(filePath);
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) return;
    const bytes = await vscode.workspace.fs.readFile(uri);
    return {
      data: Buffer.from(bytes).toString("base64"),
      mimeType,
      path: filePath,
    };
  } catch (_error) {
    return;
  }
}
