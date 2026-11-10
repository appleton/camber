import type { ProjectFolder } from "@camber/rpc";
import * as path from "path";
import * as vscode from "vscode";

export async function selectProjectFolder(): Promise<ProjectFolder | undefined> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Add Project",
    title: "Add Project",
  });

  const folder = selected?.[0];
  if (!folder) return undefined;

  return {
    path: folder.fsPath,
    name: path.basename(folder.fsPath),
  };
}
