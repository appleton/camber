<script lang="ts">
  import { CollapsibleContent } from "@camber/components/collapsible";
  import type { WorkspaceFolder } from "@camber/rpc";
  import type { ToolCall } from "../../../types";
  import ToolRoot from "../../shared/ToolRoot.svelte";
  import ToolBody from "../../shared/ToolBody.svelte";
  import ToolFooter from "../../shared/ToolFooter.svelte";
  import ToolCallContents from "../../shared/ToolCallContents.svelte";
  import FetchToolHeader from "./FetchToolHeader.svelte";
  import { getFetchUrl } from "./fetchTool";

  interface Props {
    event: ToolCall;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { event, workspaceFolders = [] }: Props = $props();

  let url = $derived(getFetchUrl(event) ?? event.title);
  let hasContent = $derived(!!event.content?.length);
  let rawOutput = $derived(stringify(event.rawOutput));
  let status = $derived.by(() => {
    if (event.status === "in_progress") return "fetching";
    if (event.status === "failed") return "failed";
  });

  function stringify(value: unknown): string | undefined {
    if (value == null) return;
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }
</script>

<ToolRoot tool={event} {workspaceFolders}>
  <FetchToolHeader {url} {status} />

  <ToolBody>
    {#if hasContent}
      <ToolCallContents tool={event} {workspaceFolders} />
    {:else if rawOutput}
      <CollapsibleContent class="relative flex max-w-full flex-col">
        <div
          class="border-psx-border bg-psx-panel font-(family-name:--editor-font-size) block min-h-4 overflow-auto rounded-md border px-2.5 py-2 text-sm"
        >
          <pre class="whitespace-pre-wrap break-all">{rawOutput}</pre>
        </div>
      </CollapsibleContent>
    {/if}
  </ToolBody>

  <ToolFooter />
</ToolRoot>
