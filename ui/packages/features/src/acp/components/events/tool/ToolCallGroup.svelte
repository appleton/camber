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
  import TranscriptFold from "../TranscriptFold.svelte";
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

  let tools = $derived(events.filter((item) => item.event.eventKind === "tool_call"));
  let summaryLabel = $derived(
    live ? summarizeLiveToolGroup(events) : summarizeToolGroup(events, turn),
  );
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

{#if tools.length > 0}
  <TranscriptFold label={summaryLabel} showRule={rule}>
    {#each events as item (item.index)}
      {@render renderItem(item)}
    {/each}
  </TranscriptFold>
{/if}
