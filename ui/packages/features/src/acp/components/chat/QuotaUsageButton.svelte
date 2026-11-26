<script lang="ts">
  import { createPopover, melt } from "@melt-ui/svelte";
  import Icon from "@camber/components/icon";
  import { onDestroy, tick, untrack } from "svelte";
  import { get } from "svelte/store";
  import { getAccountQuota } from "../../accountQuota";
  import { getOptionalACPConnectionPoolContext } from "../../connectionPoolContext";
  import { appState } from "../../hostAdapter";
  import { rpc } from "../../hostRpc";
  import Gauge from "../ui/Gauge.svelte";
  import { supportsNativeMenus } from "./desktopContextMenu";
  import {
    closeDesktopQuotaPopover,
    showDesktopQuotaPopover,
    updateDesktopQuotaPopover,
    type DesktopQuotaPopoverContent,
  } from "./desktopQuotaPopover";

  interface Props {
    agentServer: string;
    hasSession: boolean;
    turnActive: boolean;
  }

  let { agentServer, hasSession, turnActive }: Props = $props();
  const connectionPool = getOptionalACPConnectionPoolContext();
  const gutter = 8;
  const buttonClass =
    "text-psx-foreground-secondary hover:bg-psx-chrome-hover focus-visible:outline-psx-focus flex size-[22px] shrink-0 items-center justify-center rounded-full focus-visible:outline-2";
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
    closeFocus: () => button ?? null,
    onOpenChange: ({ next }) => {
      if (!next) htmlFallback = false;
      return next;
    },
  });

  let button = $state<HTMLButtonElement>();
  let popover = $state<HTMLDivElement>();
  const buckets = $derived($quota.buckets ?? []);
  type QuotaSnapshot = typeof $quota;
  const usageLinkLabel = $derived(formatUsageLinkLabel($quota.availableResets));
  const usageMessage = $derived(formatUsageMessage($quota));
  let htmlFallback = $state(false);
  let nativeOpen = $state.raw<{
    id: string;
    source: typeof quota;
    initial: QuotaSnapshot;
    page: string | undefined;
  }>();
  const useNative = $derived(supportsNativeMenus($appState.environment) && !htmlFallback);
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    if (nativeOpen) void closeDesktopQuotaPopover(nativeOpen.id).catch(() => {});
  });
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

  $effect(() => {
    const pending = nativeOpen;
    if (!pending || pending.source !== quota || $quota === pending.initial || $quota.loading)
      return;
    const content = nativeContent($quota, pending.page);
    void updateDesktopQuotaPopover(pending.id, content).catch(() => {
      // Presentation errors are handled by the open request.
    });
  });

  async function openNativePopover(): Promise<void> {
    const anchor = button;
    if (nativeOpen || !anchor?.isConnected) return;
    const source = quota;
    const page = usagePage;
    source.refresh();
    const initial = get(source);
    const id = crypto.randomUUID();
    nativeOpen = { id, source, initial, page };
    try {
      const { x, y, width, height } = anchor.getBoundingClientRect();
      const selected = await showDesktopQuotaPopover({
        id,
        anchor: { x, y, width, height },
        content: nativeContent(initial, page),
      });
      if (selected && page && !destroyed) void rpc.openExternalURL(page);
    } catch {
      if (destroyed || !anchor.isConnected) return;
      htmlFallback = true;
      await tick();
      if (!destroyed) open.set(true);
    } finally {
      nativeOpen = undefined;
    }
  }

  function nativeContent(
    snapshot: QuotaSnapshot,
    page: string | undefined,
  ): DesktopQuotaPopoverContent {
    return {
      buckets: (snapshot.buckets ?? []).map((bucket) => {
        const reset = formatReset(bucket.resetsAt);
        return {
          label: bucket.label,
          usedPercent: bucket.usedPercent,
          valueLabel: `${percentFormat.format(bucket.usedPercent / 100)} used`,
          resetLabel: reset ? `Resets ${reset}` : undefined,
        };
      }),
      message: formatUsageMessage(snapshot),
      usageLinkLabel: page ? formatUsageLinkLabel(snapshot.availableResets) : undefined,
    };
  }

  function formatUsageLinkLabel(availableResets = 0): string {
    return availableResets > 0
      ? `${availableResets.toLocaleString()} ${availableResets === 1 ? "reset" : "resets"} available`
      : "Manage usage";
  }

  function formatUsageMessage(snapshot: QuotaSnapshot): string | undefined {
    if (!snapshot.buckets?.length) {
      return snapshot.loading ? "Loading usage…" : "Account usage is unavailable.";
    }
    return snapshot.unavailable ? "Couldn’t refresh usage." : undefined;
  }

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

{#if useNative}
  <button
    bind:this={button}
    type="button"
    aria-label="Account usage"
    aria-haspopup="dialog"
    aria-expanded={Boolean(nativeOpen)}
    title="Account usage"
    data-testid="prompt-usage-button"
    class={buttonClass}
    class:bg-psx-chrome-hover={Boolean(nativeOpen)}
    onclick={openNativePopover}
  >
    <Gauge size={12} usedTokens={highestUsage} totalTokens={100} />
  </button>
{:else}
  <button
    use:melt={$trigger}
    bind:this={button}
    type="button"
    aria-label="Account usage"
    title="Account usage"
    data-testid="prompt-usage-button"
    class={buttonClass}
    class:bg-psx-chrome-hover={$open}
  >
    <Gauge size={12} usedTokens={highestUsage} totalTokens={100} />
  </button>
{/if}

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
        {usageMessage}
      </p>
    {/each}
    {#if usageMessage && buckets.length > 0}
      <p role="status" class="text-psx-foreground-secondary text-xs">{usageMessage}</p>
    {/if}
    {#if usagePage}
      <div class="-mx-2 -mb-2">
        <div role="separator" class="menu-separator"></div>
        <button
          type="button"
          class="text-psx-foreground-primary hover:bg-psx-menu-hover-background focus-visible:bg-psx-menu-hover-background outline-hidden flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left"
          onclick={openUsagePage}
        >
          <span>{usageLinkLabel}</span>
          <Icon name="arrow-up-right" size={14} class="text-psx-icon shrink-0" aria-hidden="true" />
        </button>
      </div>
    {/if}
  </div>
{/if}
