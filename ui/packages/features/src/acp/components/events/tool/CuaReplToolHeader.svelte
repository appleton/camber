<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import { CollapsibleTrigger } from "@camber/components/collapsible";
  import { getToolContext } from "../../shared/ToolRoot.svelte";

  let { title }: { title?: string } = $props();
  const context = getToolContext();
  const status = $derived.by(() => {
    if (context.tool.status === "failed") return "error";
    if (context.tool.status === "cancelled") return "cancelled";
  });
</script>

<div
  class="hover:bg-psx-background-secondary text-psx-foreground-secondary hover:text-psx-foreground-primary group relative isolate flex h-6 w-fit min-w-0 max-w-full cursor-pointer select-none items-center gap-1.5 self-start rounded-md text-xs transition-colors"
>
  <CollapsibleTrigger
    aria-label={context.open ? "Collapse computer use" : "Expand computer use"}
    appearance="plain"
    class="absolute inset-0 z-10"
  />
  <span class="flex w-4 shrink-0 items-center justify-center">
    {#if context.icon === "loading"}
      <Spinner aria-hidden size={12} class="shrink-0" />
    {:else}
      <Icon name="ide" size={14} class="shrink-0" />
    {/if}
  </span>
  <span class="shrink-0">Computer use</span>
  {#if title}
    <span class="min-w-0 truncate opacity-90" {title}>{title}</span>
  {/if}
  {#if status}
    <span class="shrink-0 uppercase opacity-80">{status}</span>
  {/if}
  <span class="ml-0.5 flex shrink-0 items-center text-current">
    <Icon
      name="chevron"
      class={[
        "shrink-0 transition-all",
        !context.open && "-rotate-90 opacity-0 group-hover:opacity-100",
      ]}
    />
  </span>
</div>
