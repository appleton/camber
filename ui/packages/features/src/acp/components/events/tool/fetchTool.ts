import type { ToolCall } from "../../../types";

// Titles that identify a fetch even when the agent does not tag the call with
// kind "fetch" (e.g. Camber reports `web_fetch` as kind "execute").
const FETCH_TITLES = new Set(["fetch", "web fetch", "fetch url", "fetch web page", "open page"]);

/**
 * Matches fetch tool calls from Codex and Camber ACP so they can render with a
 * dedicated header that surfaces the requested URL.
 *
 * Confirmed shapes (captured live via camberqa):
 * - Camber: kind "execute", title "web_fetch", rawInput `{ objective, url }`.
 * - Codex: kind "fetch", title "Opening: <url>", rawInput
 *   `{ action: { type: "open_page", url }, query }`. A plain web search arrives
 *   as kind "fetch" with no URL — that stays on the generic renderer.
 */
export function isFetchToolCall(tool: ToolCall): boolean {
  if (getFetchUrl(tool) == null) return false;
  if (tool.kind === "fetch") return true;
  return FETCH_TITLES.has(normalizeToolTitle(tool.title));
}

/** Extracts the target URL of a fetch tool call from its raw input. */
export function getFetchUrl(tool: ToolCall): string | undefined {
  const direct = asUrl(tool.rawInput);
  if (direct) return direct;

  const rawInput = asRecord(tool.rawInput);
  if (!rawInput) return;

  // Codex nests the target under `action` (e.g. { type: "open_page", url }).
  const action = asRecord(rawInput.action);

  for (const value of [
    rawInput.url,
    rawInput.uri,
    rawInput.href,
    rawInput.link,
    rawInput.address,
    action?.url,
    action?.uri,
    rawInput.query,
    firstArrayString(rawInput.urls),
  ]) {
    const url = asUrl(value);
    if (url) return url;
  }
}

/** Strips the scheme and trailing slash so the URL reads cleanly in the header. */
export function formatFetchUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function normalizeToolTitle(title: string | undefined): string {
  return (title ?? "").replace(/[_-]+/g, " ").trim().toLowerCase();
}

function asUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

function firstArrayString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return;
  return value.find((item): item is string => typeof item === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}
