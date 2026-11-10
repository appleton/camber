<script lang="ts">
  import type { Content } from "@agentclientprotocol/sdk";
  import type { WorkspaceFolder } from "@camber/rpc";
  import ContentRenderer from "../content/ContentRenderer.svelte";

  interface Props {
    content: Content;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { content, workspaceFolders = [] }: Props = $props();
</script>

<div class="flex flex-col gap-2 p-2">
  <ContentRenderer content={[content.content]} {workspaceFolders} />
</div>
