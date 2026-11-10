const RECENTLY_VIEWED_CONVERSATIONS_STORAGE_KEY = "camber.desktop.recentlyViewedConversations.v1";
const RECENTLY_VIEWED_CONVERSATIONS_LIMIT = 100;

type ConversationRecencyStorage = Pick<Storage, "getItem" | "setItem">;

export interface ConversationSearchOrderState {
  key: string;
  updatedAt?: string | null;
  waitingForUser: boolean;
  unread: boolean;
  archived?: boolean;
}

export function orderConversationSearchItems<T>(
  items: readonly T[],
  recentlyViewedKeys: readonly string[],
  stateFor: (item: T) => ConversationSearchOrderState,
): T[] {
  const recentlyViewedRank = new Map(recentlyViewedKeys.map((key, index) => [key, index]));
  return items
    .map((item, index) => ({ item, index, state: stateFor(item) }))
    .filter(({ state }) => !state.archived)
    .sort((left, right) => {
      const priorityDiff = statusPriority(left.state) - statusPriority(right.state);
      if (priorityDiff !== 0) return priorityDiff;

      if (!left.state.waitingForUser && !left.state.unread) {
        const leftRank = recentlyViewedRank.get(left.state.key) ?? Number.POSITIVE_INFINITY;
        const rightRank = recentlyViewedRank.get(right.state.key) ?? Number.POSITIVE_INFINITY;
        if (leftRank !== rightRank) return leftRank - rightRank;
      }

      const recencyDiff = compareUpdatedAtDesc(left.state.updatedAt, right.state.updatedAt);
      return recencyDiff || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function recordRecentlyViewedConversation(keys: readonly string[], key: string): string[] {
  if (!key) return [...keys];
  return [key, ...keys.filter((candidate) => candidate !== key)].slice(
    0,
    RECENTLY_VIEWED_CONVERSATIONS_LIMIT,
  );
}

export function readRecentlyViewedConversations(
  storage: ConversationRecencyStorage | undefined = globalThis.localStorage,
): string[] {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(RECENTLY_VIEWED_CONVERSATIONS_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(parsed.filter((value): value is string => typeof value === "string" && value !== "")),
    ).slice(0, RECENTLY_VIEWED_CONVERSATIONS_LIMIT);
  } catch {
    return [];
  }
}

export function writeRecentlyViewedConversations(
  keys: readonly string[],
  storage: ConversationRecencyStorage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(RECENTLY_VIEWED_CONVERSATIONS_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Recency remains available for this webview when storage is unavailable.
  }
}

function statusPriority(state: ConversationSearchOrderState): number {
  if (state.waitingForUser) return 0;
  if (state.unread) return 1;
  return 2;
}

function compareUpdatedAtDesc(left?: string | null, right?: string | null): number {
  const leftTime = timestamp(left);
  const rightTime = timestamp(right);
  if (leftTime === rightTime) return 0;
  return rightTime > leftTime ? 1 : -1;
}

function timestamp(value?: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
