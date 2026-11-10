import type { AssistantTerminalTab, AssistantTerminalUpdate } from "@camber/rpc";
import { createContext } from "svelte";
import { rpc } from "../hostRpc";

type NoSetters<T> = { readonly [K in keyof T]: T[K] };

export type AssistantTerminalRepository = NoSetters<AssistantTerminalRepositoryWriter>;
export type AssistantTerminalCommandMode = "interactive" | "nonInteractive";
export type AssistantTerminalPlacement = "tab" | "splitRight" | "bottomPanel" | "mainTab";
export type AssistantTerminalOpener = (
  worktreePath: string,
  options?: {
    command?: string;
    env?: Record<string, string>;
    commandMode?: AssistantTerminalCommandMode;
    placement?: AssistantTerminalPlacement;
    layoutKey?: string;
    /**
     * Prefer replacing an existing terminal tab for the worktree on the target
     * surface (e.g. one restored from the default layout) over opening a second
     * tab. The command still runs in a fresh host-spawned shell — the existing
     * tab only lends its slot in the layout.
     */
    reuseExisting?: boolean;
    /**
     * Whether the terminal takes keyboard focus as it opens. False for
     * terminals the app opens on its own behalf (worktree setup), which must
     * become visible without pulling focus out of whatever the user is typing
     * into. Defaults to true.
     */
    focus?: boolean;
  },
) => Promise<AssistantTerminalTab | undefined>;

interface RunCommandAndWaitOptions {
  visible?: boolean;
  keepAliveAfterCommand?: boolean;
  reuseExisting?: boolean;
  placement?: AssistantTerminalPlacement;
  layoutKey?: string;
  /** See AssistantTerminalOpener's `focus`; only meaningful with `visible`. */
  focus?: boolean;
  onOutput?: (data: string) => void;
}

const MAX_BUFFER_LENGTH = 200_000;
const COMMAND_DONE_PREFIX = "\x1b]1337;CamberCommandDone=";
const COMMAND_DONE_RE = /\x1b]1337;CamberCommandDone=([^:\x07]+):(\d+)\x07/g;
// Terminal panes usually keep a stable size across sessions (the layout is
// restored), so the last measured size is a good guess at the spawn size for
// the next terminal. A shell spawned at the size its pane will actually have
// paints its first prompt at the right width, making the compensating startup
// clear (and its briefly visible `^L`) unnecessary. The size is a single
// global — in a split layout with differently sized panes, whichever pane
// resized last wins and a terminal opened in the other pane falls back to the
// (now silent) clear+repaint path.
const LAST_MEASURED_SIZE_STORAGE_KEY = "camber.assistantTerminal.lastMeasuredSize";

export interface AssistantTerminalSize {
  cols: number;
  rows: number;
}

function isValidSize(size: Partial<AssistantTerminalSize> | null | undefined): boolean {
  return (
    typeof size?.cols === "number" &&
    typeof size.rows === "number" &&
    Number.isFinite(size.cols) &&
    Number.isFinite(size.rows) &&
    size.cols > 0 &&
    size.rows > 0
  );
}

function readStoredMeasuredSize(): AssistantTerminalSize | null {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_MEASURED_SIZE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AssistantTerminalSize>;
    if (!isValidSize(parsed)) return null;
    return { cols: Math.floor(parsed.cols!), rows: Math.floor(parsed.rows!) };
  } catch {
    return null;
  }
}

function writeStoredMeasuredSize(size: AssistantTerminalSize): void {
  try {
    globalThis.localStorage?.setItem(LAST_MEASURED_SIZE_STORAGE_KEY, JSON.stringify(size));
  } catch {
    // Storage may be unavailable (private mode, quota); in-memory still works.
  }
}

export class AssistantTerminalRepositoryWriter {
  readonly emitter = new EventTarget();
  tabs = $state<AssistantTerminalTab[]>([]);
  activeTabByWorktree = $state<Record<string, string>>({});
  buffers = $state<Record<string, string>>({});
  bufferStartOffsets = $state<Record<string, number>>({});
  currentWorktreePath = $state("");
  private creatingForWorktree = new Set<string>();
  private exitWaiters = new Map<string, (exitCode?: number) => void>();
  private commandWaiters = new Map<
    string,
    { token: string; resolve: (exitCode?: number) => void }
  >();
  private commandResults = new Map<string, number>();
  private commandOutputListeners = new Map<string, (data: string) => void>();
  private pendingCommandTokens = new Set<string>();
  private partialCommandMarkers: Record<string, string> = {};
  private visibleTerminalOpeners = new Set<AssistantTerminalOpener>();
  // Size each newly created interactive terminal was spawned at. After its
  // first fit, the view compares the measured size against this and requests
  // a clear+repaint only when they differ — so the common case (pane size
  // matched) shows the first prompt untouched, with no `^L` flash from the
  // compensating Ctrl+L.
  private pendingInitialSpawnSizes = new Map<string, AssistantTerminalSize>();
  // Last size a terminal view actually measured (kept fresh by resize()).
  // Used as the spawn size for new interactive terminals so their first
  // prompt paints at the right width. Null only before any terminal has ever
  // been fitted on this machine.
  private lastMeasuredSize: AssistantTerminalSize | null = readStoredMeasuredSize();

  readonly activeTabs = $derived(
    this.tabs.filter((tab) => tab.worktreePath === this.currentWorktreePath),
  );
  readonly activeTabId = $derived(this.activeTabByWorktree[this.currentWorktreePath] ?? null);
  readonly activeTab = $derived(
    this.activeTabs.find((tab) => tab.id === this.activeTabId) ?? this.activeTabs[0] ?? null,
  );

  async setWorktreePath(worktreePath: string): Promise<void> {
    if (!worktreePath || this.currentWorktreePath === worktreePath) return;
    this.currentWorktreePath = worktreePath;
    await this.loadTabsForWorktree(worktreePath);
  }

  async ensureTabForWorktree(worktreePath: string): Promise<void> {
    if (!worktreePath) return;
    this.currentWorktreePath = worktreePath;
    const tabs = await this.loadTabsForWorktree(worktreePath);
    if (tabs.length > 0 || this.creatingForWorktree.has(worktreePath)) return;

    this.creatingForWorktree.add(worktreePath);
    try {
      const size = this.lastMeasuredSize;
      const tab = await rpc.createAssistantTerminal(
        worktreePath,
        undefined,
        undefined,
        undefined,
        undefined,
        size?.cols,
        size?.rows,
      );
      this.upsertTab(tab);
      // Without a measured size the host spawns at its 80x24 default, which
      // the first fit will almost certainly contradict, triggering the
      // clear+repaint fallback.
      this.pendingInitialSpawnSizes.set(tab.id, size ?? { cols: 80, rows: 24 });
      this.selectTab(tab.id);
    } finally {
      this.creatingForWorktree.delete(worktreePath);
    }
  }

  private async loadTabsForWorktree(worktreePath: string): Promise<AssistantTerminalTab[]> {
    const tabs = await rpc.listAssistantTerminals(worktreePath);
    const buffers = { ...this.buffers };
    const bufferStartOffsets = { ...this.bufferStartOffsets };
    for (const tab of tabs) {
      if (tab.buffer !== undefined) {
        buffers[tab.id] = tab.buffer;
        bufferStartOffsets[tab.id] = 0;
      }
      this.upsertTab(tab);
    }
    this.buffers = buffers;
    this.bufferStartOffsets = bufferStartOffsets;
    if (!this.activeTabByWorktree[worktreePath] && tabs[0]) {
      this.activeTabByWorktree = { ...this.activeTabByWorktree, [worktreePath]: tabs[0].id };
    }
    return this.tabs.filter((tab) => tab.worktreePath === worktreePath);
  }

  async createTab(
    worktreePath = this.currentWorktreePath,
    command?: string,
    env?: Record<string, string>,
    commandMode?: AssistantTerminalCommandMode,
    cwd?: string,
  ): Promise<AssistantTerminalTab | undefined> {
    if (!worktreePath) return undefined;
    const interactive = !command?.trim() && commandMode !== "nonInteractive";
    // Interactive shells spawn at the last measured pane size so the first
    // prompt paints at the right width; command runners keep the host default
    // (their tab has no pane to match yet, and non-interactive output does not
    // draw a prompt-at-the-wrong-width artifact worth clearing).
    const size = interactive ? this.lastMeasuredSize : null;
    const tab = await rpc.createAssistantTerminal(
      worktreePath,
      command,
      env,
      commandMode,
      cwd,
      size?.cols,
      size?.rows,
    );
    this.upsertTab(tab);
    if (interactive) {
      this.pendingInitialSpawnSizes.set(tab.id, size ?? { cols: 80, rows: 24 });
    }
    this.selectTab(tab.id);
    return tab;
  }

  selectTab(id: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    this.activeTabByWorktree = { ...this.activeTabByWorktree, [tab.worktreePath]: id };
  }

  setVisibleTerminalOpener(opener: AssistantTerminalOpener): () => void {
    this.visibleTerminalOpeners.add(opener);
    return () => {
      this.visibleTerminalOpeners.delete(opener);
    };
  }

  async deleteTab(id: string): Promise<void> {
    await rpc.deleteAssistantTerminal(id);
    this.removeTab(id);
  }

  write(id: string, data: string): Promise<void> {
    if (data.includes("\x03")) {
      this.finishCommandWaiter(id, undefined);
    }
    return rpc.writeAssistantTerminal(id, data);
  }

  async clear(id: string): Promise<void> {
    // Drop the replayable buffer first so the cleared state survives a re-render
    // or tab switch; the host then wipes its own buffer and redraws the prompt.
    this.buffers = { ...this.buffers, [id]: "" };
    this.bufferStartOffsets = { ...this.bufferStartOffsets, [id]: 0 };
    await rpc.clearAssistantTerminal(id);
  }

  resize(id: string, cols: number, rows: number): Promise<void> {
    // Every fit of a visible terminal refreshes the preferred spawn size for
    // the next terminal (and, via storage, for the next session).
    if (isValidSize({ cols, rows })) {
      this.lastMeasuredSize = { cols: Math.floor(cols), rows: Math.floor(rows) };
      writeStoredMeasuredSize(this.lastMeasuredSize);
    }
    return rpc.resizeAssistantTerminal(id, cols, rows);
  }

  terminalDidOpen(tab: AssistantTerminalTab): void {
    this.upsertTab(tab);
  }

  terminalDidUpdate(update: AssistantTerminalUpdate): void {
    let changed = false;
    this.tabs = this.tabs.map((tab) => {
      if (tab.id !== update.terminalId) return tab;
      changed = true;
      return {
        ...tab,
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.cwd !== undefined ? { cwd: update.cwd } : {}),
      };
    });
    if (changed) {
      this.emitTabsChanged();
    }
  }

  terminalDidWrite(terminalId: string, data: string): void {
    const commandOutputListener = this.commandOutputListeners.get(terminalId);
    data = this.stripCommandDoneMarkers(terminalId, data);
    if (!data) return;
    commandOutputListener?.(data);
    const previousBuffer = this.buffers[terminalId] ?? "";
    const previousStartOffset = this.bufferStartOffsets[terminalId] ?? 0;
    const nextBuffer = `${previousBuffer}${data}`;
    const trimmedLength = Math.max(0, nextBuffer.length - MAX_BUFFER_LENGTH);
    this.buffers = {
      ...this.buffers,
      [terminalId]: nextBuffer.slice(trimmedLength),
    };
    this.bufferStartOffsets = {
      ...this.bufferStartOffsets,
      [terminalId]: previousStartOffset + trimmedLength,
    };
  }

  terminalDidExit(terminalId: string, exitCode?: number): void {
    this.tabs = this.tabs.map((tab) => (tab.id === terminalId ? { ...tab, exitCode } : tab));
    this.emitTabsChanged();
    this.finishCommandWaiter(terminalId, exitCode);
    this.exitWaiters.get(terminalId)?.(exitCode);
  }

  terminalDidClose(terminalId: string): void {
    this.finishCommandWaiter(terminalId, undefined);
    this.exitWaiters.get(terminalId)?.(undefined);
    this.removeTab(terminalId);
  }

  /**
   * Called by the terminal view after its first fit, with the size the pane
   * actually measured. Returns true when the shell was spawned at a different
   * size, i.e. its already painted prompt is wrapped wrongly and the view
   * should request a clear+repaint. When the spawn size matched (the common
   * case now that terminals spawn at the last measured size), no clear — and
   * none of its `^L` echo flash — is needed.
   *
   * Called without a measured size, this behaves like the old API: the
   * pending entry is consumed and the clear is always requested.
   */
  consumeInitialResizeClear(id: string, measuredCols?: number, measuredRows?: number): boolean {
    const spawnSize = this.pendingInitialSpawnSizes.get(id);
    if (!spawnSize) return false;
    this.pendingInitialSpawnSizes.delete(id);
    if (measuredCols === undefined || measuredRows === undefined) return true;
    return spawnSize.cols !== measuredCols || spawnSize.rows !== measuredRows;
  }

  async closeWorktree(worktreePath: string): Promise<void> {
    await rpc.closeAssistantTerminalsForWorktree(worktreePath);
    this.removeTabsFor((tab) => tab.worktreePath === worktreePath);
  }

  async closeProject(projectPath: string): Promise<void> {
    await rpc.closeAssistantTerminalsForProject(projectPath);
    const prefix = projectPath.endsWith("/") ? projectPath : `${projectPath}/`;
    this.removeTabsFor(
      (tab) => tab.worktreePath === projectPath || tab.worktreePath.startsWith(prefix),
    );
  }

  async runCommandAndWait(
    worktreePath: string,
    command: string,
    signal?: AbortSignal,
    options?: RunCommandAndWaitOptions,
  ): Promise<number | undefined> {
    const token = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.pendingCommandTokens.add(token);
    const tab = await this.createCommandTab(
      worktreePath,
      commandWithDoneMarker(command, token, options?.keepAliveAfterCommand),
      options,
    );
    if (!tab) {
      this.pendingCommandTokens.delete(token);
      return undefined;
    }
    return await new Promise<number | undefined>((resolve) => {
      let settled = false;
      const onAbort = () => finish(undefined);
      const finish = (code?: number) => {
        if (settled) return;
        settled = true;
        this.pendingCommandTokens.delete(token);
        this.commandWaiters.delete(tab.id);
        this.exitWaiters.delete(tab.id);
        this.commandOutputListeners.delete(tab.id);
        signal?.removeEventListener("abort", onAbort);
        resolve(code);
      };
      if (options?.onOutput) {
        const bufferedOutput = this.buffers[tab.id];
        if (bufferedOutput) {
          options.onOutput(bufferedOutput);
        }
        this.commandOutputListeners.set(tab.id, options.onOutput);
      }
      const earlyResult = this.commandResults.get(token);
      if (earlyResult !== undefined) {
        this.commandResults.delete(token);
        finish(earlyResult);
        return;
      }
      if (signal?.aborted) {
        finish(undefined);
        return;
      }
      const currentTab = this.tabs.find((candidate) => candidate.id === tab.id);
      if (currentTab?.exitCode !== undefined) {
        finish(currentTab.exitCode);
        return;
      }
      this.commandWaiters.set(tab.id, { token, resolve: finish });
      this.exitWaiters.set(tab.id, finish);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async createCommandTab(
    worktreePath: string,
    command: string,
    options?: RunCommandAndWaitOptions,
  ): Promise<AssistantTerminalTab | undefined> {
    // Command tabs always use command-argument (`nonInteractive`) delivery so
    // the private completion wrapper is never echoed as terminal input.
    const visibleOpener = options?.visible ? this.currentVisibleTerminalOpener() : undefined;
    if (!visibleOpener) {
      return await this.createTab(worktreePath, command, undefined, "nonInteractive");
    }

    const tab = await visibleOpener(worktreePath, {
      command,
      commandMode: "nonInteractive",
      placement: options?.placement,
      layoutKey: options?.layoutKey,
      reuseExisting: options?.reuseExisting,
      focus: options?.focus,
    });
    if (tab) {
      this.upsertTab(tab);
      this.selectTab(tab.id);
    }
    return tab;
  }

  private currentVisibleTerminalOpener(): AssistantTerminalOpener | undefined {
    let current: AssistantTerminalOpener | undefined;
    for (const opener of this.visibleTerminalOpeners) {
      current = opener;
    }
    return current;
  }

  private stripCommandDoneMarkers(terminalId: string, data: string): string {
    const combined = `${this.partialCommandMarkers[terminalId] ?? ""}${data}`;
    delete this.partialCommandMarkers[terminalId];

    let stripped = combined.replace(COMMAND_DONE_RE, (_match, token: string, code: string) => {
      const exitCode = Number.parseInt(code, 10);
      const waiter = this.commandWaiters.get(terminalId);
      if (waiter?.token === token) {
        waiter.resolve(exitCode);
      } else if (this.pendingCommandTokens.has(token)) {
        this.commandResults.set(token, exitCode);
      }
      return "";
    });

    const markerStart = stripped.lastIndexOf(COMMAND_DONE_PREFIX);
    if (markerStart !== -1 && !stripped.slice(markerStart).includes("\x07")) {
      this.partialCommandMarkers[terminalId] = stripped.slice(markerStart);
      stripped = stripped.slice(0, markerStart);
    }

    return stripped;
  }

  private finishCommandWaiter(terminalId: string, exitCode?: number): void {
    const waiter = this.commandWaiters.get(terminalId);
    if (!waiter) return;
    waiter.resolve(exitCode);
  }

  private upsertTab(tab: AssistantTerminalTab): void {
    const { buffer: _buffer, ...tabWithoutBuffer } = tab;
    const tabs = this.tabs.filter((candidate) => candidate.id !== tab.id);
    this.tabs = [...tabs, tabWithoutBuffer].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    this.emitTabsChanged();
  }

  private removeTab(id: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === id);
    this.tabs = this.tabs.filter((candidate) => candidate.id !== id);
    const { [id]: _removedBuffer, ...buffers } = this.buffers;
    const { [id]: _removedBufferStartOffset, ...bufferStartOffsets } = this.bufferStartOffsets;
    this.buffers = buffers;
    this.bufferStartOffsets = bufferStartOffsets;
    delete this.partialCommandMarkers[id];
    this.pendingInitialSpawnSizes.delete(id);
    this.emitTabsChanged();
    if (!tab || this.activeTabByWorktree[tab.worktreePath] !== id) return;
    const next = this.tabs.find((candidate) => candidate.worktreePath === tab.worktreePath);
    this.activeTabByWorktree = { ...this.activeTabByWorktree, [tab.worktreePath]: next?.id ?? "" };
  }

  private removeTabsFor(predicate: (tab: AssistantTerminalTab) => boolean): void {
    const removed = new Set(this.tabs.filter(predicate).map((tab) => tab.id));
    this.tabs = this.tabs.filter((tab) => !removed.has(tab.id));
    this.buffers = Object.fromEntries(
      Object.entries(this.buffers).filter(([id]) => !removed.has(id)),
    );
    this.bufferStartOffsets = Object.fromEntries(
      Object.entries(this.bufferStartOffsets).filter(([id]) => !removed.has(id)),
    );
    for (const id of removed) {
      delete this.partialCommandMarkers[id];
      this.pendingInitialSpawnSizes.delete(id);
    }
    if (removed.size > 0) {
      this.emitTabsChanged();
    }
  }

  private emitTabsChanged(): void {
    this.emitter.dispatchEvent(new Event("tabsChanged"));
  }
}

function commandWithDoneMarker(
  command: string,
  token: string,
  keepAliveAfterCommand = false,
): string {
  const lines = [
    "(",
    command.trim(),
    ")",
    `printf '\\033]1337;CamberCommandDone=${token}:%s\\007' "$?"`,
  ];
  if (keepAliveAfterCommand) {
    lines.push('exec "${SHELL:-/bin/sh}"');
  }
  return lines.join("\n");
}

const [getAssistantTerminalContext, setAssistantTerminalRepositoryContext] =
  createContext<AssistantTerminalRepository>();

const ASSISTANT_TERMINAL_REPOSITORY_GLOBAL = Symbol.for("camber.assistantTerminalRepository");

type AssistantTerminalRepositoryGlobal = typeof globalThis & {
  [ASSISTANT_TERMINAL_REPOSITORY_GLOBAL]?: AssistantTerminalRepositoryWriter;
};

function globalAssistantTerminalRepository(): AssistantTerminalRepositoryWriter | undefined {
  return (globalThis as AssistantTerminalRepositoryGlobal)[ASSISTANT_TERMINAL_REPOSITORY_GLOBAL];
}

function setCurrentAssistantTerminalRepository(repo: AssistantTerminalRepositoryWriter): void {
  currentAssistantTerminalRepository = repo;
  (globalThis as AssistantTerminalRepositoryGlobal)[ASSISTANT_TERMINAL_REPOSITORY_GLOBAL] = repo;
}

let currentAssistantTerminalRepository =
  globalAssistantTerminalRepository() ?? new AssistantTerminalRepositoryWriter();
setCurrentAssistantTerminalRepository(currentAssistantTerminalRepository);

export { getAssistantTerminalContext };

export function setAssistantTerminalContext(): AssistantTerminalRepositoryWriter {
  const repo = new AssistantTerminalRepositoryWriter();
  setCurrentAssistantTerminalRepository(repo);
  setAssistantTerminalRepositoryContext(repo);
  return repo;
}

export { setAssistantTerminalRepositoryContext as _setAssistantTerminalContextForTests };

export function getAssistantTerminalRepo(): AssistantTerminalRepository {
  return getAssistantTerminalContext();
}

export function getCurrentAssistantTerminalRepo(): AssistantTerminalRepositoryWriter {
  return globalAssistantTerminalRepository() ?? currentAssistantTerminalRepository;
}
