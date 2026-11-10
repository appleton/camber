import type { AttachedFile } from "@camber/rpc";
import * as vscode from "vscode";

/**
 * getFileContents returns the contents of a file. If the file does not exist or if the given path
 * is a directory then undefined is returned
 */
export async function getFileContents(path: string): Promise<AttachedFile | undefined> {
  const uri = vscode.Uri.file(path);

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) return;
  } catch (_e) {
    return;
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  const content = doc.getText();

  return { path, content };
}
