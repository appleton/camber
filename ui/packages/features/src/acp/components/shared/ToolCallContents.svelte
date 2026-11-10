<script lang="ts">
  import type { ToolCall } from "../../types";
  import type { WorkspaceFolder } from "@camber/rpc";
  import ToolCallContentRenderer from "./ToolCallContentRenderer.svelte";
  import { CollapsibleContent } from "@camber/components/collapsible";

  interface Props {
    tool: ToolCall;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { tool, workspaceFolders = [] }: Props = $props();
  const hasDiff = $derived(tool.content?.some((content) => content.type === "diff") ?? false);
</script>

<CollapsibleContent class="relative flex flex-col gap-2" animated={!hasDiff}>
  {#each tool.content ?? [] as content, i (`${content.type}-${i}`)}
    <ToolCallContentRenderer {content} {workspaceFolders} />
  {/each}
</CollapsibleContent>
