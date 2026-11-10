/**
 * Keydown decision logic for the file picker.
 *
 * `decideFilePickerAction` takes a key event plus a snapshot of the menu's
 * state and returns the next action the host should take. Keeping it pure
 * lets us unit-test the matrix of cases (open quote, parent control,
 * directory drill-in, no-match row) without rendering the menu.
 *
 * TODO: the actual listener still lives on `document` with capture
 * — see FilesMenu.svelte. Migrating to a ProseMirror keymap plugin attached
 * to the editor is the next step; this module is shaped to slot into either.
 */
import type { ClassifiedQuery } from "@camber/lib/path-query";
import type { FileLike } from "./pathRewrites.js";
import { isExactSingleMatch } from "./pathRewrites.js";

export type SelectedControl = "parent" | "no-match" | null;

export interface KeyboardSnapshot {
  query: ClassifiedQuery;
  files: FileLike[];
  selectedFile: FileLike | null;
  selectedControl: SelectedControl;
  hasParentControl: boolean;
  hasSelectedAction: boolean;
  searchComplete: boolean;
}

export type FilePickerAction =
  /** Don't intercept: let normal editor / popup handling take over. */
  | { kind: "passthrough" }
  /** Stop here without doing anything (no-match Tab/Enter swallow). */
  | { kind: "noop" }
  /** The user closed an open `"`-quote with the matching `"`. */
  | { kind: "close-quote" }
  /** Same as close-quote, but the existing selectedAction should fire too. */
  | { kind: "close-quote-and-action" }
  /** Empty open-quoted query that the user terminated with Space/Tab/Enter/Esc. */
  | { kind: "rewrite-and-close"; suffix: string }
  /** Tab/Enter on the `..` parent control. */
  | { kind: "navigate-to-parent" }
  /** Tab/Enter on a directory hit in folder mode. */
  | { kind: "navigate-into"; file: FileLike };

const TERMINAL_KEYS = new Set([" ", "Tab", "Enter", "Escape"]);

export function decideFilePickerAction(
  event: KeyboardEvent,
  snapshot: KeyboardSnapshot,
): FilePickerAction {
  const {
    query,
    files,
    selectedFile,
    selectedControl,
    hasParentControl,
    hasSelectedAction,
    searchComplete,
  } = snapshot;
  const openQuoted = query.quoted && !query.closedQuote;

  if (event.key === "Tab" && event.shiftKey) {
    return hasParentControl ? { kind: "navigate-to-parent" } : { kind: "passthrough" };
  }

  if (openQuoted) {
    if (event.key === '"') {
      if (isExactSingleMatch(query, files) && hasSelectedAction) {
        return { kind: "close-quote-and-action" };
      }
      return { kind: "close-quote" };
    }
    if (files.length === 0 && searchComplete && TERMINAL_KEYS.has(event.key)) {
      return { kind: "rewrite-and-close", suffix: event.key === " " ? " " : "" };
    }
  }

  if ((event.key === "Tab" || event.key === "Enter") && selectedControl === "parent") {
    return { kind: "navigate-to-parent" };
  }

  if ((event.key === "Tab" || event.key === "Enter") && selectedControl === "no-match") {
    return { kind: "noop" };
  }

  if (event.key !== "Tab" && event.key !== "Enter") return { kind: "passthrough" };
  if (!selectedFile?.isDirectory) return { kind: "passthrough" };
  if (query.mode === "fuzzy") return { kind: "passthrough" };

  return { kind: "navigate-into", file: selectedFile };
}
