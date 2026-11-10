export { DEFAULT_AGENT_SERVER, LOCAL_AGENT_SERVER, normalizeAgentServerName } from "./agentServers";
export {
  ASSISTANT_CONFIG_DISPLAY_PATH,
  canOpenAssistantConfigFile,
  openAssistantConfigFile,
} from "./assistantConfig";
export { camberqaSlotForWorktree, camberqaSlotMobileUrl } from "./camberqaMobile";
export type { MobileCamberQAInstance, MobileCamberQASlot } from "./camberqaMobile";
export { createACPChatWorkingDirectory } from "./chatWorkspaces";
export { ACPClient } from "./Client";
export { default as AcpAgentConfigurationView } from "./components/AgentConfigurationView.svelte";
export { default as AssistantTerminalView } from "./components/AssistantTerminalView.svelte";
export { default as AcpChatPane } from "./components/chat/ChatPane.svelte";
export type {
  ChatPaneChrome,
  ChatPaneSidebarChrome,
  ChatPaneTerminalChrome,
  OpenExternalTerminal,
} from "./components/chat/chatPaneChrome";
export {
  DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT,
  DESKTOP_OPEN_DIFF_TAB_EVENT,
  type DesktopNewTabAvailability,
  type DesktopOpenDiffTabEventDetail,
} from "./components/chat/desktopCommandPicker";
export {
  NATIVE_MENU_SET_DEFAULT_EVENT,
  showDesktopContextMenu,
  type DesktopContextMenuRequest,
  type DesktopContextMenuSpecItem,
  type NativeMenuSetDefaultPayload,
} from "./components/chat/desktopContextMenu";
export {
  requestDesktopFilePromptChip,
  requestDesktopImageAttachment,
  type DesktopImageAttachmentEventDetail,
} from "./components/chat/desktopFilePromptChip";
export {
  buildDesktopFileTreeContextMenuSpec,
  buildOpenInContextMenuSpec,
  decodeFileTreeActionId,
  desktopFileTreeContextMenuNeedsPasteboard,
  encodeFileTreeActionId,
  fileTreeSpecToGenericSpec,
  type DesktopFileTreeContextMenuOpener,
  type DesktopFileTreeContextMenuRequest,
  type DesktopFileTreeContextMenuSpecItem,
} from "./components/chat/desktopFilesTreeContextMenu";
export type { DesktopFileViewerPanelProps } from "./components/chat/desktopFileViewerPanel";
export {
  buildDesktopImageContextMenuItems,
  performDesktopImageContextMenuAction,
  type DesktopImageContextMenuRPC,
  type DesktopImageContextMenuState,
  type DesktopImageData,
  type PerformDesktopImageContextMenuActionOptions,
} from "./components/chat/desktopImageContextMenu";
export {
  readStoredWorktreeSetupSurface,
  terminalPlacementForWorktreeSetupSurface,
  writeStoredWorktreeSetupSurface,
  type DesktopWorktreeSetupSurface,
} from "./components/chat/desktopLayoutPersistence";
export type {
  DesktopSplitNavigationLocation,
  DesktopSplitNavigationRequest,
} from "./components/chat/desktopNavigation";
export {
  desktopRenderedImageTarget,
  imageFromContextMenuEvent,
  loadRenderedImageData,
  showDesktopRenderedImageContextMenu,
  type DesktopRenderedImageTarget,
} from "./components/chat/desktopRenderedImageContextMenu";
export {
  DESKTOP_SPLITS_CACHE_LIMIT,
  DesktopSplitsCache,
  terminalIdsForDesktopSplitsEntry,
  type DesktopSplitsEntry,
} from "./components/chat/desktopSplitsCache";
export { default as AcpDesktopSplitsPane } from "./components/chat/DesktopSplitsPane.svelte";
export type { DesktopSystemContextMenuRequest } from "./components/chat/desktopSystemContextMenu";
export { default as ElicitationPrompt } from "./components/chat/elicitation/ElicitationPrompt.svelte";
export {
  parseGitGutterDecorations,
  type GitGutterDecorations,
  type GitGutterRange,
} from "./components/chat/gitGutterDecorations";
export { agentIconUrl, agentName, isClaudeAgent } from "./components/chat/menus/config/agentConfig";
export { resolveNativeMenuTheme } from "./components/chat/nativeMenuTheme";
export { default as AcpSidebarChrome } from "./components/chat/SidebarChrome.svelte";
export { default as AcpConnectorsView } from "./components/ConnectorsView.svelte";
export { default as DesktopSettingsView } from "./components/DesktopSettingsView.svelte";
export { default as DesktopSideBar } from "./components/DesktopSideBar.svelte";
export { default as AcpHandoffConfirmationProvider } from "./components/HandoffConfirmationProvider.svelte";
export { default as IDESideBar } from "./components/IDESideBar.svelte";
export { default as MobileSideBar } from "./components/MobileSideBar.svelte";
export { default as ProjectSettingsView } from "./components/ProjectSettingsView.svelte";
export { default as SessionEventsRenderer } from "./components/SessionEventsRenderer.svelte";
export { default as DesktopProjectSettingsIndex } from "./components/settings/DesktopProjectSettingsIndex.svelte";
export { default as DesktopProjectSettingsView } from "./components/settings/DesktopProjectSettingsView.svelte";
export { default as SettingsSectionCard } from "./components/settings/SettingsSection.svelte";
export {
  DESKTOP_SETTINGS_NAV_SECTIONS,
  DESKTOP_SETTINGS_SECTIONS,
  IDE_SETTINGS_SECTIONS,
  SETTINGS_HEADINGS,
  SETTINGS_NAV_ITEMS,
  type DesktopSettingsNavSection,
  type DesktopSettingsSection,
  type SettingsSection,
} from "./components/settings/settingsSections";
export {
  AcpSidebarController,
  type ConversationRowState,
  type SidebarLiveStatus,
} from "./components/sidebar/SidebarController.svelte";
export { sidebarToasts, type SidebarToast } from "./components/sidebar/sidebarToastsState.svelte";
export type {
  NativeConfirmationRequest,
  NativeErrorRequest,
} from "./components/ui/nativeConfirmation";
export { default as StreamingIndicator } from "./components/ui/StreamingIndicator.svelte";
export { ACPConnectionPool } from "./ConnectionPool";
export { getACPConnectionPoolContext, setACPConnectionPoolContext } from "./connectionPoolContext";
export { createACPConnection } from "./createACPConnection";
export { ACP_DEBUG_DUMP_LOADED_EVENT, normalizeDumpEntries } from "./debugDump";
export type { ACPDebugAPI, ACPDebugDumpLoadedEventDetail, ACPDumpEntry } from "./debugDump";
export type { DesktopOpenerInfo } from "./desktopOpeners";
export { desktopUpdate, type DesktopUpdateState } from "./desktopUpdate";
export { extractErrorMessage } from "./errors";
export {
  getACPActiveAgentAllowsCustomMcp,
  getACPActiveAgentServer,
  getACPActiveAgentSupportsMcp,
  setACPActiveAgentServer,
} from "./features/activeAgent.svelte";
export {
  getACPAgentRegistryContext,
  getACPAgentRegistryRepo,
  setACPAgentRegistryContext,
} from "./features/AgentRegistryRepository.svelte";
export {
  getACPAgentServersContext,
  getACPAgentServersRepo,
  setACPAgentServersContext,
} from "./features/AgentServersRepository.svelte";
export {
  ACPAgentUpdateRepository,
  getACPAgentUpdateContext,
  getACPAgentUpdateRepo,
  setACPAgentUpdateContext,
} from "./features/AgentUpdateRepository.svelte";
export type {
  ACPAgentUpdate,
  ACPAgentUpdateProgress,
  ACPAgentUpdateStage,
} from "./features/AgentUpdateRepository.svelte";
export {
  getAssistantTerminalRepo,
  getCurrentAssistantTerminalRepo,
  setAssistantTerminalContext,
} from "./features/AssistantTerminalRepository.svelte";
export {
  ACPChatSessionScopeWriter,
  getACPChatSessionScope,
  setACPChatSessionScope,
} from "./features/ChatSessionScope.svelte";
export type { ACPChatSessionScope } from "./features/ChatSessionScope.svelte";
export {
  ACPConversationRepositoryWriter,
  getACPConversationRepo,
  setACPConversationContext,
} from "./features/ConversationRepository.svelte";
export type { ACPConversationRepository } from "./features/ConversationRepository.svelte";
export {
  ACPConversationStatusRepositoryWriter,
  getACPConversationStatusContext,
  setACPConversationStatusContext,
} from "./features/ConversationStatusRepository.svelte";
export type { ACPConversationStatusRepository } from "./features/ConversationStatusRepository.svelte";
export { DESKTOP_GIT_CHANGED_EVENT } from "./features/DesktopGitChangesState.svelte";
export {
  ACPGithubRepositoryWriter,
  getACPGithubRepo,
  setACPGithubContext,
} from "./features/GithubRepository.svelte";
export type { ACPGithubRepository } from "./features/GithubRepository.svelte";
export { AggregatedSessionListSource } from "./features/HistoryRepository.svelte";
export {
  ACPLocalHistoryRepositoryWriter,
  getACPLocalHistoryRepo,
  setACPLocalHistoryContext,
} from "./features/LocalHistoryRepository.svelte";
export type { ACPLocalHistoryRepository } from "./features/LocalHistoryRepository.svelte";
export {
  LocalInferenceAgentSync,
  type LocalInferenceAgentSyncSessions,
} from "./features/LocalInferenceAgentSync";
export {
  LocalInferenceRepository,
  getLocalInferenceContext,
  getLocalInferenceRepo,
  setLocalInferenceContext,
} from "./features/LocalInferenceRepository.svelte";
export {
  getACPMCPSettingsRepo,
  setACPMCPSettingsContext,
} from "./features/MCPSettingsRepository.context";
export {
  ACPMCPSettingsRepositoryWriter,
  fetchAllowCustomMCPServers,
} from "./features/MCPSettingsRepository.svelte";
export type { ACPMCPSettingsRepository } from "./features/MCPSettingsRepository.svelte";
export {
  NotificationRepositoryWriter,
  getNotificationContext,
  setNotificationContext,
} from "./features/NotificationRepository.svelte";
export type {
  NotificationRepository,
  NotificationShowParams,
  Notifier,
} from "./features/NotificationRepository.svelte";
export {
  ACPProjectRepositoryWriter,
  getACPProjectRepo,
  setACPProjectContext,
} from "./features/ProjectRepository.svelte";
export type { ACPProjectRepository } from "./features/ProjectRepository.svelte";
export { refreshACPNavState } from "./features/refreshACPNavState";
export { ACP_SESSION_NEW_EVENT, ACP_SESSION_TITLE_EVENT } from "./features/Session.svelte";
export type { ACPSession } from "./features/Session.svelte";
export { enableAcpTranscriptBatching } from "./features/session/transcriptBatching";
export { default as AcpProvider } from "./features/SessionProvider.svelte";
export {
  ACPSessionRepositoryWriter,
  getACPContext,
  getACPSessionRepo,
  setACPContext,
} from "./features/SessionRepository.svelte";
export type { ACPSessionRepository } from "./features/SessionRepository.svelte";
export {
  AcpSetupScriptOutputRepositoryWriter,
  getACPSetupScriptOutputRepo,
  setACPSetupScriptOutputContext,
} from "./features/SetupScriptOutputRepository.svelte";
export type {
  AcpSetupScriptOutput,
  AcpSetupScriptOutputRepository,
  AcpSetupScriptOutputStatus,
} from "./features/SetupScriptOutputRepository.svelte";
export { getUserMCPServersRepo } from "./features/UserMCPServersRepository.svelte";
export {
  ACPWorktreeRepositoryWriter,
  createACPWorktreeRepository,
  createAssistantTerminalCommandRunner,
  getACPWorktreeRepo,
  setACPWorktreeContext,
} from "./features/WorktreeRepository";
export type {
  ACPWorktreeCommandRunner,
  ACPWorktreeRepository,
  AssistantTerminalCommandRunnerOptions,
} from "./features/WorktreeRepository";
export {
  GITHUB_COLOR_MODES,
  githubChecksCountLabel,
  githubCommentsCountLabel,
  githubDotColorClass,
  githubPRActionLabel,
  githubReviewDecisionLabel,
  githubStatusCategory,
  githubStatusSummary,
} from "./github/githubStatus";
export type {
  GitHubCheckRun,
  GitHubChecks,
  GitHubColorMode,
  GitHubComment,
  GitHubPRDetail,
  GitHubPRStatus,
  GitHubReview,
  GitHubStatusCategory,
  GitHubWorktreeStatus,
} from "./github/githubStatus";
export {
  CODEX_GOAL_CONTROL_METHOD,
  parseClaudeGoalUpdate,
  parseCodexGoalUpdate,
  type ACPClaudeGoalUpdate,
  type ACPGoalState,
  type ACPGoalStatus,
} from "./goals";
export * from "./hostAdapter";
export {
  rpc as acpHostRpc,
  createHelperApiClient,
  initializeStatefulModule as initializeACPHostRpc,
} from "./hostRpc";
export type { HelperAPIClient, HostMessageSender, RPCClient } from "./hostRpc";
export { CAMBER_ROUNDEL_ICON_URL } from "./localAgentIcon";
export { markdownHost } from "./markdownHost";
export {
  ACP_DESKTOP_CONVERSATIONS_EVENT,
  countAttentionConversations,
  isACPChatConversation,
  newConversationID,
} from "./navTypes";
export type {
  ACPConversationSummary,
  ACPConversationsState,
  ACPNavConversation,
  ACPNavProject,
  ACPNavProjectSettings,
} from "./navTypes";
export type { ACPTransport } from "./RPCTransport";
export type { ACPResolvedSessionInfo } from "./sessionInfo";
export { wireACPHistorySync } from "./wireACPHistorySync";
export { wireACPSessionSync } from "./wireACPSessionSync";
export {
  ACP_CHAT_WORKSPACE_PATH,
  ACP_IDE_WORKSPACE_PATH,
  acpProtocolCwd,
  acpSessionWorkspacePath,
  acpWorkingDirectories,
  acpWorkspaceFolders,
  acpWorkspacePath,
} from "./workspaceScope";
