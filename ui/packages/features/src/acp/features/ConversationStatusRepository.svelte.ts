import type { SessionId } from "@agentclientprotocol/sdk";
import { keyBy, mapValues } from "lodash";
import { createContext } from "svelte";
import { DEFAULT_AGENT_SERVER, normalizeAgentServerName } from "../agentServers";
import type {
  NotificationRepository,
  NotificationShowParams,
} from "./NotificationRepository.svelte";
import type { ACPConversationLiveStatus } from "./session";

export type ACPConversationStatusRepository = Readonly<ACPConversationStatusRepositoryWriter>;

type LiveSessionStatus = Pick<NotificationShowParams, "agentServer"> &
  Pick<ACPConversationLiveStatus, "working" | "waitingForUser"> & {
    conversationId: string;
    sessionId: SessionId | null;
  };

export interface DescendantCandidate {
  id: string;
  parentId?: string | null;
  sessionId: string | null;
  agentServer: string;
  liveStatus?: ACPConversationLiveStatus;
}

const emptyConversationStatus: ACPConversationLiveStatus = {
  working: false,
  waitingForUser: false,
  unread: false,
};

export class ACPConversationStatusRepositoryWriter {
  private statuses = $state.raw<Record<string, ACPConversationLiveStatus>>({});
  private conversationBySession = new Map<string, string>();
  // Helper-pushed statuses from the conversation summaries — the only signal
  // for turns driven on ANOTHER surface (see SidebarController.rowLiveStatus);
  // `syncLiveSessions` only sees this surface's own flags. Plain Map, not
  // $state: consumed by untracked lifecycle checks (eviction / idle-close
  // protection); the sidebar reads pushed liveStatus off the summaries itself.
  private remoteStatuses = new Map<
    string,
    Pick<ACPConversationLiveStatus, "working" | "waitingForUser">
  >();
  private remoteStatusRevision = $state(0);

  constructor(private notifications?: NotificationRepository) {}

  /**
   * Local status merged with the helper-pushed remote overlay. NOTE: the
   * remote overlay is intentionally NOT reactive ($state) — it exists for
   * untracked lifecycle checks (eviction / idle-close protection). Reactive
   * consumers only re-derive when the local `statuses` record changes;
   * anything that must render remote turns should read the pushed liveStatus
   * off the conversation summaries instead (see SidebarController).
   */
  getConversationStatus(
    sessionId: SessionId,
    agentServer = DEFAULT_AGENT_SERVER,
  ): ACPConversationLiveStatus {
    const conversationId = this.getConversationId(sessionId, agentServer);
    const local = conversationId
      ? (this.statuses[conversationId] ?? emptyConversationStatus)
      : emptyConversationStatus;
    const remote = this.remoteStatuses.get(sessionKey(sessionId, agentServer));
    if (!remote) return local;
    return {
      ...local,
      working: local.working || remote.working,
      waitingForUser: local.waitingForUser || remote.waitingForUser,
    };
  }

  /**
   * Ingest the helper-pushed live statuses that ride on conversation
   * summaries, so cross-surface turns are visible to status consumers.
   * Replaces the previous remote snapshot wholesale on every nav push.
   */
  syncRemoteStatuses(
    sessions: readonly {
      sessionId: SessionId | null;
      agentServer: string;
      liveStatus?: ACPConversationLiveStatus;
    }[],
  ): void {
    this.remoteStatuses.clear();
    for (const session of sessions) {
      if (!session.sessionId || !session.liveStatus) continue;
      const { working, waitingForUser } = session.liveStatus;
      if (!working && !waitingForUser) continue;
      this.remoteStatuses.set(
        sessionKey(session.sessionId, normalizeAgentServerName(session.agentServer)),
        { working, waitingForUser },
      );
    }
    this.remoteStatusRevision += 1;
  }

  get hasWorkingConversation(): boolean {
    void this.remoteStatusRevision;
    return (
      Object.values(this.statuses).some((status) => status.working) ||
      [...this.remoteStatuses.values()].some((status) => status.working)
    );
  }

  hasWorkingConversationForAgent(agentServer: string): boolean {
    void this.remoteStatusRevision;
    const prefix = `${normalizeAgentServerName(agentServer)}\0`;
    for (const [key, status] of this.remoteStatuses) {
      if (key.startsWith(prefix) && status.working) return true;
    }
    for (const [key, conversationId] of this.conversationBySession) {
      if (key.startsWith(prefix) && this.statuses[conversationId]?.working) return true;
    }
    return false;
  }

  syncLiveSessions(sessions: LiveSessionStatus[]): void {
    const liveSessionKeys = new Set<string>();

    for (const session of sessions) {
      if (session.sessionId) {
        const key = sessionKey(session.sessionId, session.agentServer);
        liveSessionKeys.add(key);
        this.conversationBySession.set(key, session.conversationId);
      }
    }

    for (const key of this.conversationBySession.keys()) {
      if (!liveSessionKeys.has(key)) {
        this.conversationBySession.delete(key);
      }
    }

    const next = mapValues(keyBy(sessions, "conversationId"), (session) => ({
      working: session.working,
      waitingForUser: session.waitingForUser,
      unread: this.statuses[session.conversationId]?.unread ?? false,
    }));
    // Called on every session update of every session; keep the record's
    // identity stable when no status changed so sidebar rows and tab status
    // badges are not re-derived once per streaming chunk.
    if (!statusesEqual(this.statuses, next)) {
      this.statuses = next;
    }
  }

  markUnread(sessionId: SessionId, agentServer: string): void {
    this.patchSessionStatus(sessionId, agentServer, { working: false, unread: true });
    this.notifications?.dismiss(sessionId, agentServer);
    void this.notifications?.show({ type: "turn_completed", sessionId, agentServer });
  }

  clearUnread(sessionId: SessionId, agentServer: string): void {
    this.patchSessionStatus(sessionId, agentServer, { unread: false });
    this.notifications?.dismiss(sessionId, agentServer);
  }

  /**
   * Clears the turn-completed unread state (and its notification) of every
   * descendant of `conversationId`, found by walking `parentId` over
   * `conversations`. Descendants waiting for the user are left untouched. One-shot:
   * call it when the parent becomes viewed; later completions mark unread as usual.
   */
  clearDescendantUnread(
    conversationId: string,
    conversations: readonly DescendantCandidate[],
  ): void {
    const childrenByParent = new Map<string, DescendantCandidate[]>();
    for (const conversation of conversations) {
      if (!conversation.parentId || conversation.parentId === conversation.id) continue;
      const siblings = childrenByParent.get(conversation.parentId);
      if (siblings) siblings.push(conversation);
      else childrenByParent.set(conversation.parentId, [conversation]);
    }
    const seen = new Set<string>([conversationId]);
    const queue = [conversationId];
    while (queue.length > 0) {
      for (const child of childrenByParent.get(queue.shift()!) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        queue.push(child.id);
        if (!child.sessionId) continue;
        const agentServer = normalizeAgentServerName(child.agentServer);
        const status = this.getConversationStatus(child.sessionId as SessionId, agentServer);
        if (status.unread && !status.waitingForUser && !child.liveStatus?.waitingForUser) {
          this.clearUnread(child.sessionId as SessionId, agentServer);
        }
      }
    }
  }

  markWaitingForUser(params: NotificationShowParams): void {
    this.patchSessionStatus(params.sessionId, params.agentServer, {
      waitingForUser: true,
      unread: true,
    });
    void this.notifications?.show(params);
  }

  clearWaitingForUser(sessionId: SessionId, agentServer: string): void {
    this.patchSessionStatus(sessionId, agentServer, { waitingForUser: false });
    this.notifications?.dismiss(sessionId, agentServer);
  }

  publicAPI(): ACPConversationStatusRepository {
    return this as ACPConversationStatusRepository;
  }

  private patchSessionStatus(
    sessionId: SessionId,
    agentServer: string,
    patch: Partial<ACPConversationLiveStatus>,
  ): void {
    const conversationId = this.getConversationId(sessionId, agentServer);
    if (!conversationId) return;
    this.statuses = {
      ...this.statuses,
      [conversationId]: {
        ...(this.statuses[conversationId] ?? emptyConversationStatus),
        ...patch,
      },
    };
  }

  private getConversationId(sessionId: SessionId, agentServer: string): string | undefined {
    return this.conversationBySession.get(sessionKey(sessionId, agentServer));
  }
}

const [getACPConversationStatusContext, setACPConversationStatusRepositoryContext] =
  createContext<ACPConversationStatusRepository>();

export { getACPConversationStatusContext };

export function setACPConversationStatusContext(
  notifications?: NotificationRepository,
): ACPConversationStatusRepositoryWriter {
  const repo = new ACPConversationStatusRepositoryWriter(notifications);
  setACPConversationStatusRepositoryContext(repo.publicAPI());
  return repo;
}

function sessionKey(sessionId: SessionId, agentServer: string): string {
  return `${normalizeAgentServerName(agentServer)}\0${sessionId}`;
}

function statusesEqual(
  a: Record<string, ACPConversationLiveStatus>,
  b: Record<string, ACPConversationLiveStatus>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return (
      right !== undefined &&
      left.working === right.working &&
      left.waitingForUser === right.waitingForUser &&
      left.unread === right.unread
    );
  });
}
