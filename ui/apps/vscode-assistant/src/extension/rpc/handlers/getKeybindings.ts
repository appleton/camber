import type { Keybindings } from "@camber/rpc";
import * as fs from "fs/promises";
import JSON5 from "json5";
import path from "path";
import * as vscode from "vscode";
import packageJson from "../../../../package.json";
import { getConfiguration } from "../../api/configuration";
import { serialize } from "../../keybinding";

export interface Keybinding {
  command: string;
  key: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
}

const extensionKeyBindings: Keybinding[] = packageJson.contributes.keybindings;

/**
 * Attempts to resolve the configured keybindings for the commands provided
 * @param commands {string[]} a list of commands to lookup keybindings for
 * @returns {Promise<Keybinding[]>} A promise for a list of resolved keybindings
 */
export async function getKeybindings(commands: string[]) {
  const showKeybindings = getConfiguration("camber.showKeybindings");
  if (!showKeybindings) return {};

  const userKeyBindings = await loadUserKeyBindings();

  return commands.reduce((res, command) => {
    res[command] = serialize(
      platform,
      findKeybinding(extensionKeyBindings, userKeyBindings, command, platform),
    );
    return res;
  }, {} as Keybindings);
}

export type Platform = "mac" | "linux" | "win";

/**
 * Resolves the effective key for a command, matching VS Code's layered keybinding resolution:
 *
 * 1. If the user added a binding for this command, return it (last add wins).
 *    User adds are never affected by "-command" removals.
 * 2. Otherwise fall back to the extension default, unless the user explicitly
 *    removed it with a "-command" entry matching the same key.
 *
 * This matches VS Code's semantics where "-command" removals only target
 * isDefault (extension-contributed) bindings, not user-added ones.
 * See: https://github.com/microsoft/vscode/blob/cec786a/src/vs/platform/keybinding/common/keybindingResolver.ts#L83-L113
 *
 * We require this workaround because VS Code does not expose an API to discover the current keybinding for a command.
 * See https://github.com/microsoft/vscode-discussions/discussions/780
 */
export function findKeybinding(
  extensionBindings: Keybinding[],
  userBindings: Keybinding[],
  command: string,
  plat: Platform,
) {
  // User +command entries always survive — removals only target isDefault (extension) bindings.
  let userKey: string | undefined;
  const removedKeys = new Set<string>();
  for (const binding of userBindings) {
    const key = binding[plat] || binding.key;
    if (!key) continue;
    if (binding.command === command) {
      userKey = key;
    } else if (binding.command === `-${command}`) {
      removedKeys.add(normalizeKey(key)!);
    }
  }
  if (userKey) return userKey;

  // Fall back to extension default (last match wins), skipping keys removed by user
  let extensionKey: string | undefined;
  for (const binding of extensionBindings) {
    if (binding.command !== command) continue;
    const key = binding[plat] || binding.key;
    if (key && !removedKeys.has(normalizeKey(key)!)) extensionKey = key;
  }
  return extensionKey;
}

function normalizeKey(key: string | undefined) {
  return key?.split("+").sort().join("+");
}

async function readKeybindingsFile(filePath: string): Promise<Keybinding[]> {
  try {
    const contents = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    const parsed = JSON5.parse(contents.toString());
    return Array.isArray(parsed) ? (parsed as Keybinding[]) : [];
  } catch {
    return [];
  }
}

/**
 * Loads user keybindings from the default path and all profile paths.
 * globalStorageUri doesn't reflect the active profile for dev extensions,
 * so we read from all keybindings.json files. Profile entries are appended
 * after the default, so they take precedence in the last-wins find().
 */
async function loadUserKeyBindings(): Promise<Keybinding[]> {
  const paths = await resolveKeybindingsPaths();
  const results = await Promise.all(paths.map(readKeybindingsFile));
  return results.flat();
}

async function resolveKeybindingsPaths(): Promise<string[]> {
  const defaultPath = defaultKeybindingsPath()!;
  const paths = [defaultPath];
  const profilesDir = path.join(path.dirname(defaultPath), "profiles");
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        paths.push(path.join(profilesDir, entry.name, "keybindings.json"));
      }
    }
  } catch {
    // profiles dir may not exist
  }
  return paths;
}

const platform = (() => {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "linux":
      return "linux";
    case "win32":
      return "win";
    default:
      throw new Error(`unexpected platform: ${process.platform}`);
  }
})();

function defaultKeybindingsPath() {
  // Test harness sets this to a temp dir (see tests/helpers/global-setup.ts)
  const testUserDataDir = process.env.VSCODE_USER_DATA_DIR;
  if (testUserDataDir) return path.join(testUserDataDir, "User", "keybindings.json");

  switch (platform) {
    case "mac":
      return process.env.HOME + "/Library/Application Support/Code/User/keybindings.json";
    case "linux":
      return process.env.HOME + "/.config/Code/User/keybindings.json";
    case "win":
      return process.env.APPDATA + "/Code/User/keybindings.json";
  }
}

/**
 * Returns paths to watch for keybinding changes: the default user keybindings
 * plus the profiles directory (which contains per-profile keybindings.json files).
 */
export function getKeybindingsWatchPaths(): string[] {
  const defaultPath = defaultKeybindingsPath()!;
  const profilesDir = path.join(path.dirname(defaultPath), "profiles");
  return [defaultPath, profilesDir];
}
