<script lang="ts">
  import { EnvironmentProvider, LogProvider } from "@camber/components/providers";
  import type { WorkspaceFolder } from "@camber/rpc";
  import type { ToolCall } from "../../../types";
  import ToolCallComponent from "../ToolCall.svelte";

  interface Props {
    event: ToolCall;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { event, workspaceFolders = [] }: Props = $props();
</script>

<EnvironmentProvider name="test">
  <LogProvider onInfo={() => {}} onError={() => {}}>
    <ToolCallComponent {event} {workspaceFolders} />
  </LogProvider>
</EnvironmentProvider>
