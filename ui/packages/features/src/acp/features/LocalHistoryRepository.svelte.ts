import type { SessionId } from "@agentclientprotocol/sdk";
import { camberAcpNavList } from "@camber/helperapi";
import { failure, success, waiting, type AsyncState } from "@camber/lib/async-state";
import { createContext } from "svelte";
import { DEFAULT_AGENT_SERVER, normalizeAgentServerName } from "../agentServers";
import { normalizeACPError, type ACPRequestError } from "../errors";
import {
  navToConversationSummary,
  sortConversationSummaries,
  type ACPConversationSummary,
  type ACPNavConversation,
  type ACPNavProject,
} from "../navTypes";
import type {
  AggregatedSessionList,
  ConversationListSource,
  SessionListFailure,
} from "./HistoryRepository.svelte";

type NoSetters<T> = { readonly [K in keyof T]: T[K] };

export type ACPLocalHistoryRepository = NoSetters<ACPLocalHistoryRepositoryWriter>;

// Reuse the agent session/list reconciliation for this long when switching
// project filters or reopening the archive, instead of re-fanning-out to every
// agent server each time.
const RECONCILE_CACHE_TTL_MS = 30_000;

export class ACPLocalHistoryRepositoryWriter {
  private source: ConversationListSource | null = null;
  private reconcileCache: { fetchedAt: number; result: AggregatedSessionList } | null = null;
  private refreshGeneration = 0;

  state = $state<AsyncState<ACPConversationSummary[], ACPRequestError>>(waiting);
  // True while the background agent session/list fan-out is in flight. The
  // archive renders from local nav state immediately; this only signals that
  // titles/availability are still being reconciled.
  reconciling = $state(false);
  // Set only when EVERY agent server failed to list sessions during the last
  // reconcile. Partial failures stay silent: the archive renders from local
  // state regardless, and a warning per flaky agent would be noise.
  listFailures = $state<SessionListFailure[]>([]);
  // Exposed so tests (and cautious callers) can await the background reconcile.
  reconcilePromise: Promise<void> | null = null;

  readonly sessions = $derived(this.state.status === "success" ? this.state.value : []);

  setListSource(source: ConversationListSource): void {
    this.source = source;
  }

  // Renders local archived nav conversations immediately, then reconciles
  // against the agents' session lists in the background (fresher titles and
  // agent-side availability). Resolves once the local list is displayed.
  async refresh(workspacePath = "/"): Promise<void> {
    const generation = ++this.refreshGeneration;

    let navState: ArchiveNavState;
    try {
      navState = await camberAcpNavList({});
    } catch (error) {
      // The archive shows ONLY conversations present in the archived nav set,
      // so a failed nav call must surface as the pane's error state — not a
      // silently empty archive that reads as "nothing archived".
      if (generation === this.refreshGeneration) {
        this.state = failure(normalizeACPError(error));
      }
      return;
    }
    if (generation !== this.refreshGeneration) return;

    const archived = archivedSummariesForScope(navState, workspacePath);
    const cached = this.freshReconcileCache();
    this.state = success(reconcileWithAgentSessions(archived, cached));
    if (cached) {
      this.listFailures = totalFailures(cached);
      // This refresh owns no background reconcile, and any still-in-flight
      // reconcile from an older refresh lost the generation race — its finally
      // block will not clear the flag, so clear a stale "Refreshing…" here.
      this.reconciling = false;
      return;
    }

    this.reconcilePromise = this.reconcile(generation, archived);
  }

  deleteSession(sessionId: SessionId, agentServer = DEFAULT_AGENT_SERVER): void {
    agentServer = normalizeAgentServerName(agentServer);
    this.state = success(
      this.sessions.filter(
        (session) => !(session.sessionId === sessionId && session.agentServer === agentServer),
      ),
    );
    if (this.reconcileCache) {
      this.reconcileCache.result.sessions = this.reconcileCache.result.sessions.filter(
        (session) => !(session.sessionId === sessionId && session.agentServer === agentServer),
      );
    }
  }

  publicAPI(): ACPLocalHistoryRepository {
    return this as ACPLocalHistoryRepository;
  }

  private async reconcile(generation: number, archived: ACPConversationSummary[]): Promise<void> {
    if (!this.source) return;
    this.reconciling = true;
    try {
      const result = await this.source.list("/");
      // Later refreshes can still reuse the fetch even if they won the
      // generation race for publishing state.
      this.reconcileCache = { fetchedAt: Date.now(), result };
      if (generation !== this.refreshGeneration) return;
      this.listFailures = totalFailures(result);
      this.state = success(reconcileWithAgentSessions(archived, result));
    } catch (error) {
      if (generation !== this.refreshGeneration) return;
      // The local list already rendered; an aggregate failure only means no
      // server could be reconciled. Keep the page and surface a notice.
      this.listFailures = [{ agentServer: "*", error: normalizeACPError(error) }];
    } finally {
      if (generation === this.refreshGeneration) {
        this.reconciling = false;
      }
    }
  }

  private freshReconcileCache(): AggregatedSessionList | null {
    if (!this.reconcileCache) return null;
    if (Date.now() - this.reconcileCache.fetchedAt > RECONCILE_CACHE_TTL_MS) return null;
    return this.reconcileCache.result;
  }
}

// A warning is only warranted when no agent produced a list at all; if at
// least one server answered, partial failures are expected churn (agents not
// running, not authenticated) and would just be noise on the archive.
function totalFailures(result: AggregatedSessionList): SessionListFailure[] {
  return result.listedServers.length === 0 ? result.failures : [];
}

// Structural subset shared by the generated helper API type and the local nav
// types, so the repo works with either without casts.
interface ArchiveNavState {
  projects?: Pick<ACPNavProject, "path" | "isWorktree" | "parentPath">[];
  conversations?: ACPNavConversation[];
}

// The archive lists archived nav conversations with an agent-side session.
// Session-less drafts have nothing to reopen and are dropped. A non-root scope
// includes the project itself, its worktrees, and conversations whose cwd is
// the scope (IDE hosts store a symbolic workspacePath, so cwd is the match).
function archivedSummariesForScope(
  navState: ArchiveNavState,
  workspacePath: string,
): ACPConversationSummary[] {
  const conversations = (navState.conversations ?? []).filter(
    (conversation) => conversation.archived && conversation.sessionId,
  );
  const scoped =
    !workspacePath || workspacePath === "/"
      ? conversations
      : conversations.filter((conversation) => {
          if (conversation.workspacePath === workspacePath) return true;
          if (conversation.cwd === workspacePath) return true;
          return (navState.projects ?? []).some(
            (project) =>
              project.isWorktree &&
              project.parentPath === workspacePath &&
              project.path === conversation.workspacePath,
          );
        });
  return scoped.map(navToConversationSummary).sort(sortConversationSummaries);
}

// Overlays fresher agent-side session info onto the archived nav records and
// flags sessions the agent no longer knows about. Purely decorative: rows are
// never dropped here, so archive contents do not depend on agent availability.
function reconcileWithAgentSessions(
  archived: ACPConversationSummary[],
  agentList: AggregatedSessionList | null,
): ACPConversationSummary[] {
  if (!agentList) return archived;

  const agentSessions = new Map(
    agentList.sessions
      .filter((session) => session.sessionId !== null)
      .map((session) => [sessionKey(session.sessionId!, session.agentServer), session]),
  );
  const completeServers = new Set(agentList.completeServers);

  const reconciled = archived.map((summary) => {
    if (!summary.sessionId) return summary;
    const agentSession = agentSessions.get(sessionKey(summary.sessionId, summary.agentServer));
    if (agentSession) {
      return {
        ...agentSession,
        id: summary.id,
        workspacePath: summary.workspacePath,
        nickname: summary.nickname,
        // A user-set nickname always wins over the agent's generated title.
        title: summary.nickname || agentSession.title || summary.title,
        updatedAt: latestTimestamp(agentSession.updatedAt, summary.updatedAt),
        metadata: summary.metadata ?? agentSession.metadata,
        workingDirectories: summary.workingDirectories?.length
          ? summary.workingDirectories
          : agentSession.workingDirectories,
        sessionAvailable: true,
      };
    }
    return {
      ...summary,
      sessionAvailable: completeServers.has(summary.agentServer) ? false : undefined,
    };
  });
  return reconciled.sort(sortConversationSummaries);
}

function latestTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function sessionKey(sessionId: SessionId, agentServer: string): string {
  return `${normalizeAgentServerName(agentServer)}\0${sessionId}`;
}

const [getACPLocalHistoryContext, setACPLocalHistoryRepositoryContext] =
  createContext<ACPLocalHistoryRepository>();

export function setACPLocalHistoryContext(): ACPLocalHistoryRepositoryWriter {
  const repo = new ACPLocalHistoryRepositoryWriter();
  setACPLocalHistoryRepositoryContext(repo.publicAPI());
  return repo;
}

export { setACPLocalHistoryRepositoryContext as _setACPLocalHistoryContextForTests };

export function getACPLocalHistoryRepo(): ACPLocalHistoryRepository {
  return getACPLocalHistoryContext();
}
