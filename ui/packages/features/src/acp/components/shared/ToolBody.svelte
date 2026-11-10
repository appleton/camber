<script lang="ts">
  import type { Snippet } from "svelte";
  import { CollapsibleContent } from "@camber/components/collapsible";
  import { getToolContext } from "./ToolRoot.svelte";
  import { isPermissionDeniedToolCall } from "./toolStatus";

  interface Props {
    children?: Snippet;
  }

  let { children }: Props = $props();

  const context = getToolContext();
  const showRawFailure = $derived(
    context.tool.status === "failed" &&
      context.tool.rawOutput &&
      !isPermissionDeniedToolCall(context.tool),
  );
</script>

{#if children || showRawFailure}
  {#if showRawFailure && !children}
    <CollapsibleContent>
      <div
        class="border-psx-border bg-psx-panel text-psx-foreground-secondary overflow-auto rounded-md border px-2.5 py-2"
      >
        <pre class="whitespace-pre-wrap break-all">{JSON.stringify(
            context.tool.rawOutput,
            null,
            2,
          )}</pre>
      </div>
    </CollapsibleContent>
  {:else}
    {@render children?.()}
  {/if}
{/if}
