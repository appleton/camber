import * as vscode from "vscode";
import { System } from "../../system";

const terminalsByCwd = new Map<string, vscode.Terminal>();

export function openTerminal(system: System, command?: string, cwd?: string) {
  const key = cwd || "";
  let terminal = terminalsByCwd.get(key);
  if (!terminal) {
    terminal = vscode.window.createTerminal({
      name: "camber",
      cwd: cwd || undefined,
      iconPath: {
        dark: vscode.Uri.parse(system.context.asAbsolutePath("./dist/resources/icon-dark.svg")),
        light: vscode.Uri.parse(system.context.asAbsolutePath("./dist/resources/icon-light.svg")),
      },
    });
    terminalsByCwd.set(key, terminal);
    const disposable = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      terminalsByCwd.delete(key);
      disposable.dispose();
    });
  }

  if (command?.trim()) {
    terminal.sendText(command);
  }
  terminal.show();
}
