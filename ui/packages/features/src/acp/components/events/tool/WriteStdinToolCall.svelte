<script lang="ts">
  import { CollapsibleContent } from "@camber/components/collapsible";
  import ToolRoot from "../../shared/ToolRoot.svelte";
  import ToolBody from "../../shared/ToolBody.svelte";
  import ToolFooter from "../../shared/ToolFooter.svelte";
  import type { ToolCall } from "../../../types";
  import {
    getWriteStdinInput,
    getWriteStdinOutput,
    getWriteStdinSessionId,
  } from "./writeStdinTool";
  import WriteStdinToolHeader from "./WriteStdinToolHeader.svelte";

  interface Props {
    event: ToolCall;
  }

  let { event }: Props = $props();

  let sessionId = $derived(getWriteStdinSessionId(event));
  let input = $derived(getWriteStdinInput(event));
  let output = $derived(getWriteStdinOutput(event));
  let status = $derived.by(() => {
    if (event.status === "in_progress") return "receiving";
    if (event.status === "failed") return "failed";
  });
</script>

<ToolRoot tool={event}>
  <WriteStdinToolHeader {sessionId} {status} />

  <ToolBody>
    <CollapsibleContent class="relative flex max-w-full flex-col">
      <div class="border-psx-border bg-psx-panel overflow-hidden rounded-md border">
        {#if sessionId || input}
          <div
            class="border-psx-border font-(family-name:--editor-font-size) text-psx-foreground-primary border-b px-2.5 py-2 text-sm"
          >
            {#if sessionId}
              <pre class="whitespace-pre-wrap"><span
                  class="text-psx-foreground-secondary select-none"
                  >session </span>{sessionId}</pre>
            {/if}
            {#if input}
              <pre class="mt-1 whitespace-pre-wrap break-all"><span
                  class="text-psx-foreground-secondary select-none"
                  >stdin </span>{input}</pre>
            {/if}
          </div>
        {/if}

        {#if output}
          <div
            class="font-(family-name:--editor-font-size) text-psx-foreground-secondary max-h-80 overflow-auto px-2.5 py-2 text-sm"
          >
            <pre class="whitespace-pre-wrap break-all">{output}</pre>
          </div>
        {:else}
          <div class="text-psx-foreground-secondary px-2.5 py-2 text-xs">No output</div>
        {/if}
      </div>
    </CollapsibleContent>
  </ToolBody>

  <ToolFooter />
</ToolRoot>
