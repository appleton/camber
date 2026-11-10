import { getContext, setContext } from "svelte";
import type { TurnMetadata } from "../TurnMaterializer";
import type { SessionEvent, ToolCall } from "../types";

export type SessionEventGroupItem = { event: SessionEvent; index: number };

/**
 * User expand/collapse choices for a transcript's tool-call blocks, keyed by
 * `toolCallId` so they survive the remounts streaming causes: a tool's row is
 * re-keyed when it moves between standalone and grouped rendering, and
 * virtualization unmounts off-screen rows, either of which would reset
 * component-local state back to collapsed (PE-2402).
 *
 * A tool expanded while it renders standalone is also *pinned*: the live fold
 * boundary freezes at the earliest pinned tool, so the block the user is
 * reading — and every step streaming in after it — stays out of the fold until
 * the user collapses it again. Tools expanded inside an already-open group are
 * not pinned: the group keeps them visible, and pinning them would pop
 * already-folded rows back out of the fold under the reader.
 *
 * Both collections are plain immutable values reassigned on change, never
 * deep-reactive: `SessionEventsState`'s deriveds read `pinnedToolCallIds`, and
 * reading a reactive collection from inside a derived has caused infinite
 * reactive loops in this codebase before (see `interruptedFoldCache`).
 */
export class ToolCallExpansionState {
  private openById = $state<ReadonlyMap<string, boolean>>(new Map());
  private pinned = $state<ReadonlySet<string>>(new Set());

  /** The user's last explicit open/closed choice for a tool, if any. */
  openStateFor(toolCallId: string): boolean | undefined {
    return this.openById.get(toolCallId);
  }

  get pinnedToolCallIds(): ReadonlySet<string> {
    return this.pinned;
  }

  setOpen(toolCallId: string, open: boolean, options: { pin?: boolean } = {}): void {
    if (this.openById.get(toolCallId) !== open) {
      const nextOpen = new Map(this.openById);
      nextOpen.set(toolCallId, open);
      this.openById = nextOpen;
    }
    const pin = open && (options.pin ?? false);
    if (pin !== this.pinned.has(toolCallId)) {
      const nextPinned = new Set(this.pinned);
      if (pin) nextPinned.add(toolCallId);
      else nextPinned.delete(toolCallId);
      this.pinned = nextPinned;
    }
  }
}

const EXPANSION_CONTEXT_KEY = Symbol("acp-tool-call-expansion");
const IN_GROUP_CONTEXT_KEY = Symbol("acp-tool-call-in-group");

/**
 * Provides the transcript's expansion state to every tool block below. Set by
 * `SessionEventsRenderer` with the state owned by whichever
 * `SessionEventsState` produced the rendered rows, so user pins reach that
 * instance's fold logic. A getter rather than the instance itself: the
 * producing state can switch (the pane's timeline state vs the renderer's
 * fallback) after the context is set.
 */
export function setToolCallExpansionContext(get: () => ToolCallExpansionState): void {
  setContext(EXPANSION_CONTEXT_KEY, get);
}

/** Undefined outside a transcript (stories, previews): tools fall back to local state. */
export function getToolCallExpansionContext(): (() => ToolCallExpansionState) | undefined {
  return getContext(EXPANSION_CONTEXT_KEY);
}

/** Marks a subtree as rendered inside a ToolCallGroup, so expanding there does not pin. */
export function markInsideToolCallGroup(): void {
  setContext(IN_GROUP_CONTEXT_KEY, true);
}

export function isInsideToolCallGroup(): boolean {
  return getContext<boolean | undefined>(IN_GROUP_CONTEXT_KEY) ?? false;
}

/**
 * How the live turn's tools render while a prompt streams: "detailed" keeps
 * every tool call expanded until the turn completes; "grouped" (the product
 * default) folds every contiguous run of finished tools and settled thoughts —
 * whatever their kind, errors included — into one collapsed group, so only
 * agent messages and the tools still running break the transcript up (a
 * markdown reply renders in full and a fresh group starts beneath it), and
 * keeps the same two-slot tail
 * as "compact" so the bottom of the transcript does not jump; "compact" folds
 * the turn (finished tools, errors included, and interim messages) into one
 * growing summary line above a constant two-slot tail: the last two tool
 * calls, with any trailing activity (thought, "think" step, or the streaming
 * reply) taking the second slot. The user-facing setting stores this mode
 * string directly (VS Code `camber.toolActivity`, desktop
 * `toolActivity`), so future modes are new values, not a settings
 * migration. Finished turns summarize regardless of the mode — except
 * interrupted ones, which keep their streaming layout (see
 * `groupModeForTool`).
 */
export type ToolActivityMode = "detailed" | "grouped" | "compact";

/**
 * Resolves the activity mode from host state: VS Code persists the setting in
 * its configuration (`userSettings`), the desktop app in its own settings
 * file surfaced through `environment`. Unknown or missing values fall back to
 * the product default, "grouped". Typed structurally so state modules don't
 * depend on the host adapter.
 */
export function toolActivityFrom(state: {
  userSettings: unknown;
  environment: { desktopToolActivity?: unknown };
}): ToolActivityMode {
  const userSettings = state.userSettings as { toolActivity?: unknown };
  const mode = userSettings.toolActivity ?? state.environment.desktopToolActivity;
  return mode === "detailed" || mode === "grouped" || mode === "compact" ? mode : "grouped";
}

export type GroupedItem =
  | { id: string; kind: "event"; event: SessionEvent; index: number; liveThought?: boolean }
  | {
      id: string;
      kind: "event_group";
      events: SessionEventGroupItem[];
      turn?: TurnMetadata;
      /**
       * Set on groups formed while the turn streams and kept on interrupted
       * turns' groups; absent on end-of-turn summaries.
       */
      live?: boolean;
    };

export interface SessionEventsProps {
  readonly events: SessionEvent[];
  readonly turns?: readonly TurnMetadata[];
  readonly isPrompting?: boolean;
  readonly toolActivity?: ToolActivityMode;
}

type GroupMode = {
  turn?: TurnMetadata;
  live?: boolean;
};

type CurrentGroup = GroupMode & {
  events: SessionEventGroupItem[];
};

/**
 * The live turn's two-slot tail, shared by "grouped" and "compact": the rows at
 * the bottom of the transcript that never fold, so the transcript does not
 * collapse and re-expand under the reader on every step.
 */
type LiveTail = {
  /** Live-turn tools before this index may fold; the rest are the tail. */
  foldBoundary: number;
  /** First live-turn index — one past the latest user message. */
  start: number;
  /** `visibleAfter[i - start]`: whether a rendered event follows index `i`. */
  visibleAfter: boolean[];
};

export class SessionEventsState {
  /**
   * Events that can appear between collapsible tools without breaking the
   * group. Explicitly tagged steer messages are bufferable in settled turns;
   * live steers remain visible chronological boundaries (see `grouped`).
   * Ordinary user messages are always hard turn boundaries. Thoughts fold on
   * their own terms (see `groupModeForThought`); they stay listed here so
   * look-ahead can still see *through* them to a following tool.
   */
  private static readonly BUFFERABLE_KINDS = new Set<SessionEvent["eventKind"]>([
    "agent_message",
    "agent_thought",
  ]);

  private static isBufferable(event: SessionEvent): boolean {
    return SessionEventsState.BUFFERABLE_KINDS.has(event.eventKind) || isSteerMessage(event);
  }

  constructor(private readonly props: SessionEventsProps) {}

  /**
   * Expand/collapse choices for this transcript's tool calls. The fold logic
   * below reads its pins: a user-expanded standalone tool holds the fold
   * boundary so streaming cannot collapse the block being read (PE-2402).
   */
  readonly expansion = new ToolCallExpansionState();

  readonly grouped = $derived.by(() => {
    const result: GroupedItem[] = [];
    const events = this.props.events;
    const latestUserMessageIndex = this.latestUserMessageIndex(events);
    const isPrompting = !!this.props.isPrompting;
    const liveTail = this.liveTailFor(events, latestUserMessageIndex, isPrompting);
    const compactFolds = this.compactFoldsFor(events, liveTail);
    const interruptedCompactFolds = this.interruptedCompactFoldsFor(events);
    let currentGroup: CurrentGroup | null = null;

    // Every thought renders — standalone or inside a fold. The latest one,
    // while it is still trailing and a prompt is in flight, renders live
    // (streaming); every earlier thought is settled. Locate the live one here.
    let lastThoughtIndex = -1;
    let lastRealEventIndex = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (lastThoughtIndex === -1 && events[i].eventKind === "agent_thought") {
        lastThoughtIndex = i;
      }
      if (lastRealEventIndex === -1 && !isTransientForThoughtVisibility(events[i])) {
        lastRealEventIndex = i;
      }
      if (lastThoughtIndex !== -1 && lastRealEventIndex !== -1) break;
    }

    function flushGroup() {
      if (!currentGroup) return;
      const { events: groupEvents, turn, live } = currentGroup;
      const tools = groupEvents.filter((item) => item.event.eventKind === "tool_call");
      if (tools.length >= 2) {
        result.push({
          // Anchor the id on the first tool, matching the compact folds, so an
          // interrupted compact group that absorbed a leading message keeps
          // the id it had while streaming and the row is not re-keyed
          // (remounting would collapse an expanded group).
          id: `group-${tools[0].index}`,
          kind: "event_group",
          events: groupEvents,
          turn,
          live,
        });
      } else {
        for (const item of groupEvents) {
          result.push({
            id: `event-${item.index}`,
            kind: "event",
            event: item.event,
            index: item.index,
            // A thought only joins a group once it has settled; if the group
            // was too small to render, it falls out as a settled row.
            ...(item.event.eventKind === "agent_thought" ? { liveThought: false } : {}),
          });
        }
      }
      currentGroup = null;
    }

    const addToGroup = (item: SessionEventGroupItem, mode: GroupMode) => {
      if (currentGroup && (currentGroup.turn !== mode.turn || currentGroup.live !== mode.live)) {
        flushGroup();
      }
      currentGroup ??= { ...mode, events: [] };
      currentGroup.events.push(item);
    };

    // A steer can be the last event in a settled tool sequence when the agent
    // interrupts its active tool instead of continuing with another one. Keep
    // that terminal steer inside the completed fold too. The active turn is
    // handled separately below: its steers must stay at their chronological
    // position in the visible transcript.
    const addSteerToExistingGroup = (item: SessionEventGroupItem): boolean => {
      if (currentGroup) {
        currentGroup.events.push(item);
        return true;
      }
      for (let j = result.length - 1; j >= 0; j--) {
        const previous = result[j];
        if (
          previous.kind === "event" &&
          previous.event.eventKind === "user_message" &&
          !previous.event.steer
        ) {
          return false;
        }
        if (previous.kind === "event_group") {
          previous.events.push(item);
          return true;
        }
      }
      return false;
    };

    // Agents echo the session's starting mode (the one the user just picked
    // in the composer) as a mode update at session start — sometimes before
    // the first prompt, sometimes just after it — so a "Mode switched to" row
    // before any agent activity is noise. A genuine mid-chat switch always
    // follows some agent output, so those still render.
    const firstAgentActivityIndex = events.findIndex(
      (e) =>
        e.eventKind === "tool_call" ||
        e.eventKind === "agent_thought" ||
        (e.eventKind === "agent_message" && !isBlankAgentMessage(e)),
    );

    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      if (
        event.eventKind === "mode_change" &&
        (firstAgentActivityIndex === -1 || i < firstAgentActivityIndex)
      ) {
        continue;
      }

      // A steer is appended to the active turn immediately. Render it at that
      // exact position instead of moving it backward into an existing fold;
      // tools arriving later then render below it and naturally push it up.
      // Once the turn settles, its summary may absorb the steer as before.
      if (
        isPrompting &&
        i > latestUserMessageIndex &&
        isSteerMessage(event) &&
        !this.findTurnForIndex(i)
      ) {
        flushGroup();
        result.push({ id: `event-${i}`, kind: "event", event, index: i });
        continue;
      }

      // "compact": each live span between steer prompts folds its tools and
      // interim narration into a group anchored where that span's first tool
      // sits. Check membership before the thought path below so completed
      // reasoning between tools folds too.
      const compactFold = compactFolds.get(i);
      if (compactFold) {
        if (!compactFold.pushed) {
          flushGroup();
          result.push(compactFold.item);
          compactFold.pushed = true;
        }
        continue;
      }

      if (event.eventKind === "agent_thought") {
        const live = isPrompting && i === lastThoughtIndex && i > lastRealEventIndex;
        // Settled thoughts fold with the tools around them; only the live
        // (streaming) thought always renders standalone.
        const mode = live ? null : this.groupModeForThought(i, latestUserMessageIndex, liveTail);
        if (mode) {
          addToGroup({ event, index: i }, mode);
        } else {
          flushGroup();
          result.push({ id: `event-${i}`, kind: "event", event, index: i, liveThought: live });
        }
        continue;
      }

      // Blank streaming placeholders render nothing; skip them so they don't
      // wedge empty nodes between dropped thoughts. They come back with content.
      if (isBlankAgentMessage(event)) continue;

      // Interrupted "compact" turns keep one membership-based fold per turn,
      // pushed at its first member. When the interrupt settles the automatic
      // tail joins that fold without re-keying it; interleaved thoughts still
      // do not split it, and folded interim messages stay absorbed.
      const interruptedFold = interruptedCompactFolds.get(i);
      if (interruptedFold) {
        if (!interruptedFold.pushed) {
          flushGroup();
          result.push(interruptedFold.item);
          interruptedFold.pushed = true;
        }
        continue;
      }

      const mode = this.groupModeForTool(event, i, latestUserMessageIndex, liveTail);

      if (mode) {
        addToGroup({ event, index: i }, mode);
      } else if (SessionEventsState.isBufferable(event)) {
        const nextMode = this.nextGroupModeForTool(events, i, latestUserMessageIndex, liveTail);
        // Streaming groups never absorb messages: while the turn is live, agent
        // text stays visible outside the fold (in "grouped" it is the only
        // thing that splits a tool run). Active steers were handled above; a
        // steer in an already-settled interrupted turn may still bridge its
        // live-layout group to the next foldable tool. End-of-turn summaries
        // keep absorbing all bufferable events. Interrupted "compact" turns
        // absorb via their membership fold above, never here.
        const absorbs = nextMode && (!nextMode.live || isSteerMessage(event));
        if (absorbs) {
          addToGroup({ event, index: i }, nextMode);
        } else if (isSteerMessage(event) && addSteerToExistingGroup({ event, index: i })) {
          continue;
        } else {
          flushGroup();
          result.push({ id: `event-${i}`, kind: "event", event, index: i });
        }
      } else {
        flushGroup();
        result.push({ id: `event-${i}`, kind: "event", event, index: i });
      }
    }

    flushGroup();
    return result;
  });

  /**
   * A tool that is done, however it ended. Status is the only thing that keeps
   * a tool out of a fold: neither its kind nor its outcome does. A turn that
   * alternates reads, shells, MCP calls and failures reads as one collapsed
   * group rather than a stack of them, and errors summarize with everything
   * else — the same rule "compact" and the end-of-turn summary already use.
   */
  private isFinishedTool(event: SessionEvent): event is ToolCall {
    return (
      event.eventKind === "tool_call" &&
      event.status !== undefined &&
      event.status !== "pending" &&
      event.status !== "in_progress"
    );
  }

  private groupModeForTool(
    event: SessionEvent,
    index: number,
    latestUserMessageIndex: number,
    liveTail: LiveTail | null,
  ): GroupMode | null {
    const turn = this.findTurnForIndex(index);
    if (turn) {
      // An interrupted turn keeps its streaming shape rather than compacting
      // into the whole-turn summary a naturally completed turn gets: in
      // "grouped" mode agent messages stay outside the fold and split the tool
      // runs, in "compact" mode the turn stays one fold with the interim
      // messages absorbed (see `grouped`), and in "detailed" mode nothing
      // folds at all. Once the interrupt settles, the automatic two-slot tail
      // joins the fold: it was only kept out to stabilize the live transcript.
      // A tool the user explicitly expanded still pins the fold boundary, so
      // it and its successors remain visible. The final reply was cut off, so
      // the in-flight structure — rather than a whole-turn summary — remains
      // the record of what happened (PE-2401, PE-2402).
      if (turn.interrupted) {
        // "compact" interrupted turns fold membership-wise instead (see
        // `interruptedCompactFoldsFor`); their tools never group here.
        if (this.props.toolActivity !== "grouped") return null;
        if (!this.isFinishedTool(event)) return null;
        const fold = this.interruptedTurnFolds.get(turn);
        if (fold && !this.foldsBehindTail(event, index, fold)) return null;
        return { turn, live: true };
      }
      return this.isFinishedTool(event) ? { turn } : null;
    }
    if (this.props.isPrompting) {
      // Tools from earlier turns stay summarized while a new reply streams
      // (#171); the current turn's tools render live.
      if (index < latestUserMessageIndex) {
        return this.isFinishedTool(event) ? {} : null;
      }
      if (
        this.props.toolActivity === "grouped" &&
        liveTail &&
        this.isFinishedTool(event) &&
        this.foldsBehindTail(event, index, liveTail)
      ) {
        return { live: true };
      }
      return null;
    }
    return this.isFinishedTool(event) ? {} : null;
  }

  /**
   * `groupModeForTool`'s counterpart for settled thoughts: thoughts collapse
   * with the tools around them rather than splitting the fold. Once the turn
   * finishes they join the turn summary regardless of the mode; while the turn
   * streams, "grouped" folds a thought as soon as anything visible follows it
   * (the same rule "think" pseudo-steps use), so only agent messages break a
   * run of activity up. Interrupted "grouped" turns keep the same trailing
   * thought visibility rule while their finished tools settle into the fold.
   * The live "compact" fold absorbs thoughts by membership before this is
   * consulted (see `compactGroupFor`), interrupted "compact" turns keep
   * thoughts beside their fold (see
   * `interruptedCompactFoldsFor`), and "detailed" folds nothing live.
   */
  private groupModeForThought(
    index: number,
    latestUserMessageIndex: number,
    liveTail: LiveTail | null,
  ): GroupMode | null {
    const turn = this.findTurnForIndex(index);
    if (turn) {
      if (turn.interrupted) {
        if (this.props.toolActivity !== "grouped") return null;
        const fold = this.interruptedTurnFolds.get(turn);
        if (fold && !fold.visibleAfter[index - fold.start]) return null;
        return { turn, live: true };
      }
      return { turn };
    }
    if (this.props.isPrompting) {
      // Thoughts from earlier turns stay summarized with their tools while a
      // new reply streams, matching `groupModeForTool`.
      if (index < latestUserMessageIndex) return {};
      if (
        this.props.toolActivity === "grouped" &&
        liveTail &&
        liveTail.visibleAfter[index - liveTail.start]
      ) {
        return { live: true };
      }
      return null;
    }
    return {};
  }

  /**
   * The live turn's tail: the two rows that never fold. Normally the last two
   * tool calls; when anything visibly trails the newest one (a thought, a
   * "think" step, or the reply being written) it takes the second slot, so the
   * tail stays exactly two rows: [last-1, last] ⇄ [last, thinking…]. The
   * boundary only ever advances, so a folded tool never pops back out — without
   * this the bottom row collapses the instant a tool completes, then re-expands
   * as the next thought or call arrives.
   */
  private liveTailFor(
    events: SessionEvent[],
    latestUserMessageIndex: number,
    isPrompting: boolean,
  ): LiveTail | null {
    const mode = this.props.toolActivity;
    if (!isPrompting || (mode !== "grouped" && mode !== "compact")) return null;
    const start = latestUserMessageIndex + 1;
    // Live-turn tool calls, with "think" pseudo-steps left out: they trail a
    // real call rather than holding a tail slot of their own.
    const realToolIndices: number[] = [];
    for (let i = start; i < events.length; i++) {
      const event = events[i];
      if (event.eventKind !== "tool_call" || this.findTurnForIndex(i)) continue;
      if (event.kind !== "think") realToolIndices.push(i);
    }
    // Whether a rendered event follows each live-turn index, in one backward
    // pass — the per-"think" checks would otherwise rescan the suffix each
    // time, going quadratic on think-heavy turns. Blank streaming placeholders
    // render nothing, so they never count.
    const visibleAfter: boolean[] = new Array(Math.max(0, events.length - start));
    let seenVisible = false;
    for (let i = events.length - 1; i >= start; i--) {
      visibleAfter[i - start] = seenVisible;
      if (!isBlankAgentMessage(events[i]) && !isSteerMessage(events[i])) seenVisible = true;
    }
    const lastRealToolIndex = realToolIndices[realToolIndices.length - 1] ?? -1;
    // Anything visibly trailing the newest real call takes the second slot, so
    // only one real call stays out; otherwise the last two do.
    const trailingActivity =
      lastRealToolIndex === -1 ? seenVisible : visibleAfter[lastRealToolIndex - start];
    const keepReals = trailingActivity ? 1 : 2;
    const foldBoundary =
      realToolIndices.length >= keepReals
        ? realToolIndices[realToolIndices.length - keepReals]
        : -1;
    return {
      foldBoundary: this.clampFoldBoundaryToPinned(events, realToolIndices, foldBoundary),
      start,
      visibleAfter,
    };
  }

  /**
   * Freezes the fold boundary at the earliest pinned (user-expanded
   * standalone) tool: it and every tool after it stay out of the fold until
   * the user collapses it, at which point the boundary jumps forward to
   * wherever the tail computation has advanced. Tools already folded when
   * pinning happens (expanded from inside an open group) never appear here —
   * `ToolCallExpansionState` only pins standalone expands — so the boundary
   * still never moves backward.
   */
  private clampFoldBoundaryToPinned(
    events: SessionEvent[],
    realToolIndices: number[],
    foldBoundary: number,
  ): number {
    const pinned = this.expansion.pinnedToolCallIds;
    if (foldBoundary === -1 || pinned.size === 0) return foldBoundary;
    for (const index of realToolIndices) {
      if (index >= foldBoundary) break;
      const event = events[index];
      if (event.eventKind === "tool_call" && pinned.has(event.toolCallId)) return index;
    }
    return foldBoundary;
  }

  /**
   * Whether a live-turn tool has left the tail and may fold. A "think" step
   * folds once anything visible follows it; real calls fold once they leave the
   * two-slot tail.
   */
  private foldsBehindTail(event: ToolCall, index: number, tail: LiveTail): boolean {
    // A pinned tool never folds: the user expanded it standalone and is
    // reading it. Real calls are already covered by the boundary clamp; this
    // check also keeps a pinned "think" step out, since those fold by
    // trailing visibility rather than the boundary.
    if (this.expansion.pinnedToolCallIds.has(event.toolCallId)) return false;
    return event.kind === "think"
      ? tail.visibleAfter[index - tail.start]
      : index < tail.foldBoundary;
  }

  /**
   * Each interrupted turn's settled fold boundary and trailing-visibility map.
   * The live two-slot tail is an automatic layout-stability affordance, so once
   * the interrupt settles every finished tool becomes foldable. Explicitly
   * expanded tools still clamp the boundary: the earliest pin and every tool
   * after it remain visible (PE-2401, PE-2402). `visibleAfter` keeps trailing
   * thoughts and "think" steps on their existing streaming visibility rules.
   */
  private readonly interruptedTurnFolds = $derived.by(() => {
    const folds = new Map<TurnMetadata, LiveTail>();
    const turns = this.props.turns;
    const mode = this.props.toolActivity;
    if (!turns || (mode !== "grouped" && mode !== "compact")) return folds;
    const events = this.props.events;
    for (const turn of turns) {
      if (!turn.interrupted) continue;
      const start = turn.startIndex;
      const end = Math.min(turn.endIndex, events.length - 1);
      const realToolIndices: number[] = [];
      for (let i = start; i <= end; i++) {
        const event = events[i];
        if (event.eventKind !== "tool_call") continue;
        if (event.kind !== "think") realToolIndices.push(i);
      }
      const visibleAfter: boolean[] = new Array(Math.max(0, end - start + 1));
      let seenVisible = false;
      for (let i = end; i >= start; i--) {
        visibleAfter[i - start] = seenVisible;
        if (!isBlankAgentMessage(events[i]) && !isSteerMessage(events[i])) seenVisible = true;
      }
      // Every real tool is behind the settled boundary unless an explicit pin
      // pulls it back. `end + 1` is outside the turn, so every in-range index
      // satisfies `index < foldBoundary`.
      const foldBoundary = end + 1;
      folds.set(turn, {
        foldBoundary: this.clampFoldBoundaryToPinned(events, realToolIndices, foldBoundary),
        start,
        visibleAfter,
      });
    }
    return folds;
  });

  /**
   * Membership and shared group items for "compact" mode: each live span
   * between steer prompts folds into a summary line above the two-slot tail.
   * Unlike "grouped" it absorbs interim messages and allows single-tool folds;
   * steer prompts remain visible chronological boundaries between the spans.
   */
  private compactFoldsFor(
    events: SessionEvent[],
    liveTail: LiveTail | null,
  ): Map<number, { item: Extract<GroupedItem, { kind: "event_group" }>; pushed: boolean }> {
    const folds = new Map<
      number,
      { item: Extract<GroupedItem, { kind: "event_group" }>; pushed: boolean }
    >();
    if (!liveTail || this.props.toolActivity !== "compact") return folds;

    // A live steer is a visible chronological boundary. Build an independent
    // compact fold on each side so no later tool can be rendered above it.
    let segmentStart = liveTail.start;
    for (let i = segmentStart; i <= events.length; i++) {
      const isBoundary =
        i === events.length || (isSteerMessage(events[i]) && !this.findTurnForIndex(i));
      if (!isBoundary) continue;
      this.addCompactFoldForRange(folds, events, liveTail, segmentStart, i - 1);
      segmentStart = i + 1;
    }
    return folds;
  }

  private addCompactFoldForRange(
    folds: Map<number, { item: Extract<GroupedItem, { kind: "event_group" }>; pushed: boolean }>,
    events: SessionEvent[],
    liveTail: LiveTail,
    start: number,
    end: number,
  ): void {
    let lastToolIndex = -1;
    for (let i = start; i <= end; i++) {
      const event = events[i];
      // Earlier turns keep their own rendering (a summary, or expanded when
      // interrupted); only the live turn folds here.
      if (event.eventKind !== "tool_call" || this.findTurnForIndex(i)) continue;
      lastToolIndex = i;
    }
    if (lastToolIndex === -1) return;
    const items: SessionEventGroupItem[] = [];
    const indices = new Set<number>();
    for (let i = start; i <= end; i++) {
      if (this.findTurnForIndex(i)) continue;
      const event = events[i];
      if (event.eventKind !== "tool_call" || !this.isFinishedTool(event)) continue;
      if (!this.foldsBehindTail(event, i, liveTail)) continue;
      items.push({ event, index: i });
      indices.add(i);
    }
    // Unlike other groups, even a single folded tool renders as the line:
    // the constant two-slot tail matters more than the group-size nicety.
    if (items.length === 0) return;
    // The group id anchors on the first folded tool so it survives messages
    // joining the fold below.
    const idIndex = items[0].index;
    // Interim narration and reasoning fold too — matching how the end-of-turn
    // summary absorbs them — as soon as any tool call follows them, kept or
    // folded. Only trailing activity after every tool stays out: it is the
    // current thought or streaming/final reply. Agents narrate and reason
    // constantly between tools, which otherwise buries the summary line.
    for (let i = start; i <= end; i++) {
      const event = events[i];
      if (i >= lastToolIndex) continue;
      if (!SessionEventsState.isBufferable(event)) continue;
      if (isBlankAgentMessage(event)) continue;
      if (this.findTurnForIndex(i)) continue;
      items.push({ event, index: i });
      indices.add(i);
    }
    items.sort((a, b) => a.index - b.index);
    const fold = {
      item: {
        id: `group-${idIndex}`,
        kind: "event_group" as const,
        events: items,
        live: true,
      },
      pushed: false,
    };
    for (const i of indices) folds.set(i, fold);
  }

  /**
   * Per-turn cache for `interruptedCompactFoldsFor`, keyed by the turn's
   * `startIndex`. `Session.svelte.ts`'s `flushTranscript` rebuilds `turns`
   * (and every `TurnMetadata` object in it) on every transcript flush —
   * up to every `VISIBLE_TRANSCRIPT_FLUSH_MS` while a reply streams — so
   * caching by object reference would never hit; `startIndex` is the stable,
   * effectively-unique stand-in (turns don't overlap and offsets are
   * preserved across history rotation). An interrupted turn's own event range
   * is frozen the moment it finishes (`TurnMaterializer.finishCurrentTurn`
   * never revisits a pushed turn), so once computed, a fold never needs to
   * change — except if this `SessionEventsState` instance outlives a session
   * switch (it does; see `ChatSessionScope.svelte.ts`) and a new session's
   * turn reuses the same small `startIndex`. `startedAt`/`endIndex` are
   * stored alongside the fold to detect that case and recompute instead of
   * serving a stale fold. The fold also depends on the user's pins (a pinned
   * tool stays out of it), so the pinned set — reassigned wholesale on every
   * change — is stored by reference and any pin change recomputes. A plain
   * `Map`, not reactive state: reading a reactive collection from inside a
   * derived has caused infinite reactive loops in this codebase before.
   */
  private readonly interruptedFoldCache = new Map<
    number,
    {
      startedAt: string;
      endIndex: number;
      pinned: ReadonlySet<string>;
      item: Extract<GroupedItem, { kind: "event_group" }>;
      indices: Set<number>;
    }
  >();

  /**
   * Each interrupted "compact" turn's settled fold: the same membership rules
   * as `compactGroupFor`, expanded to include the automatic tail once
   * streaming ends. Finished tools before the earliest explicit pin and
   * interim messages with a later tool form one group per turn, anchored on
   * its first folded tool; single-tool folds remain allowed. Membership rather
   * than contiguity means interleaved thoughts render beside the fold without
   * splitting it into re-keyed groups, and folded interim messages stay in it.
   *
   * Folds are computed once per turn and cached in `interruptedFoldCache`
   * (see its doc comment): an interrupted turn's event range never changes,
   * so re-scanning it on every transcript flush would be O(interrupted turns
   * × their event ranges) on every flush during streaming, for turns whose
   * answer can never change. Steady state is an O(1) cache lookup per turn.
   */
  private interruptedCompactFoldsFor(
    events: SessionEvent[],
  ): Map<number, { item: Extract<GroupedItem, { kind: "event_group" }>; pushed: boolean }> {
    const folds = new Map<
      number,
      { item: Extract<GroupedItem, { kind: "event_group" }>; pushed: boolean }
    >();
    if (this.props.toolActivity !== "compact") return folds;
    const liveKeys = new Set<number>();
    for (const [turn, foldPlan] of this.interruptedTurnFolds) {
      const key = turn.startIndex;
      liveKeys.add(key);
      const pinned = this.expansion.pinnedToolCallIds;
      let cached = this.interruptedFoldCache.get(key);
      if (
        !cached ||
        cached.startedAt !== turn.startedAt ||
        cached.endIndex !== turn.endIndex ||
        cached.pinned !== pinned
      ) {
        const computed = this.computeInterruptedFold(events, turn, foldPlan);
        if (!computed) {
          this.interruptedFoldCache.delete(key);
          continue;
        }
        cached = { startedAt: turn.startedAt, endIndex: turn.endIndex, pinned, ...computed };
        this.interruptedFoldCache.set(key, cached);
      }
      const fold = { item: cached.item, pushed: false };
      for (const i of cached.indices) folds.set(i, fold);
    }
    // Drop entries for turns no longer among the interrupted folds (a full
    // transcript rewrite removed one, or this instance moved to a different
    // session) so the cache cannot grow unboundedly over the component's
    // lifetime.
    for (const key of this.interruptedFoldCache.keys()) {
      if (!liveKeys.has(key)) this.interruptedFoldCache.delete(key);
    }
    return folds;
  }

  /** Computes one interrupted turn's "compact" fold; see `interruptedCompactFoldsFor`. */
  private computeInterruptedFold(
    events: SessionEvent[],
    turn: TurnMetadata,
    foldPlan: LiveTail,
  ): { item: Extract<GroupedItem, { kind: "event_group" }>; indices: Set<number> } | null {
    const start = turn.startIndex;
    const end = Math.min(turn.endIndex, events.length - 1);
    let lastToolIndex = -1;
    for (let i = start; i <= end; i++) {
      if (events[i].eventKind === "tool_call") lastToolIndex = i;
    }
    if (lastToolIndex === -1) return null;
    const items: SessionEventGroupItem[] = [];
    const indices = new Set<number>();
    for (let i = start; i <= end; i++) {
      const event = events[i];
      if (event.eventKind !== "tool_call" || !this.isFinishedTool(event)) continue;
      if (!this.foldsBehindTail(event, i, foldPlan)) continue;
      items.push({ event, index: i });
      indices.add(i);
    }
    if (items.length === 0) return null;
    const idIndex = items[0].index;
    for (let i = start; i <= end; i++) {
      const event = events[i];
      if (i >= lastToolIndex && !isSteerMessage(event)) continue;
      if (
        (event.eventKind !== "agent_message" && !isSteerMessage(event)) ||
        isBlankAgentMessage(event)
      ) {
        continue;
      }
      items.push({ event, index: i });
      indices.add(i);
    }
    items.sort((a, b) => a.index - b.index);
    return {
      item: {
        id: `group-${idIndex}`,
        kind: "event_group" as const,
        events: items,
        turn,
        live: true,
      },
      indices,
    };
  }

  private nextGroupModeForTool(
    events: SessionEvent[],
    from: number,
    latestUserMessageIndex: number,
    liveTail: LiveTail | null,
  ): GroupMode | null {
    for (let j = from + 1; j < events.length; j++) {
      const e = events[j];
      if (SessionEventsState.isBufferable(e)) continue;
      return this.groupModeForTool(e, j, latestUserMessageIndex, liveTail);
    }
    return null;
  }

  private readonly turnByIndex = $derived.by(() => {
    const turns = this.props.turns;
    const lookup = new Map<number, TurnMetadata>();
    if (!turns) return lookup;
    for (const turn of turns) {
      for (let i = turn.startIndex; i <= turn.endIndex; i++) {
        if (!lookup.has(i)) lookup.set(i, turn); // preserve first-match semantics of .find()
      }
    }
    return lookup;
  });

  private findTurnForIndex(index: number): TurnMetadata | undefined {
    return this.turnByIndex.get(index);
  }

  private latestUserMessageIndex(events: readonly SessionEvent[]): number {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.eventKind === "user_message" && !event.steer) return i;
    }
    return -1;
  }
}

function isSteerMessage(event: SessionEvent): boolean {
  return event.eventKind === "user_message" && event.steer === true;
}

function isBlankAgentMessage(event: SessionEvent | undefined): boolean {
  if (event?.eventKind !== "agent_message") return false;
  if (event.content.length === 0) return true;
  return event.content.every((block) => block.type === "text" && block.text.trim().length === 0);
}

/** Events that never count as "real" content following a thought. */
function isTransientForThoughtVisibility(event: SessionEvent): boolean {
  return (
    event.eventKind === "agent_thought" ||
    event.eventKind === "mode_change" ||
    isBlankAgentMessage(event)
  );
}
