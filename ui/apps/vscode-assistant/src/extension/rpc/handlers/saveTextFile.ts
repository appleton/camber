import type { SaveTextFileOptions } from "@camber/rpc";
import * as vscode from "vscode";

export async function saveTextFile(options: SaveTextFileOptions): Promise<string | undefined> {
  const uri = await vscode.window.showSaveDialog({
    title: options.title,
    defaultUri: options.defaultFileName ? vscode.Uri.file(options.defaultFileName) : undefined,
    filters: Object.fromEntries(
      (options.filters ?? []).map((filter) => [filter.name, filter.extensions]),
    ),
  });
  if (!uri) return undefined;

  await vscode.workspace.fs.writeFile(uri, Buffer.from(options.contents, "utf8"));
  return uri.fsPath;
}
