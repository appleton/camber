<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { storyWorkspaceFolders } from "../fixtures";
  import ToolCall from "./ToolCall.svelte";

  const { Story } = defineMeta({
    component: ToolCall,
  });
</script>

<Story
  name="Read"
  args={{
    event: {
      eventKind: "tool_call",
      toolCallId: "call_001",
      title: "Read README.md",
      kind: "read",
      status: "completed",
      locations: [{ path: "/Users/poolie/camber/assistant/README.md" }],
      rawInput: { path: "/Users/poolie/camber/assistant/README.md" },
      rawOutput: { lines: 42 },
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "Read 42 lines from README.md",
          },
        },
      ],
    },
    workspaceFolders: storyWorkspaceFolders,
  }}
/>

<Story
  name="Fetch (Camber)"
  args={{
    event: {
      eventKind: "tool_call",
      toolCallId: "chatcmpl-tool-815a00fa7da849c0",
      title: "web_fetch",
      kind: "execute",
      status: "completed",
      rawInput: {
        objective: "Get the content of the ACP llms.txt file for a summary",
        url: "https://agentclientprotocol.com/llms.txt",
      },
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "# Agent Client Protocol\n\nThe Agent Client Protocol (ACP) standardizes communication between code editors and coding agents.",
          },
        },
      ],
    },
    workspaceFolders: storyWorkspaceFolders,
  }}
/>

<Story
  name="Fetch (Codex, in progress)"
  args={{
    event: {
      eventKind: "tool_call",
      toolCallId: "ws_03c67dff913208b4",
      title: "Opening: https://agentclientprotocol.com/llms.txt",
      kind: "fetch",
      status: "in_progress",
      rawInput: {
        action: { type: "open_page", url: "https://agentclientprotocol.com/llms.txt" },
        query: "https://agentclientprotocol.com/llms.txt",
      },
    },
    workspaceFolders: storyWorkspaceFolders,
  }}
/>

<!--
  Pool reports a delegated task as a plain tool call tagged `_meta.tool_name:
  "subagent"`, holds it at `pending` for the whole run, and only sends the
  child's final message when it finishes.
-->
<Story
  name="Subagent (Camber, running)"
  args={{
    event: {
      eventKind: "tool_call",
      toolCallId: "call_sub_001",
      title: "Subagent: Review the implementation plan in PLAN.md and report gaps",
      kind: "other",
      status: "pending",
      rawInput: {
        task: "Review the implementation plan in PLAN.md and report gaps as a bullet list.",
      },
      _meta: { tool_name: "subagent" },
    },
    workspaceFolders: storyWorkspaceFolders,
  }}
/>

<Story
  name="Subagent (Camber, completed)"
  args={{
    event: {
      eventKind: "tool_call",
      toolCallId: "call_sub_002",
      title: "Subagent: Review the implementation plan in PLAN.md and report gaps",
      kind: "other",
      status: "completed",
      rawInput: {
        task: "Review the implementation plan in PLAN.md and report gaps as a bullet list.",
      },
      rawOutput: { observation: "Reported three gaps." },
      _meta: { tool_name: "subagent" },
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "Three gaps in PLAN.md:\n\n- No rollback step for the schema migration\n- The cache invalidation section does not say who owns the key format\n- Load testing is listed but has no success criteria",
          },
        },
      ],
    },
    workspaceFolders: storyWorkspaceFolders,
  }}
/>
