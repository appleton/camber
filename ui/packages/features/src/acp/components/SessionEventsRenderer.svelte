<script lang="ts">
  import type { SessionEvent } from "../types";
  import { Boundary } from "@camber/components/boundary";
  import { VirtualList } from "@camber/components/virtual-list";
  import {
    SessionEventsState,
    setToolCallExpansionContext,
    type GroupedItem,
    type ToolActivityMode,
    type ToolCallExpansionState,
  } from "./SessionEventsState.svelte";
  import AgentMessage from "./events/AgentMessage.svelte";
  import AgentThought from "./events/AgentThought.svelte";
  import ModeChange from "./events/ModeChange.svelte";
  import SessionHandoff from "./events/SessionHandoff.svelte";
  import UserMessage from "./events/UserMessage.svelte";
  import ToolCall from "./events/ToolCall.svelte";
  import ToolCallGroup from "./events/tool/ToolCallGroup.svelte";
  import { CopyToClipboard } from "./ui";
  import type { WorkspaceFolder } from "@camber/rpc";
  import type { TurnMetadata } from "../TurnMaterializer";
  import {
    VIRTUALIZE_THRESHOLD,
    OVERSCAN_PX,
    ESTIMATED_ROW_HEIGHT,
    AT_BOTTOM_THRESHOLD_PX,
  } from "./chat/threadVirtualization";

  interface Props {
    events: SessionEvent[];
    items?: GroupedItem[];
    turns?: readonly TurnMetadata[];
    isPrompting?: boolean;
    /**
     * Drives the fallback grouping built here from `events`; when the
     * pre-grouped `items` prop is passed, the owner's timeline state has
     * already applied the mode and this only tells the rows which mode they
     * were grouped under (see showRule below). Owners passing `items` must pass
     * the mode those items were built with.
     */
    toolActivity?: ToolActivityMode;
    workspaceFolders?: WorkspaceFolder[];
    /**
     * Pass alongside a pre-grouped `items` prop: the expansion state of the
     * owner's timeline state, so user expands reach the fold logic that
     * produced the rows. Defaults to the fallback grouping's own state.
     */
    expansion?: ToolCallExpansionState;
    /**
     * When provided, enables opt-in windowing for long threads. Only the chat
     * pane passes this; all other consumers leave it undefined so every item
     * renders.
     */
    scrollElement?: HTMLElement;
    /** Keep the visible row fixed while a detached transcript corrects estimates. */
    preserveScrollAnchor?: boolean;
  }

  let {
    events,
    items,
    turns = [],
    isPrompting = false,
    toolActivity = "detailed",
    workspaceFolders = [],
    expansion,
    scrollElement,
    preserveScrollAnchor = false,
  }: Props = $props();

  export function isSwitchModeToolCall(event: SessionEvent) {
    if (event.eventKind !== "tool_call") return;
    return event.kind === "switch_mode" && event.status === "completed";
  }

  const eventsState = new SessionEventsState({
    get events() {
      return events;
    },
    get turns() {
      return turns;
    },
    get isPrompting() {
      return isPrompting;
    },
    get toolActivity() {
      return toolActivity;
    },
  });

  setToolCallExpansionContext(() => expansion ?? eventsState.expansion);

  const renderItems = $derived(items ?? eventsState.grouped);

  // Only the newest agent message in the live response can still be appended
  // to. Earlier messages in the same turn may precede tool calls and are
  // already stable, so leave them on the canonical one-shot Markdown path.
  const streamingAgentMessageIndex = $derived.by(() => {
    if (!isPrompting) return -1;
    const orderedEvents = renderItems.flatMap((item) =>
      item.kind === "event_group" ? item.events : [{ event: item.event, index: item.index }],
    );
    let latestUserMessageIndex = -1;
    for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
      const item = orderedEvents[index];
      if (item?.event.eventKind === "user_message" && !item.event.steer) {
        latestUserMessageIndex = item.index;
        break;
      }
    }
    for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
      const item = orderedEvents[index];
      if (item && item.index <= latestUserMessageIndex) break;
      if (item?.event.eventKind === "agent_message") return item.index;
    }
    return -1;
  });

  type RenderItem = {
    item: GroupedItem;
    copyText?: string;
  };

  function agentMessageText(item: GroupedItem): string {
    // Groups can absorb interim agent messages (end-of-turn summaries, and
    // interrupted compact turns); the latest one carries the response text.
    const events =
      item.kind === "event_group" ? item.events.map((groupItem) => groupItem.event) : [item.event];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.eventKind !== "agent_message") continue;
      const text = event.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n\n");
      if (text.trim() !== "") return text;
    }
    return "";
  }

  const renderItemsWithFooters = $derived.by<RenderItem[]>(() => {
    const result: RenderItem[] = [];
    let activeResponseEntries: RenderItem[] = [];
    let responseText = "";
    let copyCandidate: RenderItem | undefined;

    const setCopyText = () => {
      if (copyCandidate && responseText !== "") {
        copyCandidate.copyText = responseText;
      }
      responseText = "";
      copyCandidate = undefined;
    };

    for (const item of renderItems) {
      const entry: RenderItem = { item };
      result.push(entry);

      if (item.kind === "event" && item.event.eventKind === "user_message" && !item.event.steer) {
        setCopyText();
        activeResponseEntries = [];
      } else {
        activeResponseEntries.push(entry);

        const text = agentMessageText(item);
        const isToolRow =
          item.kind === "event_group" ||
          (item.kind === "event" && item.event.eventKind === "tool_call");
        // Trim only to decide whether the message has meaningful text; the
        // clipboard payload keeps the raw value, where leading whitespace can
        // be significant (Markdown indentation, code).
        if (text.trim() !== "") {
          responseText = text;
          copyCandidate = entry;
        } else if (isToolRow) {
          copyCandidate = entry;
        }
      }
    }
    setCopyText();

    if (isPrompting) {
      for (const entry of activeResponseEntries) {
        entry.copyText = undefined;
      }
    }

    return result;
  });
</script>

{#snippet responseFooter(entry: RenderItem)}
  {#if entry.copyText}
    <div class="flex w-full items-center justify-end gap-2">
      <div
        data-response-actions
        class="pointer-events-none flex shrink-0 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/response:pointer-events-auto group-hover/response:opacity-100"
      >
        <CopyToClipboard text={entry.copyText} />
      </div>
    </div>
  {/if}
{/snippet}

<!-- Long threads are windowed (only near-viewport rows in the DOM); short ones
     and every non-chat-pane consumer render every row. gap 10px == gap-2.5. -->
<VirtualList
  items={renderItemsWithFooters}
  key={(entry) => entry.item.id}
  {scrollElement}
  threshold={VIRTUALIZE_THRESHOLD}
  overscanPx={OVERSCAN_PX}
  estimateHeight={ESTIMATED_ROW_HEIGHT}
  pinThresholdPx={AT_BOTTOM_THRESHOLD_PX}
  gap={10}
  {preserveScrollAnchor}
>
  {#snippet row(entry, _index)}
    {@const item = entry.item}
    <Boundary name={`ACPSessionEvent:${item.id}`}>
      {#snippet failed(_error, _reset)}
        <div
          class="border-psx-border bg-psx-editor-background text-psx-foreground-secondary shadow-low dark:shadow-low-dark self-start rounded-lg border px-2.5 py-2 text-xs"
        >
          <span>This session event could not be rendered.</span>
        </div>
      {/snippet}

      {#if item.kind === "event_group"}
        <div class="group/response flex w-full min-w-0 flex-col gap-2">
          <!-- showRule: at most one rule per turn. An end-of-turn summary is
               always the turn's single fold, and so is compact mode's live
               fold — but grouped mode raises and drops several live folds as a
               turn streams, which would draw a rule for each. -->
          <ToolCallGroup
            events={item.events}
            turn={item.turn}
            live={item.live}
            showRule={!item.live || toolActivity === "compact"}
            {workspaceFolders}
          />
          {@render responseFooter(entry)}
        </div>
      {:else}
        {@const event = item.event}
        {@const previousEvent = item.index > 0 ? events[item.index - 1] : undefined}
        {#if event.eventKind === "user_message"}
          <UserMessage {event} />
        {:else if event.eventKind === "agent_message"}
          <div class="group/response flex w-full min-w-0 flex-col gap-2">
            <AgentMessage
              {event}
              streaming={item.index === streamingAgentMessageIndex}
              {scrollElement}
            />
            {@render responseFooter(entry)}
          </div>
        {:else if event.eventKind === "agent_thought"}
          <AgentThought {event} complete={!item.liveThought} />
        {:else if event.eventKind === "tool_call"}
          <div class="group/response flex w-full min-w-0 flex-col gap-2">
            <ToolCall {event} {workspaceFolders} />
            {@render responseFooter(entry)}
          </div>
        {:else if event.eventKind === "mode_change"}
          <ModeChange
            {event}
            source={previousEvent && isSwitchModeToolCall(previousEvent) ? "tool_call" : "user"}
          />
        {:else if event.eventKind === "handoff"}
          <SessionHandoff {event} />
        {/if}
      {/if}
    </Boundary>
  {/snippet}
</VirtualList>
