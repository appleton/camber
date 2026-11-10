import { runtime, toJsonrpcMethod } from "./orval/clientHelpers";

// --- GitHub awareness (camber/github/*) ---
//
// Hand-written bindings: the helper exposes these via methods/github.go. They
// are kept here rather than in gen/api.ts so they survive codegen runs.

export type GitHubPRState = "none" | "draft" | "open" | "merged" | "closed";
export type GitHubChecksStatus = "none" | "pending" | "success" | "failure";
export type GitHubReviewDecision = "approved" | "changes_requested" | "review_required" | "";

export interface GitHubChecks {
  status: GitHubChecksStatus;
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface GitHubPRStatus {
  state: GitHubPRState;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: GitHubReviewDecision;
  checks: GitHubChecks;
  commentCount: number;
  updatedAt: string;
}

export interface GitHubWorktreeStatus {
  path: string;
  branch: string;
  supported: boolean;
  // Whether the path is inside a git work tree at all. Optional so older
  // helpers that omit it keep working; treat absent as unknown.
  isRepo?: boolean;
  status: GitHubPRStatus;
}

export interface GitHubWorktreeStatusesParams {
  paths: string[];
}

export interface GitHubWorktreeStatusesOutput {
  statuses: GitHubWorktreeStatus[];
  configured: boolean;
}

export interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string;
  url: string;
}

export interface GitHubComment {
  author: string;
  body: string;
  url: string;
  createdAt: string;
}

export interface GitHubReview {
  author: string;
  state: string;
  body: string;
  url: string;
  createdAt: string;
}

export interface GitHubPRDetail extends GitHubPRStatus {
  body: string;
  author: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  checkRuns: GitHubCheckRun[];
  reviews: GitHubReview[];
  comments: GitHubComment[];
}

export interface GitHubPRDetailParams {
  path: string;
}

export interface GitHubPRDetailOutput {
  detail?: GitHubPRDetail;
  configured: boolean;
  repoSupported: boolean;
  branch: string;
}

export interface GitHubAuthStatusOutput {
  source: "cli" | "token" | "none";
  login: string;
  host: string;
  ghInstalled: boolean;
  hasStoredToken: boolean;
}

export interface GitHubSetTokenParams {
  token: string;
}

export interface GitHubPRUrlParams {
  path: string;
}

export interface GitHubPRUrlOutput {
  url: string;
  exists: boolean;
}

export async function camberGithubWorktreeStatuses(
  params: GitHubWorktreeStatusesParams,
): Promise<GitHubWorktreeStatusesOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/github/worktreeStatuses"), params);
}

export async function camberGithubPrDetail(
  params: GitHubPRDetailParams,
): Promise<GitHubPRDetailOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/github/prDetail"), params);
}

export async function camberGithubAuthStatus(): Promise<GitHubAuthStatusOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/github/authStatus"), {});
}

export async function camberGithubSetToken(params: GitHubSetTokenParams): Promise<void> {
  await runtime.jsonrpcCall(toJsonrpcMethod("/camber/github/setToken"), params);
}

export async function camberGithubPrUrl(params: GitHubPRUrlParams): Promise<GitHubPRUrlOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/github/prUrl"), params);
}

// --- Approvals (camber/acp/approvals/*) ---
//
// Hand-written bindings for the helper-owned pending-approval state
// (pkg/camber-helper/internal/handler/approvals). Permission prompts and
// elicitations are pushed to every surface as a reconciled set via the
// camber/acp/approvals/didChange notification; these bindings pull the boot/
// reconnect snapshot and answer one approval.

export type ACPApprovalKind = "permission" | "elicitation";

/** ACP session/request_permission content, verbatim (SDK ToolCallUpdate / PermissionOption shapes). */
export interface ACPApprovalPermission {
  toolCall: unknown;
  options: unknown;
}

export interface ACPApprovalElicitation {
  sessionId?: string;
  mode: "form" | "url";
  message: string;
  elicitationId: string;
  requestedSchema?: unknown;
  url?: string;
  _meta?: Record<string, unknown>;
}

/** One pending approval, identified everywhere by (agentServer, sessionId, kind, id). */
export interface ACPApproval {
  agentServer: string;
  sessionId: string;
  kind: ACPApprovalKind;
  /** toolCallId for permissions, elicitationId for elicitations. */
  id: string;
  permission?: ACPApprovalPermission;
  elicitation?: ACPApprovalElicitation;
  createdAt?: string;
}

/** didChange payload and list output: the complete pending set. */
export interface ACPApprovalsDidChangeParams {
  pending: ACPApproval[];
}

export interface ACPApprovalsRespondParams {
  agentServer: string;
  sessionId: string;
  kind: ACPApprovalKind;
  id: string;
  optionId?: string;
  overrideRules?: string[];
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export type ACPApprovalRespondOutcome = "accepted" | "already_resolved" | "invalid";

export interface ACPApprovalsRespondOutput {
  outcome: ACPApprovalRespondOutcome;
}

export async function camberAcpApprovalsList(): Promise<ACPApprovalsDidChangeParams> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/acp/approvals/list"), {});
}

export async function camberAcpApprovalsRespond(
  params: ACPApprovalsRespondParams,
): Promise<ACPApprovalsRespondOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/acp/approvals/respond"), params);
}

export interface GitHubLinksParams {
  path: string;
}

export interface GitHubLinksOutput {
  supported: boolean;
  branch: string;
  repoUrl: string;
  pullsUrl: string;
  issuesUrl: string;
  prUrl: string;
  prExists: boolean;
}

export async function camberGithubLinks(params: GitHubLinksParams): Promise<GitHubLinksOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/github/links"), params);
}

export interface GitHubFetchImageParams {
  url: string;
}

export interface GitHubFetchImageOutput {
  dataUri: string;
  ok: boolean;
}

export async function camberGithubFetchImage(
  params: GitHubFetchImageParams,
): Promise<GitHubFetchImageOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/github/fetchImage"), params);
}

// The GitHub status color mode is persisted in the acpNav settings DB (like the
// file opener and keybindings) so it survives across machines/reinstalls.
export interface ACPNavGithubColorModeState {
  colorMode: string;
}

export async function camberAcpNavGetGithubColorMode(): Promise<ACPNavGithubColorModeState> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/acpNav/getGithubColorMode"), {});
}

export async function camberAcpNavSetGithubColorMode(params: {
  colorMode: string;
}): Promise<ACPNavGithubColorModeState> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/acpNav/setGithubColorMode"), params);
}

// --- Voice input (camber/voiceInput/*) ---
//
// Hand-written bindings for the helper's local Whisper speech-to-text; the
// helper types live in methods/voice_input.go.

export type VoiceInputRuntimeStatus = "unavailable" | "stopped" | "running";

export type VoiceInputDownloadStatus = "downloading" | "completed" | "failed" | "cancelled";

export interface VoiceInputModel {
  id: string;
  name: string;
  multilingual?: boolean;
  recommended?: boolean;
  default?: boolean;
  selected?: boolean;
  downloaded: boolean;
  downloadBytes?: number;
  localPath?: string;
}

export interface VoiceInputDownloadState {
  modelId: string;
  status: VoiceInputDownloadStatus;
  bytesDownloaded?: number;
  bytesTotal?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  error?: string;
}

export interface VoiceInputState {
  supported: boolean;
  unavailableReason?: string;
  ready: boolean;
  modelsDirectory: string;
  selectedModelId: string;
  models: VoiceInputModel[];
  runtime: VoiceInputRuntimeStatus;
  download?: VoiceInputDownloadState;
}

export interface VoiceInputTranscribeParams {
  /** Base64-encoded audio; 16 kHz mono PCM16 WAV. */
  audio: string;
  mimeType?: string;
  /** Two-letter language hint; empty auto-detects. */
  language?: string;
}

export interface VoiceInputTranscribeResult {
  text: string;
}

export async function camberVoiceInputGetState(): Promise<VoiceInputState> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/voiceInput/getState"), {});
}

export async function camberVoiceInputSetModel(params: {
  modelId: string;
}): Promise<VoiceInputState> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/voiceInput/setModel"), params);
}

export async function camberVoiceInputDownloadModel(params: {
  modelId?: string;
}): Promise<VoiceInputState> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/voiceInput/downloadModel"), params);
}

export async function camberVoiceInputCancelDownload(params: {
  modelId?: string;
}): Promise<VoiceInputState> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/voiceInput/cancelDownload"), params);
}

export async function camberVoiceInputDeleteModel(params: {
  modelId: string;
}): Promise<VoiceInputState> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/voiceInput/deleteModel"), params);
}

export async function camberVoiceInputTranscribe(
  params: VoiceInputTranscribeParams,
): Promise<VoiceInputTranscribeResult> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/voiceInput/transcribe"), params);
}

// --- Conversation view state (camber/acpNav/setConversationViewState) ---
//
// Hand-written variant of the generated binding: the generated schema lags
// the helper's `reset` field, which drops every view-state entry this client
// connection reported before applying the update (sent on the first report
// after a webview boot).

export interface ConversationViewStateParams {
  agentServer: string;
  sessionId: string;
  active: boolean;
  reset?: boolean;
}

export async function camberAcpNavReportConversationViewState(
  params: ConversationViewStateParams,
): Promise<void> {
  await runtime.jsonrpcCall(toJsonrpcMethod("/camber/acpNav/setConversationViewState"), params);
}

// --- Remote access administration (camber/remoteAccess/*) ---
//
// Hand-written bindings for the desktop settings surface (methods defined in
// pkg/camber-helper/methods/remote_access.go). Primary-client only: the
// remote-access deny list blocks these for paired devices.

export interface RemoteAccessDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
  connected: boolean;
}

export interface RemoteAccessTLSInfo {
  mode: "trusted" | "localCA" | "plainHttp";
  warning?: string;
  caUrl?: string;
}

export interface RemoteAccessTailscaleInfo {
  cliInstalled: boolean;
  interfaceUp: boolean;
  backendState?: string;
  dnsName?: string;
  httpsEnabled: boolean;
  certCached: boolean;
  error?: string;
}

export interface RemoteAccessPendingPairing {
  id: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  bind?: string;
  port?: number;
  urls?: string[];
  autoStart?: boolean;
  autoStartBind?: string;
  devices: RemoteAccessDevice[];
  pendingPairings?: RemoteAccessPendingPairing[];
  connectedClients: number;
  tls?: RemoteAccessTLSInfo;
  tailscale?: RemoteAccessTailscaleInfo;
}

export interface RemoteAccessPairingCode {
  code: string;
  expiresAt: string;
  urls?: string[];
}

export async function camberRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/remoteAccess/status"), {});
}

export async function camberRemoteAccessEnable(params: {
  bind?: string;
  port?: number;
}): Promise<RemoteAccessStatus> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/remoteAccess/enable"), params);
}

export async function camberRemoteAccessDisable(): Promise<RemoteAccessStatus> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/remoteAccess/disable"), {});
}

export async function camberRemoteAccessSetAutoStart(params: {
  autoStart: boolean;
  bind?: string;
}): Promise<RemoteAccessStatus> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/remoteAccess/setAutoStart"), params);
}

export async function camberRemoteAccessCreatePairingCode(): Promise<RemoteAccessPairingCode> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/remoteAccess/createPairingCode"), {});
}

export async function camberRemoteAccessConfirmPairing(params: {
  pairingId: string;
  code: string;
}): Promise<RemoteAccessStatus> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/remoteAccess/confirmPairing"), params);
}

export async function camberRemoteAccessRevokeDevice(params: {
  deviceId: string;
}): Promise<RemoteAccessStatus> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/remoteAccess/revokeDevice"), params);
}

// --- Git working tree (camber/git/*) ---
//
// Hand-written bindings for the helper's local git operations backing the
// desktop Changes panel; the helper types live in methods/git.go.

export type GitFileChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "unmerged"
  | "unknown";

export interface GitFileChange {
  path: string;
  origPath?: string;
  status: GitFileChangeStatus;
}

export interface GitStatusOutput {
  isRepo: boolean;
  /** True when isRepo is false because the git binary is not installed. */
  gitMissing?: boolean;
  branch: string;
  detached: boolean;
  /** Remote tracking branch (e.g. "origin/main"), absent when none is set. */
  upstream?: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  stashCount: number;
  /** Total added lines vs HEAD (staged + unstaged + untracked, binary files excluded). */
  additions: number;
  /** Total deleted lines vs HEAD (staged + unstaged + untracked, binary files excluded). */
  deletions: number;
}

export interface GitStatusParams {
  path: string;
}

export async function camberGitStatus(params: GitStatusParams): Promise<GitStatusOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/status"), params);
}

export interface GitDiffFileParams {
  path: string;
  file: string;
  staged?: boolean;
  untracked?: boolean;
  /**
   * HEAD-vs-worktree diff (staged + unstaged combined), e.g. for editor
   * gutter decorations. Takes precedence over staged.
   */
  head?: boolean;
}

export interface GitDiffFileOutput {
  patch: string;
  binary: boolean;
  /** True when oldContent/newContent carry the full before/after contents. */
  hasContents?: boolean;
  /** Full base-side file content (enables expanding unmodified lines). */
  oldContent?: string;
  /** Full result-side file content (enables expanding unmodified lines). */
  newContent?: string;
}

export async function camberGitDiffFile(params: GitDiffFileParams): Promise<GitDiffFileOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/diffFile"), params);
}

export type GitDiffScope = "uncommitted" | "staged" | "unstaged";

export interface GitDiffFileSummary {
  path: string;
  origPath?: string;
  status: GitFileChangeStatus;
  statsReady?: boolean;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitDiffStats {
  files: number;
  additions: number;
  deletions: number;
  fileStats?: GitDiffFileStats[];
}

export interface GitDiffFileStats {
  path: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitDiffOpenParams {
  path: string;
  scope?: GitDiffScope;
  /** File to make immediately available when opening from a changed-file row. */
  targetPath?: string;
}

export interface GitDiffOpenOutput {
  unavailable?: boolean;
  gitMissing?: boolean;
  sessionId: string;
  files: GitDiffFileSummary[];
  nextCursor?: string;
  complete: boolean;
  target?: GitDiffFileSummary;
  stats?: GitDiffStats;
}

export async function camberGitDiffOpen(params: GitDiffOpenParams): Promise<GitDiffOpenOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/diffOpen"), params);
}

export interface GitDiffListParams {
  sessionId: string;
  cursor?: string;
}

export interface GitDiffListOutput {
  files: GitDiffFileSummary[];
  nextCursor?: string;
  complete: boolean;
  stats?: GitDiffStats;
}

export async function camberGitDiffList(params: GitDiffListParams): Promise<GitDiffListOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/diffList"), params);
}

export interface GitDiffChunk {
  patch: string;
  rows: number;
  additions: number;
  deletions: number;
  /** Number of @@ sections in patch, for row-height estimates. */
  hunks?: number;
  binary?: boolean;
  truncatedLines?: number;
}

export interface GitDiffReadParams {
  sessionId: string;
  file: string;
  cursor?: string;
}

export interface GitDiffReadOutput {
  chunk?: GitDiffChunk;
  nextCursor?: string;
  complete: boolean;
}

export async function camberGitDiffRead(params: GitDiffReadParams): Promise<GitDiffReadOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/diffRead"), params);
}

export interface GitDiffContentsParams {
  sessionId: string;
  file: string;
}

export interface GitDiffContentsOutput {
  /** True when oldContent/newContent carry the full before/after contents. */
  hasContents?: boolean;
  /** Full base-side content for the snapshot's scope. */
  oldContent?: string;
  /** Full result-side content for the snapshot's scope. */
  newContent?: string;
}

export async function camberGitDiffContents(
  params: GitDiffContentsParams,
): Promise<GitDiffContentsOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/diffContents"), params);
}

export interface GitDiffStatsOutput {
  ready: boolean;
  stats?: GitDiffStats;
}

export async function camberGitDiffStats(params: {
  sessionId: string;
}): Promise<GitDiffStatsOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/diffStats"), params);
}

export async function camberGitDiffClose(params: { sessionId: string }): Promise<void> {
  await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/diffClose"), params);
}

export interface GitStageParams {
  path: string;
  files: string[];
}

export async function camberGitStage(params: GitStageParams): Promise<GitStatusOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/stage"), params);
}

export async function camberGitUnstage(params: GitStageParams): Promise<GitStatusOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/unstage"), params);
}

export interface GitDiscardParams {
  path: string;
  files?: string[];
  untrackedFiles?: string[];
}

export async function camberGitDiscard(params: GitDiscardParams): Promise<GitStatusOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/discard"), params);
}

export interface GitCommitParams {
  path: string;
  message: string;
}

export async function camberGitCommit(params: GitCommitParams): Promise<GitStatusOutput> {
  return await runtime.jsonrpcCall(toJsonrpcMethod("/camber/git/commit"), params);
}
