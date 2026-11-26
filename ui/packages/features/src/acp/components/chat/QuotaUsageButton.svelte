<script lang="ts">
  import { createPopover, melt } from "@melt-ui/svelte";
  import Icon from "@camber/components/icon";
  import { tick, untrack } from "svelte";
  import { getAccountQuota } from "../../accountQuota";
  import { getOptionalACPConnectionPoolContext } from "../../connectionPoolContext";
  import { rpc } from "../../hostRpc";
  import Gauge from "../ui/Gauge.svelte";

  interface Props {
    agentServer: string;
    hasSession: boolean;
    turnActive: boolean;
  }

  let { agentServer, hasSession, turnActive }: Props = $props();
  const connectionPool = getOptionalACPConnectionPoolContext();
  const gutter = 8;
  const usagePages: Partial<Record<string, string>> = {
    "claude-acp": "https://claude.ai/settings/usage",
    "codex-acp": "https://chatgpt.com/settings/usage?tab=overview",
  };
  const usagePage = $derived(usagePages[agentServer]);
  const quota = $derived(getAccountQuota(agentServer, connectionPool));

  const {
    elements: { trigger, content },
    states: { open },
  } = createPopover({
    positioning: { placement: "top-end", strategy: "fixed", gutter },
    openFocus: () => popover ?? null,
  });

  let button = $state<HTMLButtonElement>();
  let popover = $state<HTMLDivElement>();
  const buckets = $derived($quota.buckets ?? []);
  const availableResets = $derived($quota.availableResets ?? 0);
  let wasTurnActive = false;
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
    const turnEnded = wasTurnActive && !turnActive;
    wasTurnActive = turnActive;
    const accountQuota = quota;
    const sessionIdle = hasSession && !turnActive;
    if ($open || sessionIdle) {
      untrack(() => accountQuota.refresh(turnEnded));
    }
  });

  $effect(() => {
    $quota;
    if (!$open) return;
    void tick().then(() => {
      // In WebKit the portal can retain its original position as the rows load.
      if (button && popover?.dataset.side === "top") {
        const top = button.getBoundingClientRect().top - popover.offsetHeight - gutter;
        popover.style.top = `${Math.max(gutter, top)}px`;
      }
    });
  });

  function formatReset(reset: string | undefined): string | null {
    if (!reset) return null;
    const date = new Date(reset);
    return Number.isFinite(date.getTime()) ? resetTimeFormat.format(date) : null;
  }

  function openUsagePage(): void {
    if (!usagePage) return;
    open.set(false);
    void rpc.openExternalURL(usagePage);
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
    class="menu-surface prompt-menu-surface outline-hidden z-50 flex max-h-[50vh] w-64 max-w-[calc(100vw-1rem)] cursor-default flex-col gap-3 overflow-y-auto p-3"
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
        {$quota.loading ? "Loading usage…" : "Account usage is unavailable."}
      </p>
    {/each}
    {#if $quota.unavailable && buckets.length > 0}
      <p role="status" class="text-psx-foreground-secondary text-xs">Couldn’t refresh usage.</p>
    {/if}
    {#if usagePage}
      <div class="-mx-2 -mb-2">
        <div role="separator" class="menu-separator"></div>
        <button
          type="button"
          class="text-psx-foreground-primary hover:bg-psx-menu-hover-background focus-visible:bg-psx-menu-hover-background outline-hidden flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left"
          onclick={openUsagePage}
        >
          <span>
            {#if availableResets > 0}
              {availableResets.toLocaleString()}
              {availableResets === 1 ? "reset" : "resets"} available
            {:else}
              Manage usage
            {/if}
          </span>
          <Icon name="arrow-up-right" size={14} class="text-psx-icon shrink-0" aria-hidden="true" />
        </button>
      </div>
    {/if}
  </div>
{/if}
