<script lang="ts">
  import { EnvironmentProvider, LogProvider } from "@camber/components/providers";
  import type { ToolCall } from "../../../types";
  import ToolCallComponent from "../ToolCall.svelte";

  interface Props {
    event: ToolCall;
  }

  let { event }: Props = $props();
</script>

<EnvironmentProvider name="test">
  <LogProvider onInfo={() => {}} onError={() => {}}>
    <ToolCallComponent {event} />
  </LogProvider>
</EnvironmentProvider>
