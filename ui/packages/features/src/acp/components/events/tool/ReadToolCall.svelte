<script lang="ts">
  import type { WorkspaceFolder } from "@camber/rpc";
  import ToolRoot from "../../shared/ToolRoot.svelte";
  import ToolHeader from "../../shared/ToolHeader.svelte";
  import type { ToolCall } from "../../../types";

  interface Props {
    event: ToolCall;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { event, workspaceFolders = [] }: Props = $props();
</script>

<ToolRoot tool={event} {workspaceFolders}>
  <ToolHeader expandable={false} />
</ToolRoot>
