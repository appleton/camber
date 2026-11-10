<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import { CollapsibleTrigger } from "@camber/components/collapsible";
  import { getToolContext } from "../../shared/ToolRoot.svelte";
  import { formatFetchUrl } from "./fetchTool";

  interface Props {
    url: string;
    status?: string;
  }

  let { url, status }: Props = $props();

  const context = getToolContext();
  const displayUrl = $derived(formatFetchUrl(url));
</script>

<div
  class="hover:bg-psx-background-secondary text-psx-foreground-secondary hover:text-psx-foreground-primary group relative isolate flex h-6 w-fit min-w-0 max-w-full cursor-pointer select-none items-center gap-1.5 self-start rounded-md text-xs transition-colors"
>
  <!-- Single full-area click target so the whole row toggles, including the
       gaps between icon/label/chevron. -->
  <CollapsibleTrigger
    aria-label={context.open ? "Collapse fetch" : "Expand fetch"}
    appearance="plain"
    class="absolute inset-0 z-10"
  />

  <span class="flex w-4 shrink-0 items-center justify-center">
    {#if context.icon === "loading"}
      <Spinner aria-hidden size={12} class="shrink-0" />
    {:else}
      <Icon name="web" size={14} class="shrink-0" />
    {/if}
  </span>

  <span class="text-auto flex min-w-0 items-baseline gap-1.5 text-current">
    <span class="shrink-0">Fetch</span>
    <span
      class="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono opacity-90"
    >
      {displayUrl}
    </span>
  </span>

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
