import type { ArrayTail } from "type-fest";
import vscode from "vscode";
import { CAMBER } from "../extensionIdentity";
import type { CamberCommand, CamberContextKey, CamberContextKeys } from "../types/manifest";

export type CamberCommandName = CamberCommand extends `camber.${infer Command}` ? Command : never;

export function camberCommand(command: CamberCommandName): string {
  return `${CAMBER}.${command}`;
}

export function registerCommand(
  command: CamberCommandName,
  ...args: ArrayTail<Parameters<typeof vscode.commands.registerCommand>>
) {
  return vscode.commands.registerCommand(camberCommand(command), ...args);
}

export function executeCommand(
  command: CamberCommandName,
  ...args: ArrayTail<Parameters<typeof vscode.commands.executeCommand>>
) {
  return vscode.commands.executeCommand(camberCommand(command), ...args);
}

export function executeSetContextCommand<K extends CamberContextKey | string>(
  key: K,
  value: K extends CamberContextKey ? CamberContextKeys[K] : unknown,
) {
  return vscode.commands.executeCommand("setContext", key, value);
}
