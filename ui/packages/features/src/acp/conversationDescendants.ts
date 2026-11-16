// Pure parent-link walks shared by the sidebar (nesting and archive cascade),
// unread clearing and the app badge. Independent of any rendered tree, search
// or collapse. The sidebar-group rule mirrors the helper's archive cascade
// (acpnav sidebarGroup): a conversation only renders as a sub-agent of an
// ancestor in the same group.
import { ACP_CHAT_WORKSPACE_PATH } from "./workspaceScope";

export interface ParentLinked {
  id: string;
  parentId?: string | null;
}

export interface SidebarGrouped {
  workspacePath?: string | null;
  cwd?: string | null;
}

export interface SubAgentCandidate extends ParentLinked, SidebarGrouped {
  rootId?: string | null;
}

// Every transitive descendant of `id` found by following `parentId` links over
// `items`, in breadth-first order. Cycle-safe; `id` itself is never returned.
export function collectDescendantIds<T extends ParentLinked>(items: readonly T[], id: string): T[] {
  const childrenByParent = new Map<string, T[]>();
  for (const item of items) {
    if (!item.parentId || item.parentId === item.id) continue;
    const siblings = childrenByParent.get(item.parentId);
    if (siblings) siblings.push(item);
    else childrenByParent.set(item.parentId, [item]);
  }
  const seen = new Set<string>([id]);
  const result: T[] = [];
  const queue = [id];
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      result.push(child);
    }
  }
  return result;
}

// Whether two conversations render in the same sidebar group: both in Chats,
// or neither in Chats and in the same working directory (project or worktree).
export function sharesSidebarGroup(a: SidebarGrouped, b: SidebarGrouped): boolean {
  const aIsChat = a.workspacePath === ACP_CHAT_WORKSPACE_PATH;
  const bIsChat = b.workspacePath === ACP_CHAT_WORKSPACE_PATH;
  if (aIsChat || bIsChat) return aIsChat && bIsChat;
  return a.cwd === b.cwd;
}

// The descendants of `id` that render as its sub-agents: every `parentId`
// descendant in the same sidebar group as `id`. The walk continues through
// descendants in other groups, so a same-group conversation below a sub-agent
// working in another worktree still counts (as in the helper's cascade).
export function collectSubAgentDescendants<T extends ParentLinked & SidebarGrouped>(
  items: readonly T[],
  id: string,
): T[] {
  const root = items.find((item) => item.id === id);
  if (!root) return [];
  return collectDescendantIds(items, id).filter((child) => sharesSidebarGroup(child, root));
}

// Whether `item` renders nested as a sub-agent: some ancestor present in
// `byId` shares its sidebar group. Ancestors resolve as in the sidebar tree
// (parentId, with rootId standing in when the parent is absent). A parent
// cycle means top-level, matching the sidebar.
export function isRenderedSubAgent<T extends SubAgentCandidate>(
  item: T,
  byId: ReadonlyMap<string, T>,
): boolean {
  const seen = new Set<string>([item.id]);
  let nested = false;
  let current: T = item;
  for (;;) {
    const parent = parentOf(current, byId);
    if (!parent) return nested;
    if (seen.has(parent.id)) return false;
    seen.add(parent.id);
    if (!nested && sharesSidebarGroup(item, parent)) nested = true;
    current = parent;
  }
}

function parentOf<T extends SubAgentCandidate>(
  item: T,
  byId: ReadonlyMap<string, T>,
): T | undefined {
  const parentId = item.parentId || undefined;
  if (!parentId || parentId === item.id) return undefined;
  const parent = byId.get(parentId);
  if (parent) return parent;
  const rootId = item.rootId || undefined;
  if (rootId && rootId !== item.id) return byId.get(rootId);
  return undefined;
}
