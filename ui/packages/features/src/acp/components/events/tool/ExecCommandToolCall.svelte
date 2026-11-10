<script lang="ts">
  import { CollapsibleContent } from "@camber/components/collapsible";
  import { HighlightedShellCommand } from "@camber/components/assistant-ui";
  import ToolRoot from "../../shared/ToolRoot.svelte";
  import ToolBody from "../../shared/ToolBody.svelte";
  import ToolFooter from "../../shared/ToolFooter.svelte";
  import type { ToolCall } from "../../../types";
  import ExecCommandToolHeader from "./ExecCommandToolHeader.svelte";
  import { getExecCommand, getExecOutput } from "./execCommandTool";
  import type { WorkspaceFolder } from "@camber/rpc";

  interface Props {
    event: ToolCall;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { event, workspaceFolders = [] }: Props = $props();

  let command = $derived(getExecCommand(event) ?? "exec_command");
  let output = $derived(getExecOutput(event));
  let status = $derived.by(() => {
    if (event.status === "in_progress") return "running";
    if (event.status === "failed") return "failed";
  });
</script>

<ToolRoot tool={event} {workspaceFolders}>
  <ExecCommandToolHeader {command} {status} />

  <ToolBody>
    <CollapsibleContent class="relative flex max-w-full flex-col">
      <div class="border-psx-border bg-psx-panel overflow-hidden rounded-md border">
        <div
          class="border-psx-border font-(family-name:--editor-font-size) text-psx-foreground-primary border-b px-2.5 py-2 text-sm"
        >
          <pre class="whitespace-pre-wrap"><span class="text-psx-foreground-secondary select-none"
              >$ </span><HighlightedShellCommand {command} /></pre>
        </div>

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
