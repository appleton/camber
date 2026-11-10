/**
 * Helpers for the @-menu file picker query language: paths starting with `/`,
 * `~/`, `./`, optionally surrounded by quotes, with the rest treated as a
 * fuzzy workspace search.
 *
 * Shared between helper search and client
 * (FilesMenu) so both sides classify the same string identically.
 */

export type QueryMode = "absolute" | "user" | "relative" | "fuzzy";

export interface ClassifiedQuery {
  mode: QueryMode;
  /** The query stripped of surrounding quotes (if any). */
  bare: string;
  /** True if the query started with `"`. */
  quoted: boolean;
  /** True when the query both starts and ends with `"`. */
  closedQuote: boolean;
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[/\\]/;
const UNC_PATH = /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/;
const TRAILING_SEPARATOR = /[/\\]$/;

function stripSurroundingQuotes(query: string): {
  bare: string;
  quoted: boolean;
  closedQuote: boolean;
} {
  let bare = query;
  let quoted = false;
  let closedQuote = false;
  if (bare.startsWith('"')) {
    quoted = true;
    bare = bare.slice(1);
    if (bare.endsWith('"')) {
      closedQuote = true;
      bare = bare.slice(0, -1);
    }
  }
  return { bare, quoted, closedQuote };
}

export function classifyQuery(
  query: string,
  options: { isWindows?: boolean } = {},
): ClassifiedQuery {
  const { bare, quoted, closedQuote } = stripSurroundingQuotes(query);
  if (bare.startsWith("/")) return { mode: "absolute", bare, quoted, closedQuote };
  if (options.isWindows && (WINDOWS_DRIVE_PATH.test(bare) || UNC_PATH.test(bare))) {
    return { mode: "absolute", bare, quoted, closedQuote };
  }
  if (bare === "~" || bare.startsWith("~/") || bare.startsWith("~\\")) {
    return { mode: "user", bare, quoted, closedQuote };
  }
  if (
    bare === "." ||
    bare === "./" ||
    bare === ".\\" ||
    bare.startsWith("./") ||
    bare.startsWith(".\\")
  ) {
    return { mode: "relative", bare, quoted, closedQuote };
  }
  return { mode: "fuzzy", bare, quoted, closedQuote };
}

export function hasTrailingPathSeparator(value: string): boolean {
  return TRAILING_SEPARATOR.test(value);
}

export function lastSeparatorIndex(value: string): number {
  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

/**
 * Separator-agnostic basename: works on both POSIX and Windows-style paths,
 * stripping any trailing separators first so a directory entry like
 * `~/Documents/` returns `Documents`.
 */
export function basename(value: string): string {
  const trimmed = value.replace(/[/\\]+$/, "");
  const idx = lastSeparatorIndex(trimmed);
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Path-join that doesn't double up separators when joining onto a root.
 * Picks the separator from `dir` when it has one, otherwise defaults to `/`.
 */
export function joinPath(dir: string, name: string): string {
  if (dir === "" || dir === ".") return name;
  if (dir === "/") return `/${name}`;
  if (dir === "\\") return `\\${name}`;
  if (hasTrailingPathSeparator(dir)) return `${dir}${name}`;
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir}${separator}${name}`;
}
