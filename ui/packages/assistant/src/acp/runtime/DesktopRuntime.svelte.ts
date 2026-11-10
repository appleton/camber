import {
  ACP_DEBUG_DUMP_LOADED_EVENT,
  DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT,
  acpWorkspaceFolders,
  appState,
  createACPChatWorkingDirectory,
  getACPGithubRepo,
  getACPWorktreeRepo,
  newConversationID,
  acpHostRpc as rpc,
  wireACPSessionSync,
  type ACPDebugDumpLoadedEventDetail,
  type ACPGithubRepository,
  type ACPWorktreeRepository,
  type DesktopOpenerInfo,
} from "@camber/features/acp";
import { auditUnwiredCommands } from "@camber/features/keybindings";
import { onMount } from "svelte";
import { get } from "svelte/store";

import { SET_CURRENT_CONVERSATION_EVENT } from "../../lib/rpc/server";
import { focusPrompt, focusPromptIfUnchanged } from "../../shared/Helpers";
import { DesktopBottomPanel } from "./desktop/DesktopBottomPanel.svelte";
import type { DesktopNavigationEntry } from "./desktop/DesktopNavigationHistory";
import { DesktopRightSidebar } from "./desktop/DesktopRightSidebar.svelte";
import { DesktopSidebarResize } from "./desktop/DesktopSidebarResize.svelte";
import { DesktopViewState, isSettingsView } from "./desktop/DesktopViewState.svelte";
import {
  initTauriDragDrop,
  makeTauriDragDropCallbacks,
  type TauriDragDropSubscriber,
} from "./desktop/TauriDragDrop.svelte";
import { findNextUnreadConversation } from "./desktop/unreadConversation";
import {
  defaultDesktopConversationCwd,
  readStoredLastConversationCwd,
  resolveConversationWorkspaceScope,
  resolveDesktopWorkspaceRoot,
  writeStoredLastConversationCwd,
} from "./desktop/workspacePaths";
import { PendingSessionBootstrap } from "./shared/PendingSessionBootstrap.svelte";
import type { Runtime } from "./shared/types";

const DESKTOP_OPEN_SETTINGS_PANEL_EVENT = "camber:desktop-open-settings-panel";
const DESKTOP_OPEN_TARGET_OPENER_STORAGE_KEY = "camber:desktop-open-target-opener-id";
const DESKTOP_CONVERSATION_PANEL_STATE_STORAGE_KEY = "camber.desktop.conversationPanelState.v1";

interface DesktopConversationPanelState {
  rightSidebarVisible: boolean;
  bottomPanelVisible: boolean;
}

const DEFAULT_CONVERSATION_PANEL_STATE: DesktopConversationPanelState = {
  rightSidebarVisible: false,
  bottomPanelVisible: false,
};

// Desktop target: view routing, sidebar resize, project gating, and conversation lifecycle on a
// CoreRuntime.
//
// NOTE: the Visual Studio extension currently mounts this same target (it has no panel-based
// experience yet), so the runtime still branches on `#isDesktop` (assistantHost === "desktop") to
// tell the real desktop app from VS. Once VS gets its own panels those branches — and this note —
// should go away.
export class DesktopRuntime {
  #core: Runtime;
  #appStateSnapshot = $state(get(appState));
  #viewState = new DesktopViewState();
  #isDesktop = $derived(this.#appStateSnapshot.environment.assistantHost === "desktop");
  #desktopSidebar = new DesktopSidebarResize({ isDesktop: () => this.#isDesktop });
  #conversationPanelStates = $state<Record<string, DesktopConversationPanelState>>(
    readStoredDesktopConversationPanelStates(),
  );
  #desktopRightSidebar = new DesktopRightSidebar({
    isDesktop: () => this.#isDesktop,
    isVisible: () => this.desktopRightSidebarVisible,
  });
  #desktopBottomPanel = new DesktopBottomPanel({
    isDesktop: () => this.#isDesktop,
    isVisible: () => this.desktopBottomPanelVisible,
  });
  #bootstrap: PendingSessionBootstrap;
  #addingProject = $state(false);
  #addingWorktree = false;
  #hasLoadedProjectsOnce = $state(false);
  #worktreeRepo?: ACPWorktreeRepository;
  #githubRepo?: ACPGithubRepository;
  #lastFocusedConversationId: string | null = null;
  #onNavigationChange?: () => void;
  #newConversationGeneration = 0;

  #activeSession = $derived.by(() =>
    this.#core.acpRepo.getSessionByConversationId(this.#core.activeConversationId),
  );
  #isSessionLoading = $derived(this.#activeSession?.loadState.status === "loading");
  // History is still loading with no transcript to show. The composer and
  // shell remain available; only the transcript area displays a loading state.
  #isBlockingSessionLoading = $derived(
    this.#isSessionLoading && (this.#activeSession?.events.length ?? 0) === 0,
  );
  // Navigation must be known before choosing a new target. Loading the
  // currently selected agent session does not prevent opening another draft.
  #isNavigationLoading = $derived.by(
    () => this.#core.acpConversationRepo.refreshState.status === "loading",
  );
  #firstProject = $derived.by(
    () =>
      this.#core.acpProjectRepo.projects.find((project) => !project.isWorktree) ??
      this.#core.acpProjectRepo.projects[0],
  );
  // The root project owning the currently visible conversation: the closest project
  // containing the conversation's cwd, with a worktree mapped back to its parent.
  // Undefined when the cwd is outside every known project.
  #currentProject = $derived.by(() => {
    const projects = this.#core.acpProjectRepo.projects;
    const root = resolveDesktopWorkspaceRoot(this.#currentConversationCwd, projects);
    const project = projects.find((candidate) => candidate.path === root);
    if (!project?.isWorktree) return project;
    return projects.find((candidate) => candidate.path === project.parentPath);
  });
  #currentConversationCwd = $derived(
    this.#activeSession?.sessionInfo?.cwd ??
      this.#activeSession?.pendingCwd ??
      this.#pendingConversationCwd(),
  );
  #currentACPWorkspaceFolders = $derived.by(() =>
    acpWorkspaceFolders(
      this.#appStateSnapshot,
      resolveDesktopWorkspaceRoot(this.#currentConversationCwd, this.#core.acpProjectRepo.projects),
    ),
  );
  // Desktop project gating: don't auto-create a session until projects have loaded once
  // (#shouldWaitForInitialProject). Once they have, a user with no projects lands directly in a
  // fresh chat (#hasNoProjectsOnDesktop drives #bootstrapLaunchChat) rather than a project-scoped
  // conversation. The IDE has an implicit workspace, so both are always false there.
  #shouldWaitForInitialProject = $derived(this.#isDesktop && !this.#hasLoadedProjectsOnce);
  #hasNoProjectsOnDesktop = $derived.by(
    () =>
      this.#isDesktop &&
      this.#hasLoadedProjectsOnce &&
      this.#core.acpProjectRepo.projects.length === 0,
  );
  #shouldOpenProject = $derived.by(
    () => this.#hasNoProjectsOnDesktop && !this.#activeSession?.isChat,
  );
  // Guards the async launch-chat bootstrap against re-entrancy while its working directory is
  // being created. A plain field (not $state) so toggling it never re-triggers the effect.
  #creatingLaunchChat = false;

  // Thin pass-throughs to the view/sidebar sub-objects. Bound fields (not getters) so the panel can
  // hand them straight to child components as event handlers without losing `this`.
  DESKTOP_SIDEBAR_MIN_WIDTH = this.#desktopSidebar.DESKTOP_SIDEBAR_MIN_WIDTH;
  DESKTOP_SIDEBAR_MAX_WIDTH = this.#desktopSidebar.DESKTOP_SIDEBAR_MAX_WIDTH;
  DESKTOP_RIGHT_SIDEBAR_MIN_WIDTH = this.#desktopRightSidebar.DESKTOP_RIGHT_SIDEBAR_MIN_WIDTH;
  DESKTOP_RIGHT_SIDEBAR_MAX_WIDTH = this.#desktopRightSidebar.DESKTOP_RIGHT_SIDEBAR_MAX_WIDTH;
  DESKTOP_BOTTOM_PANEL_MIN_HEIGHT = this.#desktopBottomPanel.DESKTOP_BOTTOM_PANEL_MIN_HEIGHT;
  DESKTOP_BOTTOM_PANEL_MAX_HEIGHT = this.#desktopBottomPanel.DESKTOP_BOTTOM_PANEL_MAX_HEIGHT;

  setDesktopSidebarWidth = this.#desktopSidebar.setWidth;
  startDesktopSidebarResize = this.#desktopSidebar.startResize;
  moveDesktopSidebarResize = this.#desktopSidebar.moveResize;
  stopDesktopSidebarResize = this.#desktopSidebar.stopResize;
  setDesktopRightSidebarWidth = this.#desktopRightSidebar.setWidth;
  startDesktopRightSidebarResize = this.#desktopRightSidebar.startResize;
  moveDesktopRightSidebarResize = this.#desktopRightSidebar.moveResize;
  stopDesktopRightSidebarResize = this.#desktopRightSidebar.stopResize;
  setDesktopBottomPanelHeight = this.#desktopBottomPanel.setHeight;
  startDesktopBottomPanelResize = this.#desktopBottomPanel.startResize;
  moveDesktopBottomPanelResize = this.#desktopBottomPanel.moveResize;
  stopDesktopBottomPanelResize = this.#desktopBottomPanel.stopResize;
  setSidebarCollapsed = this.#viewState.setSidebarCollapsed;
  toggleSidebarCollapsed = this.#viewState.toggleSidebarCollapsed;
  showSettings = () => this.#showView(this.#viewState.showSettings);
  showShortcuts = () => this.#showView(this.#viewState.showShortcuts);
  showModels = () => this.#showView(this.#viewState.showModels);
  showVoice = () => this.#showView(this.#viewState.showVoice);
  showConnectors = () => this.#showView(this.#viewState.showConnectors);
  showGithub = () => this.#showView(this.#viewState.showGithub);
  showAgents = () => this.#showView(this.#viewState.showAgents);
  showArchived = () => this.#showView(this.#viewState.showArchived);
  showRemote = () => this.#showView(this.#viewState.showRemote);
  showSettingsSection = (section: Parameters<DesktopViewState["showSettingsSection"]>[0]) => {
    this.#viewState.showSettingsSection(section);
    this.#onNavigationChange?.();
  };
  showProjectSettings = (path?: string | null) => {
    this.#viewState.showProjectSettings(path);
    this.#onNavigationChange?.();
  };
  showChat = () => this.#showView(this.#viewState.showChat);
  expandSidebar = this.#viewState.expandSidebar;

  #tauriDragDropSubscriber?: TauriDragDropSubscriber;

  constructor(
    core: Runtime,
    {
      tauriDragDropSubscriber,
      onNavigationChange,
    }: {
      tauriDragDropSubscriber?: TauriDragDropSubscriber;
      onNavigationChange?: () => void;
    } = {},
  ) {
    this.#core = core;
    this.#tauriDragDropSubscriber = tauriDragDropSubscriber;
    this.#onNavigationChange = onNavigationChange;

    // Auto-create an empty pending session only while the chat view is actually showing an idle,
    // resolvable conversation: on chat (not settings/agents), not pointing at a not-yet-loaded id,
    // and past the desktop project gates. With no projects we drive #bootstrapLaunchChat instead,
    // so this project-scoped bootstrap stays off. See PendingSessionBootstrap for the rest.
    this.#bootstrap = new PendingSessionBootstrap(core, {
      prepareWhileConfigLoading: true,
      enabled: () =>
        this.#viewState.view === "chat" &&
        !(this.#core.activeConversationId !== null && this.#activeSession === null) &&
        !this.#shouldWaitForInitialProject &&
        !this.#hasNoProjectsOnDesktop,
      activeSession: () => this.#activeSession,
      agentServer: () => this.#activeConversationAgentServer(),
      cwd: () => this.#pendingConversationCwd(),
      pendingConversationId: () => this.#activeSession?.pendingConversationId ?? null,
    });
  }

  // Registers every effect/onMount this controller owns. Must be called during component init.
  initialize() {
    this.#bootstrap.initialize();

    // With no projects, land the user directly in a ready-to-type chat instead of a "get started"
    // page. Mirrors the project-scoped PendingSessionBootstrap (create an ephemeral session while
    // the target is idle), but a chat needs an async working directory so it lives here. The
    // in-flight guard plus the isChat check keep it to a single chat until one exists; if that chat
    // is later deselected/archived, #activeSession stops being a chat and a fresh one is seeded.
    $effect(() => {
      if (
        !this.#hasNoProjectsOnDesktop ||
        this.#viewState.view !== "chat" ||
        this.#creatingLaunchChat ||
        this.#activeSession?.isChat ||
        this.#core.acpAgentServers.state.status === "loading"
      ) {
        return;
      }
      this.#creatingLaunchChat = true;
      void this.#bootstrapLaunchChat().finally(() => {
        this.#creatingLaunchChat = false;
      });
    });

    // getContext must run during component init, not in onMount.
    this.#worktreeRepo = getACPWorktreeRepo();
    this.#githubRepo = getACPGithubRepo();

    // Subscribe to Tauri file drag-drop events. The subscriber is injected by the desktop-assistant
    // app (which has access to @tauri-apps/api); non-desktop hosts leave it undefined, making this
    // a no-op. HTML5 drag events are suppressed by Tauri's native handler, so we drive both the
    // drag-over visual affordance and chip insertion through Tauri events instead.
    initTauriDragDrop(
      makeTauriDragDropCallbacks(this.#core, { rpc }),
      this.#tauriDragDropSubscriber,
    );

    // Mirror the appState store into a rune so the derived getters stay reactive.
    onMount(() => appState.subscribe((value) => (this.#appStateSnapshot = value)));

    // Attach desktop keyboard-shortcut behavior by id. Declarations + chords live in the
    // shared keybindings registry; the dispatcher (installed by RuntimeProviders) fires
    // these when the matching chord is pressed. (approve/reject are `external` — handled
    // by the permission prompt component, so they are not registered here.)
    onMount(() => {
      const keybindings = this.#core.keybindings;
      const registered = [
        "newConversation",
        "searchConversations",
        "nextUnreadConversation",
        "newProject",
        "newWorktree",
        "openInIde",
        "focusInput",
        "togglePlanMode",
        "toggleLeftPanel",
        "toggleRightPanel",
        "toggleBottomPanel",
      ] as const;
      const disposers = [
        keybindings.register("newConversation", () => void this.handleNewConversation()),
        keybindings.register("searchConversations", () => {
          window.dispatchEvent(new CustomEvent(DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT));
        }),
        keybindings.register("nextUnreadConversation", () => this.handleNextUnreadConversation()),
        keybindings.register("newProject", () => void this.handleAddProject()),
        keybindings.register("newWorktree", () => void this.handleAddWorktree()),
        keybindings.register("openInIde", () => this.handleOpenInIde()),
        keybindings.register("focusInput", () => focusPrompt()),
        keybindings.register("togglePlanMode", () => void this.#activeSession?.togglePlanMode()),
        keybindings.register("toggleLeftPanel", () => this.toggleLeftPanel()),
        keybindings.register("toggleRightPanel", () => this.toggleDesktopRightSidebarVisible()),
        keybindings.register("toggleBottomPanel", () => this.toggleDesktopBottomPanelVisible()),
      ];
      if (import.meta.env.DEV) {
        auditUnwiredCommands(registered);
      }
      return () => disposers.forEach((dispose) => dispose());
    });

    // Host bridges: restore sidebar width, open settings on the desktop menu event, jump to a
    // conversation when a debug dump loads, and clear/replace the active session when sync says so.
    onMount(() => {
      this.#desktopSidebar.loadSavedWidth();
      this.#desktopRightSidebar.loadSavedState();
      this.#desktopBottomPanel.loadSavedState();

      const openDesktopSettings = (event: Event) => {
        if (!this.#isDesktop) return;
        const section = (event as CustomEvent<{ section?: string }>).detail?.section;
        if (section && isSettingsView(section)) {
          this.showSettingsSection(section);
        } else {
          this.showSettings();
        }
      };
      const handleSetCurrentConversation = (event: Event) => {
        const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail
          ?.conversationId;
        if (!conversationId) return;
        this.openConversation(conversationId);
      };
      const handleDebugDumpLoaded = (event: Event) => {
        const detail = (event as CustomEvent<ACPDebugDumpLoadedEventDetail>).detail;
        if (!detail?.conversationId) return;
        this.#viewState.showChat();
        this.#core.activeConversationId = detail.conversationId;
        this.#onNavigationChange?.();
      };
      const activeSession = () => this.#activeSession;
      const stopSessionSync = wireACPSessionSync({
        emitter: this.#core.acpConversationRepo.emitter,
        sessions: this.#core.acpRepo,
        session: {
          get sessionId() {
            return activeSession()?.sessionId ?? null;
          },
          get sessionAgentServer() {
            return activeSession()?.agentServer ?? null;
          },
          get pendingConversationId() {
            return activeSession()?.pendingConversationId ?? null;
          },
          clearActiveSession: () => {
            this.handleActiveConversationIdChange(null);
          },
        },
      });

      window.addEventListener(DESKTOP_OPEN_SETTINGS_PANEL_EVENT, openDesktopSettings);
      window.addEventListener(SET_CURRENT_CONVERSATION_EVENT, handleSetCurrentConversation);
      this.#core.acpRepo.emitter.addEventListener(
        ACP_DEBUG_DUMP_LOADED_EVENT,
        handleDebugDumpLoaded,
      );
      return () => {
        stopSessionSync();
        window.removeEventListener(DESKTOP_OPEN_SETTINGS_PANEL_EVENT, openDesktopSettings);
        window.removeEventListener(SET_CURRENT_CONVERSATION_EVENT, handleSetCurrentConversation);
        this.#core.acpRepo.emitter.removeEventListener(
          ACP_DEBUG_DUMP_LOADED_EVENT,
          handleDebugDumpLoaded,
        );
      };
    });

    // Latch: flips true on the first successful project refresh and never back. Drives the desktop
    // project gates so they only apply before projects have ever loaded.
    $effect(() => {
      if (this.#core.acpProjectRepo.refreshState.status === "success") {
        this.#hasLoadedProjectsOnce = true;
      }
    });

    // Remember the project/worktree of the active conversation so the next "New
    // conversation" reopens there, even across app restarts.
    $effect(() => {
      const cwd = this.#currentConversationCwd;
      if (!this.#isDesktop || !cwd) return;
      if (this.#core.acpProjectRepo.projects.some((project) => project.path === cwd)) {
        writeStoredLastConversationCwd(cwd);
      }
    });

    // Focus on selection, without waiting for history. A late history result
    // must never steal focus from the search box, another pane or settings.
    $effect(() => {
      const conversationId = this.#core.activeConversationId;
      if (!conversationId || this.#lastFocusedConversationId === conversationId) return;
      this.#lastFocusedConversationId = conversationId;
      return focusPromptIfUnchanged(
        () => this.#viewState.view === "chat" && this.#core.activeConversationId === conversationId,
      );
    });
  }

  get view() {
    return this.#viewState.view;
  }
  get projectSettingsPath() {
    return this.#viewState.projectSettingsPath;
  }
  get projectSettingsProject() {
    return this.#core.acpProjectRepo.projects.find(
      (candidate) => candidate.path === this.#viewState.projectSettingsPath,
    );
  }
  get sidebarCollapsed() {
    return this.#viewState.sidebarCollapsed;
  }
  get desktopSidebarWidth() {
    return this.#desktopSidebar.width;
  }
  get desktopSidebarResizing() {
    return this.#desktopSidebar.resizing;
  }
  get desktopRightSidebarVisible() {
    return this.#currentConversationPanelState().rightSidebarVisible;
  }
  get desktopRightSidebarWidth() {
    return this.#desktopRightSidebar.width;
  }
  get desktopRightSidebarResizing() {
    return this.#desktopRightSidebar.resizing;
  }
  get desktopBottomPanelVisible() {
    return this.#currentConversationPanelState().bottomPanelVisible;
  }
  get desktopBottomPanelHeight() {
    return this.#desktopBottomPanel.height;
  }
  get desktopBottomPanelResizing() {
    return this.#desktopBottomPanel.resizing;
  }
  get addingProject() {
    return this.#addingProject;
  }
  get activeConversationId() {
    return this.#core.activeConversationId;
  }
  get activeSession() {
    return this.#activeSession;
  }
  get isDesktop() {
    return this.#isDesktop;
  }
  get isBlockingSessionLoading() {
    return this.#isBlockingSessionLoading;
  }
  get initialScreenSettled() {
    const projectStatus = this.#core.acpProjectRepo.refreshState.status;
    const conversationStatus = this.#core.acpConversationRepo.refreshState.status;
    const agentServersStatus = this.#core.acpAgentServers.state.status;
    const statuses = [projectStatus, conversationStatus, agentServersStatus];

    if (statuses.some((status) => status === "failure")) return true;
    if (statuses.some((status) => status !== "success")) return false;
    if (this.#core.acpProjectRepo.projects.length === 0) return true;
    if (this.#bootstrap.sessionError()) return true;
    if (this.#core.acpRepo.agents.authRequiredForAgent(this.#activeConversationAgentServer())) {
      return true;
    }

    const session = this.#activeSession;
    return session !== null && session !== undefined && session.loadState.status !== "loading";
  }
  get initialAgentReady() {
    const agent = this.#activeConversationAgentServer();
    return (
      this.#core.acpAgentServers.state.status === "success" &&
      this.#activeSession != null &&
      !this.#isSessionLoading &&
      !this.#core.acpRepo.agents.isConfigCacheLoadingFor(agent) &&
      !this.#core.acpRepo.agents.authRequiredForAgent(agent) &&
      !this.#core.acpRepo.agents.authInProgressForAgent(agent) &&
      !this.#bootstrap.sessionError()
    );
  }
  // Diagnostic snapshot of every input to initialScreenSettled, consumed by the
  // desktop host's startup-diagnostics probe while the startup frame is
  // visible. Read-only; safe to call from outside the reactive graph.
  startupDiagnosticsSnapshot(): Record<string, unknown> {
    const session = this.#activeSession;
    const agentServer = this.#activeConversationAgentServer();
    let initialScreenSettled: unknown;
    try {
      initialScreenSettled = this.initialScreenSettled;
    } catch (error) {
      initialScreenSettled = `threw: ${String(error)}`;
    }
    let sessionError: unknown;
    try {
      const error = this.#bootstrap.sessionError();
      sessionError =
        error == null ? null : String((error as { message?: unknown }).message ?? error);
    } catch (error) {
      sessionError = `threw: ${String(error)}`;
    }
    return {
      initialScreenSettled,
      view: this.#viewState.view,
      projectStatus: this.#core.acpProjectRepo.refreshState.status,
      conversationStatus: this.#core.acpConversationRepo.refreshState.status,
      agentServersStatus: this.#core.acpAgentServers.state.status,
      projectCount: this.#core.acpProjectRepo.projects.length,
      conversationCount: this.#core.acpConversationRepo.sessions.length,
      hasLoadedProjectsOnce: this.#hasLoadedProjectsOnce,
      isDesktop: this.#isDesktop,
      activeConversationId: this.#core.activeConversationId,
      hasActiveSession: session != null,
      activeSessionLoadState: session?.loadState.status ?? null,
      activeSessionIsChat: session?.isChat ?? null,
      activeSessionAgentSessionId: session?.sessionId ?? null,
      agentServer,
      defaultAgentServer: this.#core.acpRepo.agents.defaultAgentServer,
      authRequired: this.#core.acpRepo.agents.authRequiredForAgent(agentServer),
      configCacheLoading: this.#core.acpRepo.agents.isConfigCacheLoadingFor(agentServer),
      sessionError,
      isBlockingSessionLoading: this.#isBlockingSessionLoading,
    };
  }
  get currentACPWorkspaceFolders() {
    return this.#currentACPWorkspaceFolders;
  }
  get desktopChatLayoutKey() {
    return (
      this.#core.activeConversationId ??
      `new:${this.#activeConversationAgentServer()}:${this.#currentConversationCwd}`
    );
  }
  get terminalWorktreePath() {
    return resolveDesktopWorkspaceRoot(
      this.#currentConversationCwd,
      this.#core.acpProjectRepo.projects,
    );
  }

  restoreNavigation = (
    entry: Pick<DesktopNavigationEntry, "view" | "projectSettingsPath" | "conversationId">,
  ) => {
    this.#viewState.restore(entry.view, entry.projectSettingsPath);
    this.#core.activeConversationId = entry.conversationId;
  };

  handleNewConversation = async (cwd = this.#newConversationDefaultCwd()) => {
    return await this.#createNewConversation(cwd);
  };

  // Seeds an ephemeral chat for the no-projects launch. Unlike handleNewChat it does not persist
  // the pending conversation, so an untouched draft never clutters the sidebar (matching the
  // project-scoped bootstrap); the first prompt persists it like any other conversation.
  async #bootstrapLaunchChat() {
    if (this.#isNavigationLoading) {
      return;
    }
    const previousConversationId = this.#core.activeConversationId;
    const conversationId = newConversationID();
    const cwd = await createACPChatWorkingDirectory(conversationId);
    if (
      this.#viewState.view !== "chat" ||
      this.#core.activeConversationId !== previousConversationId ||
      !this.#hasNoProjectsOnDesktop
    )
      return;
    const agentServer = this.#core.acpRepo.agents.defaultAgentServer;
    const { cwd: protocolCwd } = resolveConversationWorkspaceScope(this.#appStateSnapshot, cwd);
    this.#bootstrap.markPrepared(agentServer, protocolCwd);
    const session = this.#core.acpRepo.createSession(protocolCwd, agentServer, conversationId, {
      isChat: true,
    });
    this.#core.activeConversationId = session.conversationId;
    this.#onNavigationChange?.();
  }

  handleNewChat = async () => {
    if (this.#isNavigationLoading) {
      return null;
    }
    const isCurrent = this.#captureNewConversationRequest();
    const conversationId = newConversationID();
    const cwd = await createACPChatWorkingDirectory(conversationId);
    if (!isCurrent()) return null;
    return await this.#createNewConversation(cwd, { conversationId, isChat: true });
  };

  async #createNewConversation(
    cwd: string,
    options: { conversationId?: string; isChat?: boolean } = {},
  ) {
    if (this.#isNavigationLoading) {
      return null;
    }
    this.#viewState.showChat();
    const isCurrent = this.#captureNewConversationRequest();
    if (this.#core.acpAgentServers.state.status !== "success") {
      await this.#core.acpAgentServers.refresh();
      if (!isCurrent()) return null;
    }
    const agentServer = this.#core.acpRepo.agents.defaultAgentServer;
    const { cwd: protocolCwd } = resolveConversationWorkspaceScope(this.#appStateSnapshot, cwd);
    cwd = protocolCwd;

    const activeSession = this.#activeSession;
    if (
      activeSession?.sessionId === null &&
      (activeSession.events?.length ?? 0) === 0 &&
      cwd === (activeSession.cwd ?? "")
    ) {
      activeSession.requestPromptFocus();
      this.#onNavigationChange?.();
      return activeSession.conversationId;
    }

    this.#bootstrap.markPrepared(agentServer, cwd);
    // Surface the draft in the sidebar immediately — don't wait for the first
    // keystroke. "New conversation" (and worktree creation, which routes here)
    // then gives instant visible feedback, and the draft is a real conversation
    // its terminal / setup-script output can attach to.
    const session = options.isChat
      ? this.#core.acpRepo.createSession(cwd, agentServer, options.conversationId ?? null, {
          isChat: true,
        })
      : this.#core.acpRepo.createSession(cwd, agentServer, options.conversationId ?? null);
    session.persistPendingConversation();
    session.requestPromptFocus();
    this.#core.activeConversationId = session.conversationId;
    this.#onNavigationChange?.();
    return session.conversationId;
  }

  #captureNewConversationRequest() {
    const generation = ++this.#newConversationGeneration;
    const conversationId = this.#core.activeConversationId;
    const view = this.#viewState.view;
    const projectSettingsPath = this.#viewState.projectSettingsPath;
    // Directory creation and agent discovery can outlive a navigation choice.
    // Also discard older New commands even if the newer one is still waiting.
    return () =>
      generation === this.#newConversationGeneration &&
      conversationId === this.#core.activeConversationId &&
      view === this.#viewState.view &&
      projectSettingsPath === this.#viewState.projectSettingsPath;
  }

  // Deselecting (id === null) doesn't leave the user on a blank screen: unless a settings view or a
  // project gate is in the way, it immediately seeds a fresh empty session to land back on.
  handleActiveConversationIdChange = (id: string | null): string | null => {
    if (id === null) {
      this.#core.activeConversationId = null;
      if (
        this.#viewState.view !== "chat" ||
        this.#shouldWaitForInitialProject ||
        this.#shouldOpenProject
      ) {
        this.#onNavigationChange?.();
        return null;
      }
      const cwd = this.#defaultConversationCwd();
      const agentServer = this.#core.acpRepo.agents.defaultAgentServer;
      this.#bootstrap.markPrepared(agentServer, cwd);
      const replacementConversationId = this.#core.acpRepo.createSession(
        cwd,
        agentServer,
        null,
      ).conversationId;
      this.#core.activeConversationId = replacementConversationId;
      this.#onNavigationChange?.();
      return replacementConversationId;
    }
    this.#core.activeConversationId = id;
    this.#onNavigationChange?.();
    return id;
  };

  handleAddProject = async () => {
    if (this.#addingProject) return;
    this.#addingProject = true;
    try {
      const project = await rpc.selectProjectFolder();
      if (!project?.path) return;
      await this.#core.acpProjectRepo.upsertProject({
        path: project.path,
        name: project.name || project.path,
      });
      await this.#core.acpConversationRepo.refresh();
      // Land in a ready-to-type draft conversation for the new project.
      await this.handleNewConversation(project.path);
    } finally {
      this.#addingProject = false;
    }
  };

  // Simplified worktree creation for the keyboard shortcut: prepare + create on the
  // project owning the visible conversation, then open a conversation in it. No-ops
  // when that project is unknown or not a git repository. The sidebar button keeps
  // the richer optimistic/abortable flow.
  handleAddWorktree = async () => {
    if (this.#addingWorktree) return;
    const project = this.#currentProject;
    const worktrees = this.#worktreeRepo;
    if (!project || !worktrees) return;
    // Same gate as the sidebar button: disabled only on a confirmed non-repo
    // (undefined = status not loaded yet, let the attempt proceed).
    if (this.#githubRepo?.isRepoFor(project.path) === false) return;
    this.#addingWorktree = true;
    try {
      const prepared = await worktrees.prepareWorktree(project.path);
      if (!prepared) return;
      // prepareWorktree reserves the worktree server-side; release the reservation
      // if creation throws or yields nothing, so failed shortcut presses don't leak.
      let created: Awaited<ReturnType<typeof worktrees.createWorktree>>;
      try {
        created = await worktrees.createWorktree(project.path, prepared);
      } catch (error) {
        await worktrees.discardPreparedWorktree(prepared.path).catch(() => {});
        throw error;
      }
      if (!created?.path) {
        await worktrees.discardPreparedWorktree(prepared.path).catch(() => {});
        return;
      }
      await this.#core.acpProjectRepo.refresh();
      await this.#core.acpConversationRepo.refresh();
      await this.handleNewConversation(created.path);
    } finally {
      this.#addingWorktree = false;
    }
  };

  handleOpenInIde = () => {
    const path = this.#currentACPWorkspaceFolders[0]?.path ?? this.#currentConversationCwd;
    if (!path) return;
    const openerId = resolveDesktopOpenTargetOpenerId(
      this.#appStateSnapshot.environment.desktopFileOpenerId,
      this.#appStateSnapshot.environment.desktopOpeners,
    );
    // openPathWithOpener is a desktop-host-only RPC method, not on the shared RPCClient type.
    const desktopRpc = rpc as unknown as {
      openPathWithOpener(path: string, openerId: string): Promise<void>;
    };
    void desktopRpc.openPathWithOpener(path, openerId).catch(() => {});
  };

  // Jump to an existing conversation (e.g. the host relaying a clicked
  // notification), leaving any settings view for the chat.
  openConversation = (conversationId: string) => {
    this.#viewState.showChat();
    this.handleActiveConversationIdChange(conversationId);
  };

  // Switch to the next conversation flagged unread (forward-scan with wrap-around;
  // see findNextUnreadConversation). No-op when nothing is unread.
  handleNextUnreadConversation = () => {
    const next = findNextUnreadConversation(
      this.#core.acpConversationRepo.sessions,
      this.#core.activeConversationId,
    );
    if (!next) return;
    this.#viewState.showChat();
    this.handleActiveConversationIdChange(next.id);
  };

  toggleLeftPanel = () => {
    this.setSidebarCollapsed(!this.sidebarCollapsed);
  };

  setDesktopRightSidebarVisible = (visible: boolean) => {
    this.#setConversationPanelState({ rightSidebarVisible: visible });
  };

  toggleDesktopRightSidebarVisible = () => {
    this.setDesktopRightSidebarVisible(!this.desktopRightSidebarVisible);
  };

  setDesktopBottomPanelVisible = (visible: boolean) => {
    this.#setConversationPanelState({ bottomPanelVisible: visible });
  };

  toggleDesktopBottomPanelVisible = () => {
    this.setDesktopBottomPanelVisible(!this.desktopBottomPanelVisible);
  };

  #currentConversationPanelState(): DesktopConversationPanelState {
    return (
      this.#conversationPanelStates[this.desktopChatLayoutKey] ?? DEFAULT_CONVERSATION_PANEL_STATE
    );
  }

  #setConversationPanelState(next: Partial<DesktopConversationPanelState>) {
    const key = this.desktopChatLayoutKey;
    const current = this.#currentConversationPanelState();
    this.#conversationPanelStates = {
      ...this.#conversationPanelStates,
      [key]: {
        ...current,
        ...next,
      },
    };
    writeStoredDesktopConversationPanelStates(this.#conversationPanelStates);
  }

  #showView(show: () => void) {
    show();
    this.#onNavigationChange?.();
  }

  // Where a user-initiated "New conversation" opens: on desktop, the
  // project/worktree of the conversation the user is currently in, or (across
  // restarts) the last one they used, so it lands where they left off.
  // Auto-seeded landing drafts (e.g. after archiving) use
  // #defaultConversationCwd instead, which always resolves to a stable default.
  #newConversationDefaultCwd(): string {
    if (this.#isDesktop) {
      const isKnownWorkspace = (path: string | null | undefined): path is string =>
        !!path && this.#core.acpProjectRepo.projects.some((project) => project.path === path);
      const activeCwd = this.#activeSession?.cwd;
      if (isKnownWorkspace(activeCwd)) return activeCwd;
      const storedCwd = readStoredLastConversationCwd();
      if (isKnownWorkspace(storedCwd)) return storedCwd;
    }
    return this.#defaultConversationCwd();
  }

  #defaultConversationCwd(): string {
    return defaultDesktopConversationCwd({
      appState: this.#appStateSnapshot,
      isDesktop: this.#isDesktop,
      firstProject: this.#firstProject,
    });
  }

  #activeConversationAgentServer(): string {
    return this.#activeSession?.agentServer ?? this.#core.acpRepo.agents.defaultAgentServer;
  }

  #pendingConversationCwd(): string {
    return this.#activeSession?.pendingConversationId && this.#activeSession.pendingCwd
      ? this.#activeSession.pendingCwd
      : this.#defaultConversationCwd();
  }
}

function resolveDesktopOpenTargetOpenerId(
  fallbackOpenerId: string | undefined,
  openers: DesktopOpenerInfo[] | undefined,
): string {
  const desktopOpeners = Array.isArray(openers) ? openers : [];
  const storedOpenerId = readStoredDesktopOpenTargetOpenerId();
  if (storedOpenerId && hasDesktopOpener(desktopOpeners, storedOpenerId)) {
    return storedOpenerId;
  }

  if (fallbackOpenerId && hasDesktopOpener(desktopOpeners, fallbackOpenerId)) {
    return fallbackOpenerId;
  }

  return desktopOpeners[0]?.id ?? fallbackOpenerId ?? "default";
}

function hasDesktopOpener(openers: DesktopOpenerInfo[], openerId: string): boolean {
  return openers.some((opener) => opener.id === openerId);
}

function readStoredDesktopOpenTargetOpenerId(): string | null {
  try {
    return globalThis.localStorage?.getItem(DESKTOP_OPEN_TARGET_OPENER_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function readStoredDesktopConversationPanelStates(): Record<string, DesktopConversationPanelState> {
  try {
    const value = globalThis.localStorage?.getItem(DESKTOP_CONVERSATION_PANEL_STATE_STORAGE_KEY);
    if (!value) return {};

    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const states: Record<string, DesktopConversationPanelState> = {};
    for (const [key, state] of Object.entries(parsed)) {
      if (!key || !state || typeof state !== "object" || Array.isArray(state)) continue;
      states[key] = {
        rightSidebarVisible:
          (state as Partial<DesktopConversationPanelState>).rightSidebarVisible === true,
        bottomPanelVisible:
          (state as Partial<DesktopConversationPanelState>).bottomPanelVisible === true,
      };
    }
    return states;
  } catch {
    return {};
  }
}

function writeStoredDesktopConversationPanelStates(
  states: Record<string, DesktopConversationPanelState>,
) {
  try {
    globalThis.localStorage?.setItem(
      DESKTOP_CONVERSATION_PANEL_STATE_STORAGE_KEY,
      JSON.stringify(states),
    );
  } catch {
    // Best-effort UI preference persistence.
  }
}
