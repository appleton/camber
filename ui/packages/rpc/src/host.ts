import type {
  DeleteSecretOutput,
  DeleteSecretParams,
  GetSecretOutput,
  GetSecretParams,
  ListSecretsOutput,
  ListSecretsParams,
  UpsertSecretOutput,
  UpsertSecretParams,
} from "@camber/helperapi/schemas";
import type { ErrorObject } from "serialize-error";
import type { Client, Messages } from "./generics";

interface LineRange {
  start: number;
  end: number;
  confidence?: number;
}

/**
 * Host encodes all RPC methods that can be sent from a webview to a host
 */
export interface Host {
  checkFileExists(path: string): Promise<boolean>;
  getCodeSymbols: (path?: string) => Promise<CodeSymbolResponse>;
  getFileContents(path: string): Promise<AttachedFile | undefined>;
  getFileIconDefinition(iconName: string): Promise<string | undefined>;
  getImageFileData(path: string): Promise<ImageFileData | undefined>;
  getPromptContext: () => Promise<PromptContextFacet[]>;
  getUrlContents(url: string): Promise<AttachedUrl | undefined>;
  // jsonrpc performs a jsonrpc request to the camber Helper over jsonrpc,
  // and returns the response. Throws an error if an error response is received.
  /** @deprecated Use generated `@camber/helperapi` methods instead. */
  jsonrpc(methodName: string, params: object): Promise<object>;
  jsonrpcNotify(methodName: string, params: object): Promise<void>;
  openExternalURL: (url: string) => void;
  openFile: (path: string, line?: number, column?: number) => void;
  /**
   * Reveals the host editor's native source-control (git) view. Backs the
   * conversation "Review" bar on VS Code, which has no in-webview changes
   * view. A no-op on hosts without a native SCM view (desktop has its own
   * changes view; mobile has none yet) — those never call it.
   */
  revealSourceControl(): void;
  selectProjectFolder(): Promise<ProjectFolder | undefined>;
  /** Lists MCP servers configured in the host editor (VS Code mcp.json). Empty off VS Code. */
  listVSCodeMcpServers(): Promise<VSCodeMcpServer[]>;
  saveTextFile(options: SaveTextFileOptions): Promise<string | undefined>;
  openWorkspace(path: string): Promise<void>;
  addFolderToWorkspace(path: string): Promise<void>;
  openImageFile: (svgContent: string, filename?: string) => void;
  openSettings(setting?: string): void;
  openTerminal(command?: string, cwd?: string): void;
  listAssistantTerminals(worktreePath: string): Promise<AssistantTerminalTab[]>;
  createAssistantTerminal(
    worktreePath: string,
    command?: string,
    env?: Record<string, string>,
    commandMode?: AssistantTerminalCommandMode,
    cwd?: string,
    /**
     * Initial PTY size measured from the pane that will display the terminal.
     * Spawning at the real size lets the shell paint its first prompt at the
     * correct width, so no compensating clear (with its visible `^L` flash)
     * is needed. Hosts fall back to 80×24 when omitted.
     */
    cols?: number,
    rows?: number,
  ): Promise<AssistantTerminalTab>;
  deleteAssistantTerminal(terminalId: string): Promise<void>;
  writeAssistantTerminal(terminalId: string, data: string): Promise<void>;
  clearAssistantTerminal(terminalId: string): Promise<void>;
  resizeAssistantTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  closeAssistantTerminalsForWorktree(worktreePath: string): Promise<void>;
  closeAssistantTerminalsForProject(projectPath: string): Promise<void>;
  ready(): void;
  reportError(error: ErrorObject): void;
  reportEvent(name: TelemetryEventInputEventType, data: TelemetryEventInputMetadata): void;
  setACPAgentServers(agentServers: ACPAgentServers, defaultAgentServer?: string): Promise<void>;
  openAcpChat(opts: OpenAcpChatOptions): Promise<void>;
  closeAcpChat(opts: CloseAcpChatOptions): Promise<void>;
  updateAcpChatPanelMetadata(metadata: AcpChatPanelMetadata): void;
  setWebviewFocus(focused: boolean): void;
  showInfoMessage(message: string, type?: InfoMessageType): void;
  upsertSecret(upsertSecretParams: UpsertSecretParams): Promise<UpsertSecretOutput>;
  deleteSecret(deleteSecretParams: DeleteSecretParams): Promise<DeleteSecretOutput>;
  listSecrets(listSecretsParams: ListSecretsParams): Promise<ListSecretsOutput>;
  getSecret(getSecretParams: GetSecretParams): Promise<GetSecretOutput>;
  // Available if the hostClipboardWrite capability is set.
  writeToClipboard(text: string): void;
}

export type Selection = [start: number, end: number];

export enum InfoMessageType {
  info = "info",
  error = "error",
  warning = "warning",
}

export const INFO_MESSAGE_EVENT = "camber:info-message";

/**
 * HostClient is the interface which should be implemented to communicate with the RPC Host process
 */
export type HostClient = Client<Host>;

type HostMessages = Messages<Host>;
export type HostMessage = HostMessages[keyof HostMessages];

export interface AttachedFile {
  path?: string;
  content?: string;
  selection?: Selection;
  selectedCode?: string;
  visibleRange?: LineRange;
  codeSymbolsAvailable?: boolean;
  cursorLine?: number;
}

export interface ImageFileData {
  data: string;
  mimeType: string;
  path: string;
}

export interface SaveTextFileOptions {
  contents: string;
  defaultFileName?: string;
  title?: string;
  filters?: Array<{
    name: string;
    extensions: string[];
  }>;
}

export interface ActiveFileContext {
  workspaces: WorkspaceFolder[];
  // Resolved by the host so webviews can render paths relative to the actual
  // user profile without guessing from a platform-specific path shape.
  homeDirectory?: string;
  // Working directory the assistant should use when no folder is open.
  // Computed by the host (e.g. extension) since only it can resolve $HOME.
  defaultCwd?: string;
  recentFile?: AttachedFile;
  activeFiles?: AttachedFile[];
}

export type AttachedUrl = {
  url: string;
  title?: string;
  content: string;
};

export interface ACPAgentServerConfig {
  type?: "custom" | "registry" | "local";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  binary?: Record<string, ACPAgentServerBinaryDistribution>;
  default_config_options?: Record<string, string>;
  /**
   * Config option ids whose default the user pinned explicitly. Pinned keys
   * keep their `default_config_options` value: the last-used auto-follow
   * skips them until they are unpinned.
   */
  pinned_config_options?: string[];
}

export interface ACPAgentServerBinaryDistribution {
  archive: string;
  sha256?: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
}

export type ACPAgentServers = Record<string, ACPAgentServerConfig>;

/**
 * OpenAcpChatOptions controls the host's `openAcpChat` RPC.
 *
 * - When neither `agentServer` nor `conversationId` is set, the host reveals or
 *   creates the single "pending" chat panel (the empty agent-picker state).
 * - When `conversationId` is set, the host reveals or creates the panel for that conversation.
 * - `agentName` and `sessionTitle` are used to set the editor tab title.
 */
export interface OpenAcpChatOptions {
  conversationId?: string;
  agentServer?: string;
  sessionId?: string;
  agentName?: string;
  agentIconUrl?: string;
  sessionTitle?: string;
  cwd?: string;
  workingDirectories?: string[];
  /** Open the conversation for inspection only (archived conversations). */
  readOnly?: boolean;
  /** Cwds to retry session/load with when `cwd` no longer exists. */
  fallbackCwds?: string[];
}

export interface AcpChatPanelMetadata {
  agentServer?: string;
  agentName?: string;
  agentIconUrl?: string;
  /** Whether this agent accepts MCP servers (null = capabilities not known yet). */
  supportsMcp?: boolean | null;
  /**
   * For the Camber agent: whether the active model permits user/custom MCP
   * servers. Per-model, so only the live session knows it (null = unknown).
   */
  allowCustomMcp?: boolean | null;
}

export interface CloseAcpChatOptions {
  conversationId: string;
  agentServer?: string;
  sessionId?: string;
}

/**
 * Client-side, user-controlled configuration, i.e.
 * VSCode preferences. Treat with caution
 */
export interface Configuration {
  uri: string;
  themeOverride: string | null;
  wrapLines: boolean;
  showMermaidDiagrams?: boolean;
  bubbleTheme?: string;
  // whether to show RenderScan performance monitoring
  renderScan?: boolean;
  highlightTelemetryElements?: boolean;
  // boolean only feature flags, matching the server-side features.
  // These are pre-processed to allow us to specify full "camber.boolFeatures.foo"
  // keys, but end up with a single object, where all non-booleans are dropped.
  // VSCode only currently
  boolFeatures?: {
    [name: string]: boolean;
  };
  fontLigatures?: boolean; // Web Assistant only
  notifyOnApproval?: boolean;
  // How much of the agent's activity to show while it works. Stores the mode
  // string so future modes are new values, not a settings migration.
  toolActivity?: "detailed" | "grouped" | "compact";
  agentServers?: ACPAgentServers;
  acpAgentServers?: ACPAgentServers;
}

export interface WorkspaceFolder {
  path: string;
  name: string;
  index: number;
}

export interface ProjectFolder {
  path: string;
  name: string;
}

/** An MCP server read from the host editor's configuration (VS Code mcp.json). */
export interface VSCodeMcpServer {
  name: string;
  /** Where the entry came from, for display. */
  source: "workspace" | "user";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http
  url?: string;
  headers?: Record<string, string>;
}

export type AssistantTerminalCommandMode = "interactive" | "nonInteractive";

export interface AssistantTerminalTab {
  id: string;
  title: string;
  cwd: string;
  worktreePath: string;
  createdAt: string;
  exitCode?: number;
  buffer?: string;
}

export interface AssistantTerminalUpdate {
  terminalId: string;
  title?: string;
  cwd?: string;
}

export type TelemetryEventInputEventType =
  (typeof TelemetryEventInputEventType)[keyof typeof TelemetryEventInputEventType];

export const TelemetryEventInputEventType = {
  prompt_started: "prompt_started",
  prompt_completed: "prompt_completed",
  file_modifications_previewed: "file_modifications_previewed",
  file_modifications_applied: "file_modifications_applied",
  file_modifications_discarded: "file_modifications_discarded",
  response_regenerated: "response_regenerated",
  file_opened: "file_opened",
  selection_changed: "selection_changed",
  file_edited: "file_edited",
  task_started: "task_started",
  task_completed: "task_completed",
  task_canceled: "task_canceled",
  task_reopened: "task_reopened",
  rated_thumbs_up: "rated_thumbs_up",
  rated_thumbs_down: "rated_thumbs_down",
  client_error: "client_error",
  user_interaction: "user_interaction",
} as const;

export type TelemetryEventInputMetadata = { [key: string]: unknown };

export type Matchable<T extends string = string> =
  | T
  | { value: T; score: number; indices: readonly number[] };

export interface SearchFile {
  path: string;
  name: Matchable;
  directory: Matchable;
  workspace?: Matchable;
  isDirectory?: boolean;
  /** Exact query text to use when drilling into this row. */
  navigationPath?: string;
  /** Virtual rows are UI navigation targets, not real files to insert/open. */
  virtualKind?: "workspace-folder";
  score?: number;
  /** A user-friendly form of the path (e.g. `~/Documents/x` or workspace-relative)
   *  computed by the server based on how the query was phrased. Used for chip
   *  tooltips so users see the same shape they typed.
   */
  displayPath?: string;
}

export interface CodeSymbolResponse {
  symbols: CodeSymbol[];
}

export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
}

export type CodeSymbolKind = "type" | "code" | "value";

export type Keybindings = Record<string, string | undefined>;

export type PromptContextFacet = {
  /** describes the content for the model, in natural language. Can use markdown formatting */
  description: string;
  /** Describes the supplied context for user, will be visible in history */
  history?: string;
  /** @minItems 1 */
  items: ContextItem[];
  /** well-known values here (anything but "dynamic") opts in to specific behaviour */
  kind: EnrichedContextKind;
  /**
   * the mime-type of the content. Must be a non-binary format
   * @pattern [^/]+/[^/]+
   */
  mime_type: string;
  /** indicates the source of this context */
  source: EnrichedContextSource;
};

export type ContextItem = {
  /** content in the format specified by mime_type */
  content: string;
  path?: string;
};

/** The kinds of enriched context that we might send to the API. */
export enum EnrichedContextKind {
  branchCommits = "branch_commits",
  branchName = "branch_name",
}

/** The various sources of enriched context we might have. The sources are user-facing views
 of the enriched context, and may produce more than one kind of context. (For example, the
 `branch` source produces both branch names and latest commits on the branch, which are two
 kinds of content.) */
export enum EnrichedContextSource {
  // e.g. the name of the current VCS branch and commit messages of changes on the branch
  branch = "branch",
}

export interface FileIconTheme {
  fonts?: Record<string, string>; // fontId -> embedded font CSS
  iconDefinitions?: Record<string, string>; // iconName -> SVG/img string
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  languageIds?: Record<string, string>;
  file?: string;
  folder?: string;
}

export type Language = {
  id: string;
  extensions?: string[];
  aliases?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
};
