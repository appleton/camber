import * as vscode from "vscode";
import { camberCommand } from "./api/commands";
import { CAMBER, getExtensionIdentity } from "./extensionIdentity";

/**
 * Status bar entry point for the assistant.
 *
 * The editor title button only renders once a document is open, so with an
 * empty window the status bar is the only always-visible way to reach the
 * assistant. `focusInput` opens a new chat when none exists and otherwise
 * reveals the most recent one, matching the editor title button.
 */
export function createStatusBarItem(): vscode.StatusBarItem {
  const { assistantTitle } = getExtensionIdentity();

  const statusBarItem = vscode.window.createStatusBarItem(
    `${CAMBER}.launch`,
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.name = assistantTitle;
  statusBarItem.text = `$(${CAMBER}-roundel)`;
  statusBarItem.tooltip = `Open ${assistantTitle}`;
  statusBarItem.command = camberCommand("focusInput");
  statusBarItem.show();

  return statusBarItem;
}
