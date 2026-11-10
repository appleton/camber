import type { ToolCall } from "../../../types";
import { findConnectorCatalogEntry, type ConnectorCatalogEntry } from "../../mcp/connectorCatalog";
import { isPermissionDeniedToolCall } from "../../shared/toolStatus";
import { getMcpToolName, isMcpToolCall } from "./toolCategory";

export type McpToolInfo = {
  serverName: string;
  toolName: string;
  /** Catalog entry when the server is one of our curated connectors. */
  connector?: ConnectorCatalogEntry;
};

/**
 * MCP tool calls get the connector-aware override, except permission denials,
 * which keep the generic denied treatment (auto-open body + observation).
 */
export function isMcpToolCallOverride(tool: ToolCall): boolean {
  return isMcpToolCall(tool) && !isPermissionDeniedToolCall(tool);
}

/**
 * Agent namespaces stripped before the server/tool split. Claude Code prefixes
 * every MCP tool with "mcp__"; the Pool agent re-registers client-injected
 * servers (our connectors) as `camber__agent__<name>`, so their tools arrive
 * as `camber__agent__<name>__<tool>`. Pool's own built-in servers
 * (e.g. "camber-github") carry no prefix.
 */
const AGENT_NAMESPACE_PREFIXES = ["mcp__", "camber__agent__"];

/**
 * Server/tool split of an MCP tool call's namespaced name (see
 * {@link isMcpToolCall}). Metadata names use "__" separators; agent-owned MCP
 * titles use `mcp.<server>.<tool>`, with the last dot separating the tool so
 * nested server namespaces remain intact. Dotted server namespaces are matched
 * against progressively shorter suffixes in the connector catalog, so
 * `codex_apps.github` resolves to the `github` connector.
 *
 * When the server is one of our curated connectors the catalog entry is
 * attached, so the header can show the connector's label and service icon;
 * catalog installs keep `name === id` (see connectorCatalog), which is what
 * makes the name-based lookup reliable.
 */
export function getMcpToolInfo(tool: ToolCall): McpToolInfo | undefined {
  const name = getMcpToolName(tool);
  if (!name) return;

  if (name.toLowerCase().startsWith("mcp.")) {
    const namespaced = name.slice("mcp.".length);
    const separator = namespaced.lastIndexOf(".");
    if (separator <= 0) return;
    const serverName = namespaced.slice(0, separator);
    return buildMcpToolInfo(
      serverName,
      namespaced.slice(separator + 1),
      findDottedServerConnector(serverName),
    );
  }

  const prefix = AGENT_NAMESPACE_PREFIXES.find((candidate) => name.startsWith(candidate));
  const namespaced = prefix ? name.slice(prefix.length) : name;
  const separator = namespaced.indexOf("__");
  if (separator <= 0) return;
  return buildMcpToolInfo(namespaced.slice(0, separator), namespaced.slice(separator + 2));
}

function buildMcpToolInfo(
  serverName: string,
  toolName: string,
  connector = findConnectorCatalogEntry({ name: serverName }),
): McpToolInfo | undefined {
  if (!serverName || !toolName) return;
  return {
    serverName,
    toolName,
    connector,
  };
}

/**
 * Agent-owned MCP names can prefix the provider with an internal namespace
 * (`codex_apps.github`). Prefer the most specific catalog match, then peel
 * namespace segments from the left. Agent identifiers also commonly replace
 * hyphens with underscores, so try that tool-safe spelling as an alias.
 */
function findDottedServerConnector(serverName: string): ConnectorCatalogEntry | undefined {
  const segments = serverName.split(".");
  for (let start = 0; start < segments.length; start += 1) {
    const candidate = segments.slice(start).join(".");
    const exact = findConnectorCatalogEntry({ name: candidate });
    if (exact) return exact;

    const hyphenated = candidate.replaceAll("_", "-");
    if (hyphenated !== candidate) {
      const alias = findConnectorCatalogEntry({ name: hyphenated });
      if (alias) return alias;
    }
  }
}

/**
 * Pretty-print a JSON payload: objects are re-stringified with indentation,
 * strings are parsed first so a serialized MCP result renders structured.
 * Returns undefined when the value isn't JSON, so callers can fall back to
 * plain text (and skip JSON highlighting).
 */
export function prettyPrintJson(value: unknown): string | undefined {
  if (value == null) return;
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return;
  }
}
