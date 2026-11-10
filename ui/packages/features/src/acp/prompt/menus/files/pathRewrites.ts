/**
 * Pure transformations behind the file-picker's path-aware queries.
 *
 * These helpers don't touch the editor or DOM — they take a query, a file,
 * or a decoration's text and return the next text/state. The Svelte
 * component dispatches the resulting transactions; the logic is unit-tested
 * in isolation here.
 */
import {
  basename,
  type ClassifiedQuery,
  hasTrailingPathSeparator,
  lastSeparatorIndex,
} from "@camber/lib/path-query";

export interface FileLike {
  path: string;
  isDirectory?: boolean;
  displayPath?: string;
  navigationPath?: string;
}

export function isWindowsOperatingSystem(operatingSystem?: string): boolean {
  return operatingSystem === "win32";
}

/** Pick the separator already used in the query, falling back to the path. */
export function preferredSeparator(query: string, fallbackPath: string): "/" | "\\" {
  const last = lastSeparatorIndex(query);
  if (last >= 0) return query[last] === "\\" ? "\\" : "/";
  if (fallbackPath.includes("\\") && !fallbackPath.includes("/")) return "\\";
  return "/";
}

/** The "context" portion of `bare` — i.e. the directory part the user is editing. */
export function folderContextQuery(bare: string): string {
  if (hasTrailingPathSeparator(bare)) return bare;
  const index = lastSeparatorIndex(bare);
  if (index >= 0) return bare.slice(0, index + 1);
  if (bare === "~") return "~/";
  if (bare === ".") return "./";
  return bare;
}

/** Strips the trailing segment off `folderContextQuery`, yielding the parent's query. */
export function parentQuery(bare: string): string {
  const context = folderContextQuery(bare);
  const trimmed = context.replace(/[/\\]+$/, "");
  const index = lastSeparatorIndex(trimmed);
  if (index < 0) return context;
  return trimmed.slice(0, index + 1);
}

/**
 * Compute the navigation target string when the user drills into a directory
 * (Tab on a folder hit). Preserves the `~/` and `./` shorthands they typed
 * and falls back to the absolute path otherwise.
 */
export function navigationTarget(query: ClassifiedQuery, file: FileLike): string {
  const { mode, bare, quoted } = query;
  if (file.navigationPath) {
    return replacementQuery(file.navigationPath, query);
  }

  const separator = preferredSeparator(bare, file.path);

  let navTarget: string;
  if (mode === "user") {
    const prefix = bare === "~" ? `~${separator}` : bare.slice(0, lastSeparatorIndex(bare) + 1);
    navTarget = `${prefix}${basename(file.path)}${separator}`;
  } else if (mode === "relative") {
    const prefix =
      bare === "." || bare === "./" || bare === ".\\"
        ? `.${separator}`
        : bare.slice(0, lastSeparatorIndex(bare) + 1);
    navTarget = `${prefix}${basename(file.path)}${separator}`;
  } else {
    navTarget = hasTrailingPathSeparator(file.path) ? file.path : `${file.path}${separator}`;
  }

  // Wrap in quotes if any segment in the resulting path contains a space (or
  // the user already opted into quoted mode). Leave the closing quote off so
  // the cursor sits inside, ready for further navigation/typing.
  const needsQuotes = quoted || /\s/.test(navTarget);
  return needsQuotes ? `"${navTarget}` : navTarget;
}

/** The text to put back into the query when replacing the typed query. */
export function replacementQuery(queryText: string, query: ClassifiedQuery): string {
  const needsQuotes = query.quoted || /\s/.test(queryText);
  return needsQuotes ? `"${queryText}` : queryText;
}

function normalizeComparablePath(value: string): string {
  return value.replace(/[/\\]+$/, "").replaceAll("\\", "/");
}

/**
 * True when there's exactly one file hit and it matches the user's query
 * verbatim (path or displayPath). Used to decide whether the closing `"`
 * should commit-and-close or just close.
 */
export function isExactSingleMatch(query: ClassifiedQuery, files: FileLike[]): boolean {
  if (files.length !== 1) return false;
  const file = files[0];
  const candidates = [file.path, file.displayPath].filter((p): p is string => !!p);
  const normalizedBare = normalizeComparablePath(query.bare);
  return candidates.some((candidate) => normalizeComparablePath(candidate) === normalizedBare);
}
