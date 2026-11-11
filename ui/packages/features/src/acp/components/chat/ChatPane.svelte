<script lang="ts">
  import { appState, resolveSessionCwd } from "../../hostAdapter";
  import { toolActivityFrom } from "../SessionEventsState.svelte";
  import Prompt from "./Prompt.svelte";
  import { getACPContext } from "../../features/SessionRepository.svelte";
  import { reportConversationViewState } from "../../features/conversationViewState";
  import { setACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import { getACPAgentServersRepo } from "../../features/AgentServersRepository.svelte";
  import { getACPConversationRepo } from "../../features/ConversationRepository.svelte";
  import { getACPProjectRepo } from "../../features/ProjectRepository.svelte";
  import { refreshACPNavState } from "../../features/refreshACPNavState";
  import { getCurrentAssistantTerminalRepo } from "../../features/AssistantTerminalRepository.svelte";
  import type { ChatPaneChrome } from "./chatPaneChrome";
  import {
    getACPSetupScriptOutputRepo,
    type AcpSetupScriptOutput,
  } from "../../features/SetupScriptOutputRepository.svelte";
  import { isWindowsOperatingSystem } from "../../prompt/menus/files/pathRewrites";
  import SessionPlan from "../events/SessionPlan.svelte";
  import SessionEventsRenderer from "../SessionEventsRenderer.svelte";
  import { ScrollManager } from "./ScrollManager";
  import { Boundary } from "@camber/components/boundary";
  import { Spinner } from "@camber/components/spinner";
  import ChatEmptyState from "./ChatEmptyState.svelte";
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { getKeybindingService } from "../../../keybindings";
  import AcpAuthRequiredPanel from "../AuthRequiredPanel.svelte";
  import { getACPAgentRegistryRepo } from "../../features/AgentRegistryRepository.svelte";
  import AcpEmptyStateProjectSelector from "./EmptyStateProjectSelector.svelte";
  import AcpAddProjectDropzone from "./AddProjectDropzone.svelte";
  import AcpSetupAgentDropzone from "./SetupAgentDropzone.svelte";
  import AcpConversationHeader from "./ConversationHeader.svelte";
  import AcpPromptConfigControls from "./menus/config/PromptConfigControls.svelte";
  import AcpPlanModeBanner from "./PlanModeBanner.svelte";
  import CompactionBanner from "./CompactionBanner.svelte";
  import AcpEnqueuedInput from "./EnqueuedInput.svelte";
  import AcpPromptError from "./PromptError.svelte";
  import AcpHistoryUnavailableNotice from "./HistoryUnavailableNotice.svelte";
  import PermissionRequest from "../events/PermissionRequest.svelte";
  import { isToolCall, type ToolCall } from "../../types";
  import StreamingIndicator from "../ui/StreamingIndicator.svelte";
  import AssistantLiveRegion from "../ui/AssistantLiveRegion.svelte";
  import { agentBrandTint, agentIconUrl, agentPickerIconProps } from "./menus/config/agentConfig";
  import ElicitationPrompt from "./elicitation/ElicitationPrompt.svelte";
  import { getElicitationContext } from "../../../elicitation";
  import AssistantTerminalPanel from "../AssistantTerminalPanel.svelte";
  import {
    acpProtocolCwd,
    acpWorkspaceProjectFolders,
    acpWorkspaceFolders,
  } from "../../workspaceScope";
  import {
    DEFAULT_AGENT_SERVER,
    LOCAL_AGENT_SERVER,
    resolveAgentServers,
  } from "../../agentServers";
  import { getLocalInferenceRepo } from "../../features/LocalInferenceRepository.svelte";
  import { currentModelConfigValue } from "../../localInferenceModelOptions";
  import {
    isExternalLocalInferenceRuntime,
    localRuntimeResidency,
    turnHasAgentOutput,
  } from "../../localInferenceRuntime";
  import Icon from "@camber/components/icon";
  import { InfoMessageType } from "@camber/rpc";
  import type { ACPAuthMethodTerminal } from "../../authMethods";
  import { rpc } from "../../hostRpc";
  import {
    DESKTOP_FILE_TREE_CHANGED_EVENT,
    DESKTOP_GIT_CHANGED_EVENT,
    DesktopGitChangesState,
    type DesktopFileTreeChangedEventDetail,
  } from "../../features/DesktopGitChangesState.svelte";
  import { requestDesktopChangesView } from "./desktopChangesViewRequest";
  import {
    DESKTOP_OPEN_DIFF_TAB_EVENT,
    type DesktopOpenDiffTabEventDetail,
  } from "./desktopCommandPicker";
  import DesktopGitChangesSummary from "./DesktopGitChangesSummary.svelte";
  import { getOptionalACPConnectionPoolContext } from "../../connectionPoolContext";
  import { scopeTrajectoryToConversation } from "../../trajectory";
  import { saveACPTrajectory } from "../../dumpACPConversation";
  import AcpTrajectoryViewer from "./TrajectoryViewer.svelte";
  import SetupScriptToolCall from "./SetupScriptToolCall.svelte";
  import {
    imageFromContextMenuEvent,
    showDesktopRenderedImageContextMenu,
  } from "./desktopRenderedImageContextMenu";
  import { getOptionalSubagentTranscriptNavigation } from "./subagentTranscriptNavigation";

  interface Props {
    /** Affordances the host surface supplies around the pane; see ChatPaneChrome. */
    chrome?: ChatPaneChrome;
    onNewConversation: (cwd?: string) => string | null | void | Promise<string | null | void>;
    onAddProject: () => Promise<void> | void;
    onShowAgentSettings: () => void;
    onShowModelSettings?: () => void;
    editorSurface?: boolean;
    promptBanners?: Snippet;
    promptCommandItems?: Snippet;
    promptMenus?: Snippet;
    promptFooterLeading?: Snippet;
    activeConversationId?: string | null;
    onActiveConversationIdChange?: (key: string | null) => void;
    markReadWhenVisible?: boolean;
    /** Focus the composer when the pane opens (mobile new-conversation flow). */
    autofocusPrompt?: boolean;
    /** Transcript-only presentation for modal inspection of archived conversations. */
    readOnlyPreview?: boolean;
  }

  let {
    chrome,
    onNewConversation,
    onAddProject,
    onShowAgentSettings,
    editorSurface = false,
    promptBanners,
    promptCommandItems,
    promptMenus,
    promptFooterLeading,
    activeConversationId = null,
    onActiveConversationIdChange,
    markReadWhenVisible = true,
    autofocusPrompt = false,
    readOnlyPreview = false,
  }: Props = $props();

  let hostSidebar = $derived(chrome?.sidebar);
  let sidebarCollapsed = $derived(hostSidebar?.collapsed ?? false);
  let desktopSidebarWidth = $derived(hostSidebar?.width ?? 260);
  let showConversationHeader = $derived((chrome?.header ?? "conversation") === "conversation");
  let terminalSurface = $derived(chrome?.terminal?.surface ?? "legacy-panel");
  let openExternalTerminal = $derived(
    chrome?.terminal?.surface === "external" ? chrome.terminal.open : undefined,
  );
  let desktopPanelFrame = $derived((chrome?.frame ?? "desktop-panel") === "desktop-panel");

  const acp = getACPContext();
  const agentServers = getACPAgentServersRepo();
  const conversations = getACPConversationRepo();
  const useSubagentTranscriptTabs = getOptionalSubagentTranscriptNavigation() !== undefined;
  const chatSession = setACPChatSessionScope(
    acp,
    () => activeConversationId,
    (id) => onActiveConversationIdChange?.(id),
    conversations,
    () => toolActivityFrom($appState),
    useSubagentTranscriptTabs,
  );
  const projects = getACPProjectRepo();
  const registry = getACPAgentRegistryRepo();
  const assistantTerminals = getCurrentAssistantTerminalRepo();
  const setupScriptOutputs = getACPSetupScriptOutputRepo();
  const elicitation = getElicitationContext();

  const DESKTOP_TERMINAL_WIDTH_STORAGE_KEY = "camber.desktop.terminalWidth";
  const DESKTOP_TERMINAL_DEFAULT_WIDTH = 420;
  const DESKTOP_TERMINAL_MIN_WIDTH = 280;
  const DESKTOP_TERMINAL_MAX_WIDTH = 900;
  const CHAT_CONTENT_MAX_WIDTH = "48rem";
  const TERMINAL_AUTH_POLL_INTERVAL_MS = 1_000;

  let hasPendingPermissionRequests = $derived(chatSession.pendingPermissionRequests.length > 0);
  // Elicitations are keyed to the session that raised them; other chats'
  // pending elicitations must not surface (or block the composer) here.
  let hasPendingElicitation = $derived(
    elicitation.hasPendingForChat(chatSession.sessionId, chatSession.sessionAgentServer),
  );

  // Event-driven git working-tree tracking for the desktop/VS Code conversation
  // footer. The footer is purely git-based — no task/version system: the branch,
  // file state, and +/− line counts come straight from `git status`, and the
  // branch opens "Stage and Commit...". No polling:
  // refreshes are driven by the host file watcher, in-app git mutations,
  // turn completion, and window focus (see DesktopGitChangesState).
  const gitChanges = new DesktopGitChangesState();
  onMount(() => () => gitChanges.dispose());
  // $derived.by so the supportsReviewBar reference (declared later) resolves
  // lazily.
  let desktopConversationOverlaysHeight = $state(0);
  let showGitChangesSummary = $derived.by(
    () => supportsReviewBar && chatSession.events.length > 0 && gitChanges.isRepo,
  );
  let showConversationOverlays = $derived(
    !readOnlyPreview &&
      !hasPendingPermissionRequests &&
      ((chatSession.plan && chatSession.plan.entries.length > 0) || showGitChangesSummary),
  );
  let showConversationOverlayStack = $derived(
    !readOnlyPreview && (showConversationOverlays || chatSession.queuedPrompts.length > 0),
  );
  let desktopConversationOverlaysInset = $derived(
    showConversationOverlayStack ? desktopConversationOverlaysHeight : 0,
  );
  // Keep the "Working…" indicator visible for the entire turn the agent is
  // running — including while a tool call is in flight (e.g. a long, blocking
  // command). It used to be hidden whenever the last event was an active tool,
  // so it vanished for the tool's whole duration and the transcript looked
  // idle. It still hides while a permission request is pending: there the agent
  // is blocked on the user rather than working, and the prompt already says so.
  // A turn is "live" whether it was started here (isPrompting) or on another
  // connected surface (isRemoteWorking, e.g. the phone prompting this
  // conversation while the desktop watches).
  let isTurnActive = $derived(chatSession.isPrompting || chatSession.isRemoteWorking);
  let showWorkingIndicator = $derived(isTurnActive && !hasPendingPermissionRequests);
  let streamingIndicatorIconUrl = $derived.by(() => {
    const server = chatSession.sessionAgentServer ?? chatSession.activeAgentServer;
    return server ? agentIconUrl(registry, server) : undefined;
  });
  let streamingIndicatorTint = $derived.by(() => {
    const server = chatSession.sessionAgentServer ?? chatSession.activeAgentServer;
    return server ? agentBrandTint(registry, server) : undefined;
  });
  // While a local-agent turn is running but the sidecar does not yet have the
  // session's model resident in memory, the wait is the model load (sidecar
  // spawn included) — label the indicator accordingly instead of the generic
  // "Working...". The context is provided app-wide; the fallback keeps hosts
  // without it on the default label rather than crashing.
  function optionalLocalInferenceRepo(): ReturnType<typeof getLocalInferenceRepo> | null {
    try {
      return getLocalInferenceRepo();
    } catch {
      return null;
    }
  }
  const localInference = optionalLocalInferenceRepo();
  // Residency (via localInference didChange pushes) starts the label but must
  // not end it: the push lands when the weights are resident, yet nothing is
  // on screen until prefill finishes seconds later, and a missed or
  // mismatched push would pin the label for the whole turn. So a mismatch
  // latches the label and only the first agent output releases it — the label
  // changes exactly when something visible changes. A warm model never
  // mismatches, so warm turns still go straight to "Working...".
  let modelLoadLatched = $state(false);
  let isModelLoadObserved = $derived.by(() => {
    if (!localInference || !isTurnActive) return false;
    if ((chatSession.sessionAgentServer ?? chatSession.activeAgentServer) !== LOCAL_AGENT_SERVER) {
      return false;
    }
    if (turnHasAgentOutput(chatSession.events)) return false;
    // The helper cannot observe model residency for an externally managed
    // runtime, so it cannot distinguish loading from generation there.
    if (isExternalLocalInferenceRuntime(localInference.state)) return false;
    const residency = localRuntimeResidency(localInference.state);
    return !(
      residency &&
      localModelIdsMatch(residency.modelId, currentModelConfigValue(chatSession.configOptions))
    );
  });
  $effect(() => {
    if (!isTurnActive || turnHasAgentOutput(chatSession.events)) {
      modelLoadLatched = false;
    } else if (isModelLoadObserved) {
      modelLoadLatched = true;
    }
  });
  let streamingIndicatorLabel = $derived(
    isModelLoadObserved || modelLoadLatched ? "Loading model..." : undefined,
  );
  // The selected value and loadedModelId come from the same catalog and are
  // normally identical; the last-segment fallback tolerates owner/name vs
  // bare-name mismatches. An unknown selection counts as matched — better to
  // show "Working..." than to claim a load that may not be happening.
  function localModelIdsMatch(loaded: string, selected: string | null): boolean {
    if (!selected) return true;
    if (loaded === selected) return true;
    return loaded.split("/").at(-1) === selected.split("/").at(-1);
  }

  // Drop the detached-scroll flag when the conversation changes: it belongs to
  // the previous transcript, and the new one renders (and is scrolled to its
  // bottom) before any scroll event would clear it — without this the
  // jump-to-bottom button flashes over the incoming conversation.
  $effect(() => {
    void chatSession.conversationId;
    scrollDetached = false;
  });

  let scrollManager = $state<ScrollManager>();
  let scrollEl = $state<HTMLElement>();
  /** True when auto-scroll has let go of the bottom (user scrolled up). */
  let scrollDetached = $state(false);
  let hasTranscriptTopOverflow = $state(false);
  let hasTranscriptBottomOverflow = $state(false);
  let terminalCollapsed = $state(true);
  let desktopTerminalWidth = $state(DESKTOP_TERMINAL_DEFAULT_WIDTH);

  // The "right panel" keyboard shortcut toggles the terminal panel (which this pane owns).
  // No-op on hosts without a terminal panel or without dispatch (VS Code delegates).
  const keybindings = getKeybindingService();
  let desktopTerminalResizeStartX = $state(0);
  let desktopTerminalResizeStartWidth = $state(DESKTOP_TERMINAL_DEFAULT_WIDTH);
  let desktopTerminalResizing = $state(false);
  let hasLoadedProjectsOnce = $state(false);
  let dismissedReadOnlySessionId = $state<string | null>(null);
  let pendingTerminalAuthMethodByAgent = $state<Record<string, string>>({});
  // Auth methods the user has launched (terminal or external browser flow).
  // While set, the auth panel swaps the login buttons for "I'm logged in" /
  // "Try again": external flows finish outside the app, so the user confirms
  // completion manually and we re-verify with a fresh config probe.
  let attemptedAuthMethodByAgent = $state<Record<string, string>>({});
  let authConfirmInProgressFor = $state<Record<string, true>>({});
  const terminalAuthPollControllers = new Map<string, AbortController>();
  let autoCollapsedSetupOutputKeys = $state<Record<string, true>>({});

  onMount(() => () => {
    for (const controller of terminalAuthPollControllers.values()) {
      controller.abort();
    }
    terminalAuthPollControllers.clear();
  });

  const acpConnectionPool = getOptionalACPConnectionPoolContext();
  let trajectoryViewerOpen = $state(false);

  async function saveTrajectory() {
    if (!acpConnectionPool) {
      rpc.showInfoMessage("ACP Events is unavailable", InfoMessageType.error);
      return;
    }
    const server = chatSession.sessionAgentServer ?? chatSession.activeAgentServer;
    const entries = scopeTrajectoryToConversation(
      acpConnectionPool.debug.dump(server),
      chatSession.sessionId,
    );
    if (entries.length === 0) {
      rpc.showInfoMessage("No ACP events recorded yet", InfoMessageType.info);
      return;
    }
    await saveACPTrajectory(entries, chatSession.sessionId, $appState.environment.assistantHost);
  }
  let isSessionLoading = $derived(
    chatSession.sessionLoadState.status === "loading" ||
      (activeConversationId != null && chatSession.conversationId == null),
  );
  let isBlockingSessionLoading = $derived(isSessionLoading && chatSession.events.length === 0);
  let isSessionSetupPending = $derived(
    isSessionLoading ||
      agentServers.state.status !== "success" ||
      chatSession.isConfigCacheLoading ||
      acp.agents.authInProgressForAgent(chatSession.activeAgentServer),
  );
  let readOnlySessionId = $derived(chatSession.conversationId ?? "read-only");
  let showReadOnlyBanner = $derived(
    readOnlyPreview || (chatSession.isReadOnly && dismissedReadOnlySessionId !== readOnlySessionId),
  );
  let isDesktop = $derived($appState.environment.assistantHost === "desktop");
  // Phone-sized layout: tighter transcript/composer spacing, safe-area bottom
  // padding, compact empty state.
  let isMobile = $derived($appState.environment.assistantHost === "mobile");
  // The IDE hosts have no in-webview changes view; the conversation "Review"
  // bar there opens the editor's native git UI instead (VS Code's Source
  // Control panel, Visual Studio's Git Changes window).
  let isVscode = $derived($appState.environment.assistantHost === "vscode");
  let isVs = $derived($appState.environment.assistantHost === "vs");
  // Hosts that show the git "Review" bar at the bottom of a conversation:
  // desktop (opens the custom changes view) and the IDE hosts (open native
  // SCM via revealSourceControl). Mobile is intentionally excluded until it
  // gets its own review surface — TODO(mobile-review): show the bar and wire
  // a mobile changes view in a follow-up.
  let supportsReviewBar = $derived(!readOnlyPreview && (isDesktop || isVscode || isVs));

  function showRenderedImageContextMenu(event: MouseEvent): void {
    if (!isDesktop) return;
    const image = imageFromContextMenuEvent(event);
    if (!image) return;

    event.preventDefault();
    void showDesktopRenderedImageContextMenu(image, {
      x: event.clientX,
      y: event.clientY,
    });
  }

  function transcriptImageContextMenu(node: HTMLElement): () => void {
    node.addEventListener("contextmenu", showRenderedImageContextMenu);
    return () => node.removeEventListener("contextmenu", showRenderedImageContextMenu);
  }

  // Opens the review surface appropriate to the host: the desktop app's
  // custom changes view, or VS Code's native Source Control panel.
  function openReview(): void {
    if (isDesktop) {
      requestDesktopChangesView(terminalScopePath || undefined);
    } else if (isVscode || isVs) {
      rpc.revealSourceControl();
    }
  }

  // Opens the singleton Diff tab (all changed files) on desktop; VS Code has
  // no in-webview diff tab, so fall back to the review surface there.
  function openDiff(): void {
    if (isDesktop) {
      window.dispatchEvent(
        new CustomEvent<DesktopOpenDiffTabEventDetail>(DESKTOP_OPEN_DIFF_TAB_EVENT, {
          detail: { worktreePath: terminalScopePath || undefined },
        }),
      );
    } else {
      openReview();
    }
  }
  let usesEditorSurface = $derived(isDesktop || editorSurface);
  let supportsTerminalPanel = $derived(Boolean($appState.environment.capabilities.terminalPanel));
  let usesLegacyTerminalPanel = $derived(
    !readOnlyPreview && supportsTerminalPanel && terminalSurface === "legacy-panel",
  );
  let firstProject = $derived(
    projects.projects.find((project) => !project.isWorktree) ?? projects.projects[0],
  );
  let desktopLaunchWorktreeProject = $derived.by(() => {
    const worktreeName = $appState.environment.desktopInstance?.worktreeName;
    if (!isDesktop || !worktreeName) return undefined;
    return projects.projects.find(
      (project) =>
        project.isWorktree &&
        (project.name === worktreeName || pathBasename(project.path) === worktreeName),
    );
  });
  let currentConversationCwd = $derived(chatSession.activeWorkspaceCwd ?? pendingConversationCwd());
  let setupScriptOutput = $derived(setupScriptOutputs.outputFor(currentConversationCwd));
  let inlineSetupScriptOutput = $derived(
    setupScriptOutput?.surface === "terminal" ? null : setupScriptOutput,
  );
  let hasUserPrompted = $derived(
    chatSession.events.some((event) => event.eventKind === "user_message"),
  );
  let currentACPWorkspaceFolders = $derived(
    acpWorkspaceFolders($appState, resolveDesktopWorkspaceRoot(currentConversationCwd)),
  );
  let currentWorkspaceProjects = $derived(
    acpWorkspaceProjectFolders(projects.projects, currentACPWorkspaceFolders),
  );
  let terminalScopePath = $derived(resolveTerminalScopePath(currentConversationCwd));
  let desktopOpenTargetKind = $derived(desktopTargetKind(terminalScopePath));
  let desktopInstanceWorktreeName = $derived(
    projectDisplayName(desktopLaunchWorktreeProject) ??
      projectDisplayNameForPath(terminalScopePath || currentConversationCwd),
  );
  let shouldWaitForInitialProject = $derived(isDesktop && !hasLoadedProjectsOnce);
  const initialLoadError = $derived(
    isDesktop && shouldWaitForInitialProject && projects.refreshState.status === "failure"
      ? "Couldn’t load your conversations."
      : isDesktop && agentServers.state.status === "failure" && chatSession.events.length === 0
        ? "Couldn’t load your agents."
        : null,
  );
  let retryingInitialLoad = $state(false);
  async function retryInitialLoad() {
    if (retryingInitialLoad) return;
    retryingInitialLoad = true;
    try {
      await Promise.allSettled([
        refreshACPNavState(projects, conversations),
        agentServers.refresh(),
      ]);
    } finally {
      retryingInitialLoad = false;
    }
  }
  // The centered new-conversation header offers a project picker ("...in <project>")
  // only when there is a project to anchor to (mirrors AcpEmptyStateProjectSelector's
  // own gate). With none — e.g. the standalone launch chat — it reads "...using <config>".
  let showHeaderProjectSelector = $derived((isDesktop || isMobile) && projects.projects.length > 0);
  // On desktop with no projects the user is in the standalone launch chat; offer opening a
  // folder or setting up another agent, styled like the old empty-state dropzone.
  let showLaunchChatActions = $derived(isDesktop && projects.projects.length === 0);
  let claudeSetupIconUrl = $derived(agentIconUrl(registry, "claude-acp"));
  let codexSetupIconUrl = $derived(agentIconUrl(registry, "codex-acp"));
  // Stop nudging users who have already set agents up: hide the "set up another agent"
  // action once more than one agent beyond the built-in Camber and Camber local
  // agents is configured.
  let configuredExtraAgentCount = $derived(
    acp.agents.agentServerNames.filter(
      (name) => name !== DEFAULT_AGENT_SERVER && name !== LOCAL_AGENT_SERVER,
    ).length,
  );
  let showSetupAgentAction = $derived(configuredExtraAgentCount <= 1);
  // A pending conversation submits through its selected agent. Until that agent
  // is authenticated there is no usable conversation target, so the composer
  // itself is disabled (read-only editor, blocked submit) and the
  // authentication panel owns the next action. Only the composer: the banners
  // above it stay interactive, because recovering from a failed sign-in often
  // means updating or reinstalling the very agent that cannot authenticate.
  let noAuthenticatedAgentAvailable = $derived(
    acp.agents.authRequiredForAgent(chatSession.activeAgentServer),
  );
  // The prompt-draft key identifies the conversation the user is composing
  // in, not the agent they happen to have selected — switching agent on an
  // empty draft must not throw away the in-progress text.
  // Wait only until the automatic local draft has a stable ID. A short-lived
  // `new:cwd` editor would otherwise remount and discard attachments/undo when
  // bootstrap assigns the ID. Config probing continues with the editor mounted.
  let shouldWaitForLocalDraft = $derived(
    isDesktop &&
      activeConversationId == null &&
      chatSession.conversationId == null &&
      !noAuthenticatedAgentAvailable &&
      agentServers.state.status !== "failure" &&
      !chatSession.error,
  );
  let promptDraftKey = $derived(
    chatSession.conversationId ?? activeConversationId ?? `new:${currentConversationCwd}`,
  );
  // A conversation whose history the agent could not restore is empty but is
  // not new: it keeps the ordinary conversation layout, with the notice in
  // place of the transcript, rather than the "Start a new conversation" hero.
  let isNewConversation = $derived(
    !isBlockingSessionLoading &&
      chatSession.events.length === 0 &&
      chatSession.pendingPermissionRequests.length === 0 &&
      !chatSession.historyUnavailable,
  );
  let centerNewConversationComposer = $state(true);
  let previousComposerDraftKey = $state<string | null>(null);
  let previouslyNewConversation = $state(false);
  let shouldCenterComposer = $derived(
    !readOnlyPreview &&
      !shouldWaitForInitialProject &&
      !shouldWaitForLocalDraft &&
      !initialLoadError &&
      isNewConversation &&
      centerNewConversationComposer,
  );
  // On a short pane the centered stack (header + launch actions + a grown
  // prompt editor) can outgrow the viewport; when it does, the caret-reveal
  // scroll pushes the "Start a new conversation" header out of view. Constrain
  // the composer to the pane instead: the roundel collapses first (the
  // transcript scroller's shrink), then the prompt editor gives up height and
  // scrolls internally (see the centered-composer-constrained CSS below).
  // Mobile keeps its own single-line pill composer and is left alone.
  let constrainCenteredComposer = $derived(shouldCenterComposer && !isMobile);

  // Text size for the controls in the composer column. The prompt and the
  // elicitation form are siblings that read as one input surface, so they must
  // not disagree about it; both take their size from this. Desktop draws the
  // composer a notch larger than the 14px every other host uses.
  let composerFontSize = $derived(isDesktop ? "15px" : "14px");
  let lastScrolledConversationId = $state<string | null>(null);

  // Desktop new-conversation hero grid: painted at the pane level (the empty
  // state's own grid would be clipped by the transcript scroller), with its
  // radial fade centred on the parasol. The parasol's position depends on the
  // centered stack's layout, so measure the logo stage and track resizes.
  let conversationAreaEl = $state<HTMLElement>();
  let heroGridCenter = $state<{ x: number; y: number } | null>(null);

  // The conversation area is the pane's definite, shrinkable height. The
  // composer (and the elicitation form inside it) is shrink-0 / auto-height, so
  // it has no ancestor with a resolvable height to bound against — a tall
  // elicitation form would otherwise overflow the top of this overflow-clip box
  // and clip its Submit row when a terminal/split shrinks the pane (PE-2475).
  // Publish the measured height as a CSS var so the form can cap itself to the
  // pane and scroll its fields internally.
  let conversationAreaHeight = $state(0);
  $effect(() => {
    const area = conversationAreaEl;
    if (!area) return;
    const measure = () => {
      conversationAreaHeight = area.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  });

  $effect(() => {
    const area = conversationAreaEl;
    if (!isDesktop || !shouldCenterComposer || shouldWaitForInitialProject || !area) {
      heroGridCenter = null;
      return;
    }
    const measure = () => {
      const stage = area.querySelector("[data-empty-state-logo]");
      if (!stage) {
        heroGridCenter = null;
        return;
      }
      // The hero stage renders the parasol centred in itself, so the grid's
      // fade centre is simply the stage centre.
      const stageRect = stage.getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      heroGridCenter = {
        x: stageRect.left + stageRect.width / 2 - areaRect.left,
        y: stageRect.top + stageRect.height / 2 - areaRect.top,
      };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    const stage = area.querySelector("[data-empty-state-logo]");
    if (stage) observer.observe(stage);
    return () => observer.disconnect();
  });

  onMount(() => {
    desktopTerminalWidth = getSavedDesktopTerminalWidth();
  });

  onMount(() =>
    keybindings?.register("toggleRightPanel", () => {
      if (usesLegacyTerminalPanel) terminalCollapsed = !terminalCollapsed;
    }),
  );

  $effect(() => {
    if (projects.refreshState.status === "success") {
      hasLoadedProjectsOnce = true;
    }
  });

  $effect(() => {
    const draftKey = promptDraftKey;
    const newConversation = isNewConversation;

    if (
      newConversation &&
      (!previouslyNewConversation ||
        (draftKey !== previousComposerDraftKey && !chatSession.isSending))
    ) {
      centerNewConversationComposer = true;
    }

    previousComposerDraftKey = draftKey;
    previouslyNewConversation = newConversation;
  });

  $effect(() => {
    const next = { ...pendingTerminalAuthMethodByAgent };
    const nextAttempted = { ...attemptedAuthMethodByAgent };
    let changed = false;
    let attemptedChanged = false;
    for (const agentServer of Object.keys(next)) {
      if (!acp.agents.authRequiredForAgent(agentServer)) {
        delete next[agentServer];
        changed = true;
      }
    }
    for (const agentServer of Object.keys(nextAttempted)) {
      if (!acp.agents.authRequiredForAgent(agentServer)) {
        delete nextAttempted[agentServer];
        attemptedChanged = true;
      }
    }
    if (changed) {
      pendingTerminalAuthMethodByAgent = next;
    }
    if (attemptedChanged) {
      attemptedAuthMethodByAgent = nextAttempted;
    }
  });

  $effect(() => {
    if (!chatSession.isReadOnly) {
      dismissedReadOnlySessionId = null;
    }
  });

  $effect(() => {
    if (!inlineSetupScriptOutput || inlineSetupScriptOutput.collapsed) return;
    const reason =
      inlineSetupScriptOutput.status === "completed"
        ? "completed"
        : hasUserPrompted
          ? "prompted"
          : null;
    if (!reason) return;
    const key = `${setupOutputKey(inlineSetupScriptOutput)}:${reason}`;
    if (autoCollapsedSetupOutputKeys[key]) return;
    autoCollapsedSetupOutputKeys = { ...autoCollapsedSetupOutputKeys, [key]: true };
    setupScriptOutputs.collapse(inlineSetupScriptOutput.path);
  });

  $effect(() => {
    const sessionId = chatSession.sessionId;
    const agentServer = chatSession.sessionAgentServer;
    if (!sessionId || !agentServer) return;
    if (!markReadWhenVisible) return;
    if (!$appState.isEditorFocused) return;
    if (acp.getConversationStatus(sessionId, agentServer).unread) {
      acp.clearUnread(sessionId, agentServer);
    }
  });

  // Primitive so unrelated appState churn does not re-run effects reading it.
  let editorFocusedForViewState = $derived($appState.isEditorFocused === true);

  // Viewing a parent also clears its spawned descendants' unread state. A
  // separate effect that reads descendants untracked: it re-runs only when this
  // conversation is activated or focused, never on a child's later status
  // change or on the parent's own unread flipping.
  $effect(() => {
    const sessionId = chatSession.sessionId;
    const agentServer = chatSession.sessionAgentServer;
    if (!sessionId || !agentServer) return;
    if (!markReadWhenVisible) return;
    if (!editorFocusedForViewState) return;
    untrack(() => {
      const summary = conversations.getSession(sessionId, agentServer);
      if (summary) acp.clearDescendantUnread(summary.id, conversations.sessions);
    });
  });

  // Tell the helper this surface is watching the conversation: completing
  // turns skip the unread mark while any surface watches, and activating a
  // conversation clears its unread flag on every surface. Losing focus or
  // switching away reports the conversation inactive via the effect cleanup.
  // The focus flag goes through a primitive $derived so unrelated appState
  // churn does not re-run the effect and emit redundant inactive/active pairs.
  $effect(() => {
    const sessionId = chatSession.sessionId;
    const agentServer = chatSession.sessionAgentServer;
    if (!sessionId || !agentServer) return;
    if (!markReadWhenVisible) return;
    if (!editorFocusedForViewState) return;
    reportConversationViewState({ sessionId, agentServer, active: true });
    return () => reportConversationViewState({ sessionId, agentServer, active: false });
  });

  // While this pane is the visible chat surface (markReadWhenVisible mirrors
  // the desktop chat tab's selection), keep the active conversation's session
  // on the responsive visible transcript flush cadence. Sessions no pane displays —
  // background conversations streaming from other surfaces, or everything
  // while the chat tab is hidden — drop to the slow hidden cadence and flush
  // once on their way back on screen.
  $effect(() => {
    const conversationId = activeConversationId;
    if (!conversationId || !markReadWhenVisible) return;
    // untrack: claiming can synchronously flush a pending hidden-cadence
    // publish, whose deep reads of session.events/metadata would otherwise
    // become dependencies of this effect and re-run it on every later flush.
    return untrack(() => acp.claimVisibleConversation(conversationId));
  });

  // While this pane is hidden (a terminal tab selected over it on desktop,
  // the terminal sheet open on mobile), the transcript renderer is unmounted
  // entirely — see the markReadWhenVisible gate around SessionEventsRenderer.
  // Deriveds are lazy, so with no renderer reading timelineItems the whole
  // grouping/timeline chain stops recomputing, and the hidden tab's DOM stops
  // being patched on every flush (content-visibility: hidden suppresses
  // layout/paint for keepAllAlive tabs, but not reactivity or DOM patching).
  // The pane shell — prompt, drafts, permissions, plan — stays mounted.
  //
  // Scroll position is captured here in a pre-effect (runs before the DOM
  // update that unmounts the renderer) and restored by the effect below once
  // the renderer is back. A reader who was following the bottom is returned
  // to the newest content; a detached reader gets their place back unless the
  // conversation changed while hidden.
  let hiddenScroll: { top: number; attached: boolean; conversationId: string | null } | null = null;
  $effect.pre(() => {
    if (markReadWhenVisible) return;
    const el = scrollEl;
    if (!el) return;
    hiddenScroll = {
      top: el.scrollTop,
      attached: scrollManager?.attached ?? true,
      conversationId: untrack(() => activeConversationId),
    };
  });
  $effect(() => {
    if (!markReadWhenVisible) return;
    const saved = hiddenScroll;
    if (!saved) return;
    hiddenScroll = null;
    const el = scrollEl;
    if (!el) return;
    const keepPlace =
      !saved.attached && saved.conversationId === untrack(() => activeConversationId);
    void restoreScrollAfterRemount(el, keepPlace ? saved.top : null);
  });

  /**
   * Reapplies scroll position after the transcript remounts. Remounting a long
   * virtualized thread re-measures rows over several frames (each pass can
   * grow scrollHeight), so a fixed number of attempts undershoots — keep
   * applying until the height is stable across two frames. `top === null`
   * means "pin to bottom" (the reader was following the stream).
   */
  async function restoreScrollAfterRemount(el: HTMLElement, top: number | null) {
    await tick();
    let lastHeight = -1;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (scrollEl !== el) return; // pane re-created underneath us
      el.scrollTop = top ?? el.scrollHeight;
      if (el.scrollHeight === lastHeight) return;
      lastHeight = el.scrollHeight;
      await new Promise(requestAnimationFrame);
    }
  }

  $effect(() => {
    if (
      !activeConversationId ||
      activeConversationId === lastScrolledConversationId ||
      isSessionLoading ||
      chatSession.events.length === 0 ||
      !scrollManager
    ) {
      return;
    }
    const conversationId = activeConversationId;
    const manager = scrollManager;
    lastScrolledConversationId = conversationId;
    void scrollSessionToBottom(conversationId, manager);
  });

  // Point the git working-tree tracker at the active conversation's worktree
  // on hosts that show the review bar (desktop + VS Code).
  $effect(() => {
    gitChanges.setWorktreePath(supportsReviewBar ? terminalScopePath : undefined);
  });

  // Refresh git status when files change (debounced — agent edits arrive in
  // bursts), after in-app git mutations, and on window focus as a safety net
  // for changes made while the app was unfocused. The desktop file-watcher
  // events never fire off desktop; VS Code relies on window focus and
  // turn-completion refreshes.
  $effect(() => {
    if (!supportsReviewBar) return;

    const onFileTreeChanged = (event: Event) => {
      const detail = (event as CustomEvent<DesktopFileTreeChangedEventDetail>).detail;
      if (!gitChanges.affectsWorktree(detail)) return;
      gitChanges.scheduleRefresh();
    };
    const onGitChanged = () => gitChanges.refreshNow();
    const onWindowFocus = () => gitChanges.scheduleRefresh();

    window.addEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
    window.addEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
      window.removeEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
      window.removeEventListener("focus", onWindowFocus);
    };
  });

  // Refresh when a turn finishes: the file watcher usually catches edits
  // mid-turn, but a final refresh guarantees the summary reflects the turn's
  // end state (and catches gitignored-path edge cases the watcher may skip).
  let wasTurnActive = false;
  $effect(() => {
    const active = isTurnActive;
    if (wasTurnActive && !active && supportsReviewBar) {
      gitChanges.scheduleRefresh();
    }
    wasTurnActive = active;
  });

  function updateTranscriptOverflow(element = scrollEl): void {
    if (!element) {
      hasTranscriptTopOverflow = false;
      hasTranscriptBottomOverflow = false;
      return;
    }
    hasTranscriptTopOverflow = element.scrollTop > 1;
    hasTranscriptBottomOverflow =
      element.scrollHeight - element.scrollTop - element.clientHeight > 1;
  }

  function scroller(el: HTMLDivElement) {
    scrollEl = el;
    const manager = new ScrollManager(el, (attached) => (scrollDetached = !attached));
    scrollManager = manager;
    scrollDetached = false;
    updateTranscriptOverflow(el);

    let animationFrame = 0;
    const scheduleOverflowUpdate = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => updateTranscriptOverflow(el));
    };
    const resizeObserver = new ResizeObserver(() => {
      // VirtualList corrects estimated row heights after layout. Share one
      // animation-frame reconciliation with DOM mutations so we never write
      // scrollTop from inside ResizeObserver delivery and re-enter layout.
      manager.scheduleContentSizeReconciliation();
      scheduleOverflowUpdate();
    });
    resizeObserver.observe(el);
    let observedContent = el.firstElementChild;
    if (observedContent) resizeObserver.observe(observedContent);

    const mutationObserver = new MutationObserver(() => {
      const nextContent = el.firstElementChild;
      if (nextContent !== observedContent) {
        if (observedContent) resizeObserver.unobserve(observedContent);
        observedContent = nextContent;
        if (observedContent) resizeObserver.observe(observedContent);
      }
      scheduleOverflowUpdate();
    });
    mutationObserver.observe(el, { childList: true });

    return () => {
      cancelAnimationFrame(animationFrame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      manager.disconnect();
      if (scrollManager === manager) scrollManager = undefined;
      if (scrollEl === el) scrollEl = undefined;
    };
  }

  function onSubmit() {
    if (isNewConversation) centerNewConversationComposer = false;
    scrollManager?.scrollToBottom();
  }

  async function scrollSessionToBottom(conversationId: string, manager: ScrollManager) {
    await tick();
    for (let attempt = 0; attempt < 5; attempt++) {
      if (activeConversationId !== conversationId || scrollManager !== manager) return;
      manager.scrollToBottom("instant");
      if (attempt < 4) await new Promise(requestAnimationFrame);
    }
  }

  function defaultConversationCwd(): string {
    if (isDesktop) {
      return (
        desktopLaunchWorktreeProject?.path ?? firstProject?.path ?? resolveSessionCwd($appState)
      );
    }
    return acpProtocolCwd(acpWorkspaceFolders($appState), resolveSessionCwd($appState));
  }

  function pendingConversationCwd(): string {
    return chatSession.pendingConversationId && chatSession.pendingSessionCwd
      ? chatSession.pendingSessionCwd
      : defaultConversationCwd();
  }

  function resolveTerminalScopePath(cwd: string): string {
    return resolveDesktopWorkspaceRoot(cwd);
  }

  function desktopTargetKind(path: string): "project" | "worktree" {
    const target = projects.projects.find(
      (project) => normalizeWorkspacePath(project.path) === normalizeWorkspacePath(path),
    );
    return target?.isWorktree ? "worktree" : "project";
  }

  function resolveDesktopWorkspaceRoot(cwd: string): string {
    const normalizedCwd = normalizeWorkspacePath(cwd);
    const project = projects.projects
      .filter((candidate) => pathContains(candidate.path, normalizedCwd))
      .sort(
        (left, right) =>
          normalizeWorkspacePath(right.path).length - normalizeWorkspacePath(left.path).length,
      )
      .at(0);

    return project?.path ?? cwd;
  }

  function pathContains(parentPath: string, path: string): boolean {
    const parent = normalizeWorkspacePath(parentPath);
    if (!parent || !path) return false;
    return path === parent || path.startsWith(`${parent}/`);
  }

  function normalizeWorkspacePath(path: string): string {
    let normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
    if (normalized.length > 1) {
      normalized = normalized.replace(/\/+$/g, "");
    }
    if (/^[A-Z]:\//.test(normalized)) {
      normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return normalized;
  }

  function setupOutputKey(output: AcpSetupScriptOutput): string {
    return `${normalizeWorkspacePath(output.path)}:${output.startedAt}`;
  }

  function pathBasename(path: string): string {
    return normalizeWorkspacePath(path).split("/").at(-1) || path;
  }

  function onInterrupt() {
    elicitation.declineAllForChat(chatSession.sessionId, chatSession.sessionAgentServer);
    void chatSession.cancel({ sendQueuedPrompt: true });
  }

  function onSendQueuedNow(id?: string) {
    if (chatSession.canSteerPrompt) {
      void chatSession.steerQueuedPrompt(id);
      return;
    }
    if (!chatSession.isPrompting) {
      chatSession.sendQueuedPrompt(id);
      return;
    }
    chatSession.prioritizeQueuedPrompt(id);
    onInterrupt();
  }

  function clampDesktopTerminalWidth(width: number): number {
    return Math.min(Math.max(width, DESKTOP_TERMINAL_MIN_WIDTH), DESKTOP_TERMINAL_MAX_WIDTH);
  }

  function getSavedDesktopTerminalWidth(): number {
    const value = window.localStorage.getItem(DESKTOP_TERMINAL_WIDTH_STORAGE_KEY);
    if (!value) return DESKTOP_TERMINAL_DEFAULT_WIDTH;

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return DESKTOP_TERMINAL_DEFAULT_WIDTH;

    return clampDesktopTerminalWidth(parsed);
  }

  function setDesktopTerminalWidth(width: number) {
    desktopTerminalWidth = clampDesktopTerminalWidth(width);
    window.localStorage.setItem(
      DESKTOP_TERMINAL_WIDTH_STORAGE_KEY,
      desktopTerminalWidth.toString(),
    );
  }

  function startDesktopTerminalResize(event: MouseEvent) {
    if (!usesLegacyTerminalPanel) return;

    desktopTerminalResizeStartX = event.clientX;
    desktopTerminalResizeStartWidth = desktopTerminalWidth;
    desktopTerminalResizing = true;
    document.body.classList.add("desktop-terminal-resizing");
    event.preventDefault();
  }

  function moveDesktopTerminalResize(event: MouseEvent) {
    if (!desktopTerminalResizing) return;

    setDesktopTerminalWidth(
      desktopTerminalResizeStartWidth - event.clientX + desktopTerminalResizeStartX,
    );
  }

  function stopDesktopTerminalResize() {
    if (!desktopTerminalResizing) return;

    desktopTerminalResizing = false;
    document.body.classList.remove("desktop-terminal-resizing");
  }

  function toolCallForPermission(toolCallId: string): ToolCall | undefined {
    return chatSession.events.find(
      (event): event is ToolCall => isToolCall(event) && event.toolCallId === toolCallId,
    );
  }

  async function handleAuthenticate(methodId: string) {
    const agentServer = chatSession.activeAgentServer;
    const method = acp.agents
      .authMethodsForAgent(agentServer)
      .find((candidate) => candidate.id === methodId);
    if (method?.type === "terminal") {
      // Only record the attempt once the login terminal actually launched:
      // the launch can fail (no command, no tab) and the panel must not
      // offer "I'm logged in" for a flow that never started.
      if (await handleTerminalAuthenticate(method, agentServer)) {
        attemptedAuthMethodByAgent = { ...attemptedAuthMethodByAgent, [agentServer]: methodId };
      }
      return;
    }

    // Non-terminal flows resolve outside the app (browser); mark the attempt
    // up front so the confirmation UI is available while authenticate blocks.
    attemptedAuthMethodByAgent = { ...attemptedAuthMethodByAgent, [agentServer]: methodId };
    await acp.agents.authenticate(methodId, agentServer);
    await continueAfterAuthenticated(agentServer);
  }

  // "I'm logged in": the user says they completed the login that runs outside
  // this panel (terminal TUI, browser). Verify with a fresh config probe — an
  // agent that still lacks credentials fails it and re-marks auth required
  // (for Claude the helper checks `--cli auth status` during the probe), so a
  // premature click keeps the panel and an honest one dismisses it.
  async function handleConfirmLoggedIn() {
    const agentServer = chatSession.activeAgentServer;
    if (authConfirmInProgressFor[agentServer]) return;
    authConfirmInProgressFor = { ...authConfirmInProgressFor, [agentServer]: true };
    try {
      await acp.agents.refreshCachedConfig(
        agentServer,
        chatSession.pendingSessionCwd ??
          acpProtocolCwd(currentACPWorkspaceFolders, resolveSessionCwd($appState)),
        { fresh: true },
      );
      if (!acp.agents.authRequiredForAgent(agentServer)) {
        // The verification probe above already refreshed the config cache;
        // a second refresh here would only prolong the confirmation spinner.
        await continueAfterAuthenticated(agentServer, { skipConfigRefresh: true });
      }
    } finally {
      const next = { ...authConfirmInProgressFor };
      delete next[agentServer];
      authConfirmInProgressFor = next;
    }
  }

  // "Try again": abandon the attempted method and reshow the login buttons.
  function handleAuthTryAgain() {
    const agentServer = chatSession.activeAgentServer;
    stopTerminalAuthPolling(agentServer);
    const pending = { ...pendingTerminalAuthMethodByAgent };
    delete pending[agentServer];
    pendingTerminalAuthMethodByAgent = pending;
    const attempted = { ...attemptedAuthMethodByAgent };
    delete attempted[agentServer];
    attemptedAuthMethodByAgent = attempted;
    acp.agents.clearNonSessionError(agentServer);
  }

  async function handleRetryAuthentication(methodId: string) {
    const agentServer = chatSession.activeAgentServer;
    const method = acp.agents
      .authMethodsForAgent(agentServer)
      .find((candidate) => candidate.id === methodId);
    if (method?.type === "terminal") {
      await handleTerminalAuthenticate(method, agentServer);
      return;
    }

    const authUri = acp.agents.authUriForAgent(agentServer);
    if (authUri) {
      rpc.openExternalURL(authUri);
      return;
    }

    await handleAuthenticate(methodId);
  }

  async function continueAfterAuthenticated(
    agentServer: string,
    options: { skipConfigRefresh?: boolean } = {},
  ) {
    if (acp.agents.authRequiredForAgent(agentServer)) return;
    stopTerminalAuthPolling(agentServer);
    const next = { ...pendingTerminalAuthMethodByAgent };
    delete next[agentServer];
    pendingTerminalAuthMethodByAgent = next;
    const attempted = { ...attemptedAuthMethodByAgent };
    delete attempted[agentServer];
    attemptedAuthMethodByAgent = attempted;
    if (options.skipConfigRefresh) return;
    await acp.agents.refreshCachedConfig(
      agentServer,
      chatSession.pendingSessionCwd ??
        acpProtocolCwd(currentACPWorkspaceFolders, resolveSessionCwd($appState)),
    );
  }

  function projectDisplayNameForPath(path: string | null | undefined): string | undefined {
    if (!path) return undefined;
    const normalizedPath = normalizeWorkspacePath(path);
    const project = projects.projects.find(
      (candidate) => normalizeWorkspacePath(candidate.path) === normalizedPath,
    );
    return projectDisplayName(project);
  }

  function projectDisplayName(
    project: (typeof projects.projects)[number] | undefined,
  ): string | undefined {
    return project ? project.nickname || project.name : undefined;
  }

  /** Returns whether the login terminal was actually launched. */
  async function handleTerminalAuthenticate(
    method: ACPAuthMethodTerminal,
    agentServer: string,
  ): Promise<boolean> {
    const command = terminalAuthCommand(method, agentServer);
    if (!command) {
      rpc.showInfoMessage(
        `Unable to run ${method.name}: the agent did not provide a CLI command and no configured agent command was found.`,
        InfoMessageType.error,
      );
      return false;
    }

    const worktreePath =
      terminalScopePath || currentConversationCwd || resolveSessionCwd($appState);
    // Auth commands open in the bottom panel rather than a main split tab, so
    // the login shell sits alongside the chat instead of replacing it.
    const tab =
      terminalSurface === "external" && openExternalTerminal
        ? await openExternalTerminal(worktreePath, { env: command.env, placement: "bottomPanel" })
        : await assistantTerminals.createTab(worktreePath, undefined, command.env);
    if (usesLegacyTerminalPanel) {
      terminalCollapsed = false;
    }
    if (!tab) return false;

    await delay(100);
    await assistantTerminals.write(tab.id, `${command.command.trim()}\n`);
    pendingTerminalAuthMethodByAgent = {
      ...pendingTerminalAuthMethodByAgent,
      [agentServer]: method.id,
    };
    startTerminalAuthPolling(method.id, agentServer);
    return true;
  }

  function startTerminalAuthPolling(methodId: string, agentServer: string): void {
    stopTerminalAuthPolling(agentServer);
    const controller = new AbortController();
    terminalAuthPollControllers.set(agentServer, controller);
    void pollTerminalAuthentication(methodId, agentServer, controller);
  }

  function stopTerminalAuthPolling(agentServer: string): void {
    terminalAuthPollControllers.get(agentServer)?.abort();
    terminalAuthPollControllers.delete(agentServer);
  }

  async function pollTerminalAuthentication(
    methodId: string,
    agentServer: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      while (!controller.signal.aborted) {
        await delay(TERMINAL_AUTH_POLL_INTERVAL_MS);
        if (controller.signal.aborted) return;

        if (!acp.agents.authRequiredForAgent(agentServer)) {
          await continueAfterAuthenticated(agentServer);
          return;
        }
        if (pendingTerminalAuthMethodByAgent[agentServer] !== methodId) return;

        const result = await acp.agents.probeAuthentication(methodId, agentServer);
        if (controller.signal.aborted) return;
        if (result === "authenticated") {
          await continueAfterAuthenticated(agentServer);
          return;
        }
        if (result === "failed") {
          const next = { ...pendingTerminalAuthMethodByAgent };
          delete next[agentServer];
          pendingTerminalAuthMethodByAgent = next;
          return;
        }
      }
    } finally {
      if (terminalAuthPollControllers.get(agentServer) === controller) {
        terminalAuthPollControllers.delete(agentServer);
      }
    }
  }

  function terminalAuthCommand(
    method: ACPAuthMethodTerminal,
    agentServer: string,
  ): { command: string; env?: Record<string, string> } | null {
    const configured = resolveAgentServers($appState.userSettings.acpAgentServers)[agentServer];
    const command = configured?.command || method.command;
    if (!command) return null;

    const args = configured?.command
      ? [...(configured.args ?? []), ...(method.args ?? [])]
      : (method.args ?? []);
    const env = { ...(configured?.env ?? {}), ...(method.env ?? {}) };
    return {
      command: [command, ...args].map(shellQuote).join(" "),
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }

  function shellQuote(value: string): string {
    // The command string is written to the host's terminal, so it must be quoted for that
    // terminal's shell. The VS host runs it through cmd.exe (see AssistantTerminalManager),
    // which doesn't understand POSIX single-quote quoting - feeding it a single-quoted path
    // makes cmd treat the leading quote as part of the filename. Quote for cmd on Windows and
    // for POSIX shells everywhere else.
    if (isWindowsOperatingSystem($appState.environment.operatingSystem)) {
      return windowsShellQuote(value);
    }
    if (/^[A-Za-z0-9_/:=-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  function windowsShellQuote(value: string): string {
    if (value === "") return '""';
    // Drive-letter paths (backslashes, colon, dots) are valid bare tokens in cmd; only wrap
    // when the value contains a space or a cmd metacharacter, doubling embedded quotes.
    if (/^[A-Za-z0-9_.:/\\=-]+$/.test(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
</script>

<svelte:window
  onmousemove={(event) => moveDesktopTerminalResize(event)}
  onmouseup={() => stopDesktopTerminalResize()}
/>

{#snippet chatPaneContent()}
  <div class="relative flex h-full min-w-0 flex-col">
    {#if showConversationHeader}
      <AcpConversationHeader
        showSidebarActions={sidebarCollapsed}
        sidebarWidth={desktopSidebarWidth}
        newConversationDisabled={conversations.refreshState.status === "loading"}
        supportsTerminalPanel={usesLegacyTerminalPanel}
        terminalPanelOpen={!terminalCollapsed}
        {desktopOpenTargetKind}
        desktopOpenTargetPath={terminalScopePath}
        {desktopInstanceWorktreeName}
        {editorSurface}
        onExpandSidebar={() => hostSidebar?.onExpand?.()}
        onNewConversation={() => onNewConversation()}
        onToggleTerminalPanel={() => (terminalCollapsed = !terminalCollapsed)}
        onViewTrajectory={() => (trajectoryViewerOpen = true)}
        onSaveTrajectory={() => void saveTrajectory()}
      />
    {/if}

    <!-- overflow-clip, not hidden: a hidden box is still programmatically
           scrollable, so the editor's caret-reveal could scroll the pane
           itself and push the new-conversation header out the top. -->
    <div
      class="relative min-h-0 flex-1 overflow-clip"
      bind:this={conversationAreaEl}
      style:--acp-conversation-area-height={conversationAreaHeight
        ? `${conversationAreaHeight}px`
        : undefined}
    >
      {#if heroGridCenter}
        <!-- Pane-wide hero grid: painted here rather than inside ChatEmptyState
               because the empty state lives in the transcript scroller, which
               clips anything reaching above the stage. -->
        <div
          aria-hidden="true"
          class="desktop-hero-grid"
          style:--hero-grid-x={`${heroGridCenter.x}px`}
          style:--hero-grid-y={`${heroGridCenter.y}px`}
        ></div>
      {/if}
      <!-- For a fresh draft, the transcript's top auto margin and the composer's
             bottom auto margin split the free pane height around the complete stack.
             When the stack outgrows a short pane, the empty-state scroller's
             shrink-[100] sacrifices the roundel before the composer (shrink 1)
             gives up any height. -->
      <div
        class="relative flex h-full min-w-0 flex-col"
        data-new-conversation-view-centered={shouldCenterComposer}
      >
        <div
          class={[
            shouldCenterComposer
              ? "mt-auto min-h-0 shrink-[100] overflow-y-auto"
              : "flex-1 overflow-y-auto",
            isDesktop && "desktop-transcript-scroller",
          ]}
          data-chat-transcript-scroller
          data-overflow-top={hasTranscriptTopOverflow}
          data-overflow-bottom={hasTranscriptBottomOverflow}
          onscroll={() => updateTranscriptOverflow()}
          {@attach scroller}
        >
          {#if initialLoadError || shouldWaitForInitialProject || shouldWaitForLocalDraft || isBlockingSessionLoading}
            <div
              class="text-psx-foreground-tertiary flex h-full w-full flex-col items-center justify-center gap-2 text-xs"
              role="status"
              aria-label={initialLoadError ? "Conversation unavailable" : "Loading conversation"}
            >
              {#if initialLoadError}
                <span>{initialLoadError}</span>
                <button
                  type="button"
                  class="text-psx-link cursor-pointer hover:underline"
                  disabled={retryingInitialLoad}
                  onclick={() => void retryInitialLoad()}>Try again</button
                >
              {:else}
                <Spinner size={24} />
                <span>Loading conversation…</span>
              {/if}
            </div>
          {:else if chatSession.events.length > 0 || (!readOnlyPreview && chatSession.pendingPermissionRequests.length > 0)}
            <div
              data-chat-transcript-content
              class={[
                "mx-auto flex w-full flex-col gap-2.5",
                isMobile ? "px-3 py-4" : "px-4 py-10",
              ]}
              style:max-width={CHAT_CONTENT_MAX_WIDTH}
              style:padding-bottom={isDesktop && desktopConversationOverlaysInset > 0
                ? `calc(2.5rem + ${desktopConversationOverlaysInset}px + 0.625rem)`
                : undefined}
              {@attach transcriptImageContextMenu}
            >
              <Boundary name="ACPSessionEvents">
                {#snippet failed(_error, _reset)}
                  <div
                    class="border-psx-border bg-psx-editor-background text-psx-foreground-secondary shadow-low dark:shadow-low-dark self-start rounded-lg border px-2.5 py-2 text-xs"
                  >
                    <span>The session transcript could not be rendered.</span>
                  </div>
                {/snippet}

                <!-- Key by conversation so the renderer's expanded-thought pins
                       (kept by index) reset per transcript and cannot bleed across
                       conversations that reuse the same event indices. -->
                {#key chatSession.conversationId}
                  <!-- Wait for the scroll container's element before rendering
                         the transcript: without it the renderer can't window, so
                         opening an already-populated long thread would render every
                         row once before correcting on the next tick. `scrollEl` is
                         set by the scroller attachment above and persists across
                         conversation switches, so this only defers the very first
                         mount by a frame.

                         markReadWhenVisible: unmount the transcript while this
                         pane is hidden behind another tab. Deriveds are lazy, so
                         this also stops the grouping/timeline recomputation for
                         the hidden pane, not just its DOM patching. Scroll
                         position is saved/restored by the effects that track
                         this flag (search hiddenScroll). -->
                  {#if scrollEl && markReadWhenVisible}
                    <SessionEventsRenderer
                      events={chatSession.timelineEvents}
                      items={chatSession.timelineItems}
                      expansion={chatSession.timelineExpansion}
                      turns={chatSession.timelineTurns}
                      isPrompting={isTurnActive}
                      toolActivity={chatSession.toolActivity}
                      workspaceFolders={currentWorkspaceProjects}
                      scrollElement={scrollEl}
                      preserveScrollAnchor={scrollDetached}
                    />
                  {/if}
                {/key}
              </Boundary>
              {#if !readOnlyPreview}
                {#if chatSession.promptError}
                  <AcpPromptError
                    error={chatSession.promptError.error}
                    isStreaming={chatSession.isPrompting}
                    onRetry={() => void chatSession.retryLastPrompt()}
                  />
                {:else if chatSession.error}
                  <AcpPromptError
                    error={chatSession.error}
                    prefix="Error"
                    buttonLabel="Reconnect"
                    isStreaming={chatSession.isPrompting}
                    onRetry={() => void chatSession.retryAfterError()}
                  />
                {/if}
                {#if chatSession.setupStatus}
                  <div class="flex h-7 items-center">
                    <StreamingIndicator label={chatSession.setupStatus} />
                  </div>
                {:else if isTurnActive}
                  <!-- Stay mounted for the whole turn so the shimmer never restarts.
                         While a permission request is pending we collapse the row to
                         height 0 instead of unmounting, then reveal the still-running
                         animation once it resolves — toggling `showWorkingIndicator`
                         only swaps a class, so the element (and its CSS animation) is
                         never torn down. -->
                  <div
                    class={[
                      "flex items-center gap-2 overflow-hidden",
                      showWorkingIndicator ? "h-7" : "h-0",
                    ]}
                    aria-hidden={!showWorkingIndicator}
                  >
                    <StreamingIndicator
                      iconUrl={streamingIndicatorIconUrl}
                      tint={streamingIndicatorTint}
                      label={streamingIndicatorLabel}
                    />
                  </div>
                {/if}
                {#each chatSession.pendingPermissionRequests as request (request.id)}
                  <Boundary name={`ACPPermissionRequest:${request.id}`}>
                    {@const toolCallContext = toolCallForPermission(request.toolCall.toolCallId)}
                    {#snippet failed(_error, _reset)}
                      <div
                        class="border-psx-border bg-psx-editor-background text-psx-foreground-secondary shadow-high dark:shadow-high-dark isolate flex max-w-full shrink-0 flex-col overflow-hidden rounded-xl border p-3 text-xs"
                      >
                        <span>This permission request could not be rendered.</span>
                      </div>
                    {/snippet}

                    <PermissionRequest {request} {toolCallContext} />
                  </Boundary>
                {/each}
                <AssistantLiveRegion {isTurnActive} {hasPendingPermissionRequests} />
              {/if}
            </div>
          {:else if chatSession.historyUnavailable}
            <div class="flex h-full w-full flex-col items-center justify-center">
              <!-- canPrompt mirrors the composer's disabled conditions below:
                     the notice must not promise "keep prompting here" over an
                     inert editor. -->
              <AcpHistoryUnavailableNotice
                onRetry={readOnlyPreview || chatSession.isSessionSetupPending
                  ? undefined
                  : () => void chatSession.retryHistoryUnavailable()}
                canPrompt={!readOnlyPreview &&
                  !noAuthenticatedAgentAvailable &&
                  !chatSession.isReadOnly &&
                  !chatSession.isSessionSetupPending &&
                  !hasPendingElicitation}
              />
            </div>
          {:else}
            <div class="flex h-full w-full flex-col items-center">
              <ChatEmptyState
                showConversationControls={false}
                showLeadingControls={false}
                centeredLayout={shouldCenterComposer}
                showHeader={false}
                compact={isMobile}
                showGrid={!isDesktop}
                hero={isDesktop}
              />
            </div>
          {/if}
        </div>

        {#if !shouldWaitForInitialProject && !shouldWaitForLocalDraft}
          <div
            data-acp-composer
            data-new-conversation-centered={shouldCenterComposer}
            data-centered-composer-constrained={constrainCenteredComposer}
            class={[
              "relative mx-auto flex w-full flex-col",
              // shrink-0 keeps the prompt at its natural height against the
              // transcript, but this column also holds the elicitation form,
              // which can be taller than the whole pane. max-h-full clamps
              // the column to the conversation area so the prompt can never
              // be pushed out the bottom of that overflow-clip box (and off
              // the window); the form's shrink-[100] absorbs the deficit.
              constrainCenteredComposer ? "min-h-0" : "max-h-full shrink-0",
              isDesktop && "z-10",
              shouldCenterComposer ? "mb-auto gap-5" : "gap-2.5",
              isMobile ? "px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-1" : "px-2.5 pb-2.5",
            ]}
            style:max-width={CHAT_CONTENT_MAX_WIDTH}
            style:--desktop-conversation-overlays-height={`${desktopConversationOverlaysInset}px`}
            style:--psx-composer-font-size={composerFontSize}
          >
            {#if shouldCenterComposer}
              <!-- The header stays visible while the selected agent awaits
                     login: the composer is inert then, but the agent picker is
                     how the user reaches an agent they CAN use. -->
              {#if isDesktop}
                <div
                  class="mx-auto flex w-fit min-w-0 max-w-full flex-row flex-wrap items-center justify-center gap-[3px] py-2"
                  data-testid="empty-state-container"
                >
                  <span class="text-psx-foreground-secondary shrink-0 text-xl leading-tight">
                    {showHeaderProjectSelector
                      ? "Start a new conversation in"
                      : "Start a new conversation"}
                  </span>
                  {#if showHeaderProjectSelector}
                    <div class="flex min-w-0 translate-y-px">
                      <AcpEmptyStateProjectSelector
                        emptyStateDesktop
                        onAddProject={() => onAddProject()}
                      />
                    </div>
                  {/if}
                  <span class="text-psx-foreground-secondary shrink-0 text-xl leading-tight">
                    using
                  </span>
                  <div class="flex min-w-0">
                    <AcpPromptConfigControls emptyStateDesktop placement="bottom" />
                  </div>
                </div>
              {:else}
                <div
                  class="mx-auto flex w-fit min-w-0 max-w-full flex-row flex-wrap items-center justify-center gap-[3px]"
                  data-testid="empty-state-container"
                >
                  <span
                    class="text-psx-foreground-secondary shrink-0 text-lg font-medium leading-tight"
                  >
                    {showHeaderProjectSelector
                      ? "Start a new conversation in"
                      : "Start a new conversation"}
                  </span>
                  {#if showHeaderProjectSelector}
                    <div class="flex min-w-0 translate-y-px">
                      <AcpEmptyStateProjectSelector
                        underlineLabel
                        onAddProject={() => onAddProject()}
                      />
                    </div>
                  {/if}
                  <span
                    class="text-psx-foreground-secondary shrink-0 text-lg font-medium leading-tight"
                  >
                    using
                  </span>
                  <div class="flex min-w-0">
                    <AcpPromptConfigControls underlineLabel placement="bottom" />
                  </div>
                </div>
              {/if}
              {#if showLaunchChatActions}
                <div class="mx-auto flex w-full max-w-lg flex-row items-stretch gap-3">
                  <div class="flex min-w-0 flex-1">
                    <AcpAddProjectDropzone onAddProject={() => onAddProject()} />
                  </div>
                  {#if showSetupAgentAction}
                    <div class="flex min-w-0 flex-1">
                      <AcpSetupAgentDropzone
                        claudeIconUrl={claudeSetupIconUrl}
                        codexIconUrl={codexSetupIconUrl}
                        onSetup={() => onShowAgentSettings()}
                      />
                    </div>
                  {/if}
                </div>
              {/if}
              {#if inlineSetupScriptOutput}
                <div class="mx-auto w-full max-w-sm">
                  <SetupScriptToolCall
                    output={inlineSetupScriptOutput}
                    onToggle={() => setupScriptOutputs.toggle(inlineSetupScriptOutput.path)}
                  />
                </div>
              {/if}
            {/if}
            {#if scrollDetached && chatSession.events.length > 0}
              <!-- Instant, not smooth: a smooth animation spends most of its
                     flight >150px from the bottom, where the position-based
                     detach would let go again mid-scroll — and under streaming
                     the click-time target is stale, so it can land short and
                     stay detached. mousedown is prevented so the click doesn't
                     steal focus from the composer. -->
              <button
                type="button"
                class={[
                  "border-psx-border bg-psx-editor-background text-psx-icon shadow-low dark:shadow-low-dark absolute left-1/2 z-20 flex -translate-x-1/2 items-center justify-center rounded-full border transition-colors",
                  isDesktop ? "desktop-jump-to-bottom" : "-top-2 -translate-y-full",
                  isMobile ? "size-10" : "size-7",
                ]}
                aria-label="Jump to bottom"
                onmousedown={(event) => event.preventDefault()}
                onclick={() => scrollManager?.scrollToBottom("instant")}
              >
                <Icon name="chevron" size={isMobile ? 18 : 14} aria-hidden="true" />
              </button>
            {/if}
            {#if !readOnlyPreview}
              {#if acp.agents.authRequiredForAgent(chatSession.activeAgentServer)}
                <AcpAuthRequiredPanel
                  agentServer={chatSession.activeAgentServer}
                  agent={registry.getAgent(chatSession.activeAgentServer) ?? null}
                  methods={acp.agents.authMethodsForAgent(chatSession.activeAgentServer)}
                  inProgress={acp.agents.authInProgressForAgent(chatSession.activeAgentServer)}
                  pendingTerminalAuthMethodId={pendingTerminalAuthMethodByAgent[
                    chatSession.activeAgentServer
                  ] ?? null}
                  attemptedMethodId={attemptedAuthMethodByAgent[chatSession.activeAgentServer] ??
                    null}
                  confirmInProgress={Boolean(
                    authConfirmInProgressFor[chatSession.activeAgentServer],
                  )}
                  iconClass={agentPickerIconProps(registry, chatSession.activeAgentServer).class ||
                    "text-psx-icon"}
                  onAuthenticate={handleAuthenticate}
                  onRetry={handleRetryAuthentication}
                  onConfirmLoggedIn={handleConfirmLoggedIn}
                  onTryAgain={handleAuthTryAgain}
                />
              {/if}

              {#if showConversationOverlayStack}
                <div
                  bind:clientHeight={desktopConversationOverlaysHeight}
                  data-conversation-overlays
                  class={[
                    "flex flex-col gap-2.5",
                    isDesktop
                      ? "desktop-conversation-overlays absolute inset-x-2.5 z-10"
                      : "relative",
                  ]}
                >
                  {#if chatSession.queuedPrompts.length > 0}
                    <div
                      class="flex max-h-[min(42vh,24rem)] flex-col gap-2.5 overflow-y-auto px-0.5 py-0.5"
                      data-prompt-queue
                    >
                      {#each chatSession.queuedPrompts as queuedPrompt, index}
                        <AcpEnqueuedInput
                          content={queuedPrompt.content}
                          position={index + 1}
                          total={chatSession.queuedPrompts.length}
                          turnActive={chatSession.isPrompting}
                          steeringAvailable={chatSession.canSteerPrompt}
                          onCancel={() => chatSession.clearQueuedPrompt(queuedPrompt.id)}
                          onSendNow={() => onSendQueuedNow(queuedPrompt.id)}
                        />
                      {/each}
                    </div>
                  {/if}
                  {#if showConversationOverlays && chatSession.plan && chatSession.plan.entries.length > 0}
                    <Boundary name="ACPSessionPlan">
                      {#snippet failed(_error, _reset)}
                        <div
                          class="border-psx-border bg-psx-editor-background text-psx-foreground-secondary rounded-lg border px-2.5 py-2 text-xs"
                        >
                          <span>The plan could not be rendered.</span>
                        </div>
                      {/snippet}

                      <SessionPlan
                        plan={chatSession.plan}
                        isPrompting={isTurnActive}
                        desktop={isDesktop}
                      />
                    </Boundary>
                  {/if}

                  <!-- Git-only repository summary. The branch opens Stage and
                         Commit; diff stats open Review Diff. The legacy
                         task/version status center has been removed. -->
                  {#if showGitChangesSummary}
                    <DesktopGitChangesSummary
                      files={gitChanges.changedFileCount}
                      additions={gitChanges.additions}
                      deletions={gitChanges.deletions}
                      branch={gitChanges.branchLabel}
                      upstream={gitChanges.upstreamLabel}
                      desktop={isDesktop}
                      onReview={openReview}
                      onOpenDiff={openDiff}
                    />
                  {/if}
                </div>
              {/if}
              <CompactionBanner />
              <ElicitationPrompt
                sessionId={chatSession.sessionId}
                agentServer={chatSession.sessionAgentServer}
              />
            {/if}
            {#if showReadOnlyBanner}
              <div
                class="border-psx-border bg-psx-editor-background text-psx-foreground-secondary shadow-low dark:shadow-low-dark flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs"
                role="status"
              >
                <Icon
                  name="eye-visible"
                  size={14}
                  class="text-psx-foreground-tertiary mt-0.5 shrink-0"
                />
                <div class="min-w-0">
                  <div class="text-psx-foreground font-medium">Read-only conversation</div>
                  <div>This conversation can be inspected, but new messages cannot be sent.</div>
                </div>
                {#if !readOnlyPreview}
                  <button
                    type="button"
                    class="hover:bg-psx-overlay-hover hover:text-psx-foreground focus-visible:outline-psx-focus-border text-psx-foreground-tertiary -mr-1 -mt-1 ml-auto rounded-sm p-1 focus-visible:outline focus-visible:outline-1"
                    aria-label="Dismiss read-only notice"
                    onclick={() => {
                      dismissedReadOnlySessionId = readOnlySessionId;
                    }}
                  >
                    <Icon name="cross" size={12} />
                  </button>
                {/if}
              </div>
            {/if}
            {#if !readOnlyPreview}
              <AcpPlanModeBanner />
              {#key promptDraftKey}
                <!-- Deliberately not inert/aria-disabled as a whole: this
                       container also holds the prompt banners (agent update,
                       assistant.json errors), and inert is invisible, so an
                       unauthenticated agent used to leave those banners looking
                       enabled while silently swallowing every click (PE-2466).
                       The composer's own disabled state does the blocking. -->
                <div
                  data-testid="prompt-interaction-container"
                  class={[
                    // Own stacking context so the floating menus deep inside
                    // (e.g. the prompt popup) get compared against other
                    // same-level content (the desktop todo/review stack at
                    // z-10, a transcript tool group's pinned row) as this
                    // whole z-20 box, not one level too shallow.
                    "relative z-20",
                    // Pass the pane's height pressure through to the prompt so
                    // its editor shrinks and scrolls; min-h-16 keeps the footer
                    // plus an editor line when the pane is tiny, and sits just
                    // below the resting one-line form so it adds no dead space.
                    constrainCenteredComposer && "flex min-h-16 flex-col",
                  ]}
                >
                  <!-- In editor-panel hosts /new must open a new panel like the header
                       button; elsewhere the prompt swaps the conversation in place. -->
                  <Prompt
                    draftKey={promptDraftKey}
                    showConfigControls={!shouldCenterComposer}
                    {onSubmit}
                    {onInterrupt}
                    onNewConversation={editorSurface
                      ? () => {
                          void onNewConversation();
                        }
                      : undefined}
                    onConfigureAgents={onShowAgentSettings}
                    disabled={noAuthenticatedAgentAvailable || chatSession.isReadOnly}
                    submitDisabled={isSessionSetupPending ||
                      hasPendingElicitation ||
                      noAuthenticatedAgentAvailable ||
                      chatSession.isReadOnly}
                    {promptBanners}
                    {promptCommandItems}
                    {promptMenus}
                    footerLeading={promptFooterLeading}
                    desktopFilePromptChipTarget={markReadWhenVisible}
                    autofocus={autofocusPrompt &&
                      !noAuthenticatedAgentAvailable &&
                      !chatSession.isReadOnly}
                  />
                </div>
              {/key}
            {/if}
          </div>
        {/if}
      </div>
    </div>

    {#if trajectoryViewerOpen}
      <AcpTrajectoryViewer {sidebarCollapsed} onClose={() => (trajectoryViewerOpen = false)} />
    {/if}
  </div>
{/snippet}

<div
  class={[
    "h-full min-w-0 flex-1",
    usesEditorSurface && !(isDesktop && desktopPanelFrame) ? "chat-editor-surface" : "",
    isDesktop && desktopPanelFrame ? "desktop-main-panel" : "",
    sidebarCollapsed && desktopPanelFrame ? "desktop-main-panel--no-border" : "",
  ]}
>
  {#if isDesktop && desktopPanelFrame}
    <div class="desktop-main-panel-top-drag-region" data-tauri-drag-region="deep"></div>
    <div class="desktop-main-panel-frame">
      {@render chatPaneContent()}
    </div>
  {:else}
    {@render chatPaneContent()}
  {/if}
</div>

{#if usesLegacyTerminalPanel && !terminalCollapsed}
  {#key terminalScopePath}
    <AssistantTerminalPanel
      worktreePath={terminalScopePath}
      width={desktopTerminalWidth}
      resizing={desktopTerminalResizing}
      onClose={() => (terminalCollapsed = true)}
      onResizeStart={startDesktopTerminalResize}
    />
  {/key}
{/if}

<style lang="postcss">
  /* Pointer is reserved for links. Buttons in the prompt box, the chat history,
     and the new-conversation empty state use the native arrow cursor instead of
     the pointer the base reset gives every button. File-open links inside the
     transcript are marked data-cursor="link" and keep their pointer. Disabled
     buttons are left alone so any not-allowed styling survives. The composer
     is anchored by its data-acp-composer attribute (the old
     .acp-composer-position class left with the transform-based centering). */
  [data-acp-composer] :global(button:not(:disabled):not([data-cursor="link"])),
  [data-chat-transcript-content] :global(button:not(:disabled):not([data-cursor="link"])) {
    cursor: default;
  }

  /* Short panes: the centered composer must not outgrow the pane, or the
     "Start a new conversation" header ends up above the clipped top edge.
     The composer is allowed to shrink (min-h-0 above) and these rules thread
     the height pressure down to the ProseMirror editor, which already scrolls
     internally. Every flex hop needs an explicit min-height:0 or the items'
     automatic minimum (their content) blocks the shrink. The shared prompt
     internals are addressed the same way mobile-remote's app.css restyles
     them: via their stable data-* hooks. Not applied on mobile, whose pill
     composer has its own layout. */
  [data-acp-composer][data-centered-composer-constrained="true"] :global([role="application"]) {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  [data-acp-composer][data-centered-composer-constrained="true"] :global(form:has([data-editor])) {
    min-height: 0;
  }

  /* Stretch (not center) the field's children so the editor wrapper tracks
     the squeezed field height. */
  [data-acp-composer][data-centered-composer-constrained="true"] :global([data-prompt-field]) {
    align-items: stretch;
  }

  /* The editor keeps its own max-h-[50svh] — a pure length, so the field's
     intrinsic height stays clamped by it. (A percentage clamp on the editor
     would be ignored during intrinsic sizing, so the field would be laid out
     at the editor's unclamped content height and leave a void below the
     clamped editor.) Making the wrapper a flex column is what lets the
     squeezed field bite instead: the editor is a scroll container (automatic
     minimum 0), so it shrinks with the wrapper down to its own one-line
     min-h-6 floor and scrolls the rest. The placeholder <p> in the wrapper is
     position:absolute and unaffected. */
  [data-acp-composer][data-centered-composer-constrained="true"]
    :global([data-prompt-field] > div:has(> [data-editor])) {
    display: flex;
    flex-direction: column;
  }

  .chat-editor-surface {
    background: var(--psx-editor-background);
  }

  /*
   * Desktop new-conversation hero grid. Spans the whole conversation area (so
   * it can reach the top of the page), with the fade centred on the parasol
   * via the measured --hero-grid-x/y. Two co-centred elliptical ramps are
   * multiplied together (mask-composite: intersect) for a smooth bell-shaped
   * falloff, and the linear layer bounds it vertically: soft at the pane top,
   * easing out below the parasol before it reaches the composer.
   */
  .desktop-hero-grid {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* line color themed per light/dark via --psx-grid-line-color */
    background-image:
      linear-gradient(to right, var(--psx-grid-line-color) 1px, transparent 1px),
      linear-gradient(to bottom, var(--psx-grid-line-color) 1px, transparent 1px);
    background-size: 15px 15px;
    /* half-cell shift so a cell centre, not a line crossing, sits under the parasol */
    background-position: calc(var(--hero-grid-x) - 7.5px) calc(var(--hero-grid-y) - 7.5px);
    --hero-fade-x: min(560px, 46%);
    --hero-fade-y: min(600px, 78%);
    mask-image:
      radial-gradient(
        ellipse var(--hero-fade-x) var(--hero-fade-y) at var(--hero-grid-x) var(--hero-grid-y),
        black,
        transparent 100%
      ),
      radial-gradient(
        ellipse var(--hero-fade-x) var(--hero-fade-y) at var(--hero-grid-x) var(--hero-grid-y),
        black 30%,
        rgb(0 0 0 / 55%) 65%,
        transparent 100%
      ),
      linear-gradient(
        to bottom,
        transparent 0,
        black 24px,
        black calc(var(--hero-grid-y) + 140px),
        transparent calc(var(--hero-grid-y) + 320px)
      );
    mask-composite: intersect;
    -webkit-mask-image:
      radial-gradient(
        ellipse var(--hero-fade-x) var(--hero-fade-y) at var(--hero-grid-x) var(--hero-grid-y),
        black,
        transparent 100%
      ),
      radial-gradient(
        ellipse var(--hero-fade-x) var(--hero-fade-y) at var(--hero-grid-x) var(--hero-grid-y),
        black 30%,
        rgb(0 0 0 / 55%) 65%,
        transparent 100%
      ),
      linear-gradient(
        to bottom,
        transparent 0,
        black 24px,
        black calc(var(--hero-grid-y) + 140px),
        transparent calc(var(--hero-grid-y) + 320px)
      );
    -webkit-mask-composite: source-in;
  }

  .desktop-main-panel {
    position: relative;
    z-index: 10;
    box-sizing: border-box;
    padding: var(--desktop-main-panel-inset, 8px) var(--desktop-main-panel-inset, 8px)
      var(--desktop-main-panel-inset, 8px) var(--desktop-main-panel-sidebar-gap, 8px);
    height: 100%;
    min-height: 0;
    align-self: stretch;
  }

  .desktop-main-panel--no-border {
    padding-left: var(--desktop-main-panel-inset, 8px);
  }

  .desktop-main-panel-top-drag-region {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    z-index: 1;
    height: var(--desktop-main-panel-inset, 8px);
  }

  .desktop-main-panel-frame {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-radius: var(--desktop-main-panel-radius, 10px);
    border: var(--psx-hairline, 1px) solid color-mix(in srgb, var(--psx-border) 80%, transparent);
    background: var(--psx-editor-background);
    box-shadow: 0 0 16px -9px color-mix(in srgb, var(--psx-foreground-primary) 35%, transparent);
  }

  .desktop-transcript-scroller {
    --desktop-transcript-overflow-fade-height: 28px;
    --desktop-transcript-overflow-mask-top: #000;
    --desktop-transcript-overflow-mask-bottom: #000;
    /* Transcript content that pins while it scrolls (open tool folds — see
       ToolCallGroup) stops below the top fade rather than inside it, where the
       mask would erase part of it. Derived from the fade height so the two
       cannot drift apart. */
    --acp-transcript-sticky-top: var(--desktop-transcript-overflow-fade-height);

    position: relative;
    z-index: 0;
    -webkit-mask-image: linear-gradient(
      to bottom,
      var(--desktop-transcript-overflow-mask-top) 0,
      #000 var(--desktop-transcript-overflow-fade-height),
      #000 calc(100% - var(--desktop-transcript-overflow-fade-height)),
      var(--desktop-transcript-overflow-mask-bottom) 100%
    );
    mask-image: linear-gradient(
      to bottom,
      var(--desktop-transcript-overflow-mask-top) 0,
      #000 var(--desktop-transcript-overflow-fade-height),
      #000 calc(100% - var(--desktop-transcript-overflow-fade-height)),
      var(--desktop-transcript-overflow-mask-bottom) 100%
    );
    -webkit-mask-mode: alpha;
    mask-mode: alpha;
  }

  .desktop-transcript-scroller[data-overflow-top="true"] {
    --desktop-transcript-overflow-mask-top: transparent;
  }

  .desktop-transcript-scroller[data-overflow-bottom="true"] {
    --desktop-transcript-overflow-mask-bottom: transparent;
  }

  .desktop-conversation-overlays {
    bottom: calc(100% + 0.625rem);
  }

  .desktop-jump-to-bottom {
    bottom: calc(100% + var(--desktop-conversation-overlays-height) + 1.125rem);
  }

  :global(body.desktop-terminal-resizing) {
    cursor: col-resize !important;
    user-select: none;
  }

  :global(body.desktop-terminal-resizing *) {
    cursor: col-resize !important;
  }
</style>
