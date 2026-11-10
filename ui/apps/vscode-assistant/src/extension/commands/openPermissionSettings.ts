import {
  type RuntimeFilesOutput,
  type RuntimeFilesParams,
  RuntimeFilesKey,
} from "@camber/helperapi/schemas";
import * as vscode from "vscode";
import { getHelperSingleton } from "../helper";
import { System } from "../system";

export async function openPermissionSettings(system: System) {
  let res: RuntimeFilesOutput;
  try {
    const client = await getHelperSingleton(system);
    const params: RuntimeFilesParams = {};
    res = await client.sendRequest<RuntimeFilesOutput>("camber/runtimeFiles", params);
  } catch {
    vscode.window.showErrorMessage(`camber: Failed to request camber permission settings file.`);
    return;
  }

  const settingsFile = res.files.find((f) => f.key === RuntimeFilesKey.user_settings_yaml);

  if (!settingsFile || settingsFile.path === "") {
    vscode.window.showErrorMessage(`camber: Failed to find camber permission settings file.`);
    return;
  }

  if (settingsFile.fileExists) {
    try {
      const uri = vscode.Uri.parse(settingsFile.path);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    } catch {
      vscode.window.showErrorMessage(
        `camber: An error occured opening camber permission settings file.`,
      );
    }
    return;
  }

  let document;

  try {
    const uri = vscode.Uri.parse(`untitled:${settingsFile.path}`);
    document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
  } catch {
    vscode.window.showErrorMessage(
      `camber: An error occured opening camber permission settings file.`,
    );
  }

  if (settingsFile.placeholder && document && document.getText().trim() === "") {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {
      editor.insertSnippet(new vscode.SnippetString(settingsFile.placeholder));

      const position = new vscode.Position(0, 0); // Line 0, character 0
      const selection = new vscode.Selection(position, position);

      editor.selection = selection;
      editor.revealRange(new vscode.Range(position, position));
    }
  }
}
