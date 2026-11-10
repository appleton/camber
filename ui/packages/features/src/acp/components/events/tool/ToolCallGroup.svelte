<script lang="ts">
  import {
    markInsideToolCallGroup,
    type SessionEventGroupItem,
  } from "../../SessionEventsState.svelte";
  import { Boundary } from "@camber/components/boundary";
  import ToolCall from "../ToolCall.svelte";
  import AgentMessage from "../AgentMessage.svelte";
  import AgentThought from "../AgentThought.svelte";
  import UserMessage from "../UserMessage.svelte";
  import Icon from "@camber/components/icon";
  import type { WorkspaceFolder } from "@camber/rpc";
  import type { TurnMetadata } from "../../../TurnMaterializer";
  import { summarizeLiveToolGroup, summarizeToolGroup } from "./toolGroupSummary";

  interface Props {
    events: SessionEventGroupItem[];
    turn?: TurnMetadata;
    /** Present on groups formed while the turn streams: uses count labels instead of turn summaries. */
    live?: boolean;
    /**
     * Draw the wavy rule under the trigger. Owned by the caller because it is a
     * per-turn decision, not a per-fold one: a turn should carry at most one
     * rule. Defaults to end-of-turn summaries only.
     */
    showRule?: boolean;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { events, turn, live, showRule, workspaceFolders = [] }: Props = $props();

  // Derived, not a prop default: a fold keeps its identity when the turn ends,
  // so `live` flips underneath a mounted component and a default evaluated once
  // would go stale.
  let rule = $derived(showRule ?? !live);

  // Tools expanded inside this open group stay held visible by it; they must
  // not pin the live fold boundary the way standalone expands do.
  markInsideToolCallGroup();

  let expanded = $state(false);

  let tools = $derived(events.filter((item) => item.event.eventKind === "tool_call"));
  let summaryLabel = $derived(
    live ? summarizeLiveToolGroup(events) : summarizeToolGroup(events, turn),
  );

  function toggle() {
    expanded = !expanded;
  }

  let triggerEl = $state<HTMLElement>();
  let headSentinelEl = $state<HTMLElement>();
  let bodySentinelEl = $state<HTMLElement>();

  /**
   * Pinning happens in stages, and the three of them are what the rule's
   * appearance is choreographed against. Scrolling a fold up to the top:
   *
   *  1. the rule reaches its stop first, and the trigger keeps rising — so the
   *     rule separates from the label and heads for the full width. `lineLeaving`
   *     switches its end fades over as that starts.
   *  2. the trigger reaches its own stop, and everything stops moving.
   *     `headerSettled` fades the shadow in, once the rule has arrived.
   *  3. the contents reach the rule and start passing under it. `contentsPassing`
   *     turns on the strip that hides them above it — and only then, because at
   *     rest that strip would occlude the tail of whatever precedes this fold.
   */
  let lineLeaving = $state(false);
  let headerSettled = $state(false);
  let contentsPassing = $state(false);

  /**
   * CSS cannot ask whether a sticky box is stuck (`scroll-state()` container
   * queries are unsupported in the desktop webview), so each stage is a sentinel
   * left behind at a fixed place in the fold's own flow: it stops intersecting a
   * viewport inset to that stage's offset exactly when the fold reaches it.
   */
  $effect(() => {
    const head = headSentinelEl;
    const body = bodySentinelEl;
    const trigger = triggerEl;
    if (!expanded || !head || !body || !trigger) {
      lineLeaving = false;
      headerSettled = false;
      contentsPassing = false;
      return;
    }
    const scroller = head.closest<HTMLElement>("[data-chat-transcript-scroller]");
    if (!scroller) return;

    // Measured off the TRIGGER, not the rule: the strip has to hide the contents
    // on every open fold, including the ones that draw no rule. The rule pins at
    // exactly triggerStop + its height, so the two cannot drift.
    const triggerStop = Number.parseFloat(getComputedStyle(trigger).top) || 0;
    const rulePin = triggerStop + trigger.offsetHeight;
    // Where the rule sits before it pins: centred on the trigger.
    const band = Number.parseFloat(getComputedStyle(head).getPropertyValue("--fold-rule-band"));
    const ruleInset = (trigger.offsetHeight - (band || 0)) / 2;

    const observers = (
      [
        // The head sentinel marks the fold's own top, so these two offsets are
        // "how far the fold has left to travel" for the rule and the trigger.
        [head, rulePin - ruleInset, (v: boolean) => (lineLeaving = v)],
        [head, triggerStop, (v: boolean) => (headerSettled = v)],
        [body, rulePin, (v: boolean) => (contentsPassing = v)],
      ] as const
    ).map(([target, offset, set]) => {
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries.at(-1);
          if (entry) set(!entry.isIntersecting);
        },
        {
          root: scroller,
          // The generous bottom inset keeps the root extended far below the
          // viewport, so "not intersecting" can only mean the sentinel went
          // ABOVE the line — never that it is still waiting below the fold.
          rootMargin: `-${offset}px 0px 9999px 0px`,
          threshold: 0,
        },
      );
      observer.observe(target);
      return observer;
    });

    return () => {
      for (const observer of observers) observer.disconnect();
      lineLeaving = false;
      headerSettled = false;
      contentsPassing = false;
    };
  });
</script>

{#snippet renderItem(item: SessionEventGroupItem, headerClass?: string, itemClass?: string)}
  <Boundary name={`ACPToolGroupItem:${item.index}`}>
    {#snippet failed(_error, _reset)}
      <div
        class="border-psx-border bg-psx-editor-background text-psx-foreground-secondary shadow-low dark:shadow-low-dark self-start rounded-lg border px-2.5 py-2 text-xs"
      >
        <span>This grouped tool event could not be rendered.</span>
      </div>
    {/snippet}

    {#if item.event.eventKind === "tool_call"}
      <ToolCall event={item.event} {headerClass} {workspaceFolders} />
    {:else if item.event.eventKind === "agent_message"}
      <div class={["box-border w-full min-w-0 max-w-full", itemClass]}>
        <AgentMessage event={item.event} />
      </div>
    {:else if item.event.eventKind === "agent_thought"}
      <div class={["box-border w-full min-w-0 max-w-full", itemClass]}>
        <AgentThought event={item.event} complete />
      </div>
    {:else if item.event.eventKind === "user_message"}
      <div class={["box-border w-full min-w-0 max-w-full", itemClass]}>
        <UserMessage event={item.event} />
      </div>
    {/if}
  </Boundary>
{/snippet}

<!--
  While the fold is open the trigger pins to the top of the transcript and the
  rule pins just under it, so the summary stays readable through contents that
  routinely run several screens long. This works because the trigger, the rule
  and the contents share one block — that block is the sticky containing block,
  so both stay pinned for exactly as long as any of the group is on screen.

  The rule reaches its stop a little BEFORE the trigger reaches its own, because
  it starts out lower (centred on the trigger). So scrolling up, the rule settles
  first, the trigger rides up the last stretch to meet it, and the rule is left
  spanning the full width beneath it.

  No row gap: the trigger and the rule are parked by margins instead, so opening
  a fold moves nothing. The contents restore the gap.
-->
<div class="fold flex flex-col flex-wrap items-start">
  <!-- Marks the fold's own top for the stage observers; zero height, so it sits
       exactly there without displacing anything. -->
  <div bind:this={headSentinelEl} class="fold-sentinel" aria-hidden="true"></div>

  {#if contentsPassing}
    <!-- Hides everything above the rule, so contents that have passed under it
         cannot scroll back into view over the trigger or through the fade at the
         top of the transcript. -->
    <div class="fold-strip" aria-hidden="true"></div>
  {/if}

  {#if tools.length > 0}
    <!-- full-width row so the rule below has a full-width box to sit behind
         (see data-tool-group-rule in the desktop app.css). The pin is keyed off
         `expanded` rather than `showRule`: a fold that draws no rule still has
         to hold its summary and hide its contents while it scrolls. -->
    <div
      bind:this={triggerEl}
      class={[
        "fold-trigger flex w-full min-w-0 items-center",
        expanded && "fold-trigger--pinned",
        contentsPassing && "fold-trigger--opaque",
      ]}
    >
      <!-- bg-psx-editor-background: invisible at rest — it is the transcript's
           own surface — but it is what hides the length of rule that would
           otherwise run behind the label, so the rule reads as starting after
           it. Once pinned, the trigger has moved up off the rule entirely. -->
      <button
        type="button"
        onclick={toggle}
        aria-expanded={expanded}
        data-disclosure
        class="hover:bg-psx-background-secondary text-psx-foreground-secondary hover:text-psx-foreground-primary bg-psx-editor-background group flex h-[24px] items-center gap-1 rounded-md text-xs transition-colors"
      >
        <span class="opacity-60">•••</span>
        <span class="text-sm">{summaryLabel}</span>
        <Icon
          name="chevron"
          class={["transition-all", !expanded && "-rotate-90 opacity-0 group-hover:opacity-100"]}
        />
      </button>
    </div>
  {/if}

  {#if tools.length > 0 && rule}
    <div
      class={["fold-rule", expanded && "fold-rule--pinned", headerSettled && "fold-rule--shadowed"]}
      aria-hidden="true"
    >
      <!-- Depth under the cut while contents pass beneath it. A painted band
           rather than a drop-shadow on the cut: a shadow is cast from the whole
           silhouette, so it spills past the column's left and right edges, and
           the only way to taper it there would be to fade the cut itself — which
           is the one thing that has to stay opaque. Drawn before the cut so the
           cut's own surface covers the seam where their edges meet. -->
      <div data-tool-group-rule-shadow></div>
      <!-- The cut: surface colour filling everything above the wave, so contents
           dissolve into the line rather than sliding past it. Its shape has to
           stay in step with the line drawn over it — same box, same mask origin,
           and the same path (see data-tool-group-rule in the desktop app.css). -->
      <div class="fold-rule__cut"></div>
      <!-- data-stuck: the rule is drawn differently in its two states — beside
           the label it runs to the right edge, pinned it spans the column — and
           the host paints both (see app.css). -->
      <div data-tool-group-rule data-stuck={lineLeaving ? true : undefined}></div>
    </div>
  {/if}

  {#if expanded && events.length > 0}
    <!-- mt-2.5 replaces the row gap dropped above. -->
    <div class="mt-2.5 box-border flex w-full min-w-0 max-w-full flex-col flex-wrap items-start">
      <div bind:this={bodySentinelEl} class="fold-sentinel" aria-hidden="true"></div>
      <div class="flex w-full min-w-0 max-w-full flex-col flex-wrap items-start gap-2.5">
        {#each events as item (item.index)}
          {@render renderItem(item)}
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  /*
   * Stops. The trigger halts at the host's offset — desktop fades the top of the
   * transcript (--desktop-transcript-overflow-fade-height in ChatPane) and a
   * trigger pinned inside that fade would be half erased by it — and the rule
   * one trigger-height below, so it lands flush underneath.
   *
   * z-order, contents upward: strip 11, rule 12, trigger 13. Above 10 because
   * the contents carry z-indexes of their own up to that (ChatProgress pins its
   * thinking header at z-index 10), and above 0 because they also include
   * positioned pills at z-index auto, which paint in the same step as z-index 0
   * and would win on tree order.
   *
   * The trigger is positioned in every state, not just while pinned: the rule is
   * a positioned box, so it paints in a later step than in-flow content: leave
   * the row static and the rule draws straight over the summary label instead of
   * behind it, closed or open, however opaque the label's own background is.
   */
  .fold-trigger {
    position: relative;
    z-index: 13;
  }

  .fold-trigger--pinned {
    position: sticky;
    top: var(--acp-transcript-sticky-top, 0px);
  }

  /* Declared on the fold, not the rule, so the stage observers can read the band
     off any sentinel and derive where the rule rests from it. */
  .fold {
    --fold-rule-band: 6px;
    --fold-rule-inset: calc((1.5rem - var(--fold-rule-band)) / 2);
  }

  .fold-rule {
    position: relative;
    width: 100%;
    height: var(--fold-rule-band);
    /* Park it centred on the trigger, then take it back out of the layout. */
    margin-top: calc(var(--fold-rule-inset) - 1.5rem);
    margin-bottom: calc(1.5rem - var(--fold-rule-inset) - var(--fold-rule-band));
    pointer-events: none;
  }

  .fold-rule--pinned {
    position: sticky;
    top: calc(var(--acp-transcript-sticky-top, 0px) + 1.5rem);
    z-index: 12;
  }

  .fold-rule > :global(*) {
    position: absolute;
    inset: 0;
  }

  /* The squiggle, closed upwards into a fill so it masks an edge rather than
     drawing a line. Same box, origin and path as the line drawn over it, which
     is what keeps the cut and the line in step. */
  .fold-rule__cut {
    background: var(--psx-editor-background);
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='6' viewBox='0 0 12 6'%3E%3Cpath d='M0 3q3-3 6 0t6 0V0H0Z' fill='%23000'/%3E%3C/svg%3E");
    mask-repeat: repeat-x;
    mask-size: 12px var(--fold-rule-band);
    mask-position: left top;
  }

  /*
   * Depth below the cut, revealed only while contents are passing under it.
   * Starts at the band's own top, not below it, so the host can cut its upper
   * edge with the same wave and the shadow follows the line's contour instead of
   * running straight across under it (app.css paints the falloff and both
   * fades). The band's own opaque half is covered by the cut above.
   */
  .fold-rule > :global([data-tool-group-rule-shadow]) {
    top: 0;
    bottom: auto;
    height: 1.125rem;
    opacity: 0;
    transition: opacity 200ms ease-out;
  }

  .fold-rule--shadowed > :global([data-tool-group-rule-shadow]) {
    opacity: 1;
  }

  .fold-strip {
    position: sticky;
    top: 0;
    z-index: 11;
    width: 100%;
    height: var(--acp-transcript-sticky-top, 0px);
    margin-bottom: calc(-1 * var(--acp-transcript-sticky-top, 0px));
    background: var(--psx-editor-background);
    pointer-events: none;
  }

  /* The row only goes opaque once contents are passing behind it. Before that it
     has to stay clear: the rule crosses the row at rest, and a full-width opaque
     row would hide it. By the time contents reach the rule the row is already
     pinned above it, so the two never fight. */
  .fold-trigger--opaque {
    background: var(--psx-editor-background);
  }

  .fold-sentinel {
    width: 100%;
    height: 0;
  }
</style>
