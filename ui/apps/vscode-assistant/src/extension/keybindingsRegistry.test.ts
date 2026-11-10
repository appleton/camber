// Keeps the shared keybindings registry and this extension's contributed
// keybindings from drifting apart. The registry (commands.ts) declares each
// command's intended VS Code default; VS Code's source of truth is package.json.
// If the two disagree, one of them changed without the other — fail loudly.

import {
  ALL_COMMANDS,
  type KeyChord,
  parseChord,
  vscodeCommandId,
} from "@camber/features/keybindings";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

const contributedCommands = new Set(packageJson.contributes.commands.map((c) => c.command));
const contributedKeybindings = packageJson.contributes.keybindings;

/** Canonical, order-insensitive token set for comparing VS Code key strings. */
function normalizeVscodeKey(key: string): string {
  return key
    .toLowerCase()
    .split("+")
    .map((token) => token.trim())
    .map((token) => (token === "cmd" || token === "win" || token === "meta" ? "meta" : token))
    .sort()
    .join("+");
}

/** Expected VS Code tokens for a registry chord, resolving `mod` to ctrl or meta. */
function chordToVscodeKey(chord: KeyChord, modAs: "ctrl" | "meta"): string {
  const parsed = parseChord(chord);
  const tokens: string[] = [];
  if (parsed.ctrl || (parsed.mod && modAs === "ctrl")) tokens.push("ctrl");
  if (parsed.meta || (parsed.mod && modAs === "meta")) tokens.push("meta");
  if (parsed.alt) tokens.push("alt");
  if (parsed.shift) tokens.push("shift");
  tokens.push(parsed.key);
  return tokens.sort().join("+");
}

describe("keybindings registry ⇄ package.json", () => {
  it("declares every VS Code command it references", () => {
    for (const command of ALL_COMMANDS) {
      if (!command.hosts.includes("vscode")) continue;
      if (command.external) continue; // handled by a webview component, not a VS Code command
      expect(contributedCommands, `registry command "${command.id}"`).toContain(
        vscodeCommandId(command.id),
      );
    }
  });

  it("agrees with the contributed default keybinding for each command", () => {
    for (const command of ALL_COMMANDS) {
      if (command.external) continue; // not a VS Code-contributed keybinding
      const chord = command.defaults.vscode;
      if (!chord) continue;

      const entry = contributedKeybindings.find((kb) => kb.command === vscodeCommandId(command.id));
      expect(entry, `missing keybinding for "${command.id}"`).toBeDefined();
      if (!entry) continue;

      // Non-mac binding (`mod` -> ctrl).
      expect(normalizeVscodeKey(entry.key)).toBe(chordToVscodeKey(chord, "ctrl"));
      // Mac binding (`mod` -> cmd); falls back to `key` when no mac override.
      const macKey = "mac" in entry && entry.mac ? entry.mac : entry.key;
      expect(normalizeVscodeKey(macKey)).toBe(chordToVscodeKey(chord, "meta"));
    }
  });
});
