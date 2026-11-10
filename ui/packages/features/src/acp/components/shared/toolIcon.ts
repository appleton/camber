import type { IconName, IconProps } from "@camber/components/icon";
import type { ToolCall } from "../../types";
import { isMcpToolCall, isSkillToolCall } from "../events/tool/toolCategory";
import { getToolPath, isDirectoryListing } from "./toolPaths";

function modeToIcon(rawInput: unknown): IconName {
  if (rawInput == null || typeof rawInput !== "object" || Array.isArray(rawInput)) return "code";

  const mode = (rawInput as Record<string, unknown>).mode;
  return mode === "plan" ? "plan" : "code";
}

export function getToolIcon(tool: ToolCall, iconPath?: string): IconName | IconProps {
  // Directory listings come through as ACP kind "read"; show a folder, not a
  // file glyph, so they read as listings rather than file reads.
  if (isDirectoryListing(tool)) return "folder";
  // MCP tools and skills also arrive as kind "other", which would otherwise fall
  // through to the shell "terminal" glyph; give them their own icons.
  if (isMcpToolCall(tool)) return "mcp";
  if (isSkillToolCall(tool)) return "skills";

  const path = getToolPath(tool);

  switch (tool.kind) {
    case "read":
    case "delete":
    case "move":
    case "edit":
      return path ? { type: "file", name: iconPath ?? path } : "file";
    case "search":
      return "search";
    case "execute":
      return "terminal";
    case "switch_mode":
      return modeToIcon(tool.rawInput);
    case "fetch":
      return "web";
    case "think":
      return "sparkles";
    case "other":
      return "terminal";
  }

  // Fallback so every tool row shows a glyph. Some agents (e.g. codex) send tool
  // calls with no `kind` at all, which would otherwise render icon-less.
  return "sparkles";
}
