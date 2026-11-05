<script lang="ts">
  import { Badge } from "@camber/components/badge";
  import Icon from "@camber/components/icon";
  import { formatError } from "@camber/lib/errors";
  import { InfoMessageType } from "@camber/rpc";
  import { onDestroy, onMount, tick } from "svelte";
  import { appState } from "../hostAdapter";
  import type { WorkspaceFolder } from "@camber/rpc";
  import { camberRemoteAccessStatus } from "@camber/helperapi";
  import { rpc } from "../hostRpc";
  import {
    activeBinding,
    defaultChord,
    shortcutHint,
    withShortcut,
    type CommandId,
  } from "../../keybindings";
  import { chordToNativeAccelerator } from "../../keybindings/nativeAccelerator";
  import { moveItem, reorderable } from "@camber/dnd";
  import {
    ACP_DESKTOP_CONVERSATIONS_EVENT,
    ACP_DESKTOP_PROJECTS_EVENT,
    compareWorktreesByDisplayOrder,
    dedupeConversationSummaries,
    isACPChatConversation,
    worktreeBlocksUI,
    type ACPConversationSummary,
    type ACPConversationsState,
    type ACPNavProject,
    type ACPProjectsState,
  } from "../navTypes";
  import { getACPConversationRepo } from "../features/ConversationRepository.svelte";
  import { getACPAgentUpdateRepo } from "../features/AgentUpdateRepository.svelte";
  import { getACPGithubRepo } from "../features/GithubRepository.svelte";
  import { getACPProjectRepo } from "../features/ProjectRepository.svelte";
  import { getACPWorktreeRepo } from "../features/WorktreeRepository";
  import type { ACPSession } from "../features/Session.svelte";
  import { workspacePathFitsWorkspaceFolders } from "../workspacePaths";
  import { githubPRActionLabel } from "../github/githubStatus";
  import { setAcpSidebarController } from "./sidebar/SidebarController.svelte";
  import {
    CONVERSATION_SHORTCUT_LIMIT,
    conversationShortcutIndexFromKeyboardEvent,
    conversationShortcutLabel,
  } from "./sidebar/conversationShortcuts";
  import { HeldModifierHint } from "./sidebar/heldModifierHint";
  import { UNDO_COUNTDOWN_SECONDS, UndoCountdown } from "./sidebar/undoCountdown";
  import { rowExitAnimation } from "./sidebar/rowExitAnimation.svelte";
  import DesktopConversationSearch from "./sidebar/DesktopConversationSearch.svelte";
  import DesktopSidebarChrome from "./sidebar/DesktopSidebarChrome.svelte";
  import DesktopSidebarViewSlider from "./sidebar/DesktopSidebarViewSlider.svelte";
  import DesktopProjectSection from "./sidebar/DesktopProjectSection.svelte";
  import { suppressContextMenu } from "./sidebar/contextMenuHelpers";
  import ConversationGroup from "./sidebar/ConversationGroup.svelte";
  import {
    buildConversationTree,
    hasAttentionDescendant,
    sliceVisibleSessions,
  } from "./sidebar/conversationTree";
  import ConversationPreview from "./sidebar/ConversationPreview.svelte";
  import ReorderDragPreview from "./sidebar/ReorderDragPreview.svelte";
  import { ReorderMotion } from "./sidebar/ReorderMotion.svelte";
  import ReorderMotionItem from "./sidebar/ReorderMotionItem.svelte";
  import { type ContextMenuAction, type ContextMenuItem } from "./sidebar/ContextMenu.svelte";
  import {
    showDesktopSystemContextMenu,
    type DesktopSystemContextMenuItem,
  } from "./chat/desktopSystemContextMenu";
  import ConfirmationDialog from "./ui/ConfirmationDialog.svelte";
  import { getOptionalACPConnectionPoolContext } from "../connectionPoolContext";
  import ACPLogCaptureConfirmation from "./sidebar/ACPLogCaptureConfirmation.svelte";
  import { acpLogCaptureMenuAction, type ACPLogCaptureTarget } from "./sidebar/acpLogCapture";
  import SidebarNavButton from "./sidebar/SidebarNavButton.svelte";
  import SidebarIconButton from "./sidebar/SidebarIconButton.svelte";
  import SidebarLocalDownloads from "./sidebar/SidebarLocalDownloads.svelte";
  import SidebarLocalRuntime from "./sidebar/SidebarLocalRuntime.svelte";
  import SidebarToasts from "./sidebar/SidebarToasts.svelte";
  import { sidebarToasts } from "./sidebar/sidebarToastsState.svelte";
  import { sidebarInlineRenameLabel, sidebarOpensViewLabel } from "./sidebar/menuLabels";
  import {
    activeConversationSidebarSection,
    sidebarSectionToggleLabel,
    shouldShowSidebarSectionOpenBadge,
    type DesktopSidebarSection,
  } from "./sidebar/sidebarSectionOpenBadge";
  import { shouldCreateConversationAfterWorktreeCreation } from "./sidebar/worktreeConversation";
  import {
    DESKTOP_SETTINGS_NAV_SECTIONS,
    SETTINGS_NAV_ITEMS,
    type DesktopSettingsNavSection,
  } from "./settings/settingsSections";
  import {
    DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT,
    type DesktopNewTabAvailability,
    type DesktopOpenConversationSearchEventDetail,
  } from "./chat/desktopCommandPicker";

  interface Props {
    collapsed: boolean;
    currentView:
      | "chat"
      | "agents"
      | "settings"
      | "shortcuts"
      | "models"
      | "voice"
      | "connectors"
      | "github"
      | "archived"
      | "remote"
      | "project-settings";
    width?: number;
    minWidth?: number;
    maxWidth?: number;
    resizing?: boolean;
    showCollapsedActions?: boolean;
    collapseDisabled?: boolean;
    onCollapsedChange: (collapsed: boolean) => void;
    onResizeStart?: (event: MouseEvent) => void;
    onWidthChange?: (width: number) => void;
    onNewConversation: (cwd?: string) => string | null | void | Promise<string | null | void>;
    onNewChat?: () => string | null | void | Promise<string | null | void>;
    onShowSettings: () => void;
    onShowShortcuts?: () => void;
    onShowModels?: () => void;
    onShowVoice?: () => void;
    onShowConnectors?: () => void;
    onShowGithub?: () => void;
    onShowAgents?: () => void;
    onShowArchived?: () => void;
    onShowRemote?: () => void;
    onShowProjectSettings: (path?: string | null) => void;
    onShowChat: () => void;
    currentWorkspaceFolders: WorkspaceFolder[];
    activeConversationId?: string | null;
    activeSession?: ACPSession | null;
    newTabAvailability?: DesktopNewTabAvailability;
    onActiveConversationIdChange?: (id: string | null) => string | null | void;
  }

  type DesktopSidebarView = "main" | "settings";

  const DESKTOP_SIDEBAR_SECTION_ORDER_STORAGE_KEY = "camber.desktop.sidebarSectionOrder.v1";
  const DEFAULT_DESKTOP_SIDEBAR_SECTION_ORDER: DesktopSidebarSection[] = ["chats", "projects"];

  const DESKTOP_SUB_AGENTS_EXPANDED_STORAGE_KEY = "camber.desktop.expandedSubAgents.v1";

  // Sub-agent lists are collapsed by default, so only the expanded parents'
  // conversation ids are stored.
  function loadExpandedSubAgentParents(): Set<string> {
    try {
      const raw = globalThis.localStorage?.getItem(DESKTOP_SUB_AGENTS_EXPANDED_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((id): id is string => typeof id === "string"));
    } catch {
      return new Set();
    }
  }

  function loadDesktopSidebarSectionOrder(): DesktopSidebarSection[] {
    try {
      const raw = globalThis.localStorage?.getItem(DESKTOP_SIDEBAR_SECTION_ORDER_STORAGE_KEY);
      if (!raw) return [...DEFAULT_DESKTOP_SIDEBAR_SECTION_ORDER];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [...DEFAULT_DESKTOP_SIDEBAR_SECTION_ORDER];

      const saved = parsed.filter(
        (section): section is DesktopSidebarSection =>
          section === "chats" || section === "projects",
      );
      return [
        ...new Set([...saved, ...DEFAULT_DESKTOP_SIDEBAR_SECTION_ORDER]),
      ] as DesktopSidebarSection[];
    } catch {
      return [...DEFAULT_DESKTOP_SIDEBAR_SECTION_ORDER];
    }
  }

  let {
    collapsed,
    currentView,
    width = 260,
    minWidth = 220,
    maxWidth = 420,
    resizing = false,
    showCollapsedActions = false,
    collapseDisabled = false,
    onCollapsedChange,
    onResizeStart,
    onWidthChange,
    onNewConversation,
    onNewChat,
    onShowSettings,
    onShowShortcuts,
    onShowModels,
    onShowVoice,
    onShowConnectors,
    onShowGithub,
    onShowAgents,
    onShowArchived,
    onShowRemote,
    onShowProjectSettings,
    onShowChat,
    currentWorkspaceFolders,
    activeConversationId = null,
    activeSession = null,
    newTabAvailability,
    onActiveConversationIdChange,
  }: Props = $props();

  const conversations = getACPConversationRepo();
  const agentUpdates = getACPAgentUpdateRepo();
  const acpConnectionPool = getOptionalACPConnectionPoolContext();
  const projects = getACPProjectRepo();
  const github = getACPGithubRepo();
  const worktrees = getACPWorktreeRepo();
  const abortControllers = new Map<string, AbortController>();
  const sidebar = setAcpSidebarController({
    onShowChat,
    onNewConversation: async (cwd?: string) => {
      await expandCollapsedWorkspace(cwd);
      return await onNewConversation(cwd);
    },
    getActiveConversationId: () => activeConversationId,
    getActiveSession: () => activeSession,
    setActiveConversationId: (id) => onActiveConversationIdChange?.(id),
    // Don't highlight the active conversation while a non-chat destination (e.g.
    // Connectors) is open — otherwise the sidebar shows two active items.
    isChatActive: () => currentView === "chat",
  });

  let searchQuery = $state("");
  let addingProject = $state(false);
  let sidebarScrollElement = $state<HTMLDivElement | undefined>(undefined);
  let hasSidebarTopOverflow = $state(false);
  let hasSidebarBottomOverflow = $state(false);
  let navProjects = $state<ACPNavProject[]>([]);
  let navSessions = $state<ACPConversationSummary[]>([]);
  let rootProjects = $state<ACPNavProject[]>([]);
  let sidebarSectionOrder = $state<DesktopSidebarSection[]>(loadDesktopSidebarSectionOrder());
  const sidebarSectionReorderMotion = new ReorderMotion(
    () => sidebarSectionOrder,
    (section) => section,
    24,
    180,
    true,
  );
  const projectReorderMotion = new ReorderMotion(
    () => rootProjects,
    (project) => project.path,
    30,
  );
  let conversationSearchOpen = $state(false);
  let conversationSearchInitialQuery = $state("");
  let conversationSearchOpenToken = $state(0);
  // True while a worktree drag is in progress (in any project section).
  let worktreeDragActive = $state(false);
  let chatsSectionCollapsed = $state(false);
  let projectsSectionCollapsed = $state(false);
  let expandedSessionGroups = $state(new Set<string>());
  let expandedSubAgentParents = $state(loadExpandedSubAgentParents());
  let acpLogCaptureTarget = $state<ACPLogCaptureTarget | null>(null);
  let removeProjectTarget = $state<{ path: string; name: string } | null>(null);
  let deleteWorktreeTarget = $state<{ path: string; name: string } | null>(null);
  let deleteConversationTarget = $state<{
    session: ACPConversationSummary;
    name: string;
  } | null>(null);
  let exitingConversationIds = $state(new Set<string>());
  let exitingWorktreePaths = $state(new Set<string>());
  let rowExitAnimating = $derived(rowExitAnimation.animating);
  const conversationArchiveCountdown = new UndoCountdown(() => {});
  const worktreeRemovalCountdown = new UndoCountdown(() => {});
  interface SelectionRollback {
    conversationId: string;
    replacementConversationId: string | null;
  }
  const conversationSelectionRollbacks = new Map<string, SelectionRollback>();
  const worktreeSelectionRollbacks = new Map<string, SelectionRollback>();
  const SESSION_VISIBLE_LIMIT = 5;
  let canOpenWorkspace = $derived(Boolean($appState.environment.capabilities.openWorkspace));
  let canAddFolderToWorkspace = $derived(
    Boolean($appState.environment.capabilities.addFolderToWorkspace),
  );
  let isLoading = $derived(sidebar.isLoading);
  let hasAgentUpdate = $derived(agentUpdates.updates.some((update) => update.kind !== "install"));
  const CHATS_GROUP_KEY = "CHAT";
  let chatsSectionContentVisible = $derived(!chatsSectionCollapsed);
  let projectsSectionContentVisible = $derived(!projectsSectionCollapsed);
  let searching = $derived(searchQuery.trim() !== "");
  // Spawned conversations nest under their visible parent; search stays flat.
  // A child only nests under a parent whose row container is on screen;
  // otherwise it stays a normal row in its own section.
  let conversationTree = $derived(
    buildConversationTree(navSessions, { flat: searching, canNestUnder: isParentRowRendered }),
  );
  let chatSessions = $derived(
    navSessions.filter(
      (session) =>
        !exitingConversationIds.has(session.id) &&
        !conversationTree.isNested(session.id) &&
        isACPChatConversation(session) &&
        sessionMatchesSearch(session),
    ),
  );
  let activeConversationSection = $derived.by<DesktopSidebarSection | null>(() => {
    return activeConversationSidebarSection(
      navSessions,
      (session) => sidebar.rowState(session).selected,
      (session) =>
        activeSession?.conversationId === session.id ? activeSession.isChat : undefined,
    );
  });
  let chatsSectionShowsOpen = $derived(
    shouldShowSidebarSectionOpenBadge("chats", chatsSectionCollapsed, activeConversationSection),
  );
  let projectsSectionShowsOpen = $derived(
    shouldShowSidebarSectionOpenBadge(
      "projects",
      projectsSectionCollapsed,
      activeConversationSection,
    ),
  );

  // GitHub status polling: a stable key over the visible project/worktree paths
  // so we only re-fetch when the set of paths changes (not on every busy/order
  // mutation of navProjects). github.start() additionally polls on an interval
  // and on window focus; see AcpGithubRepository.
  let githubPathsKey = $derived(
    navProjects
      .map((project) => project.path)
      .sort()
      .join("\n"),
  );
  $effect(() => {
    const key = githubPathsKey;
    if (!key) return;
    void github.refresh(key.split("\n"));
  });

  let activeWorkspaceLabel = $derived.by(() => {
    const desktopWorktreeName = $appState.environment.desktopInstance?.worktreeName?.trim();
    if (!desktopWorktreeName) return null;
    const activeProject = camberqaWorktreeProject(desktopWorktreeName);
    return activeProject ? projectDisplayName(activeProject) : desktopWorktreeName;
  });
  let activeWorkspaceColor = $derived(
    $appState.environment.desktopInstance?.color?.trim() || undefined,
  );

  function updateSidebarOverflow(element = sidebarScrollElement): void {
    if (!element) {
      hasSidebarTopOverflow = false;
      hasSidebarBottomOverflow = false;
      return;
    }

    const nextTopOverflow = element.scrollTop > 1;
    const nextBottomOverflow = element.scrollHeight - element.scrollTop - element.clientHeight > 1;
    if (hasSidebarTopOverflow !== nextTopOverflow) hasSidebarTopOverflow = nextTopOverflow;
    if (hasSidebarBottomOverflow !== nextBottomOverflow) {
      hasSidebarBottomOverflow = nextBottomOverflow;
    }
  }

  function observeSidebarOverflow(element: HTMLDivElement) {
    updateSidebarOverflow(element);

    let animationFrame: number | undefined;
    const scheduleOverflowUpdate = () => {
      if (animationFrame !== undefined) return;
      animationFrame = requestAnimationFrame(() => {
        animationFrame = undefined;
        updateSidebarOverflow(element);
      });
    };
    const resizeObserver = new ResizeObserver(scheduleOverflowUpdate);
    resizeObserver.observe(element);

    const observedChildren = new Set<Element>();
    const syncObservedChildren = () => {
      const nextChildren = new Set(Array.from(element.children));
      for (const child of observedChildren) {
        if (!nextChildren.has(child)) {
          resizeObserver.unobserve(child);
          observedChildren.delete(child);
        }
      }
      for (const child of nextChildren) {
        if (!observedChildren.has(child)) {
          resizeObserver.observe(child);
          observedChildren.add(child);
        }
      }
    };
    syncObservedChildren();

    const mutationObserver = new MutationObserver(() => {
      syncObservedChildren();
      scheduleOverflowUpdate();
    });
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });

    return {
      destroy() {
        if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
        mutationObserver.disconnect();
        resizeObserver.disconnect();
      },
    };
  }

  // True while ⌘ is the only modifier held with the window focused;
  // conversation rows then show their ⌘1–9 hint in place of the spinner /
  // time-ago column, and the nav buttons show their shortcut pills. The reveal
  // is delayed so typed chords like ⌘V don't flash the hints, and adding a
  // second modifier (⌘⇧…) hides them until the hold is back to just ⌘.
  let conversationShortcutHintsVisible = $state(false);
  const heldModifierHint = new HeldModifierHint((visible) => {
    conversationShortcutHintsVisible = visible;
  });

  // The conversation rows currently visible in the sidebar, in visual order.
  // Mirrors the render rules: collapsed projects hide their sessions and
  // worktrees, collapsed worktrees hide their sessions, and each group is
  // truncated to SESSION_VISIBLE_LIMIT unless expanded (search expands all).
  let conversationShortcutSessions = $derived.by(() => {
    const ordered: ACPConversationSummary[] = [];
    const appendVisibleSessions = (workspacePath: string) => {
      const sessions = sessionsFor(workspacePath);
      const expanded = searching || isSessionGroupExpanded(workspacePath);
      ordered.push(...withExpandedSubAgents(visibleTopLevelSessions(sessions, expanded)));
    };

    for (const section of sidebarSectionOrder) {
      if (ordered.length >= CONVERSATION_SHORTCUT_LIMIT) break;
      if (section === "chats") {
        if (chatsSectionContentVisible) {
          const chatsExpanded = searching || isSessionGroupExpanded(CHATS_GROUP_KEY);
          ordered.push(
            ...withExpandedSubAgents(visibleTopLevelSessions(chatSessions, chatsExpanded)),
          );
        }
      } else if (projectsSectionContentVisible) {
        for (const project of rootProjects) {
          if (ordered.length >= CONVERSATION_SHORTCUT_LIMIT) break;
          if (!shouldShowProjectContent(project)) continue;
          appendVisibleSessions(project.path);
          for (const worktree of worktreesFor(project.path)) {
            if (searching || worktree.collapsed !== true) appendVisibleSessions(worktree.path);
          }
        }
      }
    }
    return ordered.slice(0, CONVERSATION_SHORTCUT_LIMIT);
  });

  // Expanded parents are followed by their visible nested rows, as rendered.
  function withExpandedSubAgents(sessions: ACPConversationSummary[]): ACPConversationSummary[] {
    return sessions.flatMap((session) => [
      session,
      ...(isSubAgentsExpanded(session) ? visibleSubAgents(session) : []),
    ]);
  }

  // Mirrors ConversationGroup's truncation: parents hiding a running, waiting,
  // unread or open sub-agent stay visible past the limit.
  function visibleTopLevelSessions(
    sessions: ACPConversationSummary[],
    expanded: boolean,
  ): ACPConversationSummary[] {
    if (expanded) return sessions;
    return sliceVisibleSessions(sessions, SESSION_VISIBLE_LIMIT, (session) =>
      hasAttentionDescendant(visibleSubAgents(session), (child) => sidebar.rowState(child)),
    );
  }

  // Whether a conversation's own row is rendered right now, i.e. whether its
  // sub-agents can nest beneath it. Reads only section/collapse state, never
  // the tree, so it cannot cycle.
  function isParentRowRendered(parent: ACPConversationSummary): boolean {
    if (exitingConversationIds.has(parent.id)) return false;
    if (isACPChatConversation(parent)) return chatsSectionContentVisible;
    if (!projectsSectionContentVisible) return false;
    const owner = navProjects.find((candidate) => candidate.path === parent.cwd);
    if (!owner) return false;
    if (!owner.isWorktree) {
      return (
        rootProjects.some((root) => root.path === owner.path) && shouldShowProjectContent(owner)
      );
    }
    if (exitingWorktreePaths.has(owner.path)) return false;
    const root = rootProjects.find((candidate) => candidate.path === owner.parentPath);
    return !!root && shouldShowProjectContent(root) && (searching || owner.collapsed !== true);
  }

  let conversationShortcutIndexByKey = $derived(
    new Map(
      conversationShortcutSessions.map((session, index) => [
        sidebar.reviewSessionKey(session),
        index + 1,
      ]),
    ),
  );

  function sessionShortcutHint(session: ACPConversationSummary): string | undefined {
    // While the ⌘K search is open it owns the ⌘1–9 numbering, so the sidebar
    // list (dimmed behind the overlay) hides its own hints to avoid two
    // competing sets of numbers.
    if (!conversationShortcutHintsVisible || conversationSearchOpen) return undefined;
    const index = conversationShortcutIndexByKey.get(sidebar.reviewSessionKey(session));
    return index === undefined ? undefined : conversationShortcutLabel(index);
  }

  function handleWindowKeyDown(event: KeyboardEvent) {
    heldModifierHint.handleKeyDown(event);

    // The ⌘K search handles its own ⌘1–9 selection while it is open.
    if (
      !conversationSearchOpen &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      const shortcutIndex = conversationShortcutIndexFromKeyboardEvent(event);
      const session =
        shortcutIndex === undefined ? undefined : conversationShortcutSessions[shortcutIndex - 1];
      if (session) {
        event.preventDefault();
        event.stopPropagation();
        void sidebar.openSession(session);
        return;
      }
    }

    // Command-based application shortcuts still belong to the app while the
    // terminal is focused. Preserve Ctrl+P/Ctrl+T for shell line editing.
    if (
      isNewTabSearchShortcut(event) &&
      (!isTerminalKeyboardTarget(event.target) || event.metaKey)
    ) {
      event.preventDefault();
      openConversationSearch("+");
      return;
    }
  }

  function handleWindowKeyUp(event: KeyboardEvent) {
    heldModifierHint.handleKeyUp(event);
  }

  function hideConversationShortcutHints() {
    heldModifierHint.reset();
  }

  function handleWindowPointerEvent(event: PointerEvent) {
    heldModifierHint.handlePointerEvent(event);
  }

  function handleDocumentVisibilityChange() {
    if (document.hidden) hideConversationShortcutHints();
  }

  function isNewTabSearchShortcut(event: KeyboardEvent): boolean {
    const key = event.key.toLowerCase();
    return (
      (key === "p" || key === "t") &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    );
  }

  function isTerminalKeyboardTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      Boolean(target.closest(".xterm, .xterm-helper-textarea, .xterm-screen"))
    );
  }

  const settingsSections = DESKTOP_SETTINGS_NAV_SECTIONS;
  // "connectors" is intentionally excluded: it renders as its own destination in
  // the main content pane, so the sidebar stays on the conversation list rather
  // than switching into the settings nav.
  const settingsViewActive = $derived(
    currentView === "settings" ||
      currentView === "shortcuts" ||
      currentView === "models" ||
      currentView === "voice" ||
      currentView === "github" ||
      currentView === "agents" ||
      currentView === "archived" ||
      currentView === "remote" ||
      currentView === "project-settings",
  );
  let sidebarView: DesktopSidebarView = $derived(settingsViewActive ? "settings" : "main");

  // Poll the helper for connected remote-access devices so the sidebar can
  // surface active phone connections. The status call is cheap; any failure
  // (e.g. remote access unavailable) just keeps the indicator hidden.
  let connectedRemoteDevices = $state(0);
  $effect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await camberRemoteAccessStatus();
        if (!cancelled) {
          connectedRemoteDevices = (status.devices ?? []).filter((d) => d.connected).length;
        }
      } catch {
        if (!cancelled) connectedRemoteDevices = 0;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  });

  function sidebarToggleTitle(): string {
    const label = collapsed ? "Show sidebar" : "Hide sidebar";
    const hint = shortcutHint("toggleLeftPanel");
    return hint ? `${label} ${hint}` : label;
  }

  function applyProjectState(state: ACPProjectsState) {
    const livePaths = new Set(state.projects.map((project) => project.path));
    const nextExitingWorktreePaths = new Set(
      [...exitingWorktreePaths].filter((path) => livePaths.has(path)),
    );
    if (nextExitingWorktreePaths.size !== exitingWorktreePaths.size) {
      exitingWorktreePaths = nextExitingWorktreePaths;
    }

    // A worktree drag derives its (frozen) list from `navProjects` via
    // worktreesFor(); rebuilding navProjects mid-drag would shift rows under the
    // pointer while createReorderable holds the drag's start index, persisting
    // the wrong order. Freeze the whole snapshot until the drag ends — the
    // optimistic reorder + server notification reconcile afterwards.
    if (worktreeDragActive) return;
    navProjects = [...state.projects];
    // While a project drag is in progress, `rootProjects` reflects the live
    // (optimistic) order. Rebuilding it from a background state event mid-drag
    // would reset that order; handleReorderProjects reconciles on drop.
    if (projectReorderMotion.active) return;
    rootProjects = rootProjectsFromNav();
  }

  function rootProjectsFromNav(): ACPNavProject[] {
    return navProjects.filter((project) => !project.isWorktree);
  }

  function applyConversationState(state: ACPConversationsState) {
    navSessions = dedupeConversationSummaries(state.sessions);
  }

  onMount(() => {
    const handleProjectState = (event: Event) => {
      applyProjectState((event as CustomEvent<ACPProjectsState>).detail);
    };
    const handleConversationState = (event: Event) => {
      applyConversationState((event as CustomEvent<ACPConversationsState>).detail);
    };
    const handleOpenConversationSearch = (event: Event) => {
      const detail = (event as CustomEvent<DesktopOpenConversationSearchEventDetail>).detail;
      openConversationSearch(detail?.initialQuery ?? "");
    };
    projects.emitter.addEventListener(ACP_DESKTOP_PROJECTS_EVENT, handleProjectState);
    conversations.emitter.addEventListener(
      ACP_DESKTOP_CONVERSATIONS_EVENT,
      handleConversationState,
    );
    window.addEventListener(DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT, handleOpenConversationSearch);
    applyProjectState({ projects: projects.projects ?? [] });
    applyConversationState({ sessions: conversations.sessions ?? [] });
    if (navProjects.length === 0) {
      void projects.refresh();
      void conversations.refresh();
    }
    github.start(() => (githubPathsKey ? githubPathsKey.split("\n") : []));
    return () => {
      github.stop();
      projects.emitter.removeEventListener(ACP_DESKTOP_PROJECTS_EVENT, handleProjectState);
      conversations.emitter.removeEventListener(
        ACP_DESKTOP_CONVERSATIONS_EVENT,
        handleConversationState,
      );
      window.removeEventListener(
        DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT,
        handleOpenConversationSearch,
      );
    };
  });

  onDestroy(() => {
    sidebar.destroy();
    heldModifierHint.destroy();
    conversationArchiveCountdown.destroy();
    worktreeRemovalCountdown.destroy();
    for (const conversationId of exitingConversationIds) {
      sidebarToasts.dismiss(conversationArchiveToastId(conversationId));
    }
    for (const path of exitingWorktreePaths) {
      sidebarToasts.dismiss(worktreeDeleteToastId(path));
    }
  });

  function getSessionAgentServer(session: { agentServer?: string }): string {
    return sidebar.getSessionAgentServer(session);
  }

  function getAgentName(agentServer: string): string {
    return sidebar.getAgentName(agentServer);
  }

  function activeSessionWorkspaceCwd(session: ACPSession | null): string | null {
    return session?.sessionInfo?.cwd ?? session?.pendingCwd ?? session?.cwd ?? null;
  }

  function isCurrentWorkspace(path: string): boolean {
    return workspacePathFitsWorkspaceFolders(path, currentWorkspaceFolders);
  }

  function isProjectCollapsed(project: ACPNavProject): boolean {
    return project.collapsed;
  }

  function worktreesFor(projectPath: string) {
    return navProjects
      .filter(
        (project) => project.parentPath === projectPath && !exitingWorktreePaths.has(project.path),
      )
      .sort(compareWorktreesByDisplayOrder);
  }

  function projectDisplayName(project: ACPNavProject): string {
    return project.nickname || project.name;
  }

  function camberqaWorktreeProject(worktreeName: string): ACPNavProject | null {
    let match: ACPNavProject | null = null;
    for (const project of navProjects) {
      if (!project.isWorktree || project.name !== worktreeName) continue;
      if (!match || project.path.length > match.path.length) {
        match = project;
      }
    }
    return match;
  }

  function shouldShowProjectContent(project: ACPNavProject): boolean {
    return searchQuery.trim() !== "" || !isProjectCollapsed(project);
  }

  function sessionsFor(workspacePath: string) {
    return navSessions.filter((session) => {
      if (exitingConversationIds.has(session.id)) return false;
      if (conversationTree.isNested(session.id)) return false;
      if (session.cwd !== workspacePath) return false;
      return sessionMatchesSearch(session);
    });
  }

  function sessionMatchesSearch(session: ACPConversationSummary): boolean {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return (
      (session.title || "Untitled Conversation").toLowerCase().includes(query) ||
      getAgentName(getSessionAgentServer(session)).toLowerCase().includes(query)
    );
  }

  function hasSearchResults(): boolean {
    return (
      chatSessions.length > 0 ||
      rootProjects.some((project) => {
        if (sessionsFor(project.path).length > 0) return true;
        return worktreesFor(project.path).some((worktree) => sessionsFor(worktree.path).length > 0);
      })
    );
  }

  async function handleNewSession(cwd?: string, event?: Event): Promise<string | null> {
    projectsSectionCollapsed = false;
    return await sidebar.newConversation(cwd, event);
  }

  function shouldInterruptSelectedSession(sessionId: string | null, agentServer: string): boolean {
    return sidebar.shouldInterruptSelectedSession(sessionId, agentServer);
  }

  function nextSessionInGroup(
    workspacePath: string,
    conversationId: string,
  ): ACPConversationSummary | undefined {
    const currentSession = navSessions.find((session) => session.id === conversationId);
    const candidateSessions =
      currentSession && isACPChatConversation(currentSession)
        ? navSessions.filter(
            (session) =>
              (session.id === conversationId ||
                (!exitingConversationIds.has(session.id) &&
                  !conversationTree.isNested(session.id))) &&
              isACPChatConversation(session) &&
              sessionMatchesSearch(session),
          )
        : navSessions.filter(
            (session) =>
              (session.id === conversationId ||
                (!exitingConversationIds.has(session.id) &&
                  !conversationTree.isNested(session.id))) &&
              session.cwd === workspacePath &&
              sessionMatchesSearch(session),
          );
    const archivedIndex = candidateSessions.findIndex((session) => session.id === conversationId);
    const remainingSessions = candidateSessions.filter((session) => session.id !== conversationId);
    return remainingSessions[archivedIndex] ?? remainingSessions[archivedIndex - 1];
  }

  async function handleRemoveProject(path: string) {
    await projects.removeProject(path);
    await worktrees.closeProject(path);
    await conversations.refresh();
  }

  async function handleRenameProject(path: string, name: string) {
    await projects.renameProject(path, name);
  }

  function handleProjectSettings(path: string) {
    onShowProjectSettings(path);
  }

  function conversationArchiveToastId(conversationId: string): string {
    return `conversation-archive:${conversationId}`;
  }

  function worktreeDeleteToastId(path: string): string {
    return `worktree-delete:${path}`;
  }

  function isSessionExiting(session: ACPConversationSummary): boolean {
    return exitingConversationIds.has(session.id);
  }

  function setConversationExiting(conversationId: string, exiting: boolean) {
    if (exitingConversationIds.has(conversationId) === exiting) return;
    const next = new Set(exitingConversationIds);
    if (exiting) next.add(conversationId);
    else next.delete(conversationId);
    exitingConversationIds = next;
    if (exiting) rowExitAnimation.hold();
  }

  function setWorktreeExiting(path: string, exiting: boolean) {
    if (exitingWorktreePaths.has(path) === exiting) return;
    const next = new Set(exitingWorktreePaths);
    if (exiting) next.add(path);
    else next.delete(path);
    exitingWorktreePaths = next;
    if (exiting) rowExitAnimation.hold();
  }

  function isConversationSelected(session: ACPConversationSummary): boolean {
    const agentServer = getSessionAgentServer(session);
    return (
      activeConversationId === session.id ||
      sidebar.isSelectedSession(session.sessionId, session.id, agentServer) ||
      shouldInterruptSelectedSession(session.sessionId, agentServer)
    );
  }

  function selectedSessionInWorkspace(path: string): ACPConversationSummary | undefined {
    return navSessions.find((session) => session.cwd === path && isConversationSelected(session));
  }

  async function restoreSelectionIfUnchanged(rollback: SelectionRollback | undefined) {
    if (!rollback) return;
    // Let the replacement draft propagate back through the parent before
    // deciding whether the user has navigated somewhere else in the meantime.
    await tick();
    if (activeConversationId !== rollback.replacementConversationId) return;
    onActiveConversationIdChange?.(rollback.conversationId);
  }

  async function performRemoveWorktree(
    path: string,
    sessionToCancel: ACPSession | null = null,
    selectionRollback?: SelectionRollback,
  ) {
    worktreeRemovalCountdown.cancel(path);
    setWorktreeExiting(path, true);
    sidebarToasts.updateProgressToast(worktreeDeleteToastId(path), "Running teardown script", {
      kind: "indeterminate",
    });
    const busy = projects.getWorktreeBusy(path);
    if (busy === "creating" || busy === "running_setup") {
      projects.requestDelete(path);
      abortControllers.get(path)?.abort();
      // handleAddWorktree owns the in-flight operation and reveals the row
      // again if its cleanup fails.
      return;
    }
    const worktreeSessions = navSessions.filter((session) => session.cwd === path);
    const activeWorktreeSession = selectedSessionInWorkspace(path);
    try {
      if (sessionToCancel) {
        await sessionToCancel.cancel();
      }
      if (
        activeWorktreeSession &&
        activeSession !== sessionToCancel &&
        shouldInterruptSelectedSession(
          activeWorktreeSession.sessionId,
          getSessionAgentServer(activeWorktreeSession),
        )
      ) {
        await sidebar.cancelActiveSession();
      }
      await worktrees.removeWorktree(path);
    } catch (error) {
      console.error("Failed to delete worktree", error);
      setWorktreeExiting(path, false);
      sidebarToasts.showProgressError(worktreeDeleteToastId(path), "Error running teardown script");
      worktreeSelectionRollbacks.delete(path);
      await restoreSelectionIfUnchanged(selectionRollback);
      return;
    }

    worktreeSelectionRollbacks.delete(path);
    sidebarToasts.dismiss(worktreeDeleteToastId(path));
    // Teardown can outlive a sidebar navigation; only clear if this worktree is still active.
    const activeConversationStillBelongsToWorktree = worktreeSessions.some((session) =>
      isConversationSelected(session),
    );
    if (activeConversationStillBelongsToWorktree) {
      onActiveConversationIdChange?.(null);
    }
    try {
      await projects.refresh();
      await conversations.refresh();
    } catch (error) {
      // The worktree is already gone, so keep its optimistic row hidden and
      // let the next project notification reconcile the stale sidebar data.
      console.error("Failed to refresh after deleting worktree", error);
    }
  }

  function handleRemoveWorktree(path: string) {
    const activeWorktreeSession = selectedSessionInWorkspace(path);
    const sessionToCancel =
      activeWorktreeSession &&
      shouldInterruptSelectedSession(
        activeWorktreeSession.sessionId,
        getSessionAgentServer(activeWorktreeSession),
      )
        ? activeSession
        : null;
    setWorktreeExiting(path, true);
    if (activeWorktreeSession) {
      // Deselecting uses the stable root-project default, so the replacement
      // draft cannot be created inside the worktree that is pending deletion.
      const replacementConversationId = onActiveConversationIdChange?.(null);
      if (replacementConversationId !== undefined) {
        worktreeSelectionRollbacks.set(path, {
          conversationId: activeWorktreeSession.id,
          replacementConversationId,
        });
      }
    }
    sidebarToasts.addProgressToast(
      worktreeDeleteToastId(path),
      "Deleting worktree...",
      { kind: "countdown", durationMs: UNDO_COUNTDOWN_SECONDS * 1000 },
      { label: "Cancel", onClick: () => undoRemoveWorktree(path) },
    );
    const selectionRollback = worktreeSelectionRollbacks.get(path);
    worktreeRemovalCountdown.start(
      path,
      () => void performRemoveWorktree(path, sessionToCancel, selectionRollback),
    );
  }

  function undoRemoveWorktree(path: string) {
    worktreeRemovalCountdown.cancel(path);
    sidebarToasts.dismiss(worktreeDeleteToastId(path));
    setWorktreeExiting(path, false);
    const selectionRollback = worktreeSelectionRollbacks.get(path);
    worktreeSelectionRollbacks.delete(path);
    void restoreSelectionIfUnchanged(selectionRollback);
  }

  async function handleAddWorktree(project: { path: string }) {
    let pendingPath = "";
    let controller: AbortController | undefined;
    let firstConversationId: string | null = null;
    let firstConversationPath: string | null = null;
    let deleteCleanupFailed = false;
    try {
      await expandCollapsedWorkspace(project.path);
      const prepared = await worktrees.prepareWorktree(project.path);
      if (!prepared) return;
      pendingPath = projects.addPendingWorktree(prepared, "creating");
      controller = new AbortController();
      abortControllers.set(pendingPath, controller);
      if (!isLoading) {
        firstConversationId = await handleNewSession(prepared.path);
        const firstConversation = firstConversationId
          ? conversations.sessions.find((session) => session.id === firstConversationId)
          : null;
        if (firstConversationId) {
          firstConversationPath = firstConversation?.cwd ?? prepared.path;
        }
      }
      if (controller.signal.aborted) {
        await worktrees.discardPreparedWorktree(pendingPath);
        await projects.refresh();
        await conversations.refresh();
        return;
      }
      const created = await worktrees.createWorktree(
        project.path,
        prepared,
        (kind) => projects.setWorktreeBusy(prepared.path, kind),
        controller.signal,
        { terminalLayoutKey: firstConversationId },
      );
      await projects.refresh();
      await conversations.refresh();
      const createdPath = created?.path;
      if (createdPath && (controller.signal.aborted || projects.isDeleteRequested(pendingPath))) {
        await worktrees.removeWorktree(createdPath, (kind) =>
          projects.setWorktreeBusy(pendingPath, kind),
        );
        await projects.refresh();
        await conversations.refresh();
        return;
      }
      if (
        createdPath &&
        shouldCreateConversationAfterWorktreeCreation({
          createdPath,
          firstConversationPath,
          isLoading,
        })
      ) {
        await onNewConversation(createdPath);
      }
    } catch (error) {
      console.error("Failed to create ACP worktree", error);
      const deletionRequested = Boolean(pendingPath && projects.isDeleteRequested(pendingPath));
      if (pendingPath) {
        try {
          await worktrees.discardPreparedWorktree(pendingPath);
        } catch (discardError) {
          console.error("Failed to discard prepared worktree", discardError);
        }
        await projects.refresh();
        await conversations.refresh();
      }
      if (deletionRequested) {
        deleteCleanupFailed = true;
        sidebarToasts.showProgressError(
          worktreeDeleteToastId(pendingPath),
          "Error running teardown script",
        );
      } else {
        rpc.showInfoMessage(
          formatError(error, {
            prefix: "Failed to create worktree",
          }),
          InfoMessageType.error,
        );
      }
    } finally {
      if (pendingPath) {
        const deletionRequested = projects.isDeleteRequested(pendingPath);
        abortControllers.delete(pendingPath);
        projects.clearWorktreeBusy(pendingPath);
        setWorktreeExiting(pendingPath, false);
        if (deletionRequested && !deleteCleanupFailed) {
          sidebarToasts.dismiss(worktreeDeleteToastId(pendingPath));
        }
        if (deletionRequested) {
          const selectionRollback = worktreeSelectionRollbacks.get(pendingPath);
          worktreeSelectionRollbacks.delete(pendingPath);
          if (deleteCleanupFailed) {
            await restoreSelectionIfUnchanged(selectionRollback);
          }
        }
      }
    }
  }

  async function handleAddProject() {
    if (addingProject) return;
    projectsSectionCollapsed = false;
    addingProject = true;
    try {
      const project = await rpc.selectProjectFolder();
      if (!project?.path) return;
      await projects.upsertProject({
        path: project.path,
        name: project.name || project.path,
      });
      await conversations.refresh();
      // Land in a ready-to-type conversation for the new project instead of
      // leaving the user to click "New conversation" themselves.
      await handleNewSession(project.path);
    } finally {
      addingProject = false;
    }
  }

  function toggleSessionsExpanded(workspacePath: string) {
    const updated = new Set(expandedSessionGroups);
    if (updated.has(workspacePath)) updated.delete(workspacePath);
    else updated.add(workspacePath);
    expandedSessionGroups = updated;
  }

  function isSessionGroupExpanded(workspacePath: string): boolean {
    return expandedSessionGroups.has(workspacePath);
  }

  function descendantsFor(session: ACPConversationSummary): readonly ACPConversationSummary[] {
    return conversationTree.descendantsOf(session.id);
  }

  function visibleSubAgents(session: ACPConversationSummary): ACPConversationSummary[] {
    return conversationTree
      .descendantsOf(session.id)
      .filter((child) => !exitingConversationIds.has(child.id));
  }

  // The open conversation, when it is a nested sub-agent: its top ancestor is
  // shown expanded for this session (never persisted) so the selected row is
  // visible. An explicit collapse sticks until the selection changes.
  let activeNestedParentId = $derived.by(() => {
    if (!activeConversationId || !conversationTree.isNested(activeConversationId)) return null;
    const parentId = conversationTree.topAncestorOf(activeConversationId)?.id ?? null;
    if (
      parentId &&
      sessionCollapsedParent?.conversationId === activeConversationId &&
      sessionCollapsedParent.parentId === parentId
    ) {
      return null;
    }
    return parentId;
  });
  let sessionCollapsedParent = $state<{ conversationId: string; parentId: string } | null>(null);

  function isSubAgentsExpanded(session: ACPConversationSummary): boolean {
    return expandedSubAgentParents.has(session.id) || activeNestedParentId === session.id;
  }

  function toggleSubAgents(session: ACPConversationSummary) {
    const wasExpanded = isSubAgentsExpanded(session);
    if (wasExpanded && activeNestedParentId === session.id && activeConversationId) {
      sessionCollapsedParent = { conversationId: activeConversationId, parentId: session.id };
    } else if (!wasExpanded) {
      sessionCollapsedParent = null;
    }
    const updated = new Set(expandedSubAgentParents);
    if (wasExpanded) updated.delete(session.id);
    else updated.add(session.id);
    // Forget parents that no longer exist so the stored list cannot grow forever.
    const known = new Set(navSessions.map((candidate) => candidate.id));
    for (const id of updated) if (!known.has(id)) updated.delete(id);
    expandedSubAgentParents = updated;
    try {
      globalThis.localStorage?.setItem(
        DESKTOP_SUB_AGENTS_EXPANDED_STORAGE_KEY,
        JSON.stringify([...updated]),
      );
    } catch {
      // Persistence is best-effort.
    }
  }

  // A sub-agent living in a different worktree/project than its parent says where.
  function subAgentBadge(
    child: ACPConversationSummary,
    parent: ACPConversationSummary,
  ): string | undefined {
    if (child.cwd === parent.cwd) return undefined;
    const project = navProjects.find((candidate) => candidate.path === child.cwd);
    return project ? projectDisplayName(project) : undefined;
  }

  function toggleChatsSectionCollapsed() {
    chatsSectionCollapsed = !chatsSectionCollapsed;
  }

  function toggleProjectsSectionCollapsed() {
    projectsSectionCollapsed = !projectsSectionCollapsed;
  }

  async function handleReorderSidebarSections(from: number, to: number) {
    if (!(await sidebarSectionReorderMotion.settleDrop())) return;
    sidebarSectionOrder = moveItem(sidebarSectionOrder, from, to);
    try {
      globalThis.localStorage?.setItem(
        DESKTOP_SIDEBAR_SECTION_ORDER_STORAGE_KEY,
        JSON.stringify(sidebarSectionOrder),
      );
    } catch {
      // Persistence is best-effort; the reordered sections still remain in place for this window.
    }
  }

  function sidebarSectionLabel(section: DesktopSidebarSection): string {
    return section === "chats" ? "Chats" : "Projects";
  }

  async function toggleProjectCollapsed(project: ACPNavProject) {
    await projects.setProjectCollapsed(project.path, !project.collapsed);
  }

  // Creating a conversation or worktree inside a collapsed project/worktree
  // would otherwise leave the new row invisible; expand the target node first.
  // Best-effort: expansion is cosmetic, so a failed collapse update must not
  // block the creation itself.
  async function expandCollapsedWorkspace(path?: string) {
    if (!path) return;
    projectsSectionCollapsed = false;
    const node = navProjects.find((project) => project.path === path);
    if (!node?.collapsed) return;
    try {
      await projects.setProjectCollapsed(path, false);
    } catch (error) {
      console.error("Failed to expand workspace before creation", error);
    }
  }

  async function handleReorderProjects(from: number, to: number) {
    // `previous` is the pre-drop order; it doubles as the revert target and as
    // the source for reconciling any background changes that arrived mid-drag.
    const previous = rootProjectsFromNav();
    const next = moveItem(rootProjects, from, to);
    rootProjects = next;
    try {
      await projects.reorderProjects(next.map((project) => project.path));
    } catch (error) {
      rootProjects = previous;
      rpc.showInfoMessage(
        formatError(error, {
          prefix: "Failed to reorder projects",
        }),
        InfoMessageType.error,
      );
    }
  }

  async function handleReorderWorktrees(parentPath: string, from: number, to: number) {
    const next = moveItem(worktreesFor(parentPath), from, to);
    const previous = navProjects;
    // Optimistically apply the new order by stamping display_order; worktreesFor
    // re-sorts by it. The server notification reconciles the canonical state.
    const orderByPath = new Map(next.map((worktree, index) => [worktree.path, index]));
    navProjects = navProjects.map((project) =>
      orderByPath.has(project.path)
        ? { ...project, displayOrder: orderByPath.get(project.path) ?? project.displayOrder }
        : project,
    );
    try {
      await projects.reorderWorktrees(
        parentPath,
        next.map((worktree) => worktree.path),
      );
    } catch (error) {
      navProjects = previous;
      rpc.showInfoMessage(
        formatError(error, {
          prefix: "Failed to reorder worktrees",
        }),
        InfoMessageType.error,
      );
    }
  }

  async function handleOpenWorkspace(path: string) {
    await rpc.openWorkspace(path);
  }

  async function handleOpenGithubPullRequest(path: string) {
    const links = await github.links(path);
    if (links.prUrl) rpc.openExternalURL(links.prUrl);
  }

  async function handleOpenGithubRepository(path: string) {
    const links = await github.links(path);
    if (links.repoUrl) rpc.openExternalURL(links.repoUrl);
  }

  async function handleAddFolderToWorkspace(path: string) {
    await rpc.addFolderToWorkspace(path);
  }

  async function performArchiveSession(
    workspacePath: string,
    sessionId: string | null,
    agentServer: string,
    conversationId: string,
    sessionToCancel: ACPSession | null = null,
    selectionRollback?: SelectionRollback,
  ): Promise<boolean> {
    conversationArchiveCountdown.cancel(conversationId);
    sidebarToasts.dismiss(conversationArchiveToastId(conversationId));
    setConversationExiting(conversationId, true);
    try {
      if (sessionToCancel) {
        await sessionToCancel.cancel();
      }
      await conversations.archiveSession(workspacePath, sessionId, agentServer, conversationId);
      return true;
    } catch (error) {
      rpc.showInfoMessage(
        formatError(error, {
          prefix: "Failed to archive conversation",
        }),
        InfoMessageType.error,
      );
      await restoreSelectionIfUnchanged(selectionRollback);
      return false;
    } finally {
      conversationSelectionRollbacks.delete(conversationId);
      setConversationExiting(conversationId, false);
    }
  }

  function switchToFreshDraftIfSelected(
    session: ACPConversationSummary,
  ): SelectionRollback | undefined {
    if (!isConversationSelected(session)) return;
    const replacementConversationId = onActiveConversationIdChange?.(null);
    if (replacementConversationId === undefined) return;
    return { conversationId: session.id, replacementConversationId };
  }

  // Sub-agents archived together with their parent, kept until the archive
  // fires (or is undone) so undo can reveal them again.
  const cascadedArchives = new Map<string, ACPConversationSummary[]>();

  function beginCascade(session: ACPConversationSummary): ACPConversationSummary[] {
    const descendants = visibleSubAgents(session);
    if (descendants.length === 0) return descendants;
    cascadedArchives.set(session.id, descendants);
    for (const child of descendants) setConversationExiting(child.id, true);
    return descendants;
  }

  async function archiveCascadedDescendants(descendants: ACPConversationSummary[]) {
    await Promise.all(
      descendants.map((child) => {
        const agentServer = getSessionAgentServer(child);
        const sessionToCancel = shouldInterruptSelectedSession(child.sessionId, agentServer)
          ? activeSession
          : null;
        return performArchiveSession(
          child.cwd,
          child.sessionId,
          agentServer,
          child.id,
          sessionToCancel,
          switchToFreshDraftIfSelected(child),
        );
      }),
    );
  }

  // Archives the parent first; its sub-agents follow only once that succeeded.
  // On failure the parent is restored by performArchiveSession and the
  // sub-agents are revealed again, so nothing is archived without an undo.
  async function archiveWithDescendants(
    session: ACPConversationSummary,
    agentServer: string,
    sessionToCancel: ACPSession | null,
    selectionRollback: SelectionRollback | undefined,
    cascaded: ACPConversationSummary[],
  ) {
    const archived = await performArchiveSession(
      session.cwd,
      session.sessionId,
      agentServer,
      session.id,
      sessionToCancel,
      selectionRollback,
    );
    if (archived) {
      await archiveCascadedDescendants(cascaded);
    } else {
      for (const child of cascaded) setConversationExiting(child.id, false);
    }
  }

  function handleArchiveSession(session: ACPConversationSummary, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const agentServer = getSessionAgentServer(session);
    const sessionToCancel = shouldInterruptSelectedSession(session.sessionId, agentServer)
      ? activeSession
      : null;
    // Before the parent starts exiting: an exiting parent no longer hosts nested rows.
    const cascaded = beginCascade(session);
    setConversationExiting(session.id, true);
    const selectionRollback = switchToFreshDraftIfSelected(session);
    if (selectionRollback) {
      conversationSelectionRollbacks.set(session.id, selectionRollback);
    }
    sidebarToasts.addProgressToast(
      conversationArchiveToastId(session.id),
      cascaded.length > 0
        ? `Archiving conversation and ${cascaded.length} sub-agent${cascaded.length === 1 ? "" : "s"}...`
        : "Archiving conversation...",
      { kind: "countdown", durationMs: UNDO_COUNTDOWN_SECONDS * 1000 },
      { label: "Cancel", onClick: () => undoArchiveSession(session.id) },
    );
    conversationArchiveCountdown.start(session.id, () => {
      cascadedArchives.delete(session.id);
      void archiveWithDescendants(
        session,
        agentServer,
        sessionToCancel,
        selectionRollback,
        cascaded,
      );
    });
  }

  function handleArchiveSessionNow(session: ACPConversationSummary, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const agentServer = getSessionAgentServer(session);
    const sessionToCancel = shouldInterruptSelectedSession(session.sessionId, agentServer)
      ? activeSession
      : null;
    const cascaded = beginCascade(session);
    cascadedArchives.delete(session.id);
    const selectionRollback = switchToFreshDraftIfSelected(session);
    void archiveWithDescendants(session, agentServer, sessionToCancel, selectionRollback, cascaded);
  }

  function undoArchiveSession(conversationId: string) {
    conversationArchiveCountdown.cancel(conversationId);
    sidebarToasts.dismiss(conversationArchiveToastId(conversationId));
    setConversationExiting(conversationId, false);
    for (const child of cascadedArchives.get(conversationId) ?? []) {
      setConversationExiting(child.id, false);
    }
    cascadedArchives.delete(conversationId);
    const selectionRollback = conversationSelectionRollbacks.get(conversationId);
    conversationSelectionRollbacks.delete(conversationId);
    void restoreSelectionIfUnchanged(selectionRollback);
  }

  async function handleDeleteSession(session: ACPConversationSummary, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    const agentServer = getSessionAgentServer(session);
    const selectedByKey = activeConversationId === session.id;
    const shouldInterrupt = shouldInterruptSelectedSession(session.sessionId, agentServer);
    const shouldSelectReplacement =
      Boolean(selectedByKey) ||
      sidebar.isSelectedSession(session.sessionId, session.id, agentServer) ||
      shouldInterrupt;
    const replacementSession = shouldSelectReplacement
      ? nextSessionInGroup(session.cwd, session.id)
      : undefined;
    // Marked exiting so the row plays the same slide-out as an archive; the
    // finally re-reveals it if the delete failed.
    setConversationExiting(session.id, true);
    try {
      if (shouldInterrupt) {
        await sidebar.cancelActiveSession();
      }
      await conversations.deleteConversation(session.id, session.sessionId, agentServer);
      if (!shouldSelectReplacement) return;

      if (replacementSession) {
        await sidebar.openSession(replacementSession, replacementSession.cwd);
        return;
      }
      onActiveConversationIdChange?.(null);
    } finally {
      setConversationExiting(session.id, false);
    }
  }

  /**
   * Converts sidebar menu items into system-menu items and a
   * callback map keyed by id.  Disabled items produce `enabled: false`.
   */
  function actionsToSystemMenu(actions: ContextMenuItem[]): {
    items: DesktopSystemContextMenuItem[];
    callbacks: Map<string, () => void | Promise<void>>;
  } {
    const callbacks = new Map<string, () => void | Promise<void>>();
    const items = actions.map((action, i): DesktopSystemContextMenuItem => {
      if (action.kind === "separator") return { kind: "separator" };
      const id = String(i);
      callbacks.set(id, action.callback);
      return {
        kind: "action",
        id,
        label: action.name,
        enabled: !action.disabled,
        accelerator: action.accelerator,
      };
    });
    return { items, callbacks };
  }

  function nativeMenuAccelerator(commandId: CommandId): string | undefined {
    // Prefer the user-override-aware chord from the service; fall back to the
    // registry default so the menu is still wired before the service initialises.
    const chord = activeBinding(commandId) ?? defaultChord(commandId, "desktop");
    return chord ? chordToNativeAccelerator(chord) : undefined;
  }

  function openContextMenu(event: MouseEvent, actions: ContextMenuItem[]) {
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    const position = { x: event.clientX, y: event.clientY };
    const { items, callbacks } = actionsToSystemMenu(actions);
    void showDesktopSystemContextMenu(items, position).then((id) => {
      if (id === undefined) return;
      callbacks.get(id)?.();
    });
  }

  function projectMenuActions(project: ACPNavProject): ContextMenuItem[] {
    const openActions: ContextMenuAction[] = [];
    if (canOpenWorkspace) {
      openActions.push({
        name: "Open Project",
        icon: "export",
        accelerator: nativeMenuAccelerator("openInIde"),
        callback: () => handleOpenWorkspace(project.path),
      });
    }

    if (canAddFolderToWorkspace) {
      openActions.push({
        name: "Add Project to Workspace",
        icon: "files",
        callback: () => handleAddFolderToWorkspace(project.path),
      });
    }

    if (github.supportedFor(project.path)) {
      openActions.push({
        name: "Open GitHub Repository",
        icon: "github",
        callback: () => handleOpenGithubRepository(project.path),
      });
    }

    return [
      {
        name: "New Conversation",
        icon: "new",
        accelerator: nativeMenuAccelerator("newConversation"),
        disabled: sidebar.isLoading,
        callback: async () => {
          await handleNewSession(project.path);
        },
      },
      {
        name: "New Worktree",
        icon: "git-branch",
        accelerator: nativeMenuAccelerator("newWorktree"),
        disabled: github.isRepoFor(project.path) === false,
        callback: () => handleAddWorktree(project),
      },
      { kind: "separator" },
      ...openActions,
      ...(openActions.length > 0 ? ([{ kind: "separator" }] satisfies ContextMenuItem[]) : []),
      {
        name: "Copy Project Path",
        icon: "copy",
        callback: () => rpc.writeToClipboard(project.path),
      },
      {
        name: "Copy Project Name",
        icon: "copy",
        callback: () => rpc.writeToClipboard(projectDisplayName(project)),
      },
      { kind: "separator" },
      {
        name: sidebarInlineRenameLabel("Project"),
        icon: "pencil",
        callback: () => {
          sidebar.beginRename({ kind: "project", path: project.path }, (name) =>
            handleRenameProject(project.path, name),
          );
        },
      },
      {
        name: sidebarOpensViewLabel("Project Settings"),
        icon: "gear",
        callback: () => handleProjectSettings(project.path),
      },
      { kind: "separator" },
      {
        name: sidebarOpensViewLabel("Delete Project"),
        icon: "trash",
        callback: () => {
          removeProjectTarget = { path: project.path, name: projectDisplayName(project) };
        },
      },
    ];
  }

  function openProjectContextMenu(project: ACPNavProject, event: MouseEvent) {
    openContextMenu(event, projectMenuActions(project));
  }

  function openWorktreeContextMenu(worktree: ACPNavProject, event: MouseEvent) {
    const blocked =
      worktree.deleteRequested === true ||
      (worktree.busy !== undefined && worktreeBlocksUI(worktree.busy));
    const canDelete =
      worktree.deleteRequested !== true &&
      (worktree.busy === undefined ||
        worktree.busy === "creating" ||
        worktree.busy === "running_setup");
    const actions: ContextMenuItem[] = [
      {
        name: "New Conversation",
        icon: "new",
        accelerator: nativeMenuAccelerator("newConversation"),
        disabled: sidebar.isLoading || blocked,
        callback: async () => {
          await handleNewSession(worktree.path);
        },
      },
    ];

    if (github.supportedFor(worktree.path)) {
      actions.push({
        name: githubPRActionLabel(github.statusFor(worktree.path)),
        icon: "git-branch",
        disabled: blocked,
        callback: () => handleOpenGithubPullRequest(worktree.path),
      });
    }

    actions.push(
      { kind: "separator" },
      {
        name: "Copy Worktree Path",
        icon: "copy",
        callback: () => rpc.writeToClipboard(worktree.path),
      },
      {
        name: "Copy Branch Name",
        icon: "copy",
        disabled: blocked,
        callback: async () => {
          let branch = github.branchFor(worktree.path);
          if (!branch) {
            await github.refresh(undefined, { force: true });
            branch = github.branchFor(worktree.path);
          }
          if (branch) rpc.writeToClipboard(branch);
        },
      },
      { kind: "separator" },
      {
        name: sidebarInlineRenameLabel("Worktree"),
        icon: "pencil",
        callback: () => {
          sidebar.beginRename({ kind: "worktree", path: worktree.path }, (name) =>
            handleRenameProject(worktree.path, name),
          );
        },
      },
      { kind: "separator" },
      {
        name: sidebarOpensViewLabel("Delete Worktree"),
        icon: "trash",
        disabled: !canDelete,
        callback: () => {
          deleteWorktreeTarget = { path: worktree.path, name: projectDisplayName(worktree) };
        },
      },
    );

    openContextMenu(event, actions);
  }

  function openSessionContextMenu(session: ACPConversationSummary, event: MouseEvent) {
    const canDelete = !session.sessionId || sidebar.canDeleteSession(session);
    openContextMenu(event, [
      {
        name: sidebarInlineRenameLabel("Conversation"),
        icon: "pencil",
        callback: () => {
          sidebar.beginRename({ kind: "conversation", id: session.id }, async (name) => {
            await conversations.renameConversation(session.id, name);
          });
        },
      },
      acpLogCaptureMenuAction(
        acpConnectionPool?.debug?.capture,
        {
          agentServer: getSessionAgentServer(session),
          conversationId: session.id,
          sessionId: session.sessionId,
        },
        (target) => (acpLogCaptureTarget = target),
      ),
      { kind: "separator" },
      {
        name: "Copy Session ID",
        icon: "copy",
        disabled: !session.sessionId,
        callback: () => {
          if (session.sessionId) rpc.writeToClipboard(session.sessionId);
        },
      },
      { kind: "separator" },
      {
        name: "Archive Conversation",
        icon: "archive",
        callback: () => handleArchiveSession(session, event),
      },
      {
        name: sidebarOpensViewLabel("Delete Conversation"),
        icon: "trash",
        disabled: !canDelete,
        callback: () => {
          deleteConversationTarget = {
            session,
            name: session.title || "Untitled Conversation",
          };
        },
      },
    ]);
  }

  function openConversationSearch(initialQuery = "") {
    conversationSearchInitialQuery = initialQuery;
    conversationSearchOpenToken += 1;
    conversationSearchOpen = true;
  }

  function showSettingsSection(section: DesktopSettingsNavSection) {
    switch (section) {
      case "preferences":
        onShowSettings();
        break;
      case "project-settings":
        onShowProjectSettings();
        break;
      case "shortcuts":
        onShowShortcuts?.();
        break;
      case "models":
        onShowModels?.();
        break;
      case "voice":
        onShowVoice?.();
        break;
      case "connectors":
        onShowConnectors?.();
        break;
      case "github":
        onShowGithub?.();
        break;
      case "agents":
        onShowAgents?.();
        break;
      case "archived":
        onShowArchived?.();
        break;
      case "remote":
        onShowRemote?.();
        break;
    }
  }

  function showLocalInferenceSettings() {
    if (onShowModels) {
      onShowModels();
      return;
    }
    onShowSettings();
  }

  function setCollapsed(nextCollapsed: boolean) {
    onCollapsedChange(nextCollapsed);
  }

  function handleResizeKeydown(event: KeyboardEvent) {
    if (!onWidthChange) return;

    if (event.key === "ArrowLeft") {
      onWidthChange(width - 16);
    } else if (event.key === "ArrowRight") {
      onWidthChange(width + 16);
    } else if (event.key === "Home") {
      onWidthChange(minWidth);
    } else if (event.key === "End") {
      onWidthChange(maxWidth);
    } else {
      return;
    }

    event.preventDefault();
  }
</script>

<svelte:window
  onkeydowncapture={handleWindowKeyDown}
  onkeyupcapture={handleWindowKeyUp}
  onblur={hideConversationShortcutHints}
  onfocus={hideConversationShortcutHints}
  onpointerdowncapture={handleWindowPointerEvent}
  onpointermove={handleWindowPointerEvent}
/>
<svelte:document onvisibilitychange={handleDocumentVisibilityChange} />

<DesktopConversationSearch
  bind:open={conversationSearchOpen}
  initialQuery={conversationSearchInitialQuery}
  openToken={conversationSearchOpenToken}
  shortcutHintsVisible={conversationShortcutHintsVisible}
  sessions={navSessions}
  projects={navProjects}
  excludedConversationIds={[...exitingConversationIds]}
  {activeConversationId}
  activeWorkspaceCwd={activeSessionWorkspaceCwd(activeSession)}
  {newTabAvailability}
/>

<DesktopSidebarChrome
  {collapsed}
  {width}
  {minWidth}
  {maxWidth}
  {resizing}
  {showCollapsedActions}
  {collapseDisabled}
  ariaLabel="ACP conversations"
  toggleTitle={sidebarToggleTitle()}
  toggleShortcutHint={conversationShortcutHintsVisible
    ? (shortcutHint("toggleLeftPanel") ?? undefined)
    : undefined}
  onCollapsedChange={setCollapsed}
  {onResizeStart}
  onResizeKeydown={handleResizeKeydown}
>
  <DesktopSidebarViewSlider view={sidebarView}>
    {#snippet main()}
      <div
        class="desktop-sidebar-header flex h-12 shrink-0 items-center gap-1 border-b border-transparent pr-2"
        data-tauri-drag-region="deep"
      >
        {#if activeWorkspaceLabel}
          <div
            class={[
              "flex h-[22px] min-w-0 items-center rounded-[7px] text-[13px]/[16px]",
              activeWorkspaceColor ? "px-2 font-normal text-white" : "text-psx-foreground-primary",
            ]}
            style:background-color={activeWorkspaceColor}
            title={activeWorkspaceLabel}
          >
            <span class="min-w-0 truncate">{activeWorkspaceLabel}</span>
          </div>
        {/if}
      </div>

      <div class="flex shrink-0 flex-col gap-0.5 pb-2 pl-1.5 pt-0.5">
        <SidebarNavButton
          icon="new"
          label="New conversation"
          title={withShortcut("New conversation", "newConversation")}
          shortcutHint={conversationShortcutHintsVisible
            ? (shortcutHint("newConversation") ?? undefined)
            : undefined}
          disabled={isLoading}
          onclick={() => {
            void handleNewSession();
          }}
        />

        {#if connectedRemoteDevices > 0}
          <SidebarNavButton
            icon="remote-access"
            statusDot="connected"
            label={connectedRemoteDevices === 1
              ? "1 device connected"
              : `${connectedRemoteDevices} devices connected`}
            title="Open Remote Access Settings"
            selected={currentView === "remote"}
            onclick={() => onShowRemote?.()}
          />
        {/if}

        <SidebarNavButton
          icon="mcp"
          label="Connectors"
          selected={currentView === "connectors"}
          onclick={() => onShowConnectors?.()}
        />

        <SidebarNavButton
          icon="search"
          label="Search"
          title={withShortcut("Search conversations", "searchConversations")}
          shortcutHint={conversationShortcutHintsVisible
            ? (shortcutHint("searchConversations") ?? undefined)
            : undefined}
          selected={conversationSearchOpen}
          onclick={() => openConversationSearch()}
        />
      </div>

      <div
        class="desktop-sidebar-scroll-frame min-h-0 flex-1"
        data-overflow-top={hasSidebarTopOverflow}
        data-overflow-bottom={hasSidebarBottomOverflow}
      >
        <div
          use:observeSidebarOverflow
          bind:this={sidebarScrollElement}
          class="desktop-sidebar-scroll h-full overflow-y-auto pb-1.5 pl-1.5 pt-1"
          data-overflow-top={hasSidebarTopOverflow}
          data-overflow-bottom={hasSidebarBottomOverflow}
          onscroll={(event) => updateSidebarOverflow(event.currentTarget)}
        >
          <div
            use:reorderable={{
              handleSelector: "[data-sidebar-section-reorder-handle]",
              itemSelector: "[data-sidebar-section-reorder-item]",
              getScrollContainer: () => sidebarScrollElement ?? null,
              onReorder: handleReorderSidebarSections,
              onDragStart: (index) => sidebarSectionReorderMotion.handleDragStart(index),
              onDragMove: (detail) => sidebarSectionReorderMotion.handleDragMove(detail),
              onDragEnd: () => sidebarSectionReorderMotion.handleDragEnd(),
              onTargetChange: (target) => sidebarSectionReorderMotion.handleTargetChange(target),
            }}
          >
            {#each sidebarSectionOrder as section (section)}
              {@const sectionMotionStyle = sidebarSectionReorderMotion.contentStyle(section)}
              <div data-sidebar-section-reorder-item class="relative mb-2 last:mb-0">
                <ReorderMotionItem
                  active={sidebarSectionReorderMotion.active}
                  source={sidebarSectionReorderMotion.isSource(section)}
                  style={section === "chats" ? sectionMotionStyle : undefined}
                  motion="section"
                >
                  {#if section === "chats"}
                    <div class="group/section flex h-6 items-center gap-1 px-1 pr-1 pt-0.5">
                      <button
                        type="button"
                        data-sidebar-section-reorder-handle
                        class="text-psx-foreground-tertiary hover:text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus flex min-w-0 flex-1 cursor-grab items-center gap-1 rounded-[6px] px-1 py-0.5 text-left transition-colors duration-200 focus-visible:outline-2 active:cursor-grabbing"
                        aria-label={sidebarSectionToggleLabel(
                          "chats",
                          chatsSectionCollapsed,
                          chatsSectionShowsOpen,
                        )}
                        aria-expanded={chatsSectionContentVisible}
                        onclick={toggleChatsSectionCollapsed}
                        oncontextmenu={suppressContextMenu}
                      >
                        <span class="text-[12px] font-medium">Chats</span>
                        <span
                          class={[
                            "inline-flex size-3.5 shrink-0 items-center justify-center transition-transform",
                            chatsSectionCollapsed ? "-rotate-90" : "",
                          ]}
                          aria-hidden="true"
                        >
                          <Icon name="chevron" size={12} />
                        </span>
                      </button>
                      {#if chatsSectionShowsOpen}
                        <Badge
                          intent="emphasis"
                          radius="full"
                          size="xs"
                          class="mr-1 shrink-0 px-1.5 pb-0.5 text-xs"
                        >
                          Open
                        </Badge>
                      {/if}
                      <SidebarIconButton
                        icon="new"
                        label="New chat"
                        size={13}
                        buttonSize="size-5"
                        class="ml-auto"
                        disabled={isLoading || !onNewChat}
                        onclick={() => {
                          chatsSectionCollapsed = false;
                          void onNewChat?.();
                        }}
                      />
                    </div>

                    <div
                      role="group"
                      aria-label="Chats"
                      class={[
                        "grid transition-[grid-template-rows] duration-200 ease-out",
                        chatsSectionContentVisible ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                      ]}
                      inert={!chatsSectionContentVisible}
                      aria-hidden={!chatsSectionContentVisible}
                    >
                      <div class="min-h-0 overflow-hidden">
                        {#if chatSessions.length === 0 && !rowExitAnimating && searchQuery.trim() === "" && conversations.refreshState.status === "success"}
                          <div class="pb-1 pl-1 pt-0.5">
                            <div
                              class="text-psx-foreground-tertiary flex min-w-0 select-none items-center py-1.5 pl-7 pr-2 text-[13px]/[16px]"
                            >
                              No chats
                            </div>
                          </div>
                        {:else if chatSessions.length > 0}
                          <div class="pb-1 pl-1 pt-0.5">
                            <ConversationGroup
                              sessions={chatSessions}
                              workspacePath={CHATS_GROUP_KEY}
                              {searchQuery}
                              expanded={searchQuery.trim() !== "" ||
                                isSessionGroupExpanded(CHATS_GROUP_KEY)}
                              visibleLimit={SESSION_VISIBLE_LIMIT}
                              rowIconSlotSize={16}
                              rowLeadingPaddingClass="pl-1"
                              desktop
                              onToggleExpanded={toggleSessionsExpanded}
                              onArchiveSession={handleArchiveSession}
                              onArchiveSessionNow={handleArchiveSessionNow}
                              onSessionContextMenu={openSessionContextMenu}
                              {isSessionExiting}
                              {sessionShortcutHint}
                              {descendantsFor}
                              {isSubAgentsExpanded}
                              onToggleSubAgents={toggleSubAgents}
                              {subAgentBadge}
                            />
                          </div>
                        {/if}
                      </div>
                    </div>
                  {:else}
                    <div data-sidebar-section-motion-piece>
                      <ReorderMotionItem
                        active={sidebarSectionReorderMotion.active}
                        source={false}
                        style={sectionMotionStyle}
                        motion="section"
                      >
                        <div class="group/section flex h-6 items-center gap-1 px-1 pr-1 pt-0.5">
                          <button
                            type="button"
                            data-sidebar-section-reorder-handle
                            class="text-psx-foreground-tertiary hover:text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus flex min-w-0 flex-1 cursor-grab items-center gap-1 rounded-[6px] px-1 py-0.5 text-left transition-colors duration-200 focus-visible:outline-2 active:cursor-grabbing"
                            aria-label={sidebarSectionToggleLabel(
                              "projects",
                              projectsSectionCollapsed,
                              projectsSectionShowsOpen,
                            )}
                            aria-expanded={projectsSectionContentVisible}
                            onclick={toggleProjectsSectionCollapsed}
                            oncontextmenu={suppressContextMenu}
                          >
                            <span class="text-[12px] font-medium">Projects</span>
                            <span
                              class={[
                                "inline-flex size-3.5 shrink-0 items-center justify-center transition-transform",
                                projectsSectionCollapsed ? "-rotate-90" : "",
                              ]}
                              aria-hidden="true"
                            >
                              <Icon name="chevron" size={12} />
                            </span>
                          </button>
                          {#if projectsSectionShowsOpen}
                            <Badge
                              intent="emphasis"
                              radius="full"
                              size="xs"
                              class="mr-1 shrink-0 px-1.5 pb-0.5 text-xs"
                            >
                              Open
                            </Badge>
                          {/if}
                          <SidebarIconButton
                            icon="folder-plus"
                            label="Add project"
                            title={withShortcut("Add project", "newProject")}
                            size={13}
                            buttonSize="size-5"
                            class="ml-auto"
                            disabled={addingProject}
                            onclick={handleAddProject}
                          />
                        </div>
                      </ReorderMotionItem>
                    </div>

                    <div
                      role="group"
                      aria-label="Projects"
                      class={[
                        "grid transition-[grid-template-rows] duration-200 ease-out",
                        projectsSectionContentVisible ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                      ]}
                      inert={!projectsSectionContentVisible}
                      aria-hidden={!projectsSectionContentVisible}
                    >
                      <div
                        class={[
                          "min-h-0",
                          sidebarSectionReorderMotion.active
                            ? "overflow-visible"
                            : "overflow-hidden",
                        ]}
                      >
                        {#if projects.refreshState.status === "failure"}
                          <div data-sidebar-section-motion-piece>
                            <ReorderMotionItem
                              active={sidebarSectionReorderMotion.active}
                              source={false}
                              style={sectionMotionStyle}
                              motion="section"
                            >
                              <div
                                class="text-psx-foreground-secondary px-2 py-4 text-center text-[13px]/[16px]"
                              >
                                {formatError(projects.refreshState.error, {
                                  prefix: "Failed to load projects",
                                })}
                              </div>
                            </ReorderMotionItem>
                          </div>
                        {:else}
                          {#if rootProjects.length === 0 && !isLoading}
                            <div data-sidebar-section-motion-piece>
                              <ReorderMotionItem
                                active={sidebarSectionReorderMotion.active}
                                source={false}
                                style={sectionMotionStyle}
                                motion="section"
                              >
                                <div class="px-2 py-2">
                                  <button
                                    type="button"
                                    aria-label="Open Project"
                                    class="sidebar-project-dropzone border-psx-foreground-tertiary/30 text-psx-foreground-secondary/75 outline-hidden hover:border-psx-foreground-tertiary/50 hover:bg-psx-foreground-tertiary/5 focus-visible:border-psx-input-border focus-visible:bg-psx-editor-background/60 focus-visible:outline-psx-focus flex w-full flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed px-4 py-4 text-sm transition-[transform,border-color,background-color] duration-200 focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60"
                                    disabled={addingProject}
                                    onclick={handleAddProject}
                                  >
                                    <span
                                      class="folder-glyph t-icon-swap h-6 w-6"
                                      aria-hidden="true"
                                    >
                                      <span class="t-icon" data-icon="folder">
                                        <Icon
                                          name="folder"
                                          size={20}
                                          weight={0.85}
                                          class="folder-icon text-current"
                                        />
                                      </span>
                                      <span class="t-icon" data-icon="folder-plus">
                                        <Icon
                                          name="folder-plus"
                                          size={20}
                                          weight={0.85}
                                          class="folder-icon text-current"
                                        />
                                      </span>
                                    </span>
                                    <span class="text-sm">
                                      {addingProject ? "Fetching..." : "Add a Project"}
                                    </span>
                                  </button>
                                </div>
                              </ReorderMotionItem>
                            </div>
                          {/if}

                          <div
                            use:reorderable={{
                              handleSelector: "[data-reorderable-handle]",
                              getScrollContainer: () => sidebarScrollElement ?? null,
                              onReorder: handleReorderProjects,
                              onDragStart: (index) => projectReorderMotion.handleDragStart(index),
                              onDragMove: (detail) => projectReorderMotion.handleDragMove(detail),
                              onDragEnd: () => projectReorderMotion.handleDragEnd(),
                              onTargetChange: (target) =>
                                projectReorderMotion.handleTargetChange(target),
                            }}
                          >
                            {#each rootProjects as project (project.path)}
                              {@const projectSessions = sessionsFor(project.path)}
                              <div
                                data-reorderable-item
                                aria-label={projectDisplayName(project)}
                                class="relative mb-1 last:mb-0"
                              >
                                <ReorderMotionItem
                                  active={projectReorderMotion.active}
                                  source={projectReorderMotion.isSource(project)}
                                  style={projectReorderMotion.contentStyle(project)}
                                >
                                  <div data-sidebar-section-motion-piece>
                                    <ReorderMotionItem
                                      active={sidebarSectionReorderMotion.active}
                                      source={false}
                                      style={sectionMotionStyle}
                                      motion="section"
                                    >
                                      <DesktopProjectSection
                                        {project}
                                        {projectSessions}
                                        worktrees={worktreesFor(project.path)}
                                        {searchQuery}
                                        sessionVisibleLimit={SESSION_VISIBLE_LIMIT}
                                        projectContentVisible={shouldShowProjectContent(project)}
                                        projectCollapsed={isProjectCollapsed(project)}
                                        projectSessionsExpanded={searchQuery.trim() !== "" ||
                                          isSessionGroupExpanded(project.path)}
                                        {canOpenWorkspace}
                                        {isCurrentWorkspace}
                                        {sessionsFor}
                                        {isSessionGroupExpanded}
                                        onToggleProjectCollapsed={toggleProjectCollapsed}
                                        onToggleSessionsExpanded={toggleSessionsExpanded}
                                        onAddWorktree={handleAddWorktree}
                                        onOpenWorkspace={handleOpenWorkspace}
                                        onRemoveWorktree={handleRemoveWorktree}
                                        onArchiveSession={handleArchiveSession}
                                        onArchiveSessionNow={handleArchiveSessionNow}
                                        onProjectContextMenu={openProjectContextMenu}
                                        onWorktreeContextMenu={openWorktreeContextMenu}
                                        onSessionContextMenu={openSessionContextMenu}
                                        {isSessionExiting}
                                        {rowExitAnimating}
                                        {sessionShortcutHint}
                                        {descendantsFor}
                                        {isSubAgentsExpanded}
                                        onToggleSubAgents={toggleSubAgents}
                                        {subAgentBadge}
                                        onReorderWorktrees={handleReorderWorktrees}
                                        onWorktreeDragActiveChange={(active) =>
                                          (worktreeDragActive = active)}
                                      />
                                    </ReorderMotionItem>
                                  </div>
                                </ReorderMotionItem>
                              </div>
                            {/each}
                          </div>

                          {#if searchQuery && conversations.sessions.length > 0 && !hasSearchResults() && !rowExitAnimating}
                            <div data-sidebar-section-motion-piece>
                              <ReorderMotionItem
                                active={sidebarSectionReorderMotion.active}
                                source={false}
                                style={sectionMotionStyle}
                                motion="section"
                              >
                                <div
                                  class="text-psx-foreground-secondary px-2 py-4 text-center text-[13px]/[16px]"
                                >
                                  No conversations found
                                </div>
                              </ReorderMotionItem>
                            </div>
                          {/if}
                        {/if}
                      </div>
                    </div>
                  {/if}
                </ReorderMotionItem>
              </div>
            {/each}
          </div>
        </div>
      </div>

      {#if sidebarSectionReorderMotion.preview}
        {@const preview = sidebarSectionReorderMotion.preview}
        <ReorderDragPreview style={sidebarSectionReorderMotion.previewStyle()}>
          <span class="min-w-0 truncate">{sidebarSectionLabel(preview.item)}</span>
        </ReorderDragPreview>
      {/if}

      {#if projectReorderMotion.preview}
        {@const preview = projectReorderMotion.preview}
        <ReorderDragPreview style={projectReorderMotion.previewStyle()}>
          <Icon
            name={preview.item.collapsed ? "folder-closed" : "folder-open"}
            size={14}
            class="text-psx-foreground-secondary shrink-0"
          />
          <span class="min-w-0 truncate">{projectDisplayName(preview.item)}</span>
        </ReorderDragPreview>
      {/if}

      <!-- Both views mount SidebarToasts; the instances render one shared
           list (sidebarToastsState) so a toast stays visible across the
           view slide instead of living in a single view that the slider can
           translate off-screen. -->
      <SidebarToasts class="flex shrink-0 flex-col px-1.5 pb-1" />

      <SidebarLocalRuntime
        class="flex shrink-0 flex-col gap-1 p-1.5 pt-0"
        onShowSettings={showLocalInferenceSettings}
      />

      <SidebarLocalDownloads
        class="flex shrink-0 flex-col gap-1 p-1.5 pt-0"
        onShowSettings={showLocalInferenceSettings}
      />

      <div class="relative shrink-0 p-1.5">
        <SidebarNavButton
          icon="gear"
          label="Settings"
          ariaLabel="Settings"
          pill={hasAgentUpdate ? "Update" : undefined}
          pillAppearance="vibrant"
          onclick={onShowSettings}
        />
      </div>
    {/snippet}

    {#snippet settings()}
      {#if settingsViewActive}
        <nav
          class="flex shrink-0 flex-col gap-0.5 pb-1.5 pl-1.5 pt-12"
          aria-label="Settings sections"
          data-tauri-drag-region="deep"
        >
          <SidebarNavButton icon="arrow-left" label="Back" onclick={onShowChat} />
          <span class="desktop-sidebar-divider my-0.5 -ml-1.5 block w-[calc(100%+0.375rem)]"></span>
          {#each settingsSections as section (section)}
            {@const item = SETTINGS_NAV_ITEMS[section]}
            <SidebarNavButton
              icon={item.icon}
              badge={item.badge}
              label={item.label}
              pill={section === "agents" && hasAgentUpdate ? "Update" : item.pill}
              pillAppearance={section === "agents" && hasAgentUpdate ? "vibrant" : "default"}
              selected={currentView === section ||
                (section === "preferences" && currentView === "settings")}
              onclick={() => showSettingsSection(section)}
            />
          {/each}
        </nav>
        <!-- One bottom container: toasts and downloads must share a single
             mt-auto, or flex would split the free space between their two
             auto margins and float the toasts mid-sidebar. -->
        <div class="mt-auto flex shrink-0 flex-col">
          <SidebarToasts class="flex shrink-0 flex-col px-1.5 pb-1" />
          {#if currentView !== "models"}
            <SidebarLocalRuntime
              class="flex shrink-0 flex-col gap-1 p-1.5"
              onShowSettings={showLocalInferenceSettings}
            />
            <SidebarLocalDownloads
              class="flex shrink-0 flex-col gap-1 p-1.5"
              onShowSettings={showLocalInferenceSettings}
            />
          {/if}
        </div>
      {/if}
    {/snippet}
  </DesktopSidebarViewSlider>
</DesktopSidebarChrome>

<ConversationPreview />

{#if acpLogCaptureTarget}
  <ACPLogCaptureConfirmation
    target={acpLogCaptureTarget}
    onClose={() => (acpLogCaptureTarget = null)}
  />
{/if}

{#if removeProjectTarget}
  <ConfirmationDialog
    destructive
    title="Delete project?"
    description={`Delete ${removeProjectTarget.name} from Camber. Existing files on disk will not be deleted.`}
    confirmLabel="Delete Project"
    onCancel={() => (removeProjectTarget = null)}
    onConfirm={async () => {
      const target = removeProjectTarget;
      if (!target) return;
      await handleRemoveProject(target.path);
      removeProjectTarget = null;
    }}
  />
{/if}

{#if deleteWorktreeTarget}
  <ConfirmationDialog
    destructive
    title="Delete worktree?"
    description={`Delete ${deleteWorktreeTarget.name}. This removes the worktree from disk and cannot be undone.`}
    confirmLabel="Delete Worktree"
    onCancel={() => (deleteWorktreeTarget = null)}
    onConfirm={() => {
      const target = deleteWorktreeTarget;
      if (!target) return;
      handleRemoveWorktree(target.path);
      deleteWorktreeTarget = null;
    }}
  />
{/if}

{#if deleteConversationTarget}
  <ConfirmationDialog
    destructive
    title="Delete Conversation?"
    description={isACPChatConversation(deleteConversationTarget.session)
      ? "This removes the conversation and any associated files and cannot be undone."
      : "This removes the conversation and cannot be undone."}
    confirmLabel="Delete Conversation"
    onCancel={() => (deleteConversationTarget = null)}
    onConfirm={async () => {
      const target = deleteConversationTarget;
      if (!target) return;
      await handleDeleteSession(target.session);
      deleteConversationTarget = null;
    }}
  />
{/if}

<style lang="postcss">
  @reference "#tailwind.css";

  .desktop-sidebar-header {
    box-sizing: border-box;
    align-items: flex-start;
    padding-left: calc(var(--desktop-window-controls-space, 88px) + 22px + 8px);
    padding-top: var(--desktop-title-bar-control-top, 12px);
  }

  :global(body.desktop-window-fullscreen) .desktop-sidebar-header {
    padding-left: calc(0.375rem + var(--desktop-fullscreen-sidebar-icon-offset, 5px) + 22px + 8px);
  }

  .sidebar-project-dropzone:active {
    transform: translateY(1px);
  }

  .desktop-sidebar-scroll {
    /* Native overlay scrollbars always paint at the container's right edge, so
       extend the scroller 4px into the sidebar→panel gap and pad the content
       back out of it: the 8px of padding returns that 4px extension plus the
       4px of right padding the outermost wrappers inside gave up. Rows and
       text keep their exact geometry while the OS thumb paints beside them,
       in the gap. The sidebar chrome widens its clip and nudges the resize
       handle outward to match (DesktopSidebarChrome.svelte). */
    margin-right: -4px;
    padding-right: 8px;

    --desktop-sidebar-overflow-fade-height: 20px;
    --desktop-sidebar-overflow-mask-top: #000;
    --desktop-sidebar-overflow-mask-bottom: #000;

    -webkit-mask-image: linear-gradient(
      to bottom,
      var(--desktop-sidebar-overflow-mask-top) 0,
      #000 var(--desktop-sidebar-overflow-fade-height),
      #000 calc(100% - var(--desktop-sidebar-overflow-fade-height)),
      var(--desktop-sidebar-overflow-mask-bottom) 100%
    );
    mask-image: linear-gradient(
      to bottom,
      var(--desktop-sidebar-overflow-mask-top) 0,
      #000 var(--desktop-sidebar-overflow-fade-height),
      #000 calc(100% - var(--desktop-sidebar-overflow-fade-height)),
      var(--desktop-sidebar-overflow-mask-bottom) 100%
    );
    -webkit-mask-mode: alpha;
    mask-mode: alpha;
  }

  .desktop-sidebar-scroll-frame {
    position: relative;
  }

  .desktop-sidebar-scroll-frame::before,
  .desktop-sidebar-scroll-frame::after {
    position: absolute;
    right: 0;
    left: 0;
    z-index: 1;
    content: "";
    opacity: 0;
    pointer-events: none;
  }

  .desktop-sidebar-scroll-frame::before,
  .desktop-sidebar-scroll-frame::after,
  .desktop-sidebar-divider {
    height: var(--psx-hairline, 1px);
    background: color-mix(in srgb, var(--psx-border) 64%, transparent);
  }

  .desktop-sidebar-scroll-frame::before {
    top: 0;
  }

  .desktop-sidebar-scroll-frame::after {
    bottom: 0;
  }

  .desktop-sidebar-scroll-frame[data-overflow-top="true"]::before,
  .desktop-sidebar-scroll-frame[data-overflow-bottom="true"]::after {
    opacity: 1;
  }

  .desktop-sidebar-scroll[data-overflow-top="true"] {
    --desktop-sidebar-overflow-mask-top: transparent;
  }

  .desktop-sidebar-scroll[data-overflow-bottom="true"] {
    --desktop-sidebar-overflow-mask-bottom: transparent;
  }

  .t-icon-swap {
    --icon-swap-dur: 200ms;
    --icon-swap-blur: 0;
    --icon-swap-start-scale: 0.82;
    --icon-swap-ease: ease-in-out;

    position: relative;
    display: inline-grid;
    place-items: center;
  }

  .t-icon-swap .t-icon {
    grid-area: 1 / 1;
    display: inline-flex;
    transition:
      opacity var(--icon-swap-dur) var(--icon-swap-ease),
      filter var(--icon-swap-dur) var(--icon-swap-ease),
      transform var(--icon-swap-dur) var(--icon-swap-ease);
    will-change: opacity, filter, transform;
  }

  .sidebar-project-dropzone .t-icon-swap .t-icon[data-icon="folder"],
  .sidebar-project-dropzone:not(:disabled):is(:hover, :focus-visible)
    .t-icon-swap
    .t-icon[data-icon="folder-plus"] {
    opacity: 1;
    filter: blur(0);
    transform: scale(1);
  }

  .sidebar-project-dropzone .t-icon-swap .t-icon[data-icon="folder-plus"],
  .sidebar-project-dropzone:not(:disabled):is(:hover, :focus-visible)
    .t-icon-swap
    .t-icon[data-icon="folder"] {
    opacity: 0;
    filter: blur(var(--icon-swap-blur));
    transform: scale(var(--icon-swap-start-scale));
  }

  @media (prefers-reduced-motion: reduce) {
    .t-icon-swap .t-icon {
      transition: none !important;
    }
  }
</style>
