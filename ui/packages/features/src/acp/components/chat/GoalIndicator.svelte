<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Dropdown, Tooltip } from "../ui";
  import { formatACPErrorSummary } from "../../errors";
  import { getACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import { appState } from "../../hostAdapter";
  import type { ACPGoalStatus } from "../../goals";
  import { GOAL_ICON } from "./goalPresentation";
  import "./promptFooterLabel.css";

  const chatSession = getACPChatSessionScope();

  const goal = $derived(chatSession.goal);
  const isMobile = $derived($appState.environment.assistantHost === "mobile");
  const nudgeLabel = $derived($appState.environment.assistantHost !== "vs");
  let sheetOpen = $state(false);
  let sheetGoalIdentity = $state<string | null>(null);

  const goalIdentity = $derived(
    goal
      ? [
          goal.source,
          goal.objective,
          goal.createdAt ?? goal.setAt ?? "",
          goal.tokensAtStart ?? "",
        ].join("\u0000")
      : null,
  );

  $effect(() => {
    if (sheetOpen && goalIdentity !== sheetGoalIdentity) {
      sheetOpen = false;
      sheetGoalIdentity = null;
    }
  });

  const statusLabel = $derived(goal ? humanStatus(goal.status) : "");
  const chipLabel = $derived.by(() => {
    if (!goal) return "";
    switch (goal.status) {
      case "active":
        return goal.objective;
      case "paused":
        return "Goal paused";
      case "blocked":
        return "Goal blocked";
      case "usageLimited":
      case "budgetLimited":
        return "Goal limited";
      case "complete":
        return "Goal complete";
    }
  });
  const icon = GOAL_ICON;
  const colorClass = $derived(goalColorClass(goal?.status));
  const canPause = $derived(
    goal?.source === "codex" && goal.status === "active" && goal.controlMethod !== undefined,
  );
  const canResume = $derived(goal?.source === "codex" && goal.status === "paused");
  const canClear = $derived(
    goal?.source === "claude" || (goal?.source === "codex" && goal.controlMethod !== undefined),
  );
  const pending = $derived(chatSession.pendingGoalAction);
  const errorText = $derived(
    chatSession.goalActionError
      ? formatACPErrorSummary(chatSession.goalActionError, { prefix: "Could not update goal" })
      : null,
  );
  const headerActionClass =
    "text-psx-icon hover:bg-psx-chrome-hover focus-visible:border-psx-focus focus-visible:text-psx-focus active:bg-psx-chrome-active focus:outline-hidden flex size-6 shrink-0 items-center justify-center rounded-full bg-transparent focus-visible:border disabled:pointer-events-none disabled:opacity-25";

  function humanStatus(status: ACPGoalStatus): string {
    switch (status) {
      case "usageLimited":
        return "Usage limited";
      case "budgetLimited":
        return "Budget limited";
      default:
        return status.charAt(0).toUpperCase() + status.slice(1);
    }
  }

  function goalColorClass(status: ACPGoalStatus | undefined): string {
    switch (status) {
      case "paused":
        return "text-psx-foreground-secondary";
      case "blocked":
      case "usageLimited":
      case "budgetLimited":
        return "text-amber-600 dark:text-amber-300";
      case "complete":
        return "text-green-600 dark:text-green-300";
      default:
        return "text-violet-600 dark:text-violet-300";
    }
  }

  function durationLabel(seconds: number): string {
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  function tokenBudgetLabel(tokens: number): string {
    return `${new Intl.NumberFormat(undefined, { notation: "compact" }).format(tokens)} token budget`;
  }

  async function run(action: "pause" | "resume" | "clear"): Promise<void> {
    try {
      if (action === "pause") await chatSession.pauseGoal();
      else if (action === "resume") await chatSession.resumeGoal();
      else await chatSession.clearGoal();
    } catch {
      // The session stores the normalized error for the details surface.
    }
  }

  function openSheet(): void {
    sheetGoalIdentity = goalIdentity;
    sheetOpen = true;
  }

  function closeSheet(): void {
    sheetOpen = false;
    sheetGoalIdentity = null;
  }
</script>

{#snippet trigger({ open }: { open: boolean })}
  <span
    class={[
      "hover:bg-psx-chrome-hover flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-sm transition-colors",
      open && "bg-psx-chrome-hover",
      colorClass,
    ]}
  >
    <Icon name={icon} size={14} class="shrink-0" aria-hidden="true" />
    <span class={["max-w-44 truncate", nudgeLabel && "prompt-footer-label"]}>{chipLabel}</span>
    <Icon name="chevron" size={12} class="shrink-0 opacity-60" aria-hidden="true" />
  </span>
{/snippet}

{#snippet details()}
  {#if goal}
    <div class="px-2 pb-2 pt-1">
      <div class="flex min-h-[22px] items-center">
        <span class={["text-xs font-medium", colorClass]}>{statusLabel}</span>
        {#if canPause || canResume || canClear}
          <div class="ml-auto flex shrink-0 items-center gap-0">
            {#if canPause}
              <Tooltip placement="top" gutter={4} openDelay={300}>
                {#snippet label()}
                  {pending === "pause" ? "Pausing goal…" : "Pause goal"}
                {/snippet}
                <button
                  type="button"
                  role="menuitem"
                  aria-label={pending === "pause" ? "Pausing goal" : "Pause goal"}
                  aria-busy={pending === "pause"}
                  disabled={pending !== null}
                  class={headerActionClass}
                  onclick={() => void run("pause")}
                >
                  <Icon name="pause" size={16} aria-hidden="true" />
                </button>
              </Tooltip>
            {/if}
            {#if canResume}
              <Tooltip placement="top" gutter={4} openDelay={300}>
                {#snippet label()}
                  {pending === "resume" ? "Resuming goal…" : "Resume goal"}
                {/snippet}
                <button
                  type="button"
                  role="menuitem"
                  aria-label={pending === "resume" ? "Resuming goal" : "Resume goal"}
                  aria-busy={pending === "resume"}
                  disabled={pending !== null}
                  class={headerActionClass}
                  onclick={() => void run("resume")}
                >
                  <Icon name="start" size={16} aria-hidden="true" />
                </button>
              </Tooltip>
            {/if}
            {#if canClear}
              <Tooltip placement="top" gutter={4} openDelay={300}>
                {#snippet label()}
                  {pending === "clear" ? "Clearing goal…" : "Clear goal"}
                {/snippet}
                <button
                  type="button"
                  role="menuitem"
                  aria-label={pending === "clear" ? "Clearing goal" : "Clear goal"}
                  aria-busy={pending === "clear"}
                  disabled={pending !== null}
                  class={headerActionClass}
                  onclick={() => void run("clear")}
                >
                  <Icon name="stop" size={16} aria-hidden="true" />
                </button>
              </Tooltip>
            {/if}
          </div>
        {/if}
      </div>
      <p
        class="text-psx-foreground-primary mt-1.5 whitespace-pre-wrap break-words text-sm leading-snug"
      >
        {goal.objective}
      </p>

      {#if goal.iterations !== undefined || goal.timeUsedSeconds !== undefined || goal.tokenBudget != null}
        <div class="text-psx-foreground-tertiary mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs">
          {#if goal.iterations !== undefined}
            <span>{goal.iterations} {goal.iterations === 1 ? "check" : "checks"}</span>
          {/if}
          {#if goal.timeUsedSeconds !== undefined}
            <span>{durationLabel(goal.timeUsedSeconds)}</span>
          {/if}
          {#if goal.tokenBudget != null}
            <span>{tokenBudgetLabel(goal.tokenBudget)}</span>
          {/if}
        </div>
      {/if}

      {#if goal.lastReason}
        <div
          class="bg-psx-chrome text-psx-foreground-secondary mt-2 rounded-md px-2 py-1.5 text-xs leading-snug"
        >
          <span class="font-medium">Last check:</span>
          {goal.lastReason}
        </div>
      {/if}

      {#if errorText}
        <div
          class="mt-2 rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-600 dark:text-red-300"
        >
          {errorText}
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#if goal}
  {#if isMobile}
    <button
      type="button"
      aria-label={`Goal, ${statusLabel}: ${goal.objective}`}
      aria-expanded={sheetOpen}
      class="focus:outline-psx-focus flex min-w-0 max-w-full items-center rounded-md focus-visible:outline-2"
      onclick={openSheet}
    >
      {@render trigger({ open: sheetOpen })}
    </button>
    {#if sheetOpen}
      <div
        class="fixed inset-x-0 top-0 z-[110] flex flex-col justify-end"
        style="height: var(--visual-viewport-height, 100dvh)"
        role="presentation"
      >
        <button
          type="button"
          class="absolute inset-0 cursor-default bg-black/40"
          aria-label="Close goal details"
          onclick={closeSheet}
        ></button>
        <div
          role="menu"
          aria-label="Goal details"
          class="bg-psx-panel shadow-overlay dark:shadow-overlay-dark relative max-h-[85%] w-full overflow-y-auto rounded-t-2xl px-2 pb-[calc(.5rem+env(safe-area-inset-bottom))] pt-2"
        >
          <div
            class="bg-psx-border mx-auto mb-2 mt-1 h-1 w-9 rounded-full"
            aria-hidden="true"
          ></div>
          {@render details()}
        </div>
      </div>
    {/if}
  {:else}
    <Dropdown
      {icon}
      label={chipLabel}
      placement="top-start"
      disableFocusFirstItem
      wide
      {trigger}
      triggerLabel={`Goal, ${statusLabel}: ${goal.objective}`}
    >
      {@render details()}
    </Dropdown>
  {/if}
{/if}
