import { commonPrefix, commonSuffix } from "@camber/lib/string";
import * as levenshtein from "fastest-levenshtein";
import { diffChars, type DiffCharsOptions } from "../diffChars.js";
import { diffWords } from "../diffWords.js";

/**
 * Trim a pair of strings to their differing "window" by removing any
 * common prefix and suffix. Returns just the differing middle sections.
 */
function trimWindow(oldValue: string, newValue: string) {
  const prefix = commonPrefix(oldValue, newValue);
  const oldTrimmed = oldValue.slice(prefix.length);
  const newTrimmed = newValue.slice(prefix.length);
  const suffix = commonSuffix(oldTrimmed, newTrimmed);
  const oldMid = oldTrimmed.slice(0, oldTrimmed.length - suffix.length);
  const newMid = newTrimmed.slice(0, newTrimmed.length - suffix.length);
  return { oldMid, newMid };
}

/** Maximum absolute edit size considered "tiny". */
const SMALL_EDIT_ABS = 2;
/** Maximum relative edit size (as a fraction of window length) considered "tiny". */
const SMALL_EDIT_REL = 0.25;
/** Maximum window length allowed for char-level diffs. */
const WINDOW_LEN_CEILING = 32;

/**
 * Decide whether to use character-level diff for a change.
 *
 * Returns true if the edit is small enough (absolute or relative)
 * and the differing window length is within the ceiling. This is
 * useful for typos, punctuation tweaks, and other small changes
 * where char-level is more readable.
 */
function shouldUseCharChanges(oldValue: string, newValue: string): boolean {
  if (oldValue === newValue) return false;

  const { oldMid, newMid } = trimWindow(oldValue, newValue);
  if (!oldMid && !newMid) return false;

  const maxLen = Math.max(oldMid.length, newMid.length) || 1;
  const distance = levenshtein.distance(oldMid, newMid);

  const smallAbsolute = distance <= SMALL_EDIT_ABS;
  const smallRelative = distance / maxLen <= SMALL_EDIT_REL;

  return (smallAbsolute || smallRelative) && maxLen <= WINDOW_LEN_CEILING;
}

function isWhitespaceOnlyChange(oldValue: string, newValue: string) {
  return oldValue !== newValue && oldValue.replace(/\s+/g, "") === newValue.replace(/\s+/g, "");
}

/**
 * Compute inner (within-line) diff between two strings.
 *
 * Rules:
 * - If only whitespace changed → use char-level for precision.
 * - Else if the edit is a tiny localized change → use char-level.
 * - Otherwise → use word-level for readability.
 */
export function diffText(oldStr: string, newStr: string, options: DiffCharsOptions) {
  if (isWhitespaceOnlyChange(oldStr, newStr)) {
    return diffChars(oldStr, newStr, options);
  }

  return shouldUseCharChanges(oldStr, newStr)
    ? diffChars(oldStr, newStr, options)
    : diffWords(oldStr, newStr, options);
}
