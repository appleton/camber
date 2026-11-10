import type { WorkspaceFolder } from "@camber/rpc";
import type { Component } from "svelte";
import { isSubagentTool } from "../../../subagents";
import type { ToolCall } from "../../../types";
import CuaReplToolCall from "./CuaReplToolCall.svelte";
import ExecCommandToolCall from "./ExecCommandToolCall.svelte";
import FetchToolCall from "./FetchToolCall.svelte";
import ImageGenerationToolCall from "./ImageGenerationToolCall.svelte";
import McpToolCall from "./McpToolCall.svelte";
import ReadImageToolCall from "./ReadImageToolCall.svelte";
import ReadToolCall from "./ReadToolCall.svelte";
import SubagentToolCall from "./SubagentToolCall.svelte";
import ViewImageToolCall from "./ViewImageToolCall.svelte";
import WriteStdinToolCall from "./WriteStdinToolCall.svelte";
import { isCuaReplToolCall } from "./cuaReplTool";
import { isExecCommandToolCall } from "./execCommandTool";
import { isFetchToolCall } from "./fetchTool";
import { isImageGenerationToolCall } from "./imageGenerationTool";
import { isMcpToolCallOverride } from "./mcpTool";
import { isReadImageToolCall } from "./readImageTool";
import { isReadToolCall } from "./readTool";
import { isViewImageToolCall } from "./viewImageTool";
import { isWriteStdinToolCall } from "./writeStdinTool";

export type ToolOverrideProps = {
  event: ToolCall;
  workspaceFolders?: WorkspaceFolder[];
};

export type ToolOverride = {
  id: string;
  matches: (tool: ToolCall) => boolean;
  component: Component<ToolOverrideProps>;
};

export const toolOverrides: ToolOverride[] = [
  {
    id: "acp.subagent",
    matches: isSubagentTool,
    component: SubagentToolCall,
  },
  // Specific MCP renderers precede the generic connector-aware renderer.
  {
    id: "codex.cua_repl",
    matches: isCuaReplToolCall,
    component: CuaReplToolCall,
  },
  // Before kind-based overrides: the Pool agent reports MCP tools as "execute".
  {
    id: "acp.mcp",
    matches: isMcpToolCallOverride,
    component: McpToolCall,
  },
  {
    id: "acp.fetch",
    matches: isFetchToolCall,
    component: FetchToolCall,
  },
  {
    id: "codex.image_generation",
    matches: isImageGenerationToolCall,
    component: ImageGenerationToolCall,
  },
  {
    id: "codex.view_image",
    matches: isViewImageToolCall,
    component: ViewImageToolCall,
  },
  {
    id: "codex.exec_command",
    matches: isExecCommandToolCall,
    component: ExecCommandToolCall,
  },
  {
    id: "codex.write_stdin",
    matches: isWriteStdinToolCall,
    component: WriteStdinToolCall,
  },
  // Before acp.read so an image read renders its thumbnail instead of falling
  // through to the link-only read row.
  {
    id: "codex.read_image",
    matches: isReadImageToolCall,
    component: ReadImageToolCall,
  },
  {
    id: "acp.read",
    matches: isReadToolCall,
    component: ReadToolCall,
  },
];

export function findToolOverride(tool: ToolCall): ToolOverride | undefined {
  return toolOverrides.find((override) => override.matches(tool));
}
