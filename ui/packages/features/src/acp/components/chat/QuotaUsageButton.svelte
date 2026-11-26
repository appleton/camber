<script lang="ts">
  import { createPopover, melt } from "@melt-ui/svelte";
  import { camberAcpQuotaRead } from "@camber/helperapi";
  import type { ACPQuotaBucket } from "@camber/helperapi/schemas";
  import { tick, untrack } from "svelte";
  import { getOptionalACPConnectionPoolContext } from "../../connectionPoolContext";
  import Gauge from "../ui/Gauge.svelte";

  interface Props {
    agentServer: string;
    hasSession: boolean;
    turnActive: boolean;
  }

  let { agentServer, hasSession, turnActive }: Props = $props();
  const connectionPool = getOptionalACPConnectionPoolContext();
  const gutter = 8;

  const {
    elements: { trigger, content },
    states: { open },
  } = createPopover({
    positioning: { placement: "top-end", strategy: "fixed", gutter },
  });

  let button = $state<HTMLButtonElement>();
  let popover = $state<HTMLDivElement>();
  let buckets = $state.raw<ACPQuotaBucket[]>([]);
  let loading = $state(false);
  let unavailable = $state(false);
  let lastRead = 0;
  const highestUsage = $derived(Math.max(0, ...buckets.map((bucket) => bucket.usedPercent)));
  const resetTimeFormat = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const percentFormat = new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  });

  $effect(() => {
    const sessionIdle = hasSession && !turnActive;
    if ($open || sessionIdle) {
      untrack(() => void refresh());
    }
  });

  async function refresh(): Promise<void> {
    if (loading || Date.now() - lastRead < 10_000) return;
    loading = true;
    unavailable = false;
    try {
      await connectionPool?.connect(agentServer);
      const result = await camberAcpQuotaRead({ agentServer });
      buckets = result.buckets ?? [];
      lastRead = Date.now();
    } catch {
      unavailable = true;
    } finally {
      loading = false;
      await tick();
      // In WebKit the portal can retain its original position as the rows load.
      if (button && popover?.dataset.side === "top") {
        const top = button.getBoundingClientRect().top - popover.offsetHeight - gutter;
        popover.style.top = `${Math.max(gutter, top)}px`;
      }
    }
  }

  function formatReset(reset: string | undefined): string | null {
    if (!reset) return null;
    const date = new Date(reset);
    return Number.isFinite(date.getTime()) ? resetTimeFormat.format(date) : null;
  }
</script>

<button
  use:melt={$trigger}
  bind:this={button}
  type="button"
  aria-label="Account usage"
  title="Account usage"
  data-testid="prompt-usage-button"
  class="text-psx-foreground-secondary hover:bg-psx-chrome-hover focus-visible:outline-psx-focus flex size-[22px] shrink-0 items-center justify-center rounded-full focus-visible:outline-2"
  class:bg-psx-chrome-hover={$open}
>
  <Gauge size={12} usedTokens={highestUsage} totalTokens={100} />
</button>

{#if $open}
  <div
    use:melt={$content}
    bind:this={popover}
    role="dialog"
    aria-label="Account usage"
    class="menu-surface prompt-menu-surface z-50 flex max-h-[50vh] w-64 max-w-[calc(100vw-1rem)] cursor-default flex-col gap-3 overflow-y-auto p-3"
  >
    <h2 class="text-psx-foreground-primary text-xs font-medium">Account usage</h2>
    {#each buckets as bucket}
      {@const reset = formatReset(bucket.resetsAt)}
      {@const percent = Math.max(0, Math.min(100, bucket.usedPercent))}
      <div class="flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between gap-2 text-xs">
          <span class="text-psx-foreground-primary">{bucket.label}</span>
          <span class="text-psx-foreground-secondary shrink-0 tabular-nums">
            {percentFormat.format(bucket.usedPercent / 100)} used
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={bucket.label}
          aria-valuenow={percent}
          class="bg-psx-foreground-secondary/15 h-1 overflow-hidden rounded-full"
        >
          <div
            class="h-full rounded-full bg-[var(--psx-accent,#007aff)]"
            style:width={`${percent}%`}
          ></div>
        </div>
        {#if reset}
          <span class="text-psx-foreground-secondary text-[11px]">Resets {reset}</span>
        {/if}
      </div>
    {:else}
      <p role="status" class="text-psx-foreground-secondary text-xs">
        {loading ? "Loading usage…" : "Account usage is unavailable."}
      </p>
    {/each}
    {#if unavailable && buckets.length > 0}
      <p role="status" class="text-psx-foreground-secondary text-xs">Couldn’t refresh usage.</p>
    {/if}
  </div>
{/if}
