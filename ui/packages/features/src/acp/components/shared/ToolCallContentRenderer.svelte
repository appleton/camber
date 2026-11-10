<script lang="ts">
  import type * as acp from "@agentclientprotocol/sdk";
  import type { WorkspaceFolder } from "@camber/rpc";
  import ToolDiffContent from "./ToolDiffContent.svelte";
  import ToolCallContent from "./ToolCallContent.svelte";

  interface Props {
    content: acp.ToolCallContent;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { content, workspaceFolders = [] }: Props = $props();
</script>

{#if content.type === "content"}
  <ToolCallContent {content} {workspaceFolders} />
{:else if content.type === "diff"}
  <ToolDiffContent diff={content} />
{/if}
