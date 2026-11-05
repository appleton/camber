import { DEFAULT_AGENT_SERVER, normalizeAgentServerName } from "./agentServers";
import {
  normalizeACPSessionMetadata,
  type ACPSessionMetadataSnapshot,
} from "./features/session/SessionMetadata";
import type { ACPResolvedSessionInfo } from "./sessionInfo";
import { ACP_CHAT_WORKSPACE_PATH } from "./workspaceScope";

export const ACP_SESSION_DELETE_EVENT = "session:delete";
export const ACP_SESSION_CLOSE_EVENT = "session:close";
export const ACP_DESKTOP_PROJECTS_EVENT = "desktop-projects:state";
export const ACP_DESKTOP_CONVERSATIONS_EVENT = "desktop-conversations:state";

export type ACPConversationSummary = Omit<ACPResolvedSessionInfo, "sessionId"> & {
  id: string;
  sessionId: string | null;
  agentServer: string;
  workingDirectories: string[];
  nickname?: string | null;
  draftPromptPresent?: boolean;
  metadata?: ACPSessionMetadataSnapshot;
  liveStatus?: ACPConversationLiveStatus;
  // Nav workspace (project or worktree path) the conversation belongs to.
  // Unlike cwd this survives worktree removal: the helper rehomes archived
  // conversations to the parent project.
  workspacePath?: string;
  // False when the agent server reported its full session list and this
  // session was not in it (the agent deleted or lost it). Undefined when
  // unknown (server unreachable, list unsupported, or list truncated).
  sessionAvailable?: boolean;
  // Conversation that spawned this one (camber chat spawn), and the top-most
  // ancestor. A conversation without a parent may carry rootId === id.
  parentId?: string;
  rootId?: string;
};

export function isACPChatConversation(
  conversation: Pick<ACPConversationSummary, "workspacePath">,
): boolean {
  return conversation.workspacePath === ACP_CHAT_WORKSPACE_PATH;
}

export interface ACPConversationLiveStatus {
  working: boolean;
  waitingForUser: boolean;
  unread: boolean;
}

// Discriminator for transient worktree UI state. `creating` and `running_setup`
// happen during prepareWorktree -> createWorktree -> setup. `tearing_down` and
// `deleting` happen during removeWorktree. Undefined means the worktree is
// idle. Kept as a literal union so typos are compile errors.
export type WorktreeBusyKind = "creating" | "running_setup" | "tearing_down" | "deleting";

export interface ACPNavProject {
  path: string;
  name: string;
  nickname?: string;
  isWorktree: boolean;
  parentPath?: string;
  collapsed: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  busy?: WorktreeBusyKind;
  deleteRequested?: boolean;
  setupScript?: string;
  teardownScript?: string;
  userPrompt?: string;
}

export function worktreeBusyLabel(kind: WorktreeBusyKind): string {
  switch (kind) {
    case "creating":
      return "creating";
    case "running_setup":
      return "running setup";
    case "tearing_down":
      return "tearing down";
    case "deleting":
      return "deleting";
  }
}

// Whether the worktree should be unclickable for the duration. We allow opening
// the worktree while its setup script runs (the dir exists by then) but block
// it for all other transient states.
export function worktreeBlocksUI(kind: WorktreeBusyKind): boolean {
  return kind !== "running_setup";
}

export function compareWorktreesByCreatedDesc(a: ACPNavProject, b: ACPNavProject): number {
  const createdDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (createdDiff !== 0) return createdDiff;
  return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
}

// Worktrees render in their persisted display_order (ascending), mirroring the
// helper's list ordering, with newest-first as the tiebreak for rows that share
// an order (e.g. freshly created worktrees before an explicit reorder).
export function compareWorktreesByDisplayOrder(a: ACPNavProject, b: ACPNavProject): number {
  const orderDiff = a.displayOrder - b.displayOrder;
  if (orderDiff !== 0) return orderDiff;
  return compareWorktreesByCreatedDesc(a, b);
}

// Flattens a projects list into render order: each root project (depth 0)
// immediately followed by its display-order-sorted worktrees (depth 1). Shared
// by the pickers so the "roots first, then their worktrees" rule lives once.
export function flattenProjectsWithWorktrees(
  projects: readonly ACPNavProject[],
): { project: ACPNavProject; depth: number }[] {
  const worktreesByParent = new Map<string, ACPNavProject[]>();
  for (const project of projects) {
    if (project.isWorktree && project.parentPath) {
      const list = worktreesByParent.get(project.parentPath) ?? [];
      list.push(project);
      worktreesByParent.set(project.parentPath, list);
    }
  }
  const flattened: { project: ACPNavProject; depth: number }[] = [];
  for (const project of projects) {
    if (project.isWorktree) continue;
    flattened.push({ project, depth: 0 });
    const worktrees = (worktreesByParent.get(project.path) ?? [])
      .slice()
      .sort(compareWorktreesByDisplayOrder);
    for (const worktree of worktrees) {
      flattened.push({ project: worktree, depth: 1 });
    }
  }
  return flattened;
}

export interface ACPNavProjectSettings {
  path: string;
  setupScript: string;
  teardownScript: string;
  userPrompt: string;
}

export interface ACPNavConversation {
  id: string;
  workspacePath: string;
  agentServer: string;
  sessionId?: string;
  cwd: string;
  title?: string;
  nickname?: string;
  updatedAt?: string;
  active: boolean;
  archived: boolean;
  workingDirectories: string[];
  metadata?: unknown;
  liveStatus?: ACPConversationLiveStatus;
  parentId?: string;
  rootId?: string;
}

export interface ACPNavState {
  projects: ACPNavProject[];
  conversations: ACPNavConversation[];
}

export interface ACPProjectsState {
  projects: ACPNavProject[];
}

export interface ACPConversationsState {
  sessions: ACPConversationSummary[];
}

export interface ACPClosedSession {
  sessionId?: string | null;
  conversationId?: string | null;
  agentServer: string;
}

export function countAttentionConversations<
  TConversation extends {
    active?: boolean;
    archived?: boolean;
    liveStatus?: ACPConversationLiveStatus;
  },
>(
  conversations: readonly TConversation[],
  getLiveStatus?: (conversation: TConversation) => ACPConversationLiveStatus | undefined,
): number {
  let count = 0;
  for (const conversation of conversations) {
    if (conversation.active === false || conversation.archived) continue;
    const liveStatus = getLiveStatus?.(conversation) ?? conversation.liveStatus;
    if (liveStatus?.waitingForUser || liveStatus?.unread) {
      count += 1;
    }
  }
  return count;
}

export function sortConversationSummaries(
  a: ACPConversationSummary,
  b: ACPConversationSummary,
): number {
  if (!a.updatedAt && !b.updatedAt) {
    const serverDiff = a.agentServer.localeCompare(b.agentServer);
    return serverDiff || (a.sessionId ?? a.id).localeCompare(b.sessionId ?? b.id);
  }
  if (!a.updatedAt) {
    return 1;
  }
  if (!b.updatedAt) {
    return -1;
  }

  const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  if (timeDiff !== 0) {
    return timeDiff;
  }

  const serverDiff = a.agentServer.localeCompare(b.agentServer);
  return serverDiff || (a.sessionId ?? a.id).localeCompare(b.sessionId ?? b.id);
}

export function dedupeConversationSummaries(
  sessions: ACPConversationSummary[],
): ACPConversationSummary[] {
  const bySession = new Map<string, ACPConversationSummary>();
  for (const session of sessions) {
    const key = session.id;
    const existing = bySession.get(key);
    if (!existing || compareUpdatedAt(session.updatedAt, existing.updatedAt) > 0) {
      bySession.set(key, session);
    }
  }
  return Array.from(bySession.values()).sort(sortConversationSummaries);
}

export function conversationToNav(
  workspacePath: string,
  session: ACPConversationSummary,
): ACPNavConversation {
  const cwd = session.cwd || "";
  return {
    id: session.id,
    workspacePath,
    agentServer: normalizeAgentServerName(session.agentServer),
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    cwd,
    title: session.title ?? undefined,
    nickname: session.nickname ?? undefined,
    updatedAt: session.updatedAt ?? undefined,
    active: true,
    archived: false,
    workingDirectories: cloneWorkingDirectories(session.workingDirectories, cwd),
    metadata: normalizeACPSessionMetadata(session.metadata),
    ...(session.parentId ? { parentId: session.parentId } : {}),
    ...(session.rootId ? { rootId: session.rootId } : {}),
  };
}

export function navToConversationSummary(conversation: ACPNavConversation): ACPConversationSummary {
  return {
    id: conversation.id,
    sessionId: conversation.sessionId ?? null,
    agentServer: normalizeAgentServerName(conversation.agentServer),
    cwd: conversation.cwd,
    workspacePath: conversation.workspacePath,
    workingDirectories: cloneWorkingDirectories(conversation.workingDirectories, conversation.cwd),
    metadata: normalizeACPSessionMetadata(conversation.metadata),
    title: conversation.nickname || conversation.title || null,
    nickname: conversation.nickname || null,
    updatedAt: conversation.updatedAt ?? null,
    source: "native_session",
    readOnly: false,
    errorMessage: null,
    cancellationReason: null,
    conversationId: null,
    conversationKind: null,
    agentId: null,
    liveStatus: conversation.liveStatus,
    ...(conversation.parentId ? { parentId: conversation.parentId } : {}),
    ...(conversation.rootId ? { rootId: conversation.rootId } : {}),
    _meta: {},
  };
}

export function pendingConversationSummary(input: {
  id: string;
  cwd: string;
  agentServer?: string;
  updatedAt?: string;
  workingDirectories?: string[];
}): ACPConversationSummary {
  return {
    id: input.id,
    sessionId: null,
    agentServer: normalizeAgentServerName(input.agentServer ?? DEFAULT_AGENT_SERVER),
    cwd: input.cwd,
    workingDirectories: cloneWorkingDirectories(input.workingDirectories, input.cwd),
    title: "New conversation",
    nickname: null,
    draftPromptPresent: false,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    source: "native_session",
    readOnly: false,
    errorMessage: null,
    cancellationReason: null,
    conversationId: null,
    conversationKind: null,
    agentId: null,
    metadata: undefined,
    _meta: {},
  };
}

export function newConversationID(): string {
  return `conversation:${crypto.randomUUID()}`;
}

function compareUpdatedAt(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return new Date(a).getTime() - new Date(b).getTime();
}

function cloneWorkingDirectories(
  workingDirectories: readonly string[] | undefined,
  fallbackCwd: string,
): string[] {
  const source = workingDirectories?.length ? workingDirectories : [fallbackCwd].filter(Boolean);
  return Array.from(source);
}
