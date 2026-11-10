import * as vscode from "vscode";
import { CAMBER } from "./extensionIdentity";

/**
 * DecorationProvider is used to set green line background highlights for inserted lines
 */
export class DecorationProvider {
  // insertDecorations tracks decorations that have actually been applied to a visible text editor
  private insertDecorations: Map<string, vscode.TextEditorDecorationType[]>;
  // insertLocations tracks all ranges in all files that could currently have a highlight
  private insertLocations: Map<string, { lines: vscode.Range[]; inner: vscode.Range[] }>;

  constructor() {
    this.insertDecorations = new Map();
    this.insertLocations = new Map();
  }

  // Stores all locations in all files that should be highlighted
  setInserts(locations: Map<string, { lines: vscode.Range[]; inner: vscode.Range[] }>) {
    this.deleteAllInserts();
    this.insertLocations = locations;
    return this.applyInserts();
  }

  // Applies highlights to any currently visible editors
  async applyInserts() {
    for (const editor of vscode.window.visibleTextEditors) {
      const fsPath = editor.document.uri.fsPath;
      const ranges = this.insertLocations.get(editor.document.uri.fsPath);
      if (!ranges) continue;

      this.hideInserts(fsPath);

      const decoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
        borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
      });

      const innerDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: false,
        backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
        borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
      });

      this.insertDecorations.set(editor.document.uri.fsPath, [decoration, innerDecoration]);

      const hoverMessage = new vscode.MarkdownString(`$(${CAMBER}-roundel) Edited by camber`, true);

      if (ranges.lines.length > 0) {
        editor.setDecorations(
          decoration,
          ranges.lines.map((range) => ({ range, hoverMessage })),
        );
      }

      if (ranges.inner.length > 0) {
        editor.setDecorations(
          innerDecoration,
          ranges.inner.map((range) => ({ range })),
        );
      }
    }
  }

  deleteAllInserts() {
    for (const [path, _] of this.insertDecorations) {
      this.deleteInserts(path);
    }
  }

  deleteInserts(path: string) {
    const location = this.insertLocations.get(path);
    if (location) {
      this.insertLocations.delete(path);
    }

    const decorations = this.insertDecorations.get(path);
    if (decorations) {
      decorations.forEach((d) => d.dispose());
      this.insertDecorations.delete(path);
    }
  }

  // Remove decorations from visible editors, but keep the references so they can be reapplied later
  hideInserts(path: string) {
    const decorations = this.insertDecorations.get(path);
    if (decorations) {
      decorations.forEach((d) => d.dispose());
      this.insertDecorations.delete(path);
    }
  }
}
