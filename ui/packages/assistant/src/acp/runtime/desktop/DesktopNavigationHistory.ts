import type { DesktopSplitNavigationLocation } from "@camber/features/acp";
import type { DesktopView } from "./DesktopViewState.svelte";

export interface DesktopNavigationEntry {
  view: DesktopView;
  projectSettingsPath: string | null;
  conversationId: string | null;
  split?: DesktopSplitNavigationLocation;
}

export class DesktopNavigationHistory {
  #entries: DesktopNavigationEntry[];
  #index = 0;

  constructor(initialEntry: DesktopNavigationEntry) {
    this.#entries = [cloneEntry(initialEntry)];
  }

  get current(): DesktopNavigationEntry {
    return cloneEntry(this.#entries[this.#index]!);
  }

  get canGoBack(): boolean {
    return this.#index > 0;
  }

  get canGoForward(): boolean {
    return this.#index < this.#entries.length - 1;
  }

  record(entry: DesktopNavigationEntry): void {
    const current = this.#entries[this.#index]!;
    if (entriesEqual(current, entry)) return;

    // The split component reports its initial focused tab after a conversation
    // has already been recorded. Enrich that entry instead of creating a
    // second, visually identical stop in the stack.
    if (!current.split && entry.split && sameDestination(current, entry)) {
      this.#entries[this.#index] = cloneEntry(entry);
      return;
    }

    this.#entries = this.#entries.slice(0, this.#index + 1);
    this.#entries.push(cloneEntry(entry));
    this.#index += 1;
  }

  back(): DesktopNavigationEntry | undefined {
    if (!this.canGoBack) return undefined;
    this.#index -= 1;
    return this.current;
  }

  forward(): DesktopNavigationEntry | undefined {
    if (!this.canGoForward) return undefined;
    this.#index += 1;
    return this.current;
  }
}

function sameDestination(left: DesktopNavigationEntry, right: DesktopNavigationEntry): boolean {
  return (
    left.view === right.view &&
    left.projectSettingsPath === right.projectSettingsPath &&
    left.conversationId === right.conversationId
  );
}

function entriesEqual(left: DesktopNavigationEntry, right: DesktopNavigationEntry): boolean {
  return (
    sameDestination(left, right) &&
    left.split?.layoutKey === right.split?.layoutKey &&
    left.split?.surface === right.split?.surface &&
    left.split?.paneId === right.split?.paneId &&
    left.split?.tabId === right.split?.tabId
  );
}

function cloneEntry(entry: DesktopNavigationEntry): DesktopNavigationEntry {
  return {
    ...entry,
    split: entry.split ? { ...entry.split } : undefined,
  };
}
