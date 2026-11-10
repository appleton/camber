import { camberAcpNavList, camberAcpNavUpsertConversation } from "@camber/helperapi";
import type { WorkspaceFolder } from "@camber/rpc";
import { normalizeAgentServerName } from "../../agentServers";
import {
  getExecCommand,
  isExecCommandToolCall,
} from "../../components/events/tool/execCommandTool";
import { getDiffPath, getLocationPath, getRawInputPath } from "../../components/shared/toolPaths";
import { getBasename, getReadableFileInfo } from "../../shared/paths";
import type { ToolCall } from "../../types";
import type { ACPSession } from "./Session.svelte";
import {
  normalizeSessionConfigSnapshot,
  sessionConfigSnapshot,
  type ACPSessionConfigSnapshot,
} from "./configOptions";

const MAX_PROCESSES = 3;
const MAX_FILES = 4;
const MAX_PATH = 84;
const MAX_LABEL = 72;

const EXPLORE_KINDS = new Set<ToolCall["kind"]>(["read", "search", "fetch"]);
const EDIT_KINDS = new Set<ToolCall["kind"]>(["edit", "delete", "move"]);

const KIND_LABEL: Partial<Record<NonNullable<ToolCall["kind"]>, string>> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
};

export type ACPEditedFileMetadata = {
  fileName: string;
  filePath: string;
};

export type ACPSessionMetadataSnapshot = Record<string, unknown> & {
  processes: string[];
  explored: string[];
  edited: ACPEditedFileMetadata[];
  sessionConfig?: ACPSessionConfigSnapshot;
};

export const EMPTY_ACP_SESSION_METADATA: ACPSessionMetadataSnapshot = {
  processes: [],
  explored: [],
  edited: [],
};

type PersistOptions = {
  persist?: boolean;
};

export class ACPSessionMetadata {
  private lastPersistedJSON = "";
  private persistChain = Promise.resolve();

  constructor(private readonly session: ACPSession) {}

  refresh({ persist = true }: PersistOptions = {}): void {
    const session = this.session;
    const extracted = extractACPSessionMetadata(session.events, {
      projectPath: this.projectPath(),
    });
    // Local sessions mirror the agent-wide config cache, so only agent-backed
    // sessions capture per-session config; fall back to the previous snapshot
    // so a refresh before config arrives can't wipe the stored value.
    const sessionConfig =
      session.sessionId === null
        ? session.metadata.sessionConfig
        : (sessionConfigSnapshot(session.configOptions, session.modes) ??
          session.metadata.sessionConfig);
    const next: ACPSessionMetadataSnapshot =
      sessionConfig !== undefined ? { ...extracted, sessionConfig } : extracted;
    const nextJSON = stableMetadataJSON(next);
    if (nextJSON === stableMetadataJSON(session.metadata)) {
      return;
    }

    session.metadata = next;
    if (persist) {
      this.queuePersist(next, nextJSON);
    }
  }

  reset(): void {
    this.session.metadata = EMPTY_ACP_SESSION_METADATA;
  }

  // Drop the stored config snapshot. refresh() deliberately preserves the
  // previous snapshot while config state is empty (it can't tell "not loaded
  // yet" from "agent has no config"), so callers that do know — e.g. a
  // session/load response with no config surface — clear it explicitly.
  dropSessionConfig(): void {
    if (this.session.metadata.sessionConfig === undefined) return;
    const { sessionConfig: _dropped, ...rest } = this.session.metadata;
    const next = rest as ACPSessionMetadataSnapshot;
    this.session.metadata = next;
    this.queuePersist(next, stableMetadataJSON(next));
  }

  private projectPath(): string | null {
    return this.session.sessionInfo?.cwd ?? this.session.pendingCwd ?? this.session.cwd ?? null;
  }

  private queuePersist(metadata: ACPSessionMetadataSnapshot, metadataJSON: string): void {
    // Read-only sessions (archived conversations opened for inspection, debug
    // dumps) must not write back to the sidebar database: the nav upsert
    // force-reactivates the conversation, which would silently un-archive it.
    if (this.session.sessionInfo?.readOnly) return;
    if (metadataJSON === this.lastPersistedJSON) return;
    this.lastPersistedJSON = metadataJSON;
    this.persistChain = this.persistChain
      .then(() => persistMetadataToSidebarDatabase(this.session, metadata))
      .catch((error) => {
        console.error("Failed to persist ACP session metadata", error);
      });
  }
}

export function extractACPSessionMetadata(
  events: Array<{ eventKind: string }>,
  opts: { projectPath?: string | null } = {},
): ACPSessionMetadataSnapshot {
  const tools = events.filter(
    (e): e is ToolCall & { eventKind: "tool_call" } => e.eventKind === "tool_call",
  );
  if (tools.length === 0) return EMPTY_ACP_SESSION_METADATA;

  const processes: string[] = [];
  const explored: string[] = [];
  const edited: ACPEditedFileMetadata[] = [];
  const seenProc = new Set<string>();
  const seenExp = new Set<string>();
  const seenEdit = new Set<string>();

  for (let i = tools.length - 1; i >= 0; i--) {
    if (
      processes.length >= MAX_PROCESSES &&
      explored.length >= MAX_FILES &&
      edited.length >= MAX_FILES
    ) {
      break;
    }
    const tool = tools[i];

    if (processes.length < MAX_PROCESSES) {
      const label = processLabel(tool);
      const key = label?.toLowerCase();
      if (label && key && !seenProc.has(key)) {
        seenProc.add(key);
        processes.push(label);
      }
    }

    const wantExplore = EXPLORE_KINDS.has(tool.kind) && explored.length < MAX_FILES;
    const wantEdit = EDIT_KINDS.has(tool.kind) && edited.length < MAX_FILES;
    if (!wantExplore && !wantEdit) continue;

    const path = toolPath(tool);
    if (!path) continue;
    const key = path.toLowerCase();

    if (wantExplore && !seenExp.has(key)) {
      const name = fileName(path);
      if (name) {
        seenExp.add(key);
        explored.push(name);
      }
    }
    if (wantEdit && !seenEdit.has(key)) {
      seenEdit.add(key);
      edited.push(editedPathMetadata(path, opts.projectPath));
    }
  }

  return { processes, explored, edited };
}

export function normalizeACPSessionMetadata(
  value: unknown,
): ACPSessionMetadataSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ACPSessionMetadataSnapshot>;
  const sessionConfig = normalizeSessionConfigSnapshot(
    (candidate as Record<string, unknown>).sessionConfig,
  );
  const base = {
    processes: cloneStringArray(candidate.processes),
    explored: cloneStringArray(candidate.explored),
    edited: Array.isArray(candidate.edited)
      ? candidate.edited.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const file = item as Partial<ACPEditedFileMetadata>;
          if (typeof file.fileName !== "string" || typeof file.filePath !== "string") return [];
          return [{ fileName: file.fileName, filePath: file.filePath }];
        })
      : [],
  };
  if (sessionConfig !== undefined) {
    return { ...base, sessionConfig };
  }
  return base;
}

function processLabel(tool: ToolCall): string | null {
  if (isExecCommandToolCall(tool)) {
    const cmd = getExecCommand(tool)?.trim();
    if (cmd) return truncate(cmd, MAX_LABEL);
  }
  const title = tool.title?.trim();
  if (title && title.toLowerCase() !== "exec_command") {
    return truncate(title, MAX_LABEL);
  }
  const kind = tool.kind ? KIND_LABEL[tool.kind] : null;
  return kind ? truncate(kind, MAX_LABEL) : null;
}

function fileName(path: string): string | null {
  const name = getBasename(path);
  if (!name || !/\.[^./\s]+$/.test(name)) return null;
  return truncatePath(name);
}

function toolPath(tool: ToolCall): string | undefined {
  return getLocationPath(tool) ?? getDiffPath(tool) ?? getRawInputPath(tool);
}

function editedPathMetadata(path: string, projectPath?: string | null): ACPEditedFileMetadata {
  const workspace = projectPath ? workspaceFolderFromPath(projectPath) : null;
  const displayPath = workspace ? getReadableFileInfo(path, [workspace]).filePath : path;
  return {
    fileName: getBasename(path) || path,
    filePath: truncatePath(displayPath),
  };
}

function workspaceFolderFromPath(path: string): WorkspaceFolder | null {
  const normalized = path.trim();
  if (!normalized) return null;
  return {
    path: normalized,
    name: getBasename(normalized) || normalized,
    index: -1,
  };
}

function truncate(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}

function truncatePath(path: string, max = MAX_PATH): string {
  const p = path.trim().replaceAll("\\", "/");
  if (p.length <= max) return p;
  return `...${p.slice(-(max - 3))}`;
}

function cloneStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stableMetadataJSON(metadata: ACPSessionMetadataSnapshot): string {
  return JSON.stringify(metadata);
}

async function findNavConversation(session: ACPSession) {
  const agentServer = normalizeAgentServerName(session.agentServer);
  const state = await camberAcpNavList({});
  return (
    (state.conversations ?? []).find((candidate) => {
      if (normalizeAgentServerName(candidate.agentServer) !== agentServer) return false;
      if (session.conversationId && candidate.id === session.conversationId) return true;
      return Boolean(session.sessionId && candidate.sessionId === session.sessionId);
    }) ?? null
  );
}

export async function loadPersistedSessionConfig(
  session: ACPSession,
): Promise<ACPSessionConfigSnapshot | null> {
  const conversation = await findNavConversation(session);
  const metadata = normalizeACPSessionMetadata(conversation?.metadata);
  return metadata?.sessionConfig ?? null;
}

async function persistMetadataToSidebarDatabase(
  session: ACPSession,
  metadata: ACPSessionMetadataSnapshot,
): Promise<void> {
  const conversation = await findNavConversation(session);
  if (!conversation) return;

  await camberAcpNavUpsertConversation({
    conversation: {
      ...conversation,
      metadata,
    },
  });
}
