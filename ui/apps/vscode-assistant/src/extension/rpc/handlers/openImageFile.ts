import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export function openImageFile(svgContent: string, filename?: string): void {
  try {
    // Create a temporary file
    const tempDir = os.tmpdir();
    const fileName = filename || `mermaid-diagram-${Date.now()}.svg`;
    const tempFilePath = path.join(tempDir, fileName);

    // Write SVG content to temporary file
    fs.writeFileSync(tempFilePath, svgContent, "utf8");

    vscode.commands.executeCommand("vscode.open", vscode.Uri.file(tempFilePath), {
      preview: true,
      viewColumn: vscode.ViewColumn.Active,
    });
  } catch (error) {
    console.error("Error creating or opening image file:", error);
    vscode.window.showErrorMessage("camber: Failed to open diagram image");
  }
}
