// Nesting of spawned conversations (sub-agents) under their parent in the
// desktop sidebar. Pure so the parent resolution rules stay testable: the
// sidebar feeds in the conversations it can currently show and renders the
// result, one indent level deep.
import type { ACPConversationLiveStatus } from "../../navTypes";

export interface ConversationTreeNode {
  id: string;
  parentId?: string | null;
  rootId?: string | null;
}

export interface ConversationTree<T extends ConversationTreeNode> {
  // Conversations that render as ordinary rows in their own section, in input order.
  topLevel: readonly T[];
  // True when the conversation renders nested under another row instead.
  isNested(id: string): boolean;
  // Every visible descendant of a top-level conversation (grandchildren and
  // deeper are flattened here), in input order. Empty for anything else.
  descendantsOf(id: string): readonly T[];
  // The top-level conversation a nested conversation renders under.
  topAncestorOf(id: string): T | undefined;
}

const NO_DESCENDANTS: readonly never[] = [];

// `items` is the set of conversations visible in the sidebar (archived,
// deleted and filtered-out ones already removed); `flat` disables nesting. A conversation whose parent is
// not among them falls back to being top-level.
//
// `canNestUnder` says whether an ancestor's row container is actually on screen
// (not exiting, section expanded, ...). A conversation only nests under the
// highest ancestor that passes; when none does it stays top-level in its own
// section so it never vanishes. It must not depend on the tree's own output.
export function buildConversationTree<T extends ConversationTreeNode>(
  items: readonly T[],
  options: { flat?: boolean; canNestUnder?: (ancestor: T) => boolean } = {},
): ConversationTree<T> {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  // The visible conversation this one hangs off. parentId is authoritative;
  // rootId only stands in when the parent is not visible. A missing or empty
  // parentId, a self-reference, or rootId === id (a spawn without a parent)
  // all mean top-level.
  function parentOf(item: T): T | undefined {
    if (options.flat) return undefined;
    const parentId = item.parentId || undefined;
    if (parentId && parentId !== item.id) {
      const parent = byId.get(parentId);
      if (parent) return parent;
      const rootId = item.rootId || undefined;
      if (rootId && rootId !== item.id) return byId.get(rootId);
    }
    return undefined;
  }

  const topAncestors = new Map<string, T | undefined>();
  function topAncestor(item: T): T | undefined {
    if (topAncestors.has(item.id)) return topAncestors.get(item.id);
    const seen = new Set<string>([item.id]);
    let top: T | undefined;
    let current = item;
    for (;;) {
      const parent = parentOf(current);
      if (!parent) break;
      if (seen.has(parent.id)) {
        // A cycle has no top: every conversation touching one stays top-level
        // rather than vanishing from the list.
        top = undefined;
        break;
      }
      seen.add(parent.id);
      if (!options.canNestUnder || options.canNestUnder(parent)) top = parent;
      current = parent;
    }
    topAncestors.set(item.id, top);
    return top;
  }

  const topLevel: T[] = [];
  const descendants = new Map<string, T[]>();
  const nested = new Set<string>();
  for (const item of items) {
    const top = topAncestor(item);
    if (!top || top.id === item.id) {
      topLevel.push(item);
      continue;
    }
    nested.add(item.id);
    const list = descendants.get(top.id);
    if (list) list.push(item);
    else descendants.set(top.id, [item]);
  }

  return {
    topLevel,
    isNested: (id) => nested.has(id),
    descendantsOf: (id) => descendants.get(id) ?? NO_DESCENDANTS,
    topAncestorOf: (id) => (nested.has(id) ? topAncestors.get(id) : undefined),
  };
}

export interface DescendantSummary {
  count: number;
  working: number;
  waitingForUser: boolean;
  unread: boolean;
}

// Aggregates live status over a parent's descendants so a collapsed parent can
// surface a running, waiting or unread child.
export function summarizeDescendants<T>(
  descendants: readonly T[],
  getStatus: (item: T) => Pick<ACPConversationLiveStatus, "working" | "waitingForUser" | "unread">,
): DescendantSummary {
  const summary: DescendantSummary = {
    count: descendants.length,
    working: 0,
    waitingForUser: false,
    unread: false,
  };
  for (const item of descendants) {
    const status = getStatus(item);
    if (status.working) summary.working += 1;
    if (status.waitingForUser) summary.waitingForUser = true;
    if (status.unread) summary.unread = true;
  }
  return summary;
}

export function subAgentSummaryLabel(summary: DescendantSummary, expanded: boolean): string {
  const noun = summary.count === 1 ? "sub-agent" : "sub-agents";
  const base = `${summary.count} ${noun}`;
  return !expanded && summary.working > 0 ? `${base} · ${summary.working} running` : base;
}

// The first `limit` top-level conversations plus any later one `shouldKeep`
// selects (e.g. a parent hiding a running or selected sub-agent), in the
// original order. Shared by rendering and the ⌘1–9 ordering so they agree.
export function sliceVisibleSessions<T>(
  sessions: readonly T[],
  limit: number,
  shouldKeep: (session: T) => boolean,
): T[] {
  return sessions.filter((session, index) => index < limit || shouldKeep(session));
}

// True when any descendant is running, waiting on the user, unread or the open
// conversation: such a parent must stay visible past the truncation limit so
// the child (or its roll-up indicator) is not hidden.
export function hasAttentionDescendant<T>(
  descendants: readonly T[],
  getState: (item: T) => {
    selected?: boolean;
    working?: boolean;
    waitingForUser?: boolean;
    unread?: boolean;
  },
): boolean {
  return descendants.some((item) => {
    const state = getState(item);
    return Boolean(state.selected || state.working || state.waitingForUser || state.unread);
  });
}
