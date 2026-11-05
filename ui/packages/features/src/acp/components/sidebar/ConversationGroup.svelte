<script lang="ts">
  import type { ACPConversationSummary } from "../../navTypes";
  import { DEFAULT_AGENT_SERVER, LOCAL_AGENT_SERVER } from "../../agentServers";
  import Icon from "@camber/components/icon";
  import {
    hasAttentionDescendant,
    sliceVisibleSessions,
    subAgentSummaryLabel,
    summarizeDescendants,
    type DescendantSummary,
  } from "./conversationTree";
  import ConversationRowPopover from "./ConversationRowPopover.svelte";
  import { getAcpSidebarController } from "./SidebarController.svelte";

  interface Props {
    sessions: ACPConversationSummary[];
    workspacePath: string;
    searchQuery: string;
    expanded: boolean;
    visibleLimit: number;
    indent?: boolean;
    desktop?: boolean;
    rowIconSlotSize?: number;
    rowLeadingPaddingClass?: string;
    onToggleExpanded: (workspacePath: string) => void;
    onArchiveSession?: (session: ACPConversationSummary, event: MouseEvent) => void | Promise<void>;
    onArchiveSessionNow?: (
      session: ACPConversationSummary,
      event: MouseEvent,
    ) => void | Promise<void>;
    onSessionContextMenu?: (session: ACPConversationSummary, event: MouseEvent) => void;
    sessionShortcutHint?: (session: ACPConversationSummary) => string | undefined;
    isSessionExiting?: (session: ACPConversationSummary) => boolean;
    // Sub-agent nesting: descendants (already flattened) rendered under a row.
    descendantsFor?: (session: ACPConversationSummary) => readonly ACPConversationSummary[];
    isSubAgentsExpanded?: (session: ACPConversationSummary) => boolean;
    onToggleSubAgents?: (session: ACPConversationSummary) => void;
    // Label for a nested row living outside its parent's worktree.
    subAgentBadge?: (
      child: ACPConversationSummary,
      parent: ACPConversationSummary,
    ) => string | undefined;
  }

  let {
    sessions,
    workspacePath,
    searchQuery,
    expanded,
    visibleLimit,
    indent = false,
    desktop = false,
    rowIconSlotSize,
    rowLeadingPaddingClass = "pl-2",
    onToggleExpanded,
    onArchiveSession,
    onArchiveSessionNow,
    onSessionContextMenu,
    sessionShortcutHint,
    isSessionExiting,
    descendantsFor,
    isSubAgentsExpanded,
    onToggleSubAgents,
    subAgentBadge,
  }: Props = $props();

  const sidebar = getAcpSidebarController();

  // Past the limit, a parent still shows when a descendant is running, waiting,
  // unread or open (same rule as the sidebar's ⌘1–9 ordering).
  let visibleSessions = $derived(
    expanded
      ? sessions
      : sliceVisibleSessions(sessions, visibleLimit, (session) =>
          hasAttentionDescendant(visibleDescendants(session), (child) => sidebar.rowState(child)),
        ),
  );
  // Hidden rows include the visible descendants of hidden parents.
  let hiddenSessionCount = $derived.by(() => {
    const shown = new Set(visibleSessions);
    let count = 0;
    for (const session of sessions) {
      if (shown.has(session)) continue;
      count += 1 + visibleDescendants(session).length;
    }
    return count;
  });

  function visibleDescendants(session: ACPConversationSummary): ACPConversationSummary[] {
    return (descendantsFor?.(session) ?? []).filter((child) => isSessionExiting?.(child) !== true);
  }

  let showMoreVisible = $derived(
    searchQuery.trim() === "" &&
      (expanded ? sessions.length > visibleLimit : hiddenSessionCount > 0),
  );
  // An expanded last row whose sub-agents would otherwise drag the group's
  // connector past it. A "Show more" row below keeps them inside.
  let trailingParent = $derived.by(() => {
    const last = visibleSessions.at(-1);
    if (!last || showMoreVisible || isSubAgentsExpanded?.(last) !== true) return undefined;
    return visibleDescendants(last).length > 0 ? last : undefined;
  });

  // Center of the icon column: leading padding plus half the icon slot.
  let subAgentConnectorOffset = $derived(
    (rowLeadingPaddingClass === "pl-1" ? 4 : 8) +
      ((desktop ? (rowIconSlotSize ?? 14) : rowIconSlotSize) ?? 14) / 2 -
      0.5,
  );

  function summarize(descendants: readonly ACPConversationSummary[]): DescendantSummary {
    return summarizeDescendants(descendants, (child) => sidebar.rowState(child));
  }

  function desktopAgentIconSize(agentServer: string): number {
    return agentServer === DEFAULT_AGENT_SERVER || agentServer === LOCAL_AGENT_SERVER ? 14 : 13;
  }
</script>

{#snippet sessionRow(
  session: ACPConversationSummary,
  options: { descendants?: DescendantSummary; collapsed?: boolean; badge?: string },
)}
  {@const row = sidebar.rowState(session)}
  {@const rollup = options.collapsed ? options.descendants : undefined}
  {@const waitingForUser = row.waitingForUser || rollup?.waitingForUser === true}
  <ConversationRowPopover
    {session}
    agentName={row.agentName}
    iconUrl={row.iconUrl}
    selected={row.selected}
    iconClass={desktop ? "text-psx-foreground-secondary" : row.iconClass}
    titleClass={row.titleClass}
    iconSize={desktop ? desktopAgentIconSize(row.agentServer) : undefined}
    iconSlotSize={desktop ? (rowIconSlotSize ?? 14) : rowIconSlotSize}
    leadingPaddingClass={rowLeadingPaddingClass}
    working={row.working || (rollup?.working ?? 0) > 0}
    {waitingForUser}
    unread={row.unread || rollup?.unread === true}
    badge={options.badge}
    shortcutHint={sessionShortcutHint?.(session)}
    {desktop}
    isExiting={() => isSessionExiting?.(session) === true}
    onOpen={() => sidebar.openSession(session)}
    onArchive={(event) => onArchiveSession?.(session, event)}
    onArchiveNow={(event) => onArchiveSessionNow?.(session, event)}
    onContextMenu={(event) => onSessionContextMenu?.(session, event)}
  />
{/snippet}

{#snippet subAgents(parent: ACPConversationSummary, descendants: readonly ACPConversationSummary[])}
  <!-- Same connector as worktree conversations, hanging from the chevron. -->
  <div
    class="desktop-conversation-connector before:border-psx-border relative pl-[14px] before:pointer-events-none before:absolute before:bottom-[14px] before:left-0 before:top-0 before:w-[10px] before:rounded-bl-[5px] before:border-b before:border-l before:content-['']"
    style={`margin-left: ${subAgentConnectorOffset}px`}
  >
    {#each descendants as child (`${sidebar.getSessionAgentServer(child)}:${child.id}`)}
      {@render sessionRow(child, { badge: subAgentBadge?.(child, parent) })}
    {/each}
  </div>
{/snippet}

{#if sessions.length > 0}
  <div
    class={indent
      ? "desktop-conversation-connector before:border-psx-border relative ml-[11.5px] pl-[14px] before:pointer-events-none before:absolute before:bottom-[14px] before:left-0 before:top-0 before:w-[10px] before:rounded-bl-[5px] before:border-b before:border-l before:content-['']"
      : ""}
  >
    {#each visibleSessions as session (`${sidebar.getSessionAgentServer(session)}:${session.id}`)}
      {@const descendants = visibleDescendants(session)}
      {@const subAgentsExpanded = isSubAgentsExpanded?.(session) === true}
      {@const summary = descendants.length > 0 ? summarize(descendants) : undefined}
      {@render sessionRow(session, {
        descendants: summary,
        collapsed: !subAgentsExpanded,
      })}
      {#if summary}
        <button
          type="button"
          class="text-psx-foreground-tertiary outline-hidden hover:bg-psx-menu-hover-background hover:text-psx-foreground-secondary focus-visible:outline-psx-focus flex w-full items-center gap-2 rounded-[6px] py-[5px] pr-2 text-left text-[13px]/[16px] focus-visible:outline-2 {rowLeadingPaddingClass}"
          aria-expanded={subAgentsExpanded}
          aria-label={`${subAgentsExpanded ? "Collapse" : "Expand"} ${subAgentSummaryLabel(summary, subAgentsExpanded)}`}
          onclick={() => onToggleSubAgents?.(session)}
        >
          <!-- The chevron sits in the parent row's icon column so the label
               lines up with conversation titles. -->
          <span
            class={[
              "text-psx-icon inline-flex shrink-0 items-center justify-center transition-transform",
              subAgentsExpanded ? "" : "-rotate-90",
            ]}
            style={`width: ${(desktop ? (rowIconSlotSize ?? 14) : rowIconSlotSize) ?? 14}px`}
            aria-hidden="true"
          >
            <Icon name="chevron" size={12} />
          </span>
          <span class="truncate">{subAgentSummaryLabel(summary, subAgentsExpanded)}</span>
        </button>
        {#if subAgentsExpanded && session !== trailingParent}
          {@render subAgents(session, descendants)}
        {/if}
      {/if}
    {/each}

    {#if showMoreVisible}
      <button
        type="button"
        class="text-psx-foreground-tertiary outline-hidden hover:bg-psx-menu-hover-background hover:text-psx-foreground-secondary focus-visible:outline-psx-focus flex w-full items-center gap-1 rounded-[6px] px-2 py-1.5 text-left text-[13px]/[16px] focus-visible:outline-2"
        onclick={() => onToggleExpanded(workspacePath)}
      >
        {expanded ? "Show less" : `Show ${hiddenSessionCount} more`}
      </button>
    {/if}
  </div>
  {#if trailingParent}
    <!-- The group's connector ends at the last top-level item; the expanded
         sub-agents of that item sit below it at the same indent. -->
    <div class={indent ? "ml-[11.5px] pl-[14px]" : ""}>
      {@render subAgents(trailingParent, visibleDescendants(trailingParent))}
    </div>
  {/if}
{/if}
