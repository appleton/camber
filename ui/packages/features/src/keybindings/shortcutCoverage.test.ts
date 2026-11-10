// Enforcement ("lint rule" as a CI test): every keyboard shortcut wired with
// `register("<id>")` must surface its hint to users — via `withShortcut(...)` or
// `shortcutHint("<id>")` on the control that triggers it — UNLESS it is explicitly
// listed as a global action with no corresponding button.
//
// Why a test and not an ESLint rule: registration lives in the desktop runtime
// (`@camber/assistant`) while hint display lives on buttons in shared components
// (`@camber/features`) — different files in different packages. ESLint is
// per-file/per-package and can't see both sides, so the invariant is enforced by a
// repo-wide static scan here. It runs in CI alongside the rest of the unit tests.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CommandId } from "./commands";

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCAN_DIRS = [path.join(UI_ROOT, "packages"), path.join(UI_ROOT, "apps")];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".svelte-kit",
  ".turbo",
  "build",
  "storybook-static",
]);
const SOURCE_EXT = /\.(ts|tsx|svelte)$/;
const SKIP_FILE = /\.(test|spec|stories)\./;

// Commands that are global actions with no single button to hang a tooltip on.
// Adding a shortcut here is a conscious "this one has no corresponding button"
// decision — the point of this test is that the choice can't be made silently.
const SHORTCUTS_WITHOUT_BUTTON: ReadonlySet<CommandId> = new Set<CommandId>([
  "focusInput", // focuses the prompt; no triggering button
  "nextUnreadConversation", // global navigation
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (SOURCE_EXT.test(entry.name) && !SKIP_FILE.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  SCAN_DIRS.forEach(walk);
  return out;
}

function collectIds(sources: string[]) {
  const registered = new Set<string>();
  const displayed = new Set<string>();
  // `foo.register("id", ...)` — the quoted-id form, never matches the register() definition.
  const registerRe = /\.register\(\s*["']([a-zA-Z]+)["']/g;
  // `withShortcut(label, "id")` and `shortcutHint("id")`.
  const withShortcutRe = /withShortcut\([^,]*,\s*["']([a-zA-Z]+)["']/g;
  const shortcutHintRe = /shortcutHint\(\s*["']([a-zA-Z]+)["']/g;
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(registerRe)) registered.add(m[1]);
    for (const m of text.matchAll(withShortcutRe)) displayed.add(m[1]);
    for (const m of text.matchAll(shortcutHintRe)) displayed.add(m[1]);
  }
  return { registered, displayed };
}

describe("shortcut hint coverage", () => {
  const { registered, displayed } = collectIds(sourceFiles());

  it("finds registered shortcuts to check", () => {
    // Guards against the scan silently matching nothing (e.g. a moved file/changed API).
    expect(registered.size).toBeGreaterThan(0);
  });

  it("displays a hint for every registered shortcut (or lists it as button-less)", () => {
    const missing = [...registered].filter(
      (id) => !displayed.has(id) && !SHORTCUTS_WITHOUT_BUTTON.has(id as CommandId),
    );
    expect(
      missing,
      `These shortcuts are wired with register() but never display their hint. ` +
        `Add withShortcut(label, "<id>") / shortcutHint("<id>") to the triggering button, ` +
        `or add the id to SHORTCUTS_WITHOUT_BUTTON if it has no button: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the button-less exemption list honest (no stale entries)", () => {
    const stale = [...SHORTCUTS_WITHOUT_BUTTON].filter((id) => !registered.has(id));
    expect(stale, `Exempted ids that are no longer registered: ${stale.join(", ")}`).toEqual([]);
  });
});
