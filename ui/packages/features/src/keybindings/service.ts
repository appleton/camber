// The seam every component talks to. Declarations live in commands.ts; behavior
// is attached here by id. Two implementations exist because the hosts resolve
// shortcuts very differently:
//
//   - Desktop (Tauri) has no OS-level keybinding engine, so the service OWNS
//     dispatch: it runs the keydown matcher and fires registered handlers.
//   - VS Code already resolves keybindings in the extension host via contributed
//     `keybindings` + a `when: camber.webviewFocus` context key. Re-dispatching
//     in the webview would double-fire, so the service DELEGATES: register() is a
//     no-op and dispatch belongs to the host. It still answers hint()/binding()
//     for display, reading the host-resolved hints fed in over RPC.
//
// Same interface, same call sites; only the adapter differs.

import {
  type KeyChord,
  type Platform,
  formatChord,
  hasNonShiftModifier,
  matchesChord,
} from "./chord";
import {
  ALL_COMMANDS,
  COMMAND_BY_ID,
  type CommandId,
  type KeybindingHost,
  vscodeCommandId,
} from "./commands";

export type KeybindingHandler = (event: KeyboardEvent) => void;

export interface KeybindingService {
  /** Resolved chord for a command on this host, or null when unbound. */
  binding(id: CommandId): KeyChord | null;
  /** Display hint for the resolved chord (e.g. "⌘⇧K"), or null when unbound. */
  hint(id: CommandId): string | null;
  /**
   * Attach behavior to a command. Returns a disposer. On host-delegated services
   * this is a no-op (the host dispatches) but is safe to call for uniformity.
   */
  register(id: CommandId, handler: KeybindingHandler): () => void;
  /** Feed a keydown event to the dispatcher. No-op on host-delegated services. */
  handleKeydown(event: KeyboardEvent): void;

  /** Override a command's binding (null = explicitly unbound). No-op when delegated. */
  setBinding(id: CommandId, chord: KeyChord | null): void;
  /** Drop the user override, reverting to the registry default. No-op when delegated. */
  resetBinding(id: CommandId): void;
  /** Whether this service can be edited in-app (true on desktop, false when delegated). */
  readonly editable: boolean;
  /** Suppress dispatch while the UI records a new chord. No-op when delegated. */
  beginRecording(): void;
  endRecording(): void;
}

/**
 * Persistence seam for user overrides. The default is in-memory; on desktop the
 * runtime backs it with `createAcpDbKeybindingStore`, which persists to the ACP
 * nav DB (`camber/acpNav/get|setKeybindings`) so edits survive restarts.
 * `null` means "explicitly unbound by the user".
 */
export interface KeybindingOverrideStore {
  get(id: CommandId): KeyChord | null | undefined;
  set(id: CommandId, chord: KeyChord | null): void;
  /** Drop the override so the registry default applies again. */
  clear(id: CommandId): void;
}

function inMemoryOverrideStore(): KeybindingOverrideStore {
  const map = new Map<CommandId, KeyChord | null>();
  return {
    get: (id) => map.get(id),
    set: (id, chord) => {
      map.set(id, chord);
    },
    clear: (id) => {
      map.delete(id);
    },
  };
}

interface DesktopOptions {
  platform: Platform;
  host?: KeybindingHost;
  overrides?: KeybindingOverrideStore;
  /** True when `target` is an editable element a bare-key chord should not steal. */
  isEditableTarget?: (target: EventTarget | null) => boolean;
}

function defaultIsEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

class DesktopKeybindingService implements KeybindingService {
  readonly editable = true;
  readonly #platform: Platform;
  readonly #host: KeybindingHost;
  readonly #overrides: KeybindingOverrideStore;
  readonly #isEditableTarget: (target: EventTarget | null) => boolean;
  readonly #handlers = new Map<CommandId, Set<KeybindingHandler>>();
  #recording = false;

  constructor(options: DesktopOptions) {
    this.#platform = options.platform;
    this.#host = options.host ?? "desktop";
    this.#overrides = options.overrides ?? inMemoryOverrideStore();
    this.#isEditableTarget = options.isEditableTarget ?? defaultIsEditableTarget;
  }

  binding(id: CommandId): KeyChord | null {
    const override = this.#overrides.get(id);
    if (override !== undefined) return override; // includes explicit null (unbound)
    return COMMAND_BY_ID.get(id)?.defaults[this.#host] ?? null;
  }

  hint(id: CommandId): string | null {
    const chord = this.binding(id);
    return chord ? formatChord(chord, this.#platform) : null;
  }

  register(id: CommandId, handler: KeybindingHandler): () => void {
    let handlers = this.#handlers.get(id);
    if (!handlers) {
      handlers = new Set();
      this.#handlers.set(id, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  setBinding(id: CommandId, chord: KeyChord | null): void {
    this.#overrides.set(id, chord);
  }

  resetBinding(id: CommandId): void {
    this.#overrides.clear(id);
  }

  beginRecording(): void {
    this.#recording = true;
  }

  endRecording(): void {
    this.#recording = false;
  }

  handleKeydown(event: KeyboardEvent): void {
    if (this.#recording) return; // the settings UI is capturing a new chord
    if (event.defaultPrevented) return;

    const editable = this.#isEditableTarget(event.target);
    for (const [id, handlers] of this.#handlers) {
      if (handlers.size === 0) continue;
      const chord = this.binding(id);
      if (!chord) continue;
      // Never steal plain typing inside inputs; modifier chords are still allowed.
      if (editable && !hasNonShiftModifier(chord)) continue;
      if (!matchesChord(event, chord, this.#platform)) continue;

      event.preventDefault();
      event.stopPropagation();
      for (const handler of handlers) handler(event);
      return;
    }
  }
}

interface DelegatedOptions {
  platform: Platform;
  host?: KeybindingHost;
  /** Host-resolved display hints, keyed by contributed command id (`camber.<id>`). */
  getHostHints: () => Record<string, string | undefined>;
}

class DelegatedKeybindingService implements KeybindingService {
  // Remapping happens in the host's keyboard-shortcuts editor, not in-app.
  readonly editable = false;
  readonly #platform: Platform;
  readonly #host: KeybindingHost;
  readonly #getHostHints: () => Record<string, string | undefined>;

  constructor(options: DelegatedOptions) {
    this.#platform = options.platform;
    this.#host = options.host ?? "vscode";
    this.#getHostHints = options.getHostHints;
  }

  binding(id: CommandId): KeyChord | null {
    // The authoritative binding lives in the host; the registry default is the
    // declared intent and is good enough for callers that need a chord.
    return COMMAND_BY_ID.get(id)?.defaults[this.#host] ?? null;
  }

  hint(id: CommandId): string | null {
    // Prefer the host-resolved hint (reflects user remaps in keybindings.json);
    // fall back to formatting our declared default.
    const hostHint = this.#getHostHints()[vscodeCommandId(id)];
    if (hostHint) return hostHint;
    const chord = this.binding(id);
    return chord ? formatChord(chord, this.#platform) : null;
  }

  register(): () => void {
    // The extension host dispatches via contributed keybindings; nothing to wire here.
    return () => {};
  }

  handleKeydown(): void {
    // Dispatch belongs to the host.
  }

  setBinding(): void {
    // Remapping is done in VS Code's keyboard-shortcuts editor.
  }

  resetBinding(): void {}
  beginRecording(): void {}
  endRecording(): void {}
}

export function createDesktopKeybindingService(options: DesktopOptions): KeybindingService {
  return new DesktopKeybindingService(options);
}

export function createDelegatedKeybindingService(options: DelegatedOptions): KeybindingService {
  return new DelegatedKeybindingService(options);
}

/**
 * Audit: warn about declarations that nothing wired (desktop only, where the
 * webview owns dispatch). Call once after the runtime has registered its
 * handlers. Intended for dev — gate the call behind your bundler's dev flag
 * (this library is bundler-agnostic and can't read a Vite-style env itself).
 */
export function auditUnwiredCommands(registeredIds: Iterable<CommandId>): void {
  const registered = new Set(registeredIds);
  for (const command of ALL_COMMANDS) {
    if (!command.hosts.includes("desktop")) continue;
    if (!command.defaults.desktop) continue;
    if (command.external) continue; // dispatched by a component, not the runtime
    if (!registered.has(command.id as CommandId)) {
      console.warn(
        `[keybindings] "${command.id}" has a desktop default (${command.defaults.desktop}) but no handler is registered. ` +
          `Call kb.register("${command.id}", ...) where its behavior lives.`,
      );
    }
  }
}
