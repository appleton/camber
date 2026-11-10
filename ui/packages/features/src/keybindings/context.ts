import { getContext, setContext } from "svelte";
import type { CommandId } from "./commands";
import type { KeybindingService } from "./service";

const KEY = Symbol("camber.keybindings");

// Module-level mirror of the active service so the `shortcutHint`/`withShortcut`
// helpers can resolve a hint from anywhere (markup expressions, prop values)
// without the `getContext`-during-init constraint. There is one runtime per
// webview, so last-write-wins is correct here.
let activeService: KeybindingService | null = null;

/** Provide the host-appropriate keybinding service. Call during component init. */
export function setKeybindingService(service: KeybindingService): KeybindingService {
  activeService = service;
  return setContext(KEY, service);
}

/**
 * Read the keybinding service anywhere in the tree. Returns null when no runtime
 * provided one (e.g. isolated component tests) so callers can fall back gracefully.
 */
export function getKeybindingService(): KeybindingService | null {
  return getContext<KeybindingService | undefined>(KEY) ?? activeService;
}

/**
 * The display hint for a command's shortcut (e.g. "⌘N"), or null when unbound.
 *
 * Use this to surface a shortcut on the control that triggers it — every command
 * wired with `register()` is expected to display its hint somewhere (enforced by
 * shortcutCoverage.test.ts). Prefer `withShortcut` for button tooltips.
 */
export function shortcutHint(id: CommandId): string | null {
  return activeService?.hint(id) ?? null;
}

/**
 * Append a shortcut hint to a control's tooltip label, e.g.
 * `title={withShortcut("New conversation", id)}` -> "New conversation (⌘N)".
 * Falls back to the bare label when the command is unbound.
 */
export function withShortcut(label: string, id: CommandId): string {
  const hint = shortcutHint(id);
  return hint ? `${label} (${hint})` : label;
}

/**
 * The user-override-aware chord for a command (e.g. "mod+shift+n"), or null when
 * unbound. Prefer this over `defaultChord` when you need the structured binding
 * that reflects any user remapping — for example, when building a native-menu
 * accelerator string where the display hint is not the right source.
 */
export function activeBinding(id: CommandId): string | null {
  return activeService?.binding(id) ?? null;
}
