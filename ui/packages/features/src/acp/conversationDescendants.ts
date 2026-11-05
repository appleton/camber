// Pure parent-link walk shared by the sidebar archive cascade and the
// unread-clearing logic. Independent of any rendered tree, search or collapse.

export interface ParentLinked {
  id: string;
  parentId?: string | null;
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
