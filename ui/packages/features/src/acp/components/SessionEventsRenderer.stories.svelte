<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SessionEvents from "./SessionEventsRenderer.svelte";
  import { events, storyWorkspaceFolders } from "./fixtures";
  import type { SessionEvent } from "../types";

  const { Story } = defineMeta({
    component: SessionEvents,
    args: {
      events,
      workspaceFolders: storyWorkspaceFolders,
    },
  });

  // A read tool followed by a single live "Thinking" — the one thought that is
  // still trailing while prompting. Expanding it pins it open.
  const liveThinking: SessionEvent[] = [
    {
      eventKind: "tool_call",
      toolCallId: "read-config",
      title: "Read config.ts",
      kind: "read",
      status: "completed",
    },
    {
      eventKind: "agent_thought",
      messageId: "t-live",
      content: [
        {
          type: "text",
          text: "Config looks good — now I'll update the build script and re-run the tests.",
        },
      ],
    },
  ];

  // A directory listing arrives with ACP kind "read", distinguished only by
  // `_meta.tool_name`. It should render as "List" with a folder glyph, while an
  // ordinary file read stays "Read" with a file glyph.
  const directoryListing: SessionEvent[] = [
    {
      eventKind: "tool_call",
      toolCallId: "list-root",
      title: "List `.`",
      kind: "read",
      status: "completed",
      rawInput: { path: "/repo/components" },
      _meta: { tool_name: "list_directory" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "read-utils",
      title: "Read utils.ts",
      kind: "read",
      status: "completed",
      rawInput: { path: "/repo/utils.ts" },
      _meta: { tool_name: "read" },
    },
  ];

  // A live turn in "grouped" streaming collapse: the finished reads fold into
  // one "Read 3 files" group, the interim message stays visible, and the
  // running command renders live below it.
  const streamingByKind: SessionEvent[] = [
    {
      eventKind: "user_message",
      messageId: "u-1",
      content: [{ type: "text", text: "Fix the failing auth tests" }],
    },
    {
      eventKind: "tool_call",
      toolCallId: "read-token",
      title: "Read token.go",
      kind: "read",
      status: "completed",
      rawInput: { path: "/repo/token.go" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "read-token-test",
      title: "Read token_test.go",
      kind: "read",
      status: "completed",
      rawInput: { path: "/repo/token_test.go" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "read-defaults",
      title: "Read defaults.go",
      kind: "read",
      status: "completed",
      rawInput: { path: "/repo/defaults.go" },
    },
    {
      eventKind: "agent_message",
      messageId: "m-mid",
      content: [
        {
          type: "text",
          text: "The default TTL changed to 30 minutes but the tests still assert 15 — updating them.",
        },
      ],
    },
    {
      eventKind: "tool_call",
      toolCallId: "run-tests",
      title: "exec_command: go test ./pkg/auth/...",
      kind: "execute",
      status: "in_progress",
      rawInput: { cmd: "go test ./pkg/auth/..." },
    },
  ];

  // Real Pool-agent shapes: MCP tools (`<server>__<tool>` in _meta.tool_name),
  // skills (tool_name "skill"), and shell all arrive as kind "execute" and are
  // told apart only by _meta.tool_name. In "grouped" streaming they fold into
  // their own category groups — "Used 2 MCP tools", "Used 2 skills",
  // "Ran 2 commands" — with mcp/skills/terminal icons, not one shell run.
  const mcpAndSkills: SessionEvent[] = [
    {
      eventKind: "user_message",
      messageId: "u-recon",
      content: [{ type: "text", text: "Do a quick recon" }],
    },
    {
      eventKind: "tool_call",
      toolCallId: "mcp-1",
      title: "camber-github__get_me",
      kind: "execute",
      status: "completed",
      _meta: { tool_name: "camber-github__get_me" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "mcp-2",
      title: "camber-github__list_issues",
      kind: "execute",
      status: "completed",
      _meta: { tool_name: "camber-github__list_issues" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "skill-1",
      title: "Skill: `pool-product-reference`",
      kind: "execute",
      status: "completed",
      rawInput: { name: "pool-product-reference" },
      _meta: { tool_name: "skill" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "skill-2",
      title: "Skill: `configure-sandbox`",
      kind: "execute",
      status: "completed",
      rawInput: { name: "configure-sandbox" },
      _meta: { tool_name: "skill" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "sh-1",
      title: "Print working directory: `pwd`",
      kind: "execute",
      status: "completed",
      rawInput: { cmd: "pwd" },
      _meta: { tool_name: "shell" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "sh-2",
      title: "Check git status: `git status`",
      kind: "execute",
      status: "completed",
      rawInput: { cmd: "git status" },
      _meta: { tool_name: "shell" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "mcp-live",
      title: "camber-github__get_me",
      kind: "execute",
      status: "in_progress",
      _meta: { tool_name: "camber-github__get_me" },
    },
  ];

  // Real codex-agent shapes: tool calls can arrive with NO `kind` and no
  // `_meta.tool_name` (e.g. `Tool: codex/list_mcp_resources`). They used to
  // render icon-less; now they fall back to a sparkles glyph. Agent-owned MCP
  // tools use a dotted `mcp.<server>.<tool>` title and get the MCP treatment.
  // The shell `pwd` still resolves to the terminal icon via `kind: "execute"`.
  const codexTools: SessionEvent[] = [
    {
      eventKind: "user_message",
      messageId: "u-codex",
      content: [{ type: "text", text: "List the available MCP resources" }],
    },
    {
      eventKind: "tool_call",
      toolCallId: "codex-1",
      title: "Tool: codex/list_mcp_resources",
      status: "completed",
      rawInput: { server: "codex", tool: "list_mcp_resources", arguments: {} },
    },
    {
      eventKind: "tool_call",
      toolCallId: "codex-2",
      title: "Tool: codex/list_mcp_resource_templates",
      status: "completed",
      rawInput: { server: "codex", tool: "list_mcp_resource_templates", arguments: {} },
    },
    {
      eventKind: "tool_call",
      toolCallId: "codex-3",
      title: "mcp.codex_apps.github.create_pull_request",
      kind: "execute",
      status: "failed",
      rawInput: { owner: "poolside", repo: "assistant", title: "Draft PR" },
    },
    {
      eventKind: "tool_call",
      toolCallId: "codex-4",
      title: "pwd",
      kind: "execute",
      status: "completed",
      rawInput: { command: ["/bin/zsh", "-lc", "pwd"] },
    },
  ];

  // A completed turn: the intermediate thought is dropped, leaving only the
  // tool call and the final assistant message (no "Thinking" rows).
  const completedTurn: SessionEvent[] = [
    {
      eventKind: "agent_thought",
      messageId: "t-1",
      content: [{ type: "text", text: "Planning the change." }],
    },
    {
      eventKind: "tool_call",
      toolCallId: "edit-index",
      title: "Edit index.html",
      kind: "edit",
      status: "completed",
    },
    {
      eventKind: "agent_message",
      messageId: "m-1",
      content: [{ type: "text", text: "Created index.html and wired up the entry point." }],
    },
  ];
</script>

<Story name="Default" />
<Story name="Live thinking" args={{ events: liveThinking, isPrompting: true }} />
<Story
  name="Directory listing vs file read"
  args={{ events: directoryListing, isPrompting: true }}
/>
<Story name="No thinking on completed turn" args={{ events: completedTurn, isPrompting: false }} />
<Story
  name="Streaming grouped collapse"
  args={{ events: streamingByKind, isPrompting: true, toolActivity: "grouped" }}
/>
<Story
  name="Streaming compact collapse"
  args={{ events: streamingByKind, isPrompting: true, toolActivity: "compact" }}
/>
<Story
  name="MCP and skills grouped"
  args={{ events: mcpAndSkills, isPrompting: true, toolActivity: "grouped" }}
/>
<Story name="MCP and skills settled" args={{ events: mcpAndSkills, isPrompting: false }} />
<Story
  name="Codex fallback icons"
  args={{ events: codexTools, isPrompting: true, toolActivity: "grouped" }}
/>
