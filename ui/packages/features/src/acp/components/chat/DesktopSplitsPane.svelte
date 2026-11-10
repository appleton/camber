<script lang="ts">
  import Icon, { type IconName } from "@camber/components/icon";
  import { getUnknownErrorMessage } from "@camber/lib/errors";
  import { basename } from "@camber/lib/path";
  import { InfoMessageType, type AssistantTerminalTab, type AttachedFile } from "@camber/rpc";
  import {
    SplitsController,
    SplitsView,
    type PaneGeometry,
    type ExternalTreeNode,
    type PaneID,
    type SplitOrientation,
    type SplitsDelegate,
    type Tab,
    type TabID,
  } from "@camber/splits";
  import { onDestroy, tick, untrack, type Component, type Snippet } from "svelte";
  import { DEFAULT_AGENT_SERVER, LOCAL_AGENT_SERVER } from "../../agentServers";
  import { agentPickerIconProps, agentPickerIconUrl } from "./menus/config/agentConfig";
  import { desktopUpdate } from "../../desktopUpdate";
  import { getContextRepoContext } from "../../../context";
  import { shortcutHint } from "../../../keybindings";
  import { getACPAgentRegistryRepo } from "../../features/AgentRegistryRepository.svelte";
  import { setACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import { getACPConversationRepo } from "../../features/ConversationRepository.svelte";
  import { getACPContext } from "../../features/SessionRepository.svelte";
  import { getACPProjectRepo } from "../../features/ProjectRepository.svelte";
  import {
    DESKTOP_FILE_TREE_CHANGED_EVENT,
    DESKTOP_GIT_CHANGED_EVENT,
    DesktopGitChangesState,
    type DesktopFileTreeChangedEventDetail,
  } from "../../features/DesktopGitChangesState.svelte";
  import {
    getCurrentAssistantTerminalRepo,
    type AssistantTerminalCommandMode,
    type AssistantTerminalPlacement,
  } from "../../features/AssistantTerminalRepository.svelte";
  import { rpc } from "../../hostRpc";
  import { appState } from "../../hostAdapter";
  import { toolActivityFrom } from "../SessionEventsState.svelte";
  import AssistantTerminalView from "../AssistantTerminalView.svelte";
  import RegistryAgentIcon from "../RegistryAgentIcon.svelte";
  import AcpChatPane from "./ChatPane.svelte";
  import SubagentChatPane from "./SubagentChatPane.svelte";
  import AcpTrajectoryViewer from "./TrajectoryViewer.svelte";
  import DesktopFilesTree from "./DesktopFilesTree.svelte";
  import DesktopDiffPanel from "./DesktopDiffPanel.svelte";
  import DesktopGithubControl from "./DesktopGithubControl.svelte";
  import DesktopGitHubPanel from "./DesktopGitHubPanel.svelte";
  import type { DesktopFileViewerPanelProps } from "./desktopFileViewerPanel";
  import DesktopOpenTargetControl from "./DesktopOpenTargetControl.svelte";
  import {
    DESKTOP_NEW_TAB_EVENT,
    DESKTOP_OPEN_CHANGES_EVENT,
    DESKTOP_OPEN_CHANGES_VIEW_EVENT,
    DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT,
    DESKTOP_OPEN_DIFF_TAB_EVENT,
    DESKTOP_OPEN_FILE_TAB_EVENT,
    type DesktopNewTabEventDetail,
    type DesktopNewTabAvailability,
    type DesktopNewTabKind,
    type DesktopOpenDiffTabEventDetail,
    type DesktopOpenFileTabEventDetail,
    gitViewDisabledReason,
  } from "./desktopCommandPicker";
  import type {
    DesktopSplitNavigationLocation,
    DesktopSplitNavigationRequest,
  } from "./desktopNavigation";
  import {
    desktopChatLiveStatusForSession,
    desktopChatTabStatusKind,
  } from "./desktopChatTabStatus";
  import { defaultTabForDesktopAuxiliarySurface } from "./desktopAuxiliarySurfaceDefault";
  import {
    type ClosedDesktopTab,
    type DesktopSplitsCache,
    type DesktopSplitsEntry,
    type DesktopSplitSurface,
    type DesktopTabDescriptor,
    type RestorableDesktopTabDescriptor,
    type TerminalCreateOptions,
  } from "./desktopSplitsCache";
  import {
    adoptDesktopTabContent,
    desktopTabContentPoolHost,
    pooledDesktopTabContent,
  } from "./desktopTabContentPool";
  import {
    captureDesktopSplitsLayout,
    isDesktopDefaultLayoutCandidate,
    readStoredDefaultDesktopLayout,
    readStoredDesktopLayout,
    renameStoredDesktopLayout,
    restorableTerminalCwd,
    shouldApplyStoredDefaultDesktopLayout,
    writeStoredDefaultDesktopLayout,
    writeStoredDesktopLayout,
    type PersistedDesktopLayout,
    type PersistedDesktopTabDescriptor,
  } from "./desktopLayoutPersistence";
  import { readDesktopFilesTreePrefs, writeDesktopFilesTreePrefs } from "./desktopFilesTreePrefs";
  import { requestDesktopChangesView } from "./desktopChangesViewRequest";
  import { showDesktopContextMenu } from "./desktopContextMenu";
  import { buildTabContextMenuItems } from "./desktopTabContextMenu";
  import {
    DesktopSurfaceFocusHistory,
    type DesktopAuxiliarySurface,
  } from "./desktopSurfaceFocusHistory";
  import { setSubagentTranscriptNavigation } from "./subagentTranscriptNavigation";
  import {
    subagentProvidesTranscript,
    subagentTranscriptRevision,
    type SubagentReference,
  } from "../../subagents";
  import {
    desktopSubagentTabOptions,
    desktopSubagentTabStatusKind,
    matchingDesktopSubagentTabId,
  } from "./desktopSubagentTabs";

  const DESKTOP_CLOSE_TAB_EVENT = "camber:desktop-close-tab";
  const DESKTOP_REOPEN_CLOSED_TAB_EVENT = "camber:desktop-reopen-closed-tab";
  const DESKTOP_SELECT_PREVIOUS_TAB_EVENT = "camber:desktop-select-previous-tab";
  const DESKTOP_SELECT_NEXT_TAB_EVENT = "camber:desktop-select-next-tab";
  const DESKTOP_SPLIT_RIGHT_EVENT = "camber:desktop-split-right";
  const DESKTOP_SPLIT_DOWN_EVENT = "camber:desktop-split-down";
  const DESKTOP_CLOSE_WINDOW_EVENT = "camber:desktop-close-window";
  const DESKTOP_SAVE_LAYOUT_AS_DEFAULT_EVENT = "camber:desktop-save-layout-as-default";
  const DESKTOP_LAYOUT_PERSIST_DELAY_MS = 150;

  interface Props {
    layoutKey: string;
    splitsCache: DesktopSplitsCache;
    terminalWorktreePath: string;
    sidebarCollapsed?: boolean;
    desktopSidebarWidth?: number;
    rightSidebarVisible?: boolean;
    rightSidebarWidth?: number;
    rightSidebarMinWidth?: number;
    rightSidebarMaxWidth?: number;
    rightSidebarResizing?: boolean;
    bottomPanelVisible?: boolean;
    bottomPanelHeight?: number;
    bottomPanelMinHeight?: number;
    bottomPanelMaxHeight?: number;
    bottomPanelResizing?: boolean;
    onExpandSidebar?: () => void;
    onRightSidebarVisibleChange?: (visible: boolean) => void;
    onRightSidebarResizeStart?: (event: MouseEvent) => void;
    onRightSidebarWidthChange?: (width: number) => void;
    onBottomPanelVisibleChange?: (visible: boolean) => void;
    onBottomPanelResizeStart?: (event: MouseEvent) => void;
    onBottomPanelHeightChange?: (height: number) => void;
    onNewConversation: (cwd?: string) => string | null | void | Promise<string | null | void>;
    onAddProject: () => Promise<void> | void;
    onShowAgentSettings: () => void;
    onShowModelSettings?: () => void;
    desktopFileViewerPanel?: Component<DesktopFileViewerPanelProps>;
    promptBanners?: Snippet;
    promptCommandItems?: Snippet;
    promptMenus?: Snippet;
    promptFooterLeading?: Snippet;
    activeConversationId?: string | null;
    onActiveConversationIdChange?: (key: string | null) => void;
    onNewTabAvailabilityChange?: (availability: DesktopNewTabAvailability) => void;
    navigationRequest?: DesktopSplitNavigationRequest;
    onNavigationChange?: (location: DesktopSplitNavigationLocation) => void;
  }

  interface DesktopTabFocusRequest {
    surface: DesktopSplitSurface;
    paneId: PaneID;
    tabId: TabID;
    token: number;
  }

  interface FilesCreateOptions {
    rootPath: string;
  }

  interface GithubCreateOptions {
    worktreePath: string;
  }

  interface FileCreateOptions {
    path: string;
    cwd?: string;
    line?: number;
    column?: number;
    openToken: number;
  }

  interface DiffCreateOptions {
    worktreePath: string;
    relativePath?: string;
    openToken: number;
  }

  interface DiffOpenRequest extends DiffCreateOptions {
    entry: DesktopSplitsEntry;
    tabId: TabID;
  }

  interface SubagentCreateOptions {
    conversationId: string;
    subagentKey: string;
    title: string;
  }

  interface DesktopNewTabAction {
    label: string;
    icon: IconName;
    disabled?: boolean;
    disabledReason?: string;
    onSelect: () => void;
  }

  interface VisibleDesktopTab {
    surface: DesktopSplitSurface;
    controller: SplitsController;
    tabId: TabID;
    tab: Tab;
  }

  type DesktopFileTabDescriptor = Extract<DesktopTabDescriptor, { kind: "file" }>;
  type DesktopDiffTabDescriptor = Extract<DesktopTabDescriptor, { kind: "diff" }>;

  interface VisibleDesktopFileTab {
    surface: DesktopSplitSurface;
    paneId: PaneID;
    tabId: TabID;
    descriptor: DesktopFileTabDescriptor;
  }

  let {
    layoutKey,
    splitsCache,
    terminalWorktreePath,
    sidebarCollapsed = false,
    desktopSidebarWidth = 260,
    rightSidebarVisible = false,
    rightSidebarWidth = 360,
    rightSidebarMinWidth = 280,
    rightSidebarMaxWidth = 720,
    rightSidebarResizing = false,
    bottomPanelVisible = false,
    bottomPanelHeight = 280,
    bottomPanelMinHeight = 180,
    bottomPanelMaxHeight = 640,
    bottomPanelResizing = false,
    onExpandSidebar,
    onRightSidebarVisibleChange,
    onRightSidebarResizeStart,
    onRightSidebarWidthChange,
    onBottomPanelVisibleChange,
    onBottomPanelResizeStart,
    onBottomPanelHeightChange,
    onNewConversation,
    onAddProject,
    onShowAgentSettings,
    onShowModelSettings,
    desktopFileViewerPanel,
    promptBanners,
    promptCommandItems,
    promptMenus,
    promptFooterLeading,
    activeConversationId = null,
    onActiveConversationIdChange,
    onNewTabAvailabilityChange,
    navigationRequest,
    onNavigationChange,
  }: Props = $props();

  const acp = getACPContext();
  const registry = getACPAgentRegistryRepo();
  const projects = getACPProjectRepo();
  const desktopChatSession = setACPChatSessionScope(
    acp,
    () => activeConversationId,
    (id) => onActiveConversationIdChange?.(id),
    getACPConversationRepo(),
    () => toolActivityFrom($appState),
  );
  setSubagentTranscriptNavigation({ open: openDesktopSubagentTranscript });
  const assistantTerminals = getCurrentAssistantTerminalRepo();
  const contextRepo = getContextRepoContext();
  const disposeVisibleTerminalOpener =
    assistantTerminals.setVisibleTerminalOpener(openExternalTerminal);
  const delegate: SplitsDelegate<SplitsController> = {
    shouldCloseTab(controller, tab, paneId) {
      if (tab.isClosable === false) return false;

      const targetEntry = splitsCache.entryForController(controller);
      if (targetEntry) {
        targetEntry.pendingClosedTab = closedTabSnapshot(targetEntry, controller, tab, paneId);
      }
      return true;
    },
    didCreateTab(controller, tab, paneId) {
      const targetEntry = splitsCache.entryForController(controller);
      if (!targetEntry || targetEntry.descriptors[tab.id]) return;
      if (pendingFilesCreateOptions) {
        createFilesForTab(targetEntry, controller, tab, pendingFilesCreateOptions);
        return;
      }
      if (pendingFileCreateOptions) {
        createFileForTab(targetEntry, controller, tab, pendingFileCreateOptions);
        return;
      }
      if (pendingTrajectoryCreate) {
        createTrajectoryForTab(targetEntry, controller, tab);
        return;
      }
      if (pendingGithubCreateOptions) {
        createGithubForTab(targetEntry, controller, tab, pendingGithubCreateOptions);
        return;
      }
      if (pendingDiffCreateOptions) {
        createDiffForTab(targetEntry, controller, tab, pendingDiffCreateOptions);
        return;
      }
      if (pendingSubagentCreateOptions) {
        setSubagentDescriptorForTab(targetEntry, tab.id, pendingSubagentCreateOptions);
        controller.updateTab(tab.id, desktopSubagentTabOptions(pendingSubagentCreateOptions.title));
        return;
      }
      const options = pendingTerminalCreateOptions ?? {
        worktreePath: terminalWorktreePath,
      };
      void createTerminalForTab(targetEntry, controller, tab, paneId, options);
    },
    didCloseTab(controller, tabId) {
      const targetEntry = splitsCache.entryForController(controller);
      if (!targetEntry) return;
      const descriptor = targetEntry.descriptors[tabId];
      const closedTab =
        targetEntry.pendingClosedTab?.tabId === tabId ? targetEntry.pendingClosedTab : undefined;
      targetEntry.pendingClosedTab = undefined;
      if (closedTab) {
        targetEntry.lastClosedTab = closedTab;
      }
      removeDescriptor(targetEntry, tabId);
      if (descriptor?.kind === "terminal" && descriptor.terminalId) {
        void deleteTerminal(descriptor.terminalId);
      }
      if (descriptor?.kind === "file") {
        removeDesktopFileViewOrder(tabId);
      }
      if (descriptor?.kind === "subagent-chat") {
        removeSubagentTabState(targetEntry, tabId);
      }
      collapseEmptySideSurfaceForController(targetEntry, controller);
      invalidateDesktopFileContext();
      reportFocusedControllerNavigation(controller);
    },
    didMoveTab(controller, _tab, sourcePaneId) {
      const targetEntry = splitsCache.entryForController(controller);
      if (!targetEntry) return;
      collapseEmptySideSurfaceForPane(targetEntry, sourcePaneId);
    },
    didSelectTab(controller, tab, paneId) {
      const targetEntry = splitsCache.entryForController(controller);
      setActiveSurfaceForController(targetEntry, controller);
      const descriptor = targetEntry?.descriptors[tab.id];
      if (descriptor?.kind === "terminal" && descriptor.terminalId) {
        assistantTerminals.selectTab(descriptor.terminalId);
      }
      if (descriptor?.kind === "file") {
        markDesktopFileViewed(tab.id);
      } else if (targetEntry && descriptor?.kind === "subagent-chat") {
        markSubagentTabRead(targetEntry, tab.id);
      } else {
        invalidateDesktopFileContext();
      }
      if (targetEntry) {
        requestDesktopTabFocus(targetEntry, controller, paneId, tab.id);
      }
      reportDesktopNavigation(controller, paneId, tab.id);
    },
    didFocusPane(controller, paneId) {
      const targetEntry = splitsCache.entryForController(controller);
      setActiveSurfaceForController(targetEntry, controller);
      const selectedTab = controller.selectedTab(paneId);
      const descriptor = selectedTab ? targetEntry?.descriptors[selectedTab.id] : undefined;
      if (descriptor?.kind === "file" && selectedTab) {
        markDesktopFileViewed(selectedTab.id);
      } else {
        invalidateDesktopFileContext();
      }
      if (targetEntry && selectedTab) {
        requestDesktopTabFocus(targetEntry, controller, paneId, selectedTab.id);
      }
      reportDesktopNavigation(controller, paneId, selectedTab?.id);
    },
  };

  onDestroy(disposeVisibleTerminalOpener);
  onDestroy(() => {
    if (desktopLayoutPersistTimer) {
      clearTimeout(desktopLayoutPersistTimer);
    }
    if (paneShapeAnimatingTimer) {
      clearTimeout(paneShapeAnimatingTimer);
    }
  });

  // Every tab's content renders once into a hidden pool and is reparented into
  // whichever pane slot owns that tab, so moving a tab between panes reparents
  // live DOM instead of destroying and rebuilding the view (a rebuild
  // reconstructs an xterm and replays its whole scrollback, or rebuilds a chat
  // transcript: ~150ms of blocked main thread before the new layout paints).
  //
  // Bumped ONLY when the tab -> pane placement actually changes. Controllers
  // also publish for geometry, focus and selection, and mounting content
  // triggers those — so writing this on every publish makes render publish and
  // publish render forever (effect_update_depth_exceeded). Nothing a re-render
  // can do moves a tab between panes, so gating on placement breaks every such
  // loop rather than patching one of them.
  let pooledLayoutRevision = $state(0);
  // Bumped ONLY when a pane's selected tab actually changes. Pooled content is
  // rendered from `pooledTabs` — outside the pane that owns it — so nothing
  // re-evaluates it when selection alone moves, and reads of the controller's
  // (non-reactive) selection would stay stuck at whatever they saw when the
  // pool last re-rendered. Selection is never a consequence of rendering, so
  // unlike geometry and focus it can drive content without a publish/render
  // loop. See isSelectedDesktopTab.
  let selectionRevision = $state(0);
  // Plain fields, never reactive state: all are written from inside a
  // controller publish, and reactive state read there can feed the flush that
  // triggered it.
  let pooledPlacementSignature = "";
  let selectionSignature = "";
  const pooledTabOrder: TabID[] = [];

  const POOLED_SURFACES = ["main", "rightSidebar", "bottomPanel"] as const;

  function readPooledPlacements(currentEntry: DesktopSplitsEntry): {
    placements: Map<TabID, { surface: DesktopSplitSurface; paneId: PaneID }>;
    signature: string;
    selection: string;
  } {
    const placements = new Map<TabID, { surface: DesktopSplitSurface; paneId: PaneID }>();
    let signature = "";
    let selection = "";

    // Walk the tree rather than layoutSnapshot(): a zoomed controller reports
    // only the zoomed pane, which would drop every background pane's tab from
    // the pool and destroy exactly the views it exists to keep alive. A pane
    // with no slot simply leaves its content parked in the pool. The walk is
    // also cheaper — no pixel bounds — and this runs on every publish.
    const visit = (node: ExternalTreeNode, surface: DesktopSplitSurface) => {
      if (node.type === "pane") {
        const tabIds = node.pane.tabs.map((tab) => tab.id);
        for (const tabId of tabIds) placements.set(tabId, { surface, paneId: node.pane.id });
        signature += `${surface}/${node.pane.id}:${tabIds.join(",")};`;
        selection += `${surface}/${node.pane.id}:${node.pane.selectedTabId ?? ""};`;
        return;
      }
      visit(node.split.first, surface);
      visit(node.split.second, surface);
    };

    for (const surface of POOLED_SURFACES) {
      visit(controllerForSurface(currentEntry, surface).treeSnapshot(), surface);
    }
    return { placements, signature, selection };
  }

  const pooledTabs = $derived.by(() => {
    pooledLayoutRevision;
    const currentEntry = entry;
    if (!currentEntry) return [];

    const { placements } = readPooledPlacements(currentEntry);

    // Keep insertion order stable so the keyed each below only ever appends or
    // removes. It must never reorder: a wrapper that currently lives in a pane
    // slot is not a child of the each block's own parent, so a move would
    // insert it back into the pool.
    for (const tabId of placements.keys()) {
      if (!pooledTabOrder.includes(tabId)) pooledTabOrder.push(tabId);
    }
    for (let index = pooledTabOrder.length - 1; index >= 0; index--) {
      if (!placements.has(pooledTabOrder[index]!)) pooledTabOrder.splice(index, 1);
    }

    return pooledTabOrder.map((tabId) => ({ tabId, ...placements.get(tabId)! }));
  });

  let panelGeometryAnimating = $state(false);
  let paneShapeAnimatingTimer: ReturnType<typeof setTimeout> | undefined;
  const PANEL_GEOMETRY_ANIMATION_MS = 180;

  function animatePaneShapesUntilGeometrySettles() {
    panelGeometryAnimating = true;
    if (paneShapeAnimatingTimer) clearTimeout(paneShapeAnimatingTimer);
    paneShapeAnimatingTimer = setTimeout(() => {
      paneShapeAnimatingTimer = undefined;
      panelGeometryAnimating = false;
    }, PANEL_GEOMETRY_ANIMATION_MS);
  }

  $effect(() => {
    rightSidebarVisible;
    bottomPanelVisible;
    sidebarCollapsed;
    desktopSidebarWidth;
    rightSidebarWidth;
    bottomPanelHeight;
    animatePaneShapesUntilGeometrySettles();
  });

  // Passed per surface: a closed panel keeps its panes mounted, and handing it
  // this flag puts every one of them into PaneShape's per-frame measure loop
  // during motion that cannot affect them — defeating the content-visibility
  // that takes closed panels out of layout in the first place. A surface that
  // is opening has already flipped visible, so it still tracks; one that is
  // closing stops early, which is invisible because it is on its way out.
  const paneShapesAnimating = $derived(
    panelGeometryAnimating || rightSidebarResizing || bottomPanelResizing,
  );

  let entry = $state.raw<DesktopSplitsEntry>();
  let descriptors = $state<Record<TabID, DesktopTabDescriptor>>({});
  let mainTopLeftPaneId = $state<PaneID | undefined>();
  let mainTopRightPaneId = $state<PaneID | undefined>();
  let rightSidebarTopRightPaneId = $state<PaneID | undefined>();
  let desktopSplitsFrameElement = $state<HTMLElement>();
  let desktopTabFocusToken = 0;
  let lastAppliedNavigationRequestToken: number | undefined;
  let suppressNextDesktopTabFocusRequest = false;
  // Surfaces that became visible during background work (applyingDesktopTabFocus
  // with takeFocus false); consumed by handleDesktopSurfaceVisibilityChange so
  // opening them does not take focus.
  const surfacesRevealedWithoutFocus = new Set<DesktopAuxiliarySurface>();
  let desktopTabFocusRequest = $state<DesktopTabFocusRequest>();
  let activeSurface = $state<DesktopSplitSurface>("main");
  const desktopSurfaceFocusHistory = new DesktopSurfaceFocusHistory({
    rightSidebar: rightSidebarVisible,
    bottomPanel: bottomPanelVisible,
  });
  let pendingTerminalCreateOptions: TerminalCreateOptions | undefined;
  let pendingFilesCreateOptions: FilesCreateOptions | undefined;
  let pendingFileCreateOptions: FileCreateOptions | undefined;
  let pendingTrajectoryCreate = false;
  let pendingGithubCreateOptions: GithubCreateOptions | undefined;
  let pendingDiffCreateOptions: DiffCreateOptions | undefined;
  let pendingSubagentCreateOptions: SubagentCreateOptions | undefined;
  let diffOpenRequest = $state.raw<DiffOpenRequest>();
  let fileOpenToken = 0;
  let diffOpenToken = 0;
  let desktopFileContextRevision = $state(0);
  let desktopFileViewCounter = 0;
  let desktopFileViewOrder = $state<Record<TabID, number>>({});
  let desktopFileContextByPath = $state<Record<string, AttachedFile>>({});
  let desktopLayoutPersistTimer: ReturnType<typeof setTimeout> | undefined;
  let unreadSubagentTabIds = $state<ReadonlySet<TabID>>(new Set());
  const gitViewAvailability = new DesktopGitChangesState();
  onDestroy(() => gitViewAvailability.dispose());
  let activeSession = $derived(acp.getSessionByConversationId(activeConversationId));
  let filesRootPath = $derived(
    activeSession?.sessionInfo?.cwd ?? activeSession?.pendingCwd ?? activeSession?.cwd ?? "",
  );
  // The GitHub panel only needs the worktree path, not a loaded ACP session, so
  // fall back to terminalWorktreePath (the workspace root, resolved from the
  // selected conversation + projects). This keeps GitHub available even while a
  // conversation is still connecting/loading.
  let githubWorktreePath = $derived(filesRootPath || terminalWorktreePath);
  let diffViewDisabledReason = $derived(
    gitViewDisabledReason(githubWorktreePath || undefined, gitViewAvailability.status),
  );
  let changesViewDisabledReason = $derived(
    gitViewDisabledReason(filesRootPath || undefined, gitViewAvailability.status),
  );
  let agentServer = $derived(
    activeSession?.agentServer ?? acp.agents.defaultAgentServer ?? DEFAULT_AGENT_SERVER,
  );
  let agent = $derived(registry.getAgent(agentServer) ?? null);
  let agentName = $derived(
    agentServer === DEFAULT_AGENT_SERVER
      ? "Camber"
      : agentServer === LOCAL_AGENT_SERVER
        ? "Camber Local"
        : (agent?.name ?? agentServer),
  );
  let chatTabTitle = $derived(`Chatting with ${agentName}`);
  let chatTabIconUrl = $derived(agentPickerIconUrl(registry, agentServer));
  let chatTabIconProps = $derived(agentPickerIconProps(registry, agentServer));
  let chatTabStatus = $derived.by(() =>
    desktopChatTabStatusKind(
      desktopChatLiveStatusForSession(activeSession, (sessionId, statusAgentServer) =>
        acp.getConversationStatus(sessionId, statusAgentServer),
      ),
    ),
  );
  let desktopOpenTargetKind = $derived(desktopTargetKind(terminalWorktreePath));
  let desktopCodeFontFamily = $derived($appState.environment.desktopCodeFontFamily);
  let desktopCodeFontSize = $derived($appState.environment.desktopCodeFontSize);
  const desktopFrameActionButtonClass =
    "outline-hidden focus-visible:outline-psx-focus text-psx-icon hover:bg-psx-menu-hover-background flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] focus-visible:outline-2";

  $effect(() => {
    gitViewAvailability.setWorktreePath(githubWorktreePath || undefined);
  });

  $effect(() => {
    const currentEntry = entry;
    const currentDescriptors = descriptors;
    if (!currentEntry) return;

    const previousRevisions = currentEntry.subagentRevisionByTab ?? {};
    const previousUnread = currentEntry.unreadSubagentTabIds ?? new Set<TabID>();
    const nextRevisions: Record<TabID, string> = {};
    const nextUnread = new Set(
      [...previousUnread].filter((tabId) => currentDescriptors[tabId]?.kind === "subagent-chat"),
    );

    for (const [tabId, descriptor] of Object.entries(currentDescriptors)) {
      if (descriptor.kind !== "subagent-chat") continue;
      const revision = subagentTranscriptRevision(
        desktopChatSession.subagents,
        descriptor.subagentKey,
      );
      nextRevisions[tabId] = revision;
      const previousRevision = previousRevisions[tabId];
      if (
        previousRevision !== undefined &&
        previousRevision !== revision &&
        !isSubagentTabRead(currentEntry, tabId)
      ) {
        nextUnread.add(tabId);
      }
      if (isSubagentTabRead(currentEntry, tabId)) {
        nextUnread.delete(tabId);
      }
    }

    currentEntry.subagentRevisionByTab = nextRevisions;
    currentEntry.unreadSubagentTabIds = nextUnread;
    unreadSubagentTabIds = nextUnread;
  });

  $effect(() => {
    const onGitChanged = () => gitViewAvailability.refreshNow();
    const onFileTreeChanged = (event: Event) => {
      const detail = (event as CustomEvent<DesktopFileTreeChangedEventDetail>).detail;
      if (gitViewAvailability.affectsWorktree(detail)) gitViewAvailability.scheduleRefresh();
    };
    const onFocus = () => gitViewAvailability.refreshNow();
    window.addEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
    window.addEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
      window.removeEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
      window.removeEventListener("focus", onFocus);
    };
  });

  $effect(() => {
    const nextEntry = entryForLayout(layoutKey);
    entry = nextEntry;
    descriptors = nextEntry.descriptors;
  });

  $effect(() => {
    const request = navigationRequest;
    const currentEntry = entry;
    if (!request || !currentEntry || request.location.layoutKey !== layoutKey) return;
    if (request.token === lastAppliedNavigationRequestToken) return;

    // Navigation requests are commands, not persistent state. Mark the token
    // before applying it so delegate callbacks cannot cause the same command
    // to be replayed if they invalidate this effect. Keep the callback chain
    // untracked as it updates file-context and focus state synchronously.
    lastAppliedNavigationRequestToken = request.token;
    untrack(() => applyDesktopNavigationRequest(currentEntry, request.location));
  });

  $effect(() => {
    const currentEntry = entry;
    if (!currentEntry) return;

    // subscribe() invokes the subscriber synchronously, inside this effect, so
    // prime the signature first and that call becomes a no-op. Bumping there
    // would make this effect read (via +=) and write pooledLayoutRevision in
    // its own body — the self-dependency Svelte reports as
    // effect_update_depth_exceeded.
    const primed = readPooledPlacements(currentEntry);
    pooledPlacementSignature = primed.signature;
    selectionSignature = primed.selection;
    const handlePublish = () => {
      const { signature, selection } = readPooledPlacements(currentEntry);
      if (signature !== pooledPlacementSignature) {
        pooledPlacementSignature = signature;
        // untrack keeps the read inside += from ever registering a reader as a
        // dependent, whatever else publishes synchronously during an effect.
        untrack(() => {
          pooledLayoutRevision += 1;
        });
      }
      if (selection !== selectionSignature) {
        selectionSignature = selection;
        untrack(() => {
          selectionRevision += 1;
        });
      }
      schedulePersistDesktopLayout();
    };
    const unsubscribeMain = currentEntry.mainController.subscribe(handlePublish);
    const unsubscribeRightSidebar = currentEntry.rightSidebarController.subscribe(handlePublish);
    const unsubscribeBottomPanel = currentEntry.bottomPanelController.subscribe(handlePublish);
    return () => {
      unsubscribeMain();
      unsubscribeRightSidebar();
      unsubscribeBottomPanel();
    };
  });

  $effect(() => {
    rightSidebarVisible;
    bottomPanelVisible;
    activeSurface;
    schedulePersistDesktopLayout();
  });

  $effect(() => {
    const currentEntry = entry;
    const sessionId = activeSession?.sessionId;
    if (!currentEntry || !sessionId || !currentEntry.pendingDefaultLayoutHydration) return;
    hydratePendingDefaultLayout(currentEntry);
  });

  $effect(() => {
    const currentEntry = entry;
    const title = chatTabTitle;
    if (!currentEntry) return;

    for (const [tabId, descriptor] of Object.entries(currentEntry.descriptors)) {
      if (descriptor.kind === "chat") {
        controllerForTab(currentEntry, tabId)?.updateTab(tabId, {
          title,
          icon: "agent",
        });
      } else if (descriptor.kind === "subagent-chat") {
        const reference = desktopChatSession.subagents.referenceForKey(descriptor.subagentKey);
        controllerForTab(currentEntry, tabId)?.updateTab(tabId, {
          ...desktopSubagentTabOptions(reference?.title ?? descriptor.title),
        });
      }
    }
  });

  $effect(() => {
    const currentEntry = entry;
    if (!currentEntry) return;
    const terminalsById = new Map(
      assistantTerminals.tabs.map((terminal) => [terminal.id, terminal] as const),
    );
    for (const [tabId, descriptor] of Object.entries(descriptors)) {
      if (
        descriptor.kind !== "terminal" ||
        descriptor.status !== "ready" ||
        !descriptor.terminalId
      ) {
        continue;
      }

      const terminal = terminalsById.get(descriptor.terminalId);
      if (!terminal || terminal.exitCode !== undefined) {
        controllerForTab(currentEntry, tabId)?.closeTab(tabId);
      }
    }
  });

  $effect(() => {
    const currentEntry = entry;
    const terminals = assistantTerminals.tabs;
    if (!currentEntry) return;

    syncTerminalTabTitles(currentEntry, terminals);
  });

  $effect(() => {
    const currentEntry = entry;
    const currentDescriptors = descriptors;
    const fileContexts = desktopFileContextByPath;
    const fileViewOrder = desktopFileViewOrder;
    const contextRevision = desktopFileContextRevision;
    const rightVisible = rightSidebarVisible;
    const bottomVisible = bottomPanelVisible;
    syncDesktopVisibleFileContext({
      currentEntry,
      currentDescriptors,
      fileContexts,
      fileViewOrder,
      contextRevision,
      rightVisible,
      bottomVisible,
    });
  });

  $effect(() => {
    onNewTabAvailabilityChange?.({
      terminal: { disabled: false },
      files: {
        disabled: !filesRootPath,
        disabledReason: !filesRootPath ? "No working directory" : undefined,
      },
      diff: {
        disabled: diffViewDisabledReason !== undefined,
        disabledReason: diffViewDisabledReason,
      },
      changes: {
        disabled: changesViewDisabledReason !== undefined,
        disabledReason: changesViewDisabledReason,
      },
      trajectory: {
        disabled: false,
      },
      github: {
        disabled: !githubWorktreePath,
        disabledReason: !githubWorktreePath ? "No working directory" : undefined,
      },
    });
  });

  $effect(() => {
    if (!rightSidebarVisible && activeSurface === "rightSidebar") {
      activeSurface = "main";
      reportFocusedControllerNavigation(entry?.mainController);
    }
    if (!bottomPanelVisible && activeSurface === "bottomPanel") {
      activeSurface = "main";
      reportFocusedControllerNavigation(entry?.mainController);
    }
  });

  $effect(() => {
    const currentEntry = entry;
    if (!currentEntry) {
      mainTopLeftPaneId = undefined;
      mainTopRightPaneId = undefined;
      rightSidebarTopRightPaneId = undefined;
      return;
    }

    const syncTopPanes = () => {
      mainTopLeftPaneId = topLeftPaneIdForController(currentEntry.mainController);
      mainTopRightPaneId = topRightPaneIdForController(currentEntry.mainController);
      rightSidebarTopRightPaneId = topRightPaneIdForController(currentEntry.rightSidebarController);
    };

    const unsubscribeMain = currentEntry.mainController.subscribe(syncTopPanes);
    const unsubscribeRightSidebar = currentEntry.rightSidebarController.subscribe(syncTopPanes);
    return () => {
      unsubscribeMain();
      unsubscribeRightSidebar();
    };
  });

  $effect(() => {
    const request = desktopTabFocusRequest;
    if (!request) return;
    void tick().then(() => focusRequestedDesktopTab(request));
  });

  $effect(() => {
    const frame = desktopSplitsFrameElement;
    if (!frame) return;
    frame.addEventListener("focusin", handleDesktopSplitsFocusIn);
    return () => frame.removeEventListener("focusin", handleDesktopSplitsFocusIn);
  });

  $effect(() => {
    const currentEntry = entry;
    if (currentEntry && rightSidebarVisible) {
      initializeEmptyDesktopAuxiliarySurface("rightSidebar");
    }
    handleDesktopSurfaceVisibilityChange("rightSidebar", rightSidebarVisible);
  });

  $effect(() => {
    const currentEntry = entry;
    if (currentEntry && bottomPanelVisible) {
      initializeEmptyDesktopAuxiliarySurface("bottomPanel");
    }
    handleDesktopSurfaceVisibilityChange("bottomPanel", bottomPanelVisible);
  });

  $effect(() => {
    window.addEventListener("keydown", handleDesktopTabKeydown, true);
    window.addEventListener(DESKTOP_NEW_TAB_EVENT, handleDesktopNewTabEvent);
    window.addEventListener(DESKTOP_OPEN_CHANGES_EVENT, handleDesktopOpenChangesEvent);
    window.addEventListener(DESKTOP_OPEN_CHANGES_VIEW_EVENT, handleDesktopOpenChangesViewEvent);
    window.addEventListener(DESKTOP_CLOSE_TAB_EVENT, handleDesktopCloseTabEvent);
    window.addEventListener(DESKTOP_REOPEN_CLOSED_TAB_EVENT, handleDesktopReopenClosedTabEvent);
    window.addEventListener(DESKTOP_OPEN_FILE_TAB_EVENT, handleDesktopOpenFileTabEvent);
    window.addEventListener(DESKTOP_OPEN_DIFF_TAB_EVENT, handleDesktopOpenDiffTabEvent);
    window.addEventListener(DESKTOP_SPLIT_RIGHT_EVENT, handleDesktopSplitRightEvent);
    window.addEventListener(DESKTOP_SPLIT_DOWN_EVENT, handleDesktopSplitDownEvent);
    window.addEventListener(DESKTOP_SELECT_PREVIOUS_TAB_EVENT, handleDesktopSelectPreviousTabEvent);
    window.addEventListener(DESKTOP_SELECT_NEXT_TAB_EVENT, handleDesktopSelectNextTabEvent);
    window.addEventListener(
      DESKTOP_SAVE_LAYOUT_AS_DEFAULT_EVENT,
      handleDesktopSaveLayoutAsDefaultEvent,
    );

    return () => {
      window.removeEventListener("keydown", handleDesktopTabKeydown, true);
      window.removeEventListener(DESKTOP_NEW_TAB_EVENT, handleDesktopNewTabEvent);
      window.removeEventListener(DESKTOP_OPEN_CHANGES_EVENT, handleDesktopOpenChangesEvent);
      window.removeEventListener(
        DESKTOP_OPEN_CHANGES_VIEW_EVENT,
        handleDesktopOpenChangesViewEvent,
      );
      window.removeEventListener(DESKTOP_CLOSE_TAB_EVENT, handleDesktopCloseTabEvent);
      window.removeEventListener(
        DESKTOP_REOPEN_CLOSED_TAB_EVENT,
        handleDesktopReopenClosedTabEvent,
      );
      window.removeEventListener(DESKTOP_OPEN_FILE_TAB_EVENT, handleDesktopOpenFileTabEvent);
      window.removeEventListener(DESKTOP_OPEN_DIFF_TAB_EVENT, handleDesktopOpenDiffTabEvent);
      window.removeEventListener(DESKTOP_SPLIT_RIGHT_EVENT, handleDesktopSplitRightEvent);
      window.removeEventListener(DESKTOP_SPLIT_DOWN_EVENT, handleDesktopSplitDownEvent);
      window.removeEventListener(
        DESKTOP_SELECT_PREVIOUS_TAB_EVENT,
        handleDesktopSelectPreviousTabEvent,
      );
      window.removeEventListener(DESKTOP_SELECT_NEXT_TAB_EVENT, handleDesktopSelectNextTabEvent);
      window.removeEventListener(
        DESKTOP_SAVE_LAYOUT_AS_DEFAULT_EVENT,
        handleDesktopSaveLayoutAsDefaultEvent,
      );
    };
  });

  function controllerForSurface(
    targetEntry: DesktopSplitsEntry,
    surface: DesktopSplitSurface,
  ): SplitsController {
    if (surface === "rightSidebar") return targetEntry.rightSidebarController;
    if (surface === "bottomPanel") return targetEntry.bottomPanelController;
    return targetEntry.mainController;
  }

  function reportDesktopNavigation(controller: SplitsController, paneId: PaneID, tabId?: TabID) {
    const currentEntry = entry;
    if (!currentEntry || splitsCache.entryForController(controller) !== currentEntry) return;
    const surface = surfaceForController(currentEntry, controller);
    if (!surface) return;
    onNavigationChange?.({
      layoutKey,
      surface,
      paneId,
      ...(tabId ? { tabId } : {}),
    });
  }

  function reportFocusedControllerNavigation(controller: SplitsController | undefined) {
    const paneId = controller?.focusedPaneId;
    if (!controller || !paneId) return;
    reportDesktopNavigation(controller, paneId, controller.selectedTab(paneId)?.id);
  }

  function applyDesktopNavigationRequest(
    currentEntry: DesktopSplitsEntry,
    location: DesktopSplitNavigationLocation,
  ) {
    const controller = controllerForSurface(currentEntry, location.surface);
    const pane = controller
      .layoutSnapshot()
      .panes.find((candidate) => candidate.paneId === location.paneId);
    if (!pane || (location.tabId && !pane.tabIds.includes(location.tabId))) return;

    if (location.surface === "rightSidebar" && !rightSidebarVisible) {
      setRightSidebarVisible(true);
    } else if (location.surface === "bottomPanel" && !bottomPanelVisible) {
      setBottomPanelVisible(true);
    }

    activeSurface = location.surface;
    if (!location.tabId) {
      controller.focusPane(location.paneId);
      return;
    }

    const alreadySelected =
      controller.focusedPaneId === location.paneId &&
      controller.selectedTab(location.paneId)?.id === location.tabId;
    if (!alreadySelected && !controller.selectTab(location.tabId)) {
      controller.focusPane(location.paneId);
    }
    // A no-op restore emits no controller event, but history should still
    // return keyboard focus to the remembered content.
    requestDesktopTabFocus(currentEntry, controller, location.paneId, location.tabId);
  }

  function surfaceForController(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
  ): DesktopSplitSurface | undefined {
    if (targetEntry.mainController === controller) return "main";
    if (targetEntry.rightSidebarController === controller) return "rightSidebar";
    if (targetEntry.bottomPanelController === controller) return "bottomPanel";
    return undefined;
  }

  function controllerForTab(
    targetEntry: DesktopSplitsEntry,
    tabId: TabID,
  ): SplitsController | undefined {
    if (targetEntry.mainController.tab(tabId)) return targetEntry.mainController;
    if (targetEntry.rightSidebarController.tab(tabId)) return targetEntry.rightSidebarController;
    if (targetEntry.bottomPanelController.tab(tabId)) return targetEntry.bottomPanelController;
    return undefined;
  }

  function activeDesktopController(targetEntry: DesktopSplitsEntry): SplitsController {
    if (activeSurface === "rightSidebar" && rightSidebarVisible) {
      return targetEntry.rightSidebarController;
    }
    if (activeSurface === "bottomPanel" && bottomPanelVisible) {
      return targetEntry.bottomPanelController;
    }
    return targetEntry.mainController;
  }

  function activeDesktopPaneTarget(
    targetEntry: DesktopSplitsEntry,
  ): { surface: DesktopSplitSurface; paneId: PaneID } | undefined {
    const controller = activeDesktopController(targetEntry);
    const surface = surfaceForController(targetEntry, controller);
    const paneId = controller.focusedPaneId ?? controller.layoutSnapshot().panes[0]?.paneId;
    if (!surface || !paneId) return undefined;
    return { surface, paneId };
  }

  function syncDesktopVisibleFileContext({
    currentEntry,
    currentDescriptors,
    fileContexts,
    fileViewOrder,
    contextRevision,
    rightVisible,
    bottomVisible,
  }: {
    currentEntry: DesktopSplitsEntry | undefined;
    currentDescriptors: Record<TabID, DesktopTabDescriptor>;
    fileContexts: Record<string, AttachedFile>;
    fileViewOrder: Record<TabID, number>;
    contextRevision: number;
    rightVisible: boolean;
    bottomVisible: boolean;
  }) {
    void contextRevision;

    if (!currentEntry) {
      contextRepo.setActiveFiles([]);
      contextRepo.clearRecentFile();
      return;
    }

    const visibleFileTabs = visibleDesktopFileTabs(
      currentEntry,
      currentDescriptors,
      rightVisible,
      bottomVisible,
    );
    const activeFiles = visibleFileTabs.map(({ descriptor }) =>
      desktopContextFileForDescriptor(descriptor, fileContexts),
    );
    contextRepo.setActiveFiles(activeFiles);

    const recentFileTab = mostRecentVisibleDesktopFileTab(visibleFileTabs, fileViewOrder);
    if (!recentFileTab) {
      contextRepo.clearRecentFile();
      return;
    }

    contextRepo.setRecentFile(
      desktopContextFileForDescriptor(recentFileTab.descriptor, fileContexts),
    );
  }

  function visibleDesktopFileTabs(
    targetEntry: DesktopSplitsEntry,
    currentDescriptors: Record<TabID, DesktopTabDescriptor>,
    rightVisible: boolean,
    bottomVisible: boolean,
  ): VisibleDesktopFileTab[] {
    return [
      ...visibleDesktopFileTabsForSurface("main", targetEntry.mainController, currentDescriptors),
      ...(rightVisible
        ? visibleDesktopFileTabsForSurface(
            "rightSidebar",
            targetEntry.rightSidebarController,
            currentDescriptors,
          )
        : []),
      ...(bottomVisible
        ? visibleDesktopFileTabsForSurface(
            "bottomPanel",
            targetEntry.bottomPanelController,
            currentDescriptors,
          )
        : []),
    ];
  }

  function visibleDesktopFileTabsForSurface(
    surface: DesktopSplitSurface,
    controller: SplitsController,
    currentDescriptors: Record<TabID, DesktopTabDescriptor>,
  ): VisibleDesktopFileTab[] {
    return controller.layoutSnapshot().panes.flatMap((pane) => {
      const tabId = pane.selectedTabId;
      const descriptor = tabId ? currentDescriptors[tabId] : undefined;
      if (!tabId || descriptor?.kind !== "file") return [];
      return [{ surface, paneId: pane.paneId, tabId, descriptor }];
    });
  }

  function desktopContextFileForDescriptor(
    descriptor: DesktopFileTabDescriptor,
    fileContexts: Record<string, AttachedFile>,
  ): AttachedFile {
    const contextFile = fileContexts[normalizeWorkspacePath(descriptor.path)];
    return {
      ...contextFile,
      path: contextFile?.path || descriptor.path,
    };
  }

  function mostRecentVisibleDesktopFileTab(
    visibleFileTabs: VisibleDesktopFileTab[],
    fileViewOrder: Record<TabID, number>,
  ): VisibleDesktopFileTab | undefined {
    return visibleFileTabs.reduce<VisibleDesktopFileTab | undefined>((best, candidate) => {
      if (!best) return candidate;
      return (fileViewOrder[candidate.tabId] ?? 0) >= (fileViewOrder[best.tabId] ?? 0)
        ? candidate
        : best;
    }, undefined);
  }

  function handleDesktopFileContextChange(tabId: TabID, file: AttachedFile) {
    const descriptor = descriptors[tabId];
    if (descriptor?.kind !== "file") return;
    const path = file.path || descriptor.path;
    desktopFileContextByPath = {
      ...desktopFileContextByPath,
      [normalizeWorkspacePath(path)]: {
        ...file,
        path,
      },
    };
    invalidateDesktopFileContext();
  }

  function markDesktopFileViewed(tabId: TabID) {
    desktopFileViewOrder = {
      ...desktopFileViewOrder,
      [tabId]: ++desktopFileViewCounter,
    };
    invalidateDesktopFileContext();
  }

  function removeDesktopFileViewOrder(tabId: TabID) {
    const { [tabId]: _removed, ...nextFileViewOrder } = desktopFileViewOrder;
    desktopFileViewOrder = nextFileViewOrder;
  }

  function invalidateDesktopFileContext() {
    desktopFileContextRevision += 1;
  }

  function allDesktopTabIds(targetEntry: DesktopSplitsEntry): TabID[] {
    return [
      ...targetEntry.mainController.allTabIds,
      ...targetEntry.rightSidebarController.allTabIds,
      ...targetEntry.bottomPanelController.allTabIds,
    ];
  }

  function setActiveSurfaceForController(
    targetEntry: DesktopSplitsEntry | undefined,
    controller: SplitsController,
  ) {
    if (!targetEntry) return;
    const surface = surfaceForController(targetEntry, controller);
    if (surface) {
      activeSurface = surface;
    }
  }

  function setActiveDesktopSurface(surface: DesktopSplitSurface) {
    if (activeSurface !== surface) {
      activeSurface = surface;
    }
  }

  function controllerForPaneId(
    targetEntry: DesktopSplitsEntry,
    paneId: PaneID,
  ): SplitsController | undefined {
    const controllers = [
      targetEntry.mainController,
      targetEntry.rightSidebarController,
      targetEntry.bottomPanelController,
    ];
    return controllers.find((controller) => controller.allPaneIds.includes(paneId));
  }

  function collapseEmptySideSurfaceForPane(targetEntry: DesktopSplitsEntry, paneId: PaneID) {
    const controller = controllerForPaneId(targetEntry, paneId);
    if (controller) {
      collapseEmptySideSurfaceForController(targetEntry, controller);
    }
  }

  function collapseEmptySideSurfaceForController(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
  ) {
    if (controller.allTabIds.length > 0) return;

    const surface = surfaceForController(targetEntry, controller);
    if (surface === "rightSidebar" && rightSidebarVisible) {
      setRightSidebarVisible(false);
    } else if (surface === "bottomPanel" && bottomPanelVisible) {
      setBottomPanelVisible(false);
    }
  }

  function setRightSidebarVisible(visible: boolean) {
    onRightSidebarVisibleChange?.(visible);
    if (!visible && activeSurface === "rightSidebar") {
      activeSurface = "main";
    }
  }

  function toggleRightSidebar() {
    setRightSidebarVisible(!rightSidebarVisible);
  }

  function setBottomPanelVisible(visible: boolean) {
    onBottomPanelVisibleChange?.(visible);
    if (!visible && activeSurface === "bottomPanel") {
      activeSurface = "main";
    }
  }

  function toggleBottomPanel() {
    setBottomPanelVisible(!bottomPanelVisible);
  }

  function initializeEmptyDesktopAuxiliarySurface(surface: DesktopAuxiliarySurface) {
    const currentEntry = entry;
    if (!currentEntry) return;

    const controller = controllerForSurface(currentEntry, surface);
    const defaultTab = defaultTabForDesktopAuxiliarySurface(
      surface,
      controller.allTabIds.length > 0,
      Boolean(readStoredDefaultDesktopLayout()),
    );
    if (defaultTab === "terminal") {
      createTerminalTab(controller, { worktreePath: terminalWorktreePath });
      return;
    }
    if (defaultTab === "files") {
      const rootPath = filesRootPath || terminalWorktreePath;
      if (rootPath) {
        createFilesTab(currentEntry, controller, { rootPath });
      }
    }
  }

  function captureFocusBeforeDesktopSurfaceToggle(surface: DesktopAuxiliarySurface) {
    desktopSurfaceFocusHistory.captureBeforeToggle(surface, document.activeElement);
  }

  function handleDesktopSurfaceVisibilityChange(
    surface: DesktopAuxiliarySurface,
    visible: boolean,
  ) {
    const change = desktopSurfaceFocusHistory.syncVisibility(
      surface,
      visible,
      document.activeElement,
    );
    if (change.kind === "opened") {
      if (!surfacesRevealedWithoutFocus.delete(surface)) {
        focusDesktopSurface(surface);
      }
    } else if (change.kind === "closed") {
      surfacesRevealedWithoutFocus.delete(surface);
      void tick().then(() => restoreDesktopSurfaceFocus(change.restoreFocusTo));
    }
  }

  function focusDesktopSurface(surface: DesktopAuxiliarySurface) {
    const currentEntry = entry;
    if (!currentEntry) return;

    activeSurface = surface;
    const controller = controllerForSurface(currentEntry, surface);
    const paneId = controller.focusedPaneId ?? controller.layoutSnapshot().panes[0]?.paneId;
    const selectedTab = paneId ? controller.selectedTab(paneId) : undefined;
    if (paneId && selectedTab) {
      requestDesktopTabFocus(currentEntry, controller, paneId, selectedTab.id);
      return;
    }

    void tick().then(() => {
      desktopSurfaceElement(surface)?.focus({ preventScroll: true });
    });
  }

  function restoreDesktopSurfaceFocus(focusTarget: HTMLElement | undefined) {
    if (focusTarget?.isConnected && !focusTarget.closest("[inert]")) {
      focusTarget.focus({ preventScroll: true });
      if (document.activeElement === focusTarget) return;
    }

    focusMainDesktopSurface();
  }

  function focusMainDesktopSurface() {
    const currentEntry = entry;
    if (!currentEntry) return;

    activeSurface = "main";
    const controller = currentEntry.mainController;
    const paneId = controller.focusedPaneId ?? controller.layoutSnapshot().panes[0]?.paneId;
    const selectedTab = paneId ? controller.selectedTab(paneId) : undefined;
    if (paneId && selectedTab) {
      requestDesktopTabFocus(currentEntry, controller, paneId, selectedTab.id);
    }
  }

  function handleDesktopSplitsFocusIn(event: FocusEvent) {
    if (!(event.target instanceof Element)) return;

    const contentElement = event.target.closest<HTMLElement>(
      "[data-desktop-tab-content-surface][data-desktop-tab-content-pane-id]",
    );
    if (!contentElement || contentElement.closest("[inert]")) return;

    const surface = contentElement.dataset.desktopTabContentSurface;
    const paneId = contentElement.dataset.desktopTabContentPaneId;
    if (
      (surface !== "main" && surface !== "rightSidebar" && surface !== "bottomPanel") ||
      !paneId
    ) {
      return;
    }

    const currentEntry = entry;
    if (!currentEntry) return;
    const controller = controllerForSurface(currentEntry, surface);
    if (!controller.allPaneIds.includes(paneId)) return;

    // DOM focus is authoritative. Programmatic focus (notably focusPrompt)
    // does not pass through SplitsView's pointer handler, so keep the logical
    // surface/pane in sync and cancel any older deferred focus request —
    // unless focus just landed inside the tab that request targets. That is
    // the request being fulfilled, not superseded: focusRequestedDesktopTab
    // falls back to the tab's wrapper while the real target (an xterm still
    // mounting) does not exist yet, and clearing then would zero the
    // focusToken the mounting view needs to finish the hand-off.
    if (!focusLandedInRequestedDesktopTab(contentElement)) {
      desktopTabFocusRequest = undefined;
    }
    activeSurface = surface;
    if (controller.focusedPaneId === paneId) return;

    suppressNextDesktopTabFocusRequest = true;
    try {
      controller.focusPane(paneId);
    } finally {
      suppressNextDesktopTabFocusRequest = false;
    }
  }

  function focusLandedInRequestedDesktopTab(contentElement: HTMLElement): boolean {
    const request = desktopTabFocusRequest;
    return (
      request !== undefined &&
      contentElement.dataset.desktopTabContentSurface === request.surface &&
      contentElement.dataset.desktopTabContentPaneId === request.paneId &&
      contentElement.dataset.desktopTabContentTabId === request.tabId
    );
  }

  function desktopSurfaceElement(surface: DesktopAuxiliarySurface): HTMLElement | undefined {
    return (
      desktopSplitsFrameElement?.querySelector<HTMLElement>(
        `[data-desktop-surface="${surface}"]`,
      ) ?? undefined
    );
  }

  function sidebarShortcutTitle(label: string): string {
    const hint = shortcutHint("toggleRightPanel");
    return hint ? `${label} ${hint}` : label;
  }

  function panelShortcutTitle(label: string): string {
    const hint = shortcutHint("toggleBottomPanel");
    return hint ? `${label} ${hint}` : label;
  }

  function handleRightSidebarResizeKeydown(event: KeyboardEvent) {
    if (!onRightSidebarWidthChange) return;

    const step = event.shiftKey ? 32 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onRightSidebarWidthChange(Math.min(rightSidebarWidth + step, rightSidebarMaxWidth));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onRightSidebarWidthChange(Math.max(rightSidebarWidth - step, rightSidebarMinWidth));
    }
  }

  function handleBottomPanelResizeKeydown(event: KeyboardEvent) {
    if (!onBottomPanelHeightChange) return;

    const step = event.shiftKey ? 32 : 16;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onBottomPanelHeightChange(Math.min(bottomPanelHeight + step, bottomPanelMaxHeight));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onBottomPanelHeightChange(Math.max(bottomPanelHeight - step, bottomPanelMinHeight));
    }
  }

  function syncTerminalTabTitles(
    targetEntry: DesktopSplitsEntry,
    terminals: AssistantTerminalTab[],
  ) {
    for (const [tabId, descriptor] of Object.entries(targetEntry.descriptors)) {
      if (
        descriptor.kind !== "terminal" ||
        descriptor.status !== "ready" ||
        !descriptor.terminalId
      ) {
        continue;
      }
      const terminal = terminals.find((candidate) => candidate.id === descriptor.terminalId);
      if (!terminal) continue;
      controllerForTab(targetEntry, tabId)?.updateTab(tabId, {
        title: terminalDisplayTitle(terminal),
        icon: null,
      });
    }
  }

  function entryForLayout(key: string): DesktopSplitsEntry {
    const nextEntry = splitsCache.getOrCreate(key, createDesktopSplitsEntry);
    nextEntry.mainController.delegate = delegate;
    nextEntry.rightSidebarController.delegate = delegate;
    nextEntry.bottomPanelController.delegate = delegate;
    syncTerminalTabTitles(nextEntry, assistantTerminals.tabs);
    return nextEntry;
  }

  function createDesktopSplitsController() {
    return new SplitsController({
      allowCrossControllerTabMove: true,
      contentViewLifecycle: "keepAllAlive",
      newTabPosition: "end",
      appearance: {
        tabBarHeight: 34,
        tabMinWidth: 40,
        tabMaxWidth: 208,
        tabSpacing: 4,
        showSplitButtons: false,
      },
    });
  }

  function createEmptyDesktopSplitsController() {
    const controller = createDesktopSplitsController();
    const initialTabId = controller.allTabIds[0];
    if (initialTabId) {
      controller.closeTab(initialTabId);
    }
    return controller;
  }

  function createDesktopSplitsEntry(key: string): DesktopSplitsEntry {
    const shouldDeferDefaultHydration = shouldDeferDefaultLayoutHydration(key);
    if (!shouldDeferDefaultHydration) {
      const restoredEntry = createDesktopSplitsEntryFromStoredLayout(key);
      if (restoredEntry) {
        return restoredEntry;
      }
    }

    const mainController = createDesktopSplitsController();
    const rightSidebarController = createEmptyDesktopSplitsController();
    const bottomPanelController = createEmptyDesktopSplitsController();
    const chatTabId = mainController.allTabIds[0]!;
    mainController.updateTab(chatTabId, {
      title: chatTabTitle,
      icon: "agent",
      isClosable: false,
    });

    const nextEntry: DesktopSplitsEntry = {
      cacheKey: key,
      mainController,
      rightSidebarController,
      bottomPanelController,
      descriptors: {
        [chatTabId]: { kind: "chat" },
      },
      terminalPromises: new Map(),
      pendingDefaultLayoutHydration: shouldDeferDefaultHydration,
      dispose: () => {},
    };
    mainController.delegate = delegate;
    rightSidebarController.delegate = delegate;
    bottomPanelController.delegate = delegate;
    return nextEntry;
  }

  function createDesktopSplitsEntryFromStoredLayout(key: string): DesktopSplitsEntry | undefined {
    const layout = readStoredDesktopLayout(key);
    if (!layout) return undefined;

    const mainController = createDesktopSplitsController();
    const rightSidebarController = createEmptyDesktopSplitsController();
    const bottomPanelController = createEmptyDesktopSplitsController();
    const restoredEntry: DesktopSplitsEntry = {
      cacheKey: key,
      mainController,
      rightSidebarController,
      bottomPanelController,
      descriptors: {},
      terminalPromises: new Map(),
      dispose: () => {},
    };
    mainController.delegate = delegate;
    rightSidebarController.delegate = delegate;
    bottomPanelController.delegate = delegate;

    if (!restoreDesktopLayoutIntoEntry(restoredEntry, layout)) {
      return undefined;
    }
    return restoredEntry;
  }

  function shouldDeferDefaultLayoutHydration(key: string): boolean {
    if (activeSession?.sessionId) return false;
    if (!shouldApplyStoredDefaultDesktopLayout(activeSession?.isChat === true)) return false;
    return isDesktopDefaultLayoutCandidate(key, activeSession?.pendingConversationId);
  }

  function hydratePendingDefaultLayout(targetEntry: DesktopSplitsEntry) {
    targetEntry.pendingDefaultLayoutHydration = false;
    // Tabs may already exist by the time the session id arrives — a worktree
    // setup script opens its terminal into this entry while the session is
    // still connecting. Restoring the default layout would wipe those
    // descriptors and kill the live terminals behind them, so keep what the
    // user can already see instead.
    if (desktopEntryHasLiveContent(targetEntry)) {
      schedulePersistDesktopLayout();
      return;
    }
    const layout = readStoredDefaultDesktopLayout();
    if (!layout) {
      schedulePersistDesktopLayout();
      return;
    }

    closeRestoredOverDesktopTabs(targetEntry);
    if (!restoreDesktopLayoutIntoEntry(targetEntry, layout, terminalWorktreePath)) {
      schedulePersistDesktopLayout();
      return;
    }
    if (entry === targetEntry) {
      descriptors = targetEntry.descriptors;
    }
    invalidateDesktopFileContext();
    schedulePersistDesktopLayout();
  }

  function restoreDesktopLayoutIntoEntry(
    targetEntry: DesktopSplitsEntry,
    layout: PersistedDesktopLayout,
    // Set when restoring a shared *default* layout into a fresh conversation:
    // the persisted terminal worktree/cwd came from whichever conversation the
    // template was captured in, so anchor restored terminals to the current
    // worktree instead of spawning them in that foreign one.
    terminalWorktreeAnchor?: string,
  ): boolean {
    if (
      !targetEntry.mainController.restoreState(layout.surfaces.main) ||
      !targetEntry.rightSidebarController.restoreState(layout.surfaces.rightSidebar) ||
      !targetEntry.bottomPanelController.restoreState(layout.surfaces.bottomPanel)
    ) {
      return false;
    }

    targetEntry.descriptors = {};
    targetEntry.lastClosedTab = undefined;
    targetEntry.pendingClosedTab = undefined;
    targetEntry.terminalPromises.clear();

    if (!restorePersistedDesktopDescriptors(targetEntry, layout, terminalWorktreeAnchor)) {
      return false;
    }
    ensureRestoredChatTab(targetEntry);
    applyPersistedDesktopPanelState(targetEntry, layout);
    syncDescriptors(targetEntry);
    return true;
  }

  function desktopEntryHasLiveContent(targetEntry: DesktopSplitsEntry): boolean {
    return Object.values(targetEntry.descriptors).some((descriptor) => {
      if (descriptor.kind === "chat") return false;
      // A terminal that failed to open leaves a dead descriptor behind until the
      // user closes it; it must not masquerade as live content and suppress
      // restoring the saved layout.
      if (descriptor.kind === "terminal" && descriptor.status === "failed") return false;
      return true;
    });
  }

  function closeRestoredOverDesktopTabs(targetEntry: DesktopSplitsEntry) {
    for (const [tabId, descriptor] of Object.entries(targetEntry.descriptors)) {
      if (descriptor.kind === "terminal" && descriptor.terminalId) {
        void deleteTerminal(descriptor.terminalId);
      }
      if (descriptor.kind === "file") {
        removeDesktopFileViewOrder(tabId);
      }
    }
  }

  function restorePersistedDesktopDescriptors(
    targetEntry: DesktopSplitsEntry,
    layout: PersistedDesktopLayout,
    terminalWorktreeAnchor?: string,
  ): boolean {
    const restorations: Array<{
      controller: SplitsController;
      tab: Tab;
      paneId: PaneID;
      descriptor: PersistedDesktopTabDescriptor;
    }> = [];

    for (const tabId of allDesktopTabIds(targetEntry)) {
      const persistedDescriptor = layout.descriptors[tabId];
      if (!persistedDescriptor) {
        return false;
      }

      const controller = controllerForTab(targetEntry, tabId);
      const tab = controller?.tab(tabId);
      const paneId = controller
        ?.layoutSnapshot()
        .panes.find((pane) => pane.tabIds.includes(tabId))?.paneId;
      if (!controller || !tab || !paneId) {
        return false;
      }

      restorations.push({
        controller,
        tab,
        paneId,
        descriptor: persistedDescriptor,
      });
    }

    for (const { controller, tab, paneId, descriptor } of restorations) {
      restorePersistedDesktopDescriptor(
        targetEntry,
        controller,
        tab,
        paneId,
        descriptor,
        terminalWorktreeAnchor,
      );
    }

    return true;
  }

  function restorePersistedDesktopDescriptor(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    tab: Tab,
    paneId: PaneID,
    descriptor: PersistedDesktopTabDescriptor,
    terminalWorktreeAnchor?: string,
  ) {
    switch (descriptor.kind) {
      case "chat":
        setDescriptor(targetEntry, tab.id, { kind: "chat" });
        controller.updateTab(tab.id, {
          title: chatTabTitle,
          icon: "agent",
          isDirty: false,
          isClosable: false,
        });
        return;
      case "subagent-chat":
        setSubagentDescriptorForTab(targetEntry, tab.id, descriptor);
        controller.updateTab(tab.id, {
          ...desktopSubagentTabOptions(descriptor.title),
          isDirty: false,
          isClosable: true,
        });
        return;
      case "terminal": {
        // Anchoring wins over the persisted (foreign) worktree for default-layout
        // restores; a persisted cwd only survives when it sits inside whichever
        // worktree the terminal actually spawns in.
        const worktreePath =
          terminalWorktreeAnchor || descriptor.worktreePath || terminalWorktreePath;
        void createTerminalForTab(targetEntry, controller, tab, paneId, {
          worktreePath,
          cwd: restorableTerminalCwd(descriptor.cwd, worktreePath),
          selectWhenReady: false,
        });
        return;
      }
      case "review":
      case "changes":
        // The legacy review panel and the standalone Changes panel are both
        // removed: restore their persisted tabs as a files tab opening in
        // its git changes view so old layouts keep working.
        restoreAsChangesFilesTab(
          targetEntry,
          controller,
          tab,
          "worktreePath" in descriptor ? descriptor.worktreePath : undefined,
        );
        return;
      case "trajectory":
        setTrajectoryDescriptorForTab(targetEntry, tab.id);
        controller.updateTab(tab.id, trajectoryTabOptions());
        return;
      case "files": {
        const rootPath = descriptor.rootPath || filesRootPath;
        setFilesDescriptorForTab(targetEntry, tab.id, { rootPath });
        controller.updateTab(tab.id, filesTabOptions(rootPath));
        // A layout saved while the tree showed its changes view restores in
        // changes mode — but only when no per-worktree pref exists yet. The
        // pref is written on every subview toggle while layouts are only
        // captured on tab events, so an existing pref is always the fresher
        // record of what the user last looked at.
        if (descriptor.viewMode === "changes" && rootPath) {
          const existing = readDesktopFilesTreePrefs(rootPath);
          if (!existing) {
            writeDesktopFilesTreePrefs(rootPath, {
              viewMode: "changes",
              expandedDirectoryPaths: [],
            });
          }
        }
        return;
      }
      case "github":
        setGithubDescriptorForTab(
          targetEntry,
          tab.id,
          descriptor.worktreePath || githubWorktreePath,
        );
        controller.updateTab(tab.id, githubTabOptions());
        return;
      case "file": {
        const options = {
          path: descriptor.path,
          cwd: descriptor.cwd,
          line: descriptor.line,
          column: descriptor.column,
          openToken: ++fileOpenToken,
        };
        setFileDescriptorForTab(targetEntry, tab.id, options);
        controller.updateTab(tab.id, fileViewerTabOptions(descriptor.path));
        return;
      }
      case "diff":
        // Re-opens a fresh diff helper session for the worktree; no
        // relativePath, so the restored view starts at the top instead of
        // jumping to whichever file was last targeted. Like the github
        // fallback above, an empty persisted path (shape-only default
        // layouts) anchors to the current worktree.
        setDiffDescriptorForTab(targetEntry, tab.id, {
          worktreePath: descriptor.worktreePath || githubWorktreePath,
          openToken: ++diffOpenToken,
        });
        controller.updateTab(tab.id, diffTabOptions());
        return;
    }
  }

  function ensureRestoredChatTab(targetEntry: DesktopSplitsEntry) {
    if (Object.values(targetEntry.descriptors).some((descriptor) => descriptor.kind === "chat")) {
      return;
    }

    const previousDelegate = targetEntry.mainController.delegate;
    let tabId: TabID | undefined;
    targetEntry.mainController.delegate = undefined;
    try {
      tabId = targetEntry.mainController.createTab({
        title: chatTabTitle,
        icon: "agent",
        isClosable: false,
      });
    } finally {
      targetEntry.mainController.delegate = previousDelegate;
    }
    if (tabId) {
      setDescriptor(targetEntry, tabId, { kind: "chat" });
    }
  }

  function applyPersistedDesktopPanelState(
    targetEntry: DesktopSplitsEntry,
    layout: PersistedDesktopLayout,
  ) {
    setRightSidebarVisible(layout.rightSidebarVisible);
    setBottomPanelVisible(layout.bottomPanelVisible);
    if (
      layout.activeSurface === "rightSidebar" &&
      layout.rightSidebarVisible &&
      targetEntry.rightSidebarController.allTabIds.length > 0
    ) {
      activeSurface = "rightSidebar";
    } else if (
      layout.activeSurface === "bottomPanel" &&
      layout.bottomPanelVisible &&
      targetEntry.bottomPanelController.allTabIds.length > 0
    ) {
      activeSurface = "bottomPanel";
    } else {
      activeSurface = "main";
    }
  }

  function handleDesktopTabKeydown(event: KeyboardEvent) {
    if (event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        selectPreviousDesktopTab();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        selectNextDesktopTab();
        return;
      }
    }

    if (event.metaKey && !event.ctrlKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === "t") {
        event.preventDefault();
        event.stopPropagation();
        reopenLastClosedDesktopTab();
        return;
      }

      if (event.key.toLowerCase() === "d") {
        event.preventDefault();
        event.stopPropagation();
        createDesktopTerminalSplit(event.shiftKey ? "vertical" : "horizontal");
        return;
      }

      if (!event.shiftKey && event.key.toLowerCase() === "w") {
        if (closeActiveDesktopTab()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.shiftKey && isPreviousTabKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        selectPreviousDesktopTab();
        return;
      }

      if (event.shiftKey && isNextTabKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        selectNextDesktopTab();
        return;
      }
    }

    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        selectPreviousDesktopTab();
      } else {
        selectNextDesktopTab();
      }
    }
  }

  function handleDesktopNewTabEvent(event: Event) {
    const detail = (event as CustomEvent<DesktopNewTabEventDetail>).detail;
    if (createDesktopNewTab(detail?.kind ?? "terminal")) {
      event.preventDefault();
    }
  }

  // Legacy "open changes" requests (e.g. Review Diff... in the file tree menu)
  // route to the file tree's changes view — the standalone Changes panel has
  // been removed in favor of it.
  function handleDesktopOpenChangesEvent(event: Event) {
    handleDesktopOpenChangesViewEvent(event);
  }

  // Focuses (or creates) the files sidebar tab so the tree — which listens
  // for the same event / pending request — can flip into its changes view.
  // An existing tree is used wherever it lives; when none exists a new one
  // opens in the right sidebar (revealed if hidden) rather than as a main
  // panel tab, so "Stage and Commit..." never displaces the conversation.
  function handleDesktopOpenChangesViewEvent(event: Event) {
    const currentEntry = entry;
    if (!currentEntry || changesViewDisabledReason) return;

    const filesTabId = Object.entries(currentEntry.descriptors).find(
      ([, descriptor]) => descriptor.kind === "files",
    )?.[0];
    if (filesTabId) {
      const controller = controllerForTab(currentEntry, filesTabId);
      controller?.selectTab(filesTabId);
      // Reveal whichever hidden surface hosts the tab — selecting a tab in a
      // hidden panel would otherwise be a silent no-op.
      const surface = controller ? surfaceForController(currentEntry, controller) : undefined;
      if (surface === "rightSidebar" && !rightSidebarVisible) {
        setRightSidebarVisible(true);
      } else if (surface === "bottomPanel" && !bottomPanelVisible) {
        setBottomPanelVisible(true);
      }
      event.preventDefault();
      return;
    }

    if (!filesRootPath) return;
    const sidebarController = currentEntry.rightSidebarController;
    if (createFilesTab(currentEntry, sidebarController, { rootPath: filesRootPath })) {
      if (!rightSidebarVisible) {
        setRightSidebarVisible(true);
      }
      activeSurface = "rightSidebar";
      event.preventDefault();
    }
  }

  function openDesktopNewTabPicker(surface: DesktopSplitSurface, paneId: PaneID) {
    const currentEntry = entry;
    desktopTabFocusRequest = undefined;
    if (currentEntry) {
      activeSurface = surface;
      const controller = controllerForSurface(currentEntry, surface);
      if (controller.focusedPaneId !== paneId) {
        suppressNextDesktopTabFocusRequest = true;
        try {
          controller.focusPane(paneId);
        } finally {
          suppressNextDesktopTabFocusRequest = false;
        }
      }
    }

    window.dispatchEvent(
      new CustomEvent(DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT, {
        detail: { initialQuery: "+" },
      }),
    );
  }

  function createDesktopNewTab(kind: DesktopNewTabKind): boolean {
    const currentEntry = entry;
    if (!currentEntry) return false;

    const target = activeDesktopPaneTarget(currentEntry);
    if (!target) return false;

    activeSurface = target.surface;
    const controller = controllerForSurface(currentEntry, target.surface);
    controller.focusPane(target.paneId);

    switch (kind) {
      case "files":
        return createDesktopFilesTab(target.surface, target.paneId);
      case "diff":
        if (diffViewDisabledReason) return false;
        return openDesktopDiffTab(
          { worktreePath: githubWorktreePath },
          target.surface,
          target.paneId,
        );
      case "review":
      case "changes":
        if (changesViewDisabledReason) return false;
        // Legacy kinds: the review/Changes panels are gone; the file tree's
        // changes view is the review surface now.
        requestDesktopChangesView(filesRootPath || undefined);
        return true;
      case "trajectory":
        return createDesktopTrajectoryTab(target.surface, target.paneId);
      case "github":
        return createDesktopGithubTab(target.surface, target.paneId);
      case "terminal":
      default:
        return createDesktopTerminalTab(target.surface, target.paneId);
    }
  }

  function openDesktopSubagentTranscript(reference: SubagentReference): void {
    if (!subagentProvidesTranscript(reference)) return;
    const currentEntry = entry;
    const conversationId = desktopChatSession.conversationId ?? activeConversationId;
    if (!currentEntry || !conversationId) return;

    const existingTabId = matchingDesktopSubagentTabId(
      currentEntry.descriptors,
      conversationId,
      reference.key,
    );
    if (existingTabId) {
      const controller = controllerForTab(currentEntry, existingTabId);
      const surface = controller ? surfaceForController(currentEntry, controller) : undefined;
      if (controller && surface) {
        revealDesktopSurface(surface);
        controller.selectTab(existingTabId);
      }
      return;
    }

    const target = activeDesktopPaneTarget(currentEntry);
    if (!target) return;
    const controller = controllerForSurface(currentEntry, target.surface);
    const options: SubagentCreateOptions = {
      conversationId,
      subagentKey: reference.key,
      title: reference.title,
    };
    pendingSubagentCreateOptions = options;
    try {
      const tabId = controller.createTab({
        ...desktopSubagentTabOptions(reference.title),
        inPane: target.paneId,
      });
      if (!tabId) return;
      controller.selectTab(tabId);
      revealDesktopSurface(target.surface);
    } finally {
      pendingSubagentCreateOptions = undefined;
    }
  }

  function setSubagentDescriptorForTab(
    targetEntry: DesktopSplitsEntry,
    tabId: TabID,
    options: SubagentCreateOptions,
  ): void {
    setDescriptor(targetEntry, tabId, {
      kind: "subagent-chat",
      ...options,
    });
  }

  function isSubagentTabRead(targetEntry: DesktopSplitsEntry, tabId: TabID): boolean {
    const controller = controllerForTab(targetEntry, tabId);
    if (!controller) return false;
    const surface = surfaceForController(targetEntry, controller);
    if (!surface) return false;
    if (surface !== "main" && !isDesktopAuxiliarySurfaceVisible(surface)) return false;
    return (
      controller
        ?.layoutSnapshot()
        .panes.some((pane) => controller.selectedTab(pane.paneId)?.id === tabId) ?? false
    );
  }

  function markSubagentTabRead(targetEntry: DesktopSplitsEntry, tabId: TabID): void {
    if (!isSubagentTabRead(targetEntry, tabId)) return;
    const unread = targetEntry.unreadSubagentTabIds;
    if (!unread?.has(tabId)) return;
    const next = new Set(unread);
    next.delete(tabId);
    targetEntry.unreadSubagentTabIds = next;
    if (targetEntry === entry) unreadSubagentTabIds = next;
  }

  function removeSubagentTabState(targetEntry: DesktopSplitsEntry, tabId: TabID): void {
    if (targetEntry.unreadSubagentTabIds?.has(tabId)) {
      const nextUnread = new Set(targetEntry.unreadSubagentTabIds);
      nextUnread.delete(tabId);
      targetEntry.unreadSubagentTabIds = nextUnread;
      if (targetEntry === entry) unreadSubagentTabIds = nextUnread;
    }
    if (targetEntry.subagentRevisionByTab?.[tabId] !== undefined) {
      const { [tabId]: _removed, ...nextRevisions } = targetEntry.subagentRevisionByTab;
      targetEntry.subagentRevisionByTab = nextRevisions;
    }
  }

  function handleDesktopCloseTabEvent(event: Event) {
    if (closeActiveDesktopTab()) {
      event.preventDefault();
    }
  }

  function handleDesktopReopenClosedTabEvent(event: Event) {
    if (reopenLastClosedDesktopTab()) {
      event.preventDefault();
    }
  }

  function handleDesktopOpenFileTabEvent(event: Event) {
    const detail = (event as CustomEvent<DesktopOpenFileTabEventDetail>).detail;
    if (openDesktopFileTab(detail)) {
      event.preventDefault();
    }
  }

  function handleDesktopSplitRightEvent(event: Event) {
    if (createDesktopTerminalSplit("horizontal")) {
      event.preventDefault();
    }
  }

  function handleDesktopSplitDownEvent(event: Event) {
    if (createDesktopTerminalSplit("vertical")) {
      event.preventDefault();
    }
  }

  function handleDesktopSelectPreviousTabEvent(event: Event) {
    if (selectPreviousDesktopTab()) {
      event.preventDefault();
    }
  }

  function handleDesktopSelectNextTabEvent(event: Event) {
    if (selectNextDesktopTab()) {
      event.preventDefault();
    }
  }

  function handleDesktopSaveLayoutAsDefaultEvent(event: Event) {
    if (saveCurrentDesktopLayoutAsDefault()) {
      event.preventDefault();
    }
  }

  function createDesktopTerminalSplit(orientation: SplitOrientation): boolean {
    const currentEntry = entry;
    if (!currentEntry) return false;
    const controller = activeDesktopController(currentEntry);
    if (controller.allTabIds.length === 0) {
      return Boolean(
        createTerminalTab(
          controller,
          { worktreePath: terminalWorktreePath },
          controller.focusedPaneId,
        ),
      );
    }

    return Boolean(
      createTerminalSplit(controller, orientation, { worktreePath: terminalWorktreePath }),
    );
  }

  // ---------------------------------------------------------------------------
  // Tab context menu – neighbour computation
  // ---------------------------------------------------------------------------

  /**
   * Returns the pane id that is adjacent to `sourcePaneId` in the given
   * direction within the same controller, or undefined when no such pane
   * exists.  Uses bounding-rect geometry from `layoutSnapshot()` — the same
   * approach already used by `restoredSplitPlacement`.
   */
  function adjacentPaneId(
    ctrl: SplitsController,
    sourcePaneId: PaneID,
    direction: "up" | "down" | "left" | "right",
  ): PaneID | undefined {
    const panes = ctrl.layoutSnapshot().panes;
    const source = panes.find((p) => p.paneId === sourcePaneId);
    if (!source) return undefined;

    const sx = source.frame.x;
    const sy = source.frame.y;
    const sw = source.frame.width;
    const sh = source.frame.height;

    // A candidate pane must share an edge with the source along the axis
    // perpendicular to the direction of movement. We allow a small tolerance
    // to handle sub-pixel layout rounding.
    const TOLERANCE = 2;

    let best: PaneGeometry | undefined;
    let bestDist = Infinity;

    for (const pane of panes) {
      if (pane.paneId === sourcePaneId) continue;

      const px = pane.frame.x;
      const py = pane.frame.y;
      const pw = pane.frame.width;
      const ph = pane.frame.height;

      // Check that the pane overlaps the source along the shared axis, and
      // lies on the correct side.
      switch (direction) {
        case "left": {
          const edgeDist = sx - (px + pw);
          if (edgeDist < -TOLERANCE || edgeDist > TOLERANCE) continue;
          const overlapY = Math.min(sy + sh, py + ph) - Math.max(sy, py);
          if (overlapY <= 0) continue;
          const dist = Math.abs(edgeDist);
          if (dist < bestDist) {
            best = pane;
            bestDist = dist;
          }
          break;
        }
        case "right": {
          const edgeDist = px - (sx + sw);
          if (edgeDist < -TOLERANCE || edgeDist > TOLERANCE) continue;
          const overlapY = Math.min(sy + sh, py + ph) - Math.max(sy, py);
          if (overlapY <= 0) continue;
          const dist = Math.abs(edgeDist);
          if (dist < bestDist) {
            best = pane;
            bestDist = dist;
          }
          break;
        }
        case "up": {
          const edgeDist = sy - (py + ph);
          if (edgeDist < -TOLERANCE || edgeDist > TOLERANCE) continue;
          const overlapX = Math.min(sx + sw, px + pw) - Math.max(sx, px);
          if (overlapX <= 0) continue;
          const dist = Math.abs(edgeDist);
          if (dist < bestDist) {
            best = pane;
            bestDist = dist;
          }
          break;
        }
        case "down": {
          const edgeDist = py - (sy + sh);
          if (edgeDist < -TOLERANCE || edgeDist > TOLERANCE) continue;
          const overlapX = Math.min(sx + sw, px + pw) - Math.max(sx, px);
          if (overlapX <= 0) continue;
          const dist = Math.abs(edgeDist);
          if (dist < bestDist) {
            best = pane;
            bestDist = dist;
          }
          break;
        }
      }
    }

    return best?.paneId;
  }

  // ---------------------------------------------------------------------------
  // Cross-surface tab move (descriptor-based recreate)
  // ---------------------------------------------------------------------------

  /**
   * Moves a tab from its current surface/controller to a different surface by
   * capturing its descriptor, closing it from the source, and recreating it in
   * the target controller.  Returns true on success.
   *
   * We use the descriptor-based path (rather than `moveTabFromController`)
   * because each surface has its own SplitsView whose content pool is keyed
   * by tab id.  Moving the Tab object across controllers would orphan the
   * live Svelte component in the source pool without mounting a new one in the
   * target pool.
   */
  function moveTabToSurface(
    targetEntry: DesktopSplitsEntry,
    tabId: TabID,
    sourcePaneId: PaneID,
    targetSurface: DesktopSplitSurface,
  ): boolean {
    const sourceCtrl = controllerForPaneId(targetEntry, sourcePaneId);
    if (!sourceCtrl) return false;

    const tab = sourceCtrl.tab(tabId);
    if (!tab) return false;

    const snapshot = closedTabSnapshot(targetEntry, sourceCtrl, tab, sourcePaneId);
    if (!snapshot) return false;

    // Close in source
    sourceCtrl.closeTab(tabId, sourcePaneId);

    // Make the target surface visible
    if (targetSurface === "rightSidebar") {
      setRightSidebarVisible(true);
    } else if (targetSurface === "bottomPanel") {
      setBottomPanelVisible(true);
    }

    const targetCtrl = controllerForSurface(targetEntry, targetSurface);
    const tabOptions = {
      title: snapshot.tab.title,
      icon: snapshot.tab.icon,
      isDirty: snapshot.tab.isDirty,
      isClosable: snapshot.tab.isClosable,
    };

    const newTabId = createTabFromDescriptor(targetEntry, snapshot, tabOptions, (opts) =>
      targetCtrl.createTab(opts),
    );

    if (newTabId) {
      targetCtrl.selectTab(newTabId);
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Tab context menu
  // ---------------------------------------------------------------------------

  function handleTabContextMenu({
    paneId,
    tabId,
    event,
  }: {
    paneId: PaneID;
    tabId: string;
    event: MouseEvent;
  }) {
    const currentEntry = entry;
    if (!currentEntry) return;

    const controller = controllerForPaneId(currentEntry, paneId);
    if (!controller) return;

    const tab = controller.tab(tabId);
    if (!tab) return;

    const allowClose = controller.configuration.allowCloseTabs;
    const tabClosable = tab.isClosable !== false;
    const canCloseThisTab = allowClose && tabClosable;

    // Determine whether there is at least one other closable tab in the same pane.
    const paneTabs = controller.tabs(paneId);
    const hasOtherClosableTabs = paneTabs.some(
      (t) => t.id !== tabId && t.isClosable !== false && allowClose,
    );

    const canSplit = controller.configuration.allowSplits;

    // Directional neighbours within the same controller
    const canMoveUp = adjacentPaneId(controller, paneId, "up") !== undefined;
    const canMoveDown = adjacentPaneId(controller, paneId, "down") !== undefined;
    const canMoveLeft = adjacentPaneId(controller, paneId, "left") !== undefined;
    const canMoveRight = adjacentPaneId(controller, paneId, "right") !== undefined;

    // Cross-surface move: disabled when the tab is non-closable, its source
    // surface IS the target, or its descriptor can't be captured.
    const currentSurface = surfaceForController(currentEntry, controller);
    const hasRestorableDescriptor =
      tabClosable && Boolean(restorableDesktopTabDescriptor(currentEntry.descriptors[tabId]));
    const canMoveToSidebar = hasRestorableDescriptor && currentSurface !== "rightSidebar";
    const canMoveToPanel = hasRestorableDescriptor && currentSurface !== "bottomPanel";

    // Split-and-move: disabled when splits not allowed or pane has only one tab
    const canSplitMove = canSplit && paneTabs.length > 1;

    void showDesktopContextMenu(
      buildTabContextMenuItems({
        canCloseThisTab,
        hasOtherClosableTabs,
        canSplit,
        canMoveUp,
        canMoveDown,
        canMoveLeft,
        canMoveRight,
        canMoveToSidebar,
        canMoveToPanel,
        canSplitMove,
      }),
      { x: event.clientX, y: event.clientY },
    ).then((actionId) => {
      if (!actionId) return;

      const currentEntry2 = entry;
      if (!currentEntry2) return;

      const ctrl = controllerForPaneId(currentEntry2, paneId);
      if (!ctrl) return;

      if (actionId === "close-tab") {
        const t = ctrl.tab(tabId);
        if (t && ctrl.configuration.allowCloseTabs && t.isClosable !== false) {
          ctrl.closeTab(tabId, paneId);
        }
      } else if (actionId === "close-other-tabs") {
        const currentPaneTabs = ctrl.tabs(paneId);
        for (const t of currentPaneTabs) {
          if (t.id !== tabId && t.isClosable !== false && ctrl.configuration.allowCloseTabs) {
            ctrl.closeTab(t.id, paneId);
          }
        }
      } else if (actionId === "split-right") {
        createTerminalSplit(ctrl, "horizontal", { worktreePath: terminalWorktreePath }, paneId);
      } else if (actionId === "split-down") {
        createTerminalSplit(ctrl, "vertical", { worktreePath: terminalWorktreePath }, paneId);
      } else if (actionId === "move-up") {
        const targetPaneId = adjacentPaneId(ctrl, paneId, "up");
        if (targetPaneId) ctrl.moveTab(tabId, paneId, targetPaneId);
      } else if (actionId === "move-down") {
        const targetPaneId = adjacentPaneId(ctrl, paneId, "down");
        if (targetPaneId) ctrl.moveTab(tabId, paneId, targetPaneId);
      } else if (actionId === "move-left") {
        const targetPaneId = adjacentPaneId(ctrl, paneId, "left");
        if (targetPaneId) ctrl.moveTab(tabId, paneId, targetPaneId);
      } else if (actionId === "move-right") {
        const targetPaneId = adjacentPaneId(ctrl, paneId, "right");
        if (targetPaneId) ctrl.moveTab(tabId, paneId, targetPaneId);
      } else if (actionId === "move-to-sidebar") {
        moveTabToSurface(currentEntry2, tabId, paneId, "rightSidebar");
      } else if (actionId === "move-to-panel") {
        moveTabToSurface(currentEntry2, tabId, paneId, "bottomPanel");
      } else if (actionId === "split-move-up") {
        ctrl.moveTabToSplit(tabId, paneId, paneId, "vertical", { insertFirst: true });
      } else if (actionId === "split-move-down") {
        ctrl.moveTabToSplit(tabId, paneId, paneId, "vertical", { insertFirst: false });
      } else if (actionId === "split-move-left") {
        ctrl.moveTabToSplit(tabId, paneId, paneId, "horizontal", { insertFirst: true });
      } else if (actionId === "split-move-right") {
        ctrl.moveTabToSplit(tabId, paneId, paneId, "horizontal", { insertFirst: false });
      }
    });
  }

  function createTerminalSplit(
    controller: SplitsController,
    orientation: SplitOrientation,
    options: TerminalCreateOptions,
    sourcePaneId?: PaneID,
  ): TabID | undefined {
    pendingTerminalCreateOptions = options;
    try {
      const paneId = controller.splitPane({
        paneId: sourcePaneId,
        orientation,
        withTab: {
          title: "Terminal",
          icon: null,
        },
      });
      if (!paneId) return undefined;

      const selectedTab = controller.selectedTab(paneId);
      if (selectedTab) {
        controller.selectTab(selectedTab.id);
      }
      return selectedTab?.id;
    } finally {
      pendingTerminalCreateOptions = undefined;
    }
  }

  function createDesktopTerminalTab(
    surface: DesktopSplitSurface = activeSurface,
    paneId?: PaneID,
  ): boolean {
    const currentEntry = entry;
    if (!currentEntry) return false;
    const controller = controllerForSurface(currentEntry, surface);
    return Boolean(createTerminalTab(controller, { worktreePath: terminalWorktreePath }, paneId));
  }

  function createTerminalTab(
    controller: SplitsController,
    options: TerminalCreateOptions,
    paneId?: PaneID,
  ): TabID | undefined {
    pendingTerminalCreateOptions = options;
    try {
      const tabId = controller.createTab("Terminal", { icon: null, inPane: paneId });
      if (tabId) {
        controller.selectTab(tabId);
      }
      return tabId;
    } finally {
      pendingTerminalCreateOptions = undefined;
    }
  }

  function openTerminalFromFilesTree(
    surface: DesktopSplitSurface,
    paneId: PaneID,
    worktreePath: string,
  ): void {
    const currentEntry = entry;
    if (!currentEntry) {
      throw new Error("No desktop split is active.");
    }

    const controller = controllerForSurface(currentEntry, surface);
    const tabId = createTerminalTab(controller, { worktreePath }, paneId);
    if (!tabId) {
      throw new Error("Terminal tab could not be created.");
    }
  }

  function createDesktopFilesTab(
    surface: DesktopSplitSurface = activeSurface,
    paneId?: PaneID,
  ): boolean {
    const currentEntry = entry;
    if (!currentEntry || !filesRootPath) return false;
    const controller = controllerForSurface(currentEntry, surface);
    return Boolean(createFilesTab(currentEntry, controller, { rootPath: filesRootPath }, paneId));
  }

  function createFilesTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    options: FilesCreateOptions,
    paneId?: PaneID,
  ): TabID | undefined {
    pendingFilesCreateOptions = options;
    try {
      const tabId = controller.createTab({ ...filesTabOptions(options.rootPath), inPane: paneId });
      if (tabId) {
        setFilesDescriptorForTab(targetEntry, tabId, options);
        controller.selectTab(tabId);
      }
      return tabId;
    } finally {
      pendingFilesCreateOptions = undefined;
    }
  }

  function createFilesForTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    tab: Tab,
    options: FilesCreateOptions,
  ) {
    setFilesDescriptorForTab(targetEntry, tab.id, options);
    controller.updateTab(tab.id, filesTabOptions(options.rootPath));
  }

  function setFilesDescriptorForTab(
    targetEntry: DesktopSplitsEntry,
    tabId: TabID,
    options: FilesCreateOptions,
  ) {
    setDescriptor(targetEntry, tabId, {
      kind: "files",
      rootPath: options.rootPath,
    });
  }

  function filesTabOptions(rootPath: string): Pick<Tab, "title" | "icon"> {
    return {
      title: fileTabTitle(rootPath),
      icon: "folder-open",
    };
  }

  function githubTabOptions(): Pick<Tab, "title" | "icon"> {
    return { title: "GitHub", icon: "github" };
  }

  function setGithubDescriptorForTab(
    targetEntry: DesktopSplitsEntry,
    tabId: TabID,
    worktreePath: string,
  ) {
    setDescriptor(targetEntry, tabId, { kind: "github", worktreePath });
  }

  // Opens the GitHub PR panel for the active worktree. Uses githubWorktreePath
  // (not filesRootPath) so it works without a loaded ACP session.
  function createDesktopGithubTab(
    surface: DesktopSplitSurface = activeSurface,
    paneId?: PaneID,
  ): boolean {
    const currentEntry = entry;
    if (!currentEntry || !githubWorktreePath) return false;
    const controller = controllerForSurface(currentEntry, surface);
    return Boolean(
      createGithubTab(currentEntry, controller, { worktreePath: githubWorktreePath }, paneId),
    );
  }

  // Mirrors createFilesTab: the pending marker lets didCreateTab route the new
  // tab to GitHub instead of falling through to its terminal default (which
  // would mislabel the tab "Terminal" and spawn a stray terminal).
  function createGithubTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    options: GithubCreateOptions,
    paneId?: PaneID,
  ): TabID | undefined {
    pendingGithubCreateOptions = options;
    try {
      const tabId = controller.createTab({ ...githubTabOptions(), inPane: paneId });
      if (tabId) {
        setGithubDescriptorForTab(targetEntry, tabId, options.worktreePath);
        controller.selectTab(tabId);
      }
      return tabId;
    } finally {
      pendingGithubCreateOptions = undefined;
    }
  }

  function createGithubForTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    tab: Tab,
    options: GithubCreateOptions,
  ) {
    setGithubDescriptorForTab(targetEntry, tab.id, options.worktreePath);
    controller.updateTab(tab.id, githubTabOptions());
  }

  function updateGithubTabTitle(tabId: TabID, title: string): void {
    const currentEntry = entry;
    if (!currentEntry) return;
    const descriptor = currentEntry.descriptors[tabId];
    if (descriptor?.kind !== "github") return;
    controllerForTab(currentEntry, tabId)?.updateTab(tabId, {
      title,
      icon: "github",
    });
  }

  // Persisted legacy review/Changes tabs restore as a files tab pre-set to
  // its git changes view (the worktree pref is seeded before the tree
  // mounts), so old layouts land on the new review surface.
  function restoreAsChangesFilesTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    tab: Tab,
    persistedWorktreePath?: string,
  ) {
    // Prefer the worktree the tab was persisted with — the session's own
    // roots may not have resolved yet when layouts hydrate.
    const rootPath = persistedWorktreePath || filesRootPath || githubWorktreePath;
    if (rootPath) {
      writeDesktopFilesTreePrefs(rootPath, {
        viewMode: "changes",
        expandedDirectoryPaths: readDesktopFilesTreePrefs(rootPath)?.expandedDirectoryPaths ?? [],
      });
    }
    setFilesDescriptorForTab(targetEntry, tab.id, { rootPath });
    controller.updateTab(tab.id, filesTabOptions(rootPath));
  }

  function fileTabTitle(rootPath: string): string {
    return basename(rootPath) || rootPath || "Files";
  }

  function openDesktopFileTab(detail: DesktopOpenFileTabEventDetail | undefined): boolean {
    const currentEntry = entry;
    const path = detail?.path?.trim();
    if (!currentEntry || !path) return false;

    activeSurface = "main";
    const controller = currentEntry.mainController;
    const options: FileCreateOptions = {
      path,
      cwd: filesRootPath,
      line: detail?.line,
      column: detail?.column,
      openToken: ++fileOpenToken,
    };

    const existingTabId = fileTabIdForPath(currentEntry, controller, path);
    if (existingTabId) {
      setFileDescriptorForTab(currentEntry, existingTabId, options);
      controller.updateTab(existingTabId, fileViewerTabOptions(path));
      controller.selectTab(existingTabId);
      return true;
    }

    return Boolean(createFileTab(currentEntry, controller, options));
  }

  function fileTabIdForPath(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    path: string,
  ): TabID | undefined {
    const normalized = normalizeWorkspacePath(path);
    return controller.allTabIds.find((tabId) => {
      const descriptor = targetEntry.descriptors[tabId];
      return descriptor?.kind === "file" && normalizeWorkspacePath(descriptor.path) === normalized;
    });
  }

  function createFileTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    options: FileCreateOptions,
    paneId?: PaneID,
  ): TabID | undefined {
    pendingFileCreateOptions = options;
    try {
      const tabId = controller.createTab({ ...fileViewerTabOptions(options.path), inPane: paneId });
      if (tabId) {
        setFileDescriptorForTab(targetEntry, tabId, options);
        controller.selectTab(tabId);
      }
      return tabId;
    } finally {
      pendingFileCreateOptions = undefined;
    }
  }

  function createFileForTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    tab: Tab,
    options: FileCreateOptions,
  ) {
    setFileDescriptorForTab(targetEntry, tab.id, options);
    controller.updateTab(tab.id, fileViewerTabOptions(options.path));
  }

  function setFileDescriptorForTab(
    targetEntry: DesktopSplitsEntry,
    tabId: TabID,
    options: FileCreateOptions,
  ) {
    setDescriptor(targetEntry, tabId, {
      kind: "file",
      path: options.path,
      cwd: options.cwd,
      line: options.line,
      column: options.column,
      openToken: options.openToken,
    });
  }

  function fileViewerTabOptions(path: string): Pick<Tab, "title" | "icon"> {
    return {
      title: basename(path) || path || "File",
      icon: "file",
    };
  }

  // --- Singleton Diff tab -------------------------------------------------
  // At most one diff tab exists per layout. It always shows the diff for all
  // changed files in the worktree; opening a diff focuses the existing tab
  // and scrolls the requested file into view.

  function diffTabOptions(): Pick<Tab, "title" | "icon"> {
    return {
      title: "Review Diff",
      icon: "diff",
    };
  }

  function diffTabIdForEntry(targetEntry: DesktopSplitsEntry): TabID | undefined {
    return Object.entries(targetEntry.descriptors).find(
      ([, descriptor]) => descriptor.kind === "diff",
    )?.[0];
  }

  function setDiffDescriptorForTab(
    targetEntry: DesktopSplitsEntry,
    tabId: TabID,
    options: DiffCreateOptions,
  ) {
    setDescriptor(targetEntry, tabId, {
      kind: "diff",
      worktreePath: options.worktreePath,
      relativePath: options.relativePath,
      openToken: options.openToken,
    });
  }

  // Tolerates an undefined descriptor: the tab-content snippet re-evaluates
  // this while a stale tab's content is being torn down, after its descriptor
  // is already gone.
  function diffRequestForTab(
    tabId: TabID,
    descriptor: DesktopDiffTabDescriptor | undefined,
  ): DiffCreateOptions | undefined {
    const request = diffOpenRequest;
    if (!request || request.entry !== entry || request.tabId !== tabId) return descriptor;
    return request;
  }

  function openDesktopDiffTab(
    detail: DesktopOpenDiffTabEventDetail | undefined,
    targetSurface: DesktopSplitSurface = "main",
    paneId?: PaneID,
  ): boolean {
    const currentEntry = entry;
    const worktreePath = detail?.worktreePath?.trim();
    const relativePath = detail?.relativePath?.trim();
    if (!currentEntry || !worktreePath || diffViewDisabledReason) return false;

    const options: DiffCreateOptions = {
      worktreePath,
      relativePath: relativePath || undefined,
      openToken: ++diffOpenToken,
    };

    const existingTabId = diffTabIdForEntry(currentEntry);
    if (existingTabId) {
      // Retarget the singleton diff tab instead of stacking another one.
      const controller = controllerForTab(currentEntry, existingTabId);
      if (!controller) return false;
      const surface = surfaceForController(currentEntry, controller);
      if (surface) {
        activeSurface = surface;
        revealDesktopSurface(surface);
      }
      const existingDescriptor = currentEntry.descriptors[existingTabId];
      if (
        existingDescriptor?.kind === "diff" &&
        normalizeWorkspacePath(existingDescriptor.worktreePath) ===
          normalizeWorkspacePath(options.worktreePath)
      ) {
        // Keep the mounted full diff intact. Only the target path/token need
        // to change, which lets DesktopDiffPanel animate to the requested file.
        diffOpenRequest = { entry: currentEntry, tabId: existingTabId, ...options };
      } else {
        diffOpenRequest = undefined;
        setDiffDescriptorForTab(currentEntry, existingTabId, options);
      }
      const tab = controller.tab(existingTabId);
      const tabOptions = diffTabOptions();
      if (tab?.title !== tabOptions.title || tab.icon !== tabOptions.icon) {
        controller.updateTab(existingTabId, tabOptions);
      }
      controller.selectTab(existingTabId);
      return true;
    }

    diffOpenRequest = undefined;
    activeSurface = targetSurface;
    revealDesktopSurface(targetSurface);
    const controller = controllerForSurface(currentEntry, targetSurface);
    pendingDiffCreateOptions = options;
    try {
      const tabId = controller.createTab({ ...diffTabOptions(), inPane: paneId });
      if (tabId) {
        setDiffDescriptorForTab(currentEntry, tabId, options);
        controller.selectTab(tabId);
      }
      return Boolean(tabId);
    } finally {
      pendingDiffCreateOptions = undefined;
    }
  }

  function createDiffForTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    tab: Tab,
    options: DiffCreateOptions,
  ) {
    setDiffDescriptorForTab(targetEntry, tab.id, options);
    controller.updateTab(tab.id, diffTabOptions());
  }

  function handleDesktopOpenDiffTabEvent(event: Event) {
    const detail = (event as CustomEvent<DesktopOpenDiffTabEventDetail>).detail;
    openDesktopDiffTab(detail);
  }

  function createDesktopTrajectoryTab(
    surface: DesktopSplitSurface = activeSurface,
    paneId?: PaneID,
  ): boolean {
    const currentEntry = entry;
    if (!currentEntry) return false;
    const controller = controllerForSurface(currentEntry, surface);
    return Boolean(createTrajectoryTab(currentEntry, controller, paneId));
  }

  function createTrajectoryTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    paneId?: PaneID,
  ): TabID | undefined {
    pendingTrajectoryCreate = true;
    try {
      const tabId = controller.createTab("ACP Events", {
        icon: "output",
        inPane: paneId,
      });
      if (tabId) {
        setTrajectoryDescriptorForTab(targetEntry, tabId);
        controller.selectTab(tabId);
      }
      return tabId;
    } finally {
      pendingTrajectoryCreate = false;
    }
  }

  function createTrajectoryForTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    tab: Tab,
  ) {
    setTrajectoryDescriptorForTab(targetEntry, tab.id);
    controller.updateTab(tab.id, trajectoryTabOptions());
  }

  function setTrajectoryDescriptorForTab(targetEntry: DesktopSplitsEntry, tabId: TabID) {
    setDescriptor(targetEntry, tabId, {
      kind: "trajectory",
    });
  }

  function trajectoryTabOptions(): Pick<Tab, "title" | "icon"> {
    return {
      title: "ACP Events",
      icon: "output",
    };
  }

  function closeActiveDesktopTab(): boolean {
    const currentEntry = entry;
    if (!currentEntry) return false;
    const controller = activeDesktopController(currentEntry);

    if (allDesktopTabIds(currentEntry).length <= 1) {
      requestDesktopWindowClose();
      return true;
    }

    const paneId = controller.focusedPaneId;
    if (!paneId) return false;

    const selectedTab = controller.selectedTab(paneId);
    if (!selectedTab) return false;
    if (selectedTab.isClosable === false) return true;

    controller.closeTab(selectedTab.id, paneId);
    return true;
  }

  function reopenLastClosedDesktopTab(): boolean {
    const currentEntry = entry;
    const closedTab = currentEntry?.lastClosedTab;
    if (!currentEntry || !closedTab) return false;

    currentEntry.lastClosedTab = undefined;
    if (closedTab.surface === "rightSidebar") {
      setRightSidebarVisible(true);
    } else if (closedTab.surface === "bottomPanel") {
      setBottomPanelVisible(true);
    }
    const controller = controllerForSurface(currentEntry, closedTab.surface);

    const tabOptions = {
      title: closedTab.tab.title,
      icon: closedTab.tab.icon,
      isDirty: closedTab.tab.isDirty,
      isClosable: closedTab.tab.isClosable,
    };
    const tabId = createTabFromDescriptor(currentEntry, closedTab, tabOptions, (opts) =>
      createRestoredDesktopTab(controller, closedTab, opts),
    );

    if (!tabId) {
      currentEntry.lastClosedTab = closedTab;
      return false;
    }

    controller.selectTab(tabId);
    return true;
  }

  /**
   * Sets the appropriate pending* variable, calls createTab, then calls the
   * per-kind descriptor setter.  Parameterising the create call lets both
   * moveTabToSurface (direct createTab) and reopenLastClosedDesktopTab
   * (createRestoredDesktopTab) share this dispatch.
   *
   * The pending* variables are read synchronously by didCreateTab during the
   * createTab call, so they must be set before and cleared after.
   */
  function createTabFromDescriptor(
    targetEntry: DesktopSplitsEntry,
    closedTab: ClosedDesktopTab,
    tabOptions: Pick<Tab, "title" | "icon" | "isDirty" | "isClosable">,
    createTab: (opts: Pick<Tab, "title" | "icon" | "isDirty" | "isClosable">) => TabID | undefined,
  ): TabID | undefined {
    if (closedTab.descriptor.kind === "terminal") {
      pendingTerminalCreateOptions = terminalCreateOptionsForClosedTab(closedTab);
      try {
        return createTab(tabOptions);
      } finally {
        pendingTerminalCreateOptions = undefined;
      }
    } else if (closedTab.descriptor.kind === "subagent-chat") {
      pendingSubagentCreateOptions = closedTab.descriptor;
      try {
        const tabId = createTab(tabOptions);
        if (tabId) {
          setSubagentDescriptorForTab(targetEntry, tabId, closedTab.descriptor);
        }
        return tabId;
      } finally {
        pendingSubagentCreateOptions = undefined;
      }
    } else if (closedTab.descriptor.kind === "trajectory") {
      pendingTrajectoryCreate = true;
      try {
        const tabId = createTab(tabOptions);
        if (tabId) {
          setTrajectoryDescriptorForTab(targetEntry, tabId);
        }
        return tabId;
      } finally {
        pendingTrajectoryCreate = false;
      }
    } else if (closedTab.descriptor.kind === "files") {
      const opts = { rootPath: closedTab.descriptor.rootPath };
      pendingFilesCreateOptions = opts;
      try {
        const tabId = createTab(tabOptions);
        if (tabId) {
          setFilesDescriptorForTab(targetEntry, tabId, opts);
        }
        return tabId;
      } finally {
        pendingFilesCreateOptions = undefined;
      }
    } else if (closedTab.descriptor.kind === "github") {
      const opts = { worktreePath: closedTab.descriptor.worktreePath };
      pendingGithubCreateOptions = opts;
      try {
        const tabId = createTab(tabOptions);
        if (tabId) {
          setGithubDescriptorForTab(targetEntry, tabId, opts.worktreePath);
        }
        return tabId;
      } finally {
        pendingGithubCreateOptions = undefined;
      }
    } else if (closedTab.descriptor.kind === "file") {
      const opts = {
        path: closedTab.descriptor.path,
        cwd: closedTab.descriptor.cwd,
        line: closedTab.descriptor.line,
        column: closedTab.descriptor.column,
        openToken: ++fileOpenToken,
      };
      pendingFileCreateOptions = opts;
      try {
        const tabId = createTab({ ...tabOptions, isDirty: false });
        if (tabId) {
          setFileDescriptorForTab(targetEntry, tabId, opts);
        }
        return tabId;
      } finally {
        pendingFileCreateOptions = undefined;
      }
    }
  }

  function createRestoredDesktopTab(
    controller: SplitsController,
    closedTab: ClosedDesktopTab,
    tabOptions: Pick<Tab, "title" | "icon" | "isDirty" | "isClosable">,
  ): TabID | undefined {
    if (controller.allPaneIds.includes(closedTab.paneId)) {
      return controller.createTab({
        ...tabOptions,
        inPane: closedTab.paneId,
      });
    }
    if (closedTab.wasOnlyTabInPane) {
      return createTabInRestoredSplit(controller, closedTab, tabOptions);
    }
    return controller.createTab(tabOptions);
  }

  function createTabInRestoredSplit(
    controller: SplitsController,
    closedTab: ClosedDesktopTab,
    tabOptions: Pick<Tab, "title" | "icon" | "isDirty" | "isClosable">,
  ): TabID | undefined {
    const targetPaneId = controller.focusedPaneId ?? controller.allPaneIds[0];
    if (!targetPaneId) return undefined;

    const placement = restoredSplitPlacement(controller, closedTab, targetPaneId);
    const newPaneId = controller.splitPane({
      paneId: targetPaneId,
      orientation: placement.orientation,
      insertFirst: placement.insertFirst,
      withTab: tabOptions,
    });
    if (!newPaneId) return undefined;

    return controller.selectedTab(newPaneId)?.id;
  }

  function restoredSplitPlacement(
    controller: SplitsController,
    closedTab: ClosedDesktopTab,
    targetPaneId: PaneID,
  ): { orientation: "horizontal" | "vertical"; insertFirst: boolean } {
    const targetPane = controller
      .layoutSnapshot()
      .panes.find((pane) => pane.paneId === targetPaneId);
    if (!closedTab.paneFrame || !targetPane) {
      return { orientation: "horizontal", insertFirst: false };
    }

    const closedCenterX = closedTab.paneFrame.x + closedTab.paneFrame.width / 2;
    const closedCenterY = closedTab.paneFrame.y + closedTab.paneFrame.height / 2;
    const targetCenterX = targetPane.frame.x + targetPane.frame.width / 2;
    const targetCenterY = targetPane.frame.y + targetPane.frame.height / 2;
    const deltaX = closedCenterX - targetCenterX;
    const deltaY = closedCenterY - targetCenterY;

    if (Math.abs(deltaY) > Math.abs(deltaX)) {
      return { orientation: "vertical", insertFirst: deltaY < 0 };
    }

    return { orientation: "horizontal", insertFirst: deltaX < 0 };
  }

  function selectPreviousDesktopTab(): boolean {
    const currentEntry = entry;
    return currentEntry ? selectRelativeVisibleDesktopTab(currentEntry, -1) : false;
  }

  function selectNextDesktopTab(): boolean {
    const currentEntry = entry;
    return currentEntry ? selectRelativeVisibleDesktopTab(currentEntry, 1) : false;
  }

  function requestDesktopTabFocus(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    paneId: PaneID,
    tabId: TabID,
  ) {
    if (suppressNextDesktopTabFocusRequest) return;

    const surface = surfaceForController(targetEntry, controller);
    if (!surface || entry !== targetEntry) return;
    desktopTabFocusRequest = {
      surface,
      paneId,
      tabId,
      token: ++desktopTabFocusToken,
    };
  }

  // Runs `apply` as background work when `takeFocus` is false: focus requests
  // raised inside the span are suppressed, `activeSurface` is pinned back to
  // where the user was, and any auxiliary surface the work made visible —
  // through revealDesktopSurface, layout hydration, or anything else — is
  // marked so the visibility effect does not focus it as it opens. The sweep
  // at the end of the span is what makes the policy complete: focus paths fire
  // from effects observing state the span mutated, so guarding the individual
  // mutation sites (a previous approach) missed the ones that were already
  // satisfied — e.g. a hydration opening the sidebar just before a reveal.
  // Restores rather than clears, so nesting stays honest.
  function applyingDesktopTabFocus<T>(takeFocus: boolean, apply: () => T): T {
    if (takeFocus) return apply();

    const previousSuppress = suppressNextDesktopTabFocusRequest;
    suppressNextDesktopTabFocusRequest = true;
    const previousActiveSurface = activeSurface;
    const heldDomFocus =
      document.activeElement !== null && document.activeElement !== document.body;
    const hiddenSurfaces = (["rightSidebar", "bottomPanel"] as const).filter(
      (surface) => !isDesktopAuxiliarySurfaceVisible(surface),
    );
    try {
      return apply();
    } finally {
      suppressNextDesktopTabFocusRequest = previousSuppress;
      activeSurface = previousActiveSurface;
      for (const surface of hiddenSurfaces) {
        if (isDesktopAuxiliarySurfaceVisible(surface)) {
          surfacesRevealedWithoutFocus.add(surface);
        }
      }
      // Not disturbing focus also means repairing it: a default-layout
      // hydration inside the span rebuilds every surface's tabs, unmounting
      // the element the user was typing into (usually the prompt) and
      // dropping DOM focus to <body>. The unmount lands at Svelte's flush,
      // after this synchronous span, so the check waits for tick. Repair by
      // focusing the surface the user was on — its recreated selected tab,
      // prompt included. If the user's element survived (or they moved
      // somewhere new in the meantime), focus is claimed and this is a no-op.
      if (heldDomFocus) {
        void tick().then(() => {
          const active = document.activeElement;
          if (active && active !== document.body) return;
          if (previousActiveSurface === "main") {
            focusMainDesktopSurface();
          } else {
            focusDesktopSurface(previousActiveSurface);
          }
        });
      }
    }
  }

  function focusTokenForDesktopTab(
    surface: DesktopSplitSurface,
    paneId: PaneID,
    tabId: TabID,
  ): number {
    return desktopTabFocusRequest?.surface === surface &&
      desktopTabFocusRequest.paneId === paneId &&
      desktopTabFocusRequest.tabId === tabId
      ? desktopTabFocusRequest.token
      : 0;
  }

  function isSelectedDesktopTab(
    surface: DesktopSplitSurface,
    paneId: PaneID,
    tabId: TabID,
  ): boolean {
    // Controller state is not reactive, so callers in pooled content (which the
    // owning pane never re-renders) would never see selection move. Reading the
    // revision makes every such caller recompute when it does.
    selectionRevision;
    const currentEntry = entry;
    return currentEntry
      ? controllerForSurface(currentEntry, surface).selectedTab(paneId)?.id === tabId
      : false;
  }

  function isDesktopPaneEmpty(surface: DesktopSplitSurface, paneId: PaneID): boolean {
    const currentEntry = entry;
    return currentEntry
      ? controllerForSurface(currentEntry, surface).tabs(paneId).length === 0
      : false;
  }

  function isDesktopSurfaceEmpty(surface: DesktopSplitSurface): boolean {
    const currentEntry = entry;
    return currentEntry
      ? controllerForSurface(currentEntry, surface).allTabIds.length === 0
      : false;
  }

  function focusRequestedDesktopTab(request: DesktopTabFocusRequest) {
    if (desktopTabFocusRequest?.token !== request.token) return;
    if (request.surface === "rightSidebar" && !rightSidebarVisible) return;
    if (request.surface === "bottomPanel" && !bottomPanelVisible) return;

    const contentElement = desktopTabContentElement(request);
    if (!contentElement) return;

    const focusTarget =
      contentElement.querySelector<HTMLElement>('[data-testid="prompt-input"]') ??
      contentElement.querySelector<HTMLElement>(".xterm-helper-textarea") ??
      contentElement.querySelector<HTMLElement>('[contenteditable="true"]');

    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
      return;
    }

    contentElement.focus({ preventScroll: true });
  }

  function desktopTabContentElement(
    request: Pick<DesktopTabFocusRequest, "surface" | "paneId" | "tabId">,
  ): HTMLElement | undefined {
    const elements =
      desktopSplitsFrameElement?.querySelectorAll<HTMLElement>(
        "[data-desktop-tab-content-pane-id][data-desktop-tab-content-tab-id]",
      ) ?? [];

    return [...elements].find(
      (element) =>
        element.dataset.desktopTabContentSurface === request.surface &&
        element.dataset.desktopTabContentPaneId === request.paneId &&
        element.dataset.desktopTabContentTabId === request.tabId,
    );
  }

  function selectRelativeVisibleDesktopTab(
    targetEntry: DesktopSplitsEntry,
    direction: -1 | 1,
  ): boolean {
    const tabs = visibleDesktopTabs(targetEntry);
    if (tabs.length === 0) return false;

    const currentIndex = currentVisibleDesktopTabIndex(targetEntry, tabs);
    const targetIndex = (currentIndex + direction + tabs.length) % tabs.length;
    const target = tabs[targetIndex];
    if (!target) return false;

    activeSurface = target.surface;
    return selectVisibleDesktopTab(targetEntry, target);
  }

  function selectVisibleDesktopTab(
    targetEntry: DesktopSplitsEntry,
    target: VisibleDesktopTab,
  ): boolean {
    const didSelect = target.controller.selectTab(target.tabId);
    if (!didSelect) return false;

    const paneId = target.controller
      .layoutSnapshot()
      .panes.find((pane) => pane.tabIds.includes(target.tabId))?.paneId;
    if (paneId) {
      requestDesktopTabFocus(targetEntry, target.controller, paneId, target.tabId);
    }

    return true;
  }

  function currentVisibleDesktopTabIndex(
    targetEntry: DesktopSplitsEntry,
    tabs: VisibleDesktopTab[],
  ): number {
    const controller = activeDesktopController(targetEntry);
    const surface = surfaceForController(targetEntry, controller) ?? "main";
    const focusedPaneId = controller.focusedPaneId;
    const selectedTabId = focusedPaneId ? controller.selectedTab(focusedPaneId)?.id : undefined;
    if (selectedTabId) {
      const index = tabs.findIndex(
        (candidate) => candidate.surface === surface && candidate.tabId === selectedTabId,
      );
      if (index !== -1) return index;
    }

    const firstTabInSurface = tabs.findIndex((candidate) => candidate.surface === surface);
    return firstTabInSurface === -1 ? 0 : firstTabInSurface;
  }

  function visibleDesktopTabs(targetEntry: DesktopSplitsEntry): VisibleDesktopTab[] {
    return visibleDesktopSurfaces().flatMap((surface) => {
      const controller = controllerForSurface(targetEntry, surface);
      return controller.allTabIds.flatMap((tabId) => {
        const tab = controller.tab(tabId);
        return tab ? [{ surface, controller, tabId, tab }] : [];
      });
    });
  }

  function visibleDesktopSurfaces(): DesktopSplitSurface[] {
    return [
      "main",
      ...(rightSidebarVisible ? (["rightSidebar"] as const) : []),
      ...(bottomPanelVisible ? (["bottomPanel"] as const) : []),
    ];
  }

  function requestDesktopWindowClose() {
    window.dispatchEvent(new CustomEvent(DESKTOP_CLOSE_WINDOW_EVENT));
  }

  function handleChatActiveConversationIdChange(conversationId: string | null) {
    if (conversationId && conversationId !== activeConversationId) {
      const renamedEntry = splitsCache.rename(layoutKey, conversationId);
      try {
        renameStoredDesktopLayout(layoutKey, conversationId);
      } catch (error) {
        console.debug("Unable to rename persisted desktop layout", error);
      }
      if (renamedEntry && entry === renamedEntry) {
        entry = renamedEntry;
        descriptors = renamedEntry.descriptors;
      }
    }
    onActiveConversationIdChange?.(conversationId);
  }

  function isPreviousTabKey(event: KeyboardEvent): boolean {
    return event.code === "BracketLeft" || event.key === "[" || event.key === "{";
  }

  function isNextTabKey(event: KeyboardEvent): boolean {
    return event.code === "BracketRight" || event.key === "]" || event.key === "}";
  }

  function closedTabSnapshot(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    tab: Tab,
    paneId: PaneID,
  ): ClosedDesktopTab | undefined {
    const descriptor = restorableDesktopTabDescriptor(targetEntry.descriptors[tab.id]);
    if (!descriptor) return undefined;

    const surface = surfaceForController(targetEntry, controller);
    if (!surface) return undefined;

    const paneFrame = controller
      .layoutSnapshot()
      .panes.find((pane) => pane.paneId === paneId)?.frame;

    return {
      tabId: tab.id,
      tab: {
        title: tab.title,
        icon: tab.icon,
        isDirty: tab.isDirty,
        isClosable: tab.isClosable,
      },
      descriptor,
      surface,
      paneId,
      paneFrame,
      wasOnlyTabInPane: controller.tabs(paneId).length <= 1,
    };
  }

  function restorableDesktopTabDescriptor(
    descriptor: DesktopTabDescriptor | undefined,
  ): RestorableDesktopTabDescriptor | undefined {
    if (descriptor?.kind === "subagent-chat") {
      return { ...descriptor };
    }
    if (descriptor?.kind === "trajectory") {
      return {
        kind: "trajectory",
      };
    }
    if (descriptor?.kind === "files") {
      return {
        kind: "files",
        rootPath: descriptor.rootPath || filesRootPath,
      };
    }
    if (descriptor?.kind === "github") {
      return {
        kind: "github",
        worktreePath: descriptor.worktreePath || filesRootPath,
      };
    }
    if (descriptor?.kind === "file") {
      return {
        kind: "file",
        path: descriptor.path,
        cwd: descriptor.cwd,
        line: descriptor.line,
        column: descriptor.column,
      };
    }
    if (descriptor?.kind !== "terminal") return undefined;

    const worktreePath = descriptor.worktreePath || terminalWorktreePath;
    const liveCwd = descriptor.terminalId
      ? assistantTerminals.tabs.find((candidate) => candidate.id === descriptor.terminalId)?.cwd
      : undefined;
    return {
      kind: "terminal",
      worktreePath,
      cwd: restorableTerminalCwd(liveCwd, worktreePath),
    };
  }

  function terminalCreateOptionsForClosedTab(closedTab: ClosedDesktopTab): TerminalCreateOptions {
    if (closedTab.descriptor.kind !== "terminal") {
      return { worktreePath: terminalWorktreePath };
    }
    return {
      worktreePath: closedTab.descriptor.worktreePath || terminalWorktreePath,
      cwd: closedTab.descriptor.cwd,
    };
  }

  async function openExternalTerminal(
    worktreePath: string,
    options: {
      command?: string;
      env?: Record<string, string>;
      commandMode?: AssistantTerminalCommandMode;
      placement?: AssistantTerminalPlacement;
      layoutKey?: string;
      reuseExisting?: boolean;
      focus?: boolean;
    } = {},
  ): Promise<AssistantTerminalTab | undefined> {
    await tick();
    const targetEntry = options.layoutKey ? entryForLayout(options.layoutKey) : entry;
    if (!targetEntry) return undefined;
    const createOptions = {
      worktreePath,
      command: options.command,
      env: options.env,
      commandMode: options.commandMode,
      placement: options.placement,
      focus: options.focus,
    };
    const surface = surfaceForTerminalPlacement(options.placement);

    // Creating or selecting a tab normally asks for focus (didSelectTab); a
    // background open only wants the tab on screen.
    const takeFocus = options.focus !== false;
    const tabId = applyingDesktopTabFocus(takeFocus, () => {
      // A worktree setup terminal can arrive before the conversation's session
      // id does. Apply the deferred default layout now, before adding the tab;
      // otherwise the later hydration would restore over it (killing the
      // terminal mid-setup via the requestId guard in createTerminalForTab).
      // Inside the span: hydration can open a persisted sidebar, and a
      // background open must not let that hand the sidebar focus. Only the
      // active entry can be hydrated safely here: hydration persists via the
      // module-level active entry, and a background entry is already protected
      // by the live-content check when it later hydrates on becoming active.
      if (targetEntry === entry && targetEntry.pendingDefaultLayoutHydration) {
        hydratePendingDefaultLayout(targetEntry);
      }
      const controller = surface
        ? controllerForSurface(targetEntry, surface)
        : activeDesktopController(targetEntry);
      const reusedTabId = options.reuseExisting
        ? reuseTerminalTabForCommand(targetEntry, controller, worktreePath, createOptions)
        : undefined;
      if (reusedTabId) {
        controller.selectTab(reusedTabId);
      }
      const openedTabId = reusedTabId ?? createTerminalTab(controller, createOptions);
      if (targetEntry === entry && surface) {
        revealDesktopSurface(surface);
      }
      return openedTabId;
    });
    if (!tabId) return undefined;
    return await targetEntry.terminalPromises.get(tabId);
  }

  // Reuses an existing terminal tab on the target surface (e.g. one restored
  // from the default layout) as the slot for a visible command: the tab keeps
  // its place in the layout, but its idle shell is replaced with a fresh
  // host-spawned command terminal. Running the command in a new PTY — instead
  // of typing into the live shell — keeps execution independent of the user's
  // shell flavor, the shell's current directory, and any pending startup
  // clears on the restored terminal view.
  function reuseTerminalTabForCommand(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    worktreePath: string,
    createOptions: TerminalCreateOptions,
  ): TabID | undefined {
    for (const tabId of controller.allTabIds) {
      const descriptor = targetEntry.descriptors[tabId];
      if (descriptor?.kind !== "terminal" || descriptor.status === "failed") continue;
      const descriptorWorktreePath = descriptor.worktreePath || terminalWorktreePath;
      if (normalizeWorkspacePath(descriptorWorktreePath) !== normalizeWorkspacePath(worktreePath)) {
        continue;
      }
      const tab = controller.tab(tabId);
      const paneId = controller
        .layoutSnapshot()
        .panes.find((pane) => pane.tabIds.includes(tabId))?.paneId;
      if (!tab || !paneId) continue;

      // Retire the tab's current shell. A ready terminal is deleted directly;
      // a still-pending one is orphaned by the descriptor's requestId changing
      // in createTerminalForTab, which deletes it on arrival.
      if (descriptor.status === "ready" && descriptor.terminalId) {
        void deleteTerminal(descriptor.terminalId);
      }
      void createTerminalForTab(targetEntry, controller, tab, paneId, createOptions);
      return tabId;
    }
    return undefined;
  }

  function surfaceForTerminalPlacement(
    placement: AssistantTerminalPlacement | undefined,
  ): DesktopSplitSurface | undefined {
    switch (placement) {
      case "splitRight":
        return "rightSidebar";
      case "bottomPanel":
        return "bottomPanel";
      case "mainTab":
        return "main";
      default:
        return undefined;
    }
  }

  function revealDesktopSurface(surface: DesktopSplitSurface) {
    if (surface === "rightSidebar") {
      setRightSidebarVisible(true);
    } else if (surface === "bottomPanel") {
      setBottomPanelVisible(true);
    }
    activeSurface = surface;
  }

  function isDesktopAuxiliarySurfaceVisible(surface: DesktopAuxiliarySurface): boolean {
    return surface === "rightSidebar" ? rightSidebarVisible : bottomPanelVisible;
  }

  function createTerminalForTab(
    targetEntry: DesktopSplitsEntry,
    controller: SplitsController,
    tab: Tab,
    _paneId: PaneID,
    options: TerminalCreateOptions,
  ): Promise<AssistantTerminalTab | undefined> {
    const requestId = crypto.randomUUID();
    const worktreePath = options.worktreePath || terminalWorktreePath;
    setDescriptor(targetEntry, tab.id, {
      kind: "terminal",
      worktreePath,
      status: "pending",
      requestId,
    });
    controller.updateTab(tab.id, {
      title: "Terminal",
      icon: null,
    });

    const promise = (async () => {
      if (targetEntry.disposed) {
        return undefined;
      }

      if (!worktreePath) {
        setTerminalFailed(targetEntry, tab.id, requestId, "No workspace is available.");
        return undefined;
      }

      try {
        const terminal = await assistantTerminals.createTab(
          worktreePath,
          options.command,
          options.env,
          options.commandMode,
          options.cwd,
        );
        if (!terminal) {
          setTerminalFailed(targetEntry, tab.id, requestId, "Terminal could not be created.");
          return undefined;
        }

        if (targetEntry.disposed) {
          await deleteTerminal(terminal.id);
          return undefined;
        }

        const currentDescriptor = targetEntry.descriptors[tab.id];
        if (currentDescriptor?.kind !== "terminal" || currentDescriptor.requestId !== requestId) {
          await deleteTerminal(terminal.id);
          return undefined;
        }

        setDescriptor(targetEntry, tab.id, {
          kind: "terminal",
          worktreePath: terminal.worktreePath,
          status: "ready",
          terminalId: terminal.id,
          requestId,
        });
        controllerForTab(targetEntry, tab.id)?.updateTab(tab.id, {
          title: terminalDisplayTitle(terminal),
          icon: null,
        });
        if (options.selectWhenReady !== false) {
          // The tab comes forward when its shell finally arrives, but a
          // background terminal must not take focus that late — the user has
          // long since started typing somewhere else.
          applyingDesktopTabFocus(options.focus !== false, () =>
            controllerForTab(targetEntry, tab.id)?.selectTab(tab.id),
          );
        }
        return terminal;
      } catch (error) {
        setTerminalFailed(targetEntry, tab.id, requestId, getUnknownErrorMessage(error));
        return undefined;
      }
    })();

    targetEntry.terminalPromises.set(tab.id, promise);
    void promise.finally(() => targetEntry.terminalPromises.delete(tab.id));
    return promise;
  }

  function setTerminalFailed(
    targetEntry: DesktopSplitsEntry,
    tabId: TabID,
    requestId: string,
    error: string,
  ) {
    if (targetEntry.disposed) return;
    const descriptor = targetEntry.descriptors[tabId];
    if (descriptor?.kind !== "terminal" || descriptor.requestId !== requestId) return;
    setDescriptor(targetEntry, tabId, {
      ...descriptor,
      status: "failed",
      error,
    });
    controllerForTab(targetEntry, tabId)?.updateTab(tabId, {
      title: "Terminal failed",
      icon: null,
    });
  }

  function setDescriptor(
    targetEntry: DesktopSplitsEntry,
    tabId: TabID,
    descriptor: DesktopTabDescriptor,
  ) {
    if (targetEntry.disposed) return;
    targetEntry.descriptors = {
      ...targetEntry.descriptors,
      [tabId]: descriptor,
    };
    syncDescriptors(targetEntry);
  }

  function removeDescriptor(targetEntry: DesktopSplitsEntry, tabId: TabID) {
    if (targetEntry.disposed) return;
    const { [tabId]: _removed, ...nextDescriptors } = targetEntry.descriptors;
    targetEntry.descriptors = nextDescriptors;
    syncDescriptors(targetEntry);
  }

  function syncDescriptors(targetEntry: DesktopSplitsEntry) {
    if (entry === targetEntry) {
      descriptors = targetEntry.descriptors;
    }
    schedulePersistDesktopLayout();
  }

  function schedulePersistDesktopLayout() {
    const currentEntry = entry;
    if (!currentEntry || currentEntry.disposed) return;

    if (desktopLayoutPersistTimer) {
      clearTimeout(desktopLayoutPersistTimer);
    }
    desktopLayoutPersistTimer = setTimeout(() => {
      desktopLayoutPersistTimer = undefined;
      if (entry !== currentEntry || currentEntry.disposed) return;
      persistDesktopLayout(currentEntry);
    }, DESKTOP_LAYOUT_PERSIST_DELAY_MS);
  }

  function persistDesktopLayout(targetEntry: DesktopSplitsEntry) {
    if (targetEntry.disposed || targetEntry.pendingDefaultLayoutHydration) return;

    try {
      const layout = captureCurrentDesktopLayout(targetEntry);
      if (!layout) return;
      writeStoredDesktopLayout(targetEntry.cacheKey, layout);
    } catch (error) {
      console.debug("Unable to persist desktop layout", error);
    }
  }

  function captureCurrentDesktopLayout(
    targetEntry: DesktopSplitsEntry,
    { shapeOnly = false }: { shapeOnly?: boolean } = {},
  ): PersistedDesktopLayout | undefined {
    return captureDesktopSplitsLayout(targetEntry, {
      rightSidebarVisible,
      bottomPanelVisible,
      activeSurface,
      // The default layout is a template reused across worktrees; persisting a
      // terminal's worktree/cwd there would leak one conversation's paths into
      // every other. Conversation layouts keep their own paths.
      shapeOnlyTerminals: shapeOnly,
      excludeConversationSpecificTabs: shapeOnly,
      terminalCwd: (terminalId) =>
        assistantTerminals.tabs.find((tab) => tab.id === terminalId)?.cwd,
    });
  }

  function saveCurrentDesktopLayoutAsDefault(): boolean {
    const currentEntry = entry;
    if (!currentEntry) return false;

    try {
      const layout = captureCurrentDesktopLayout(currentEntry, { shapeOnly: true });
      if (!layout) {
        throw new Error("The current layout is not ready to save.");
      }
      writeStoredDefaultDesktopLayout(layout);
      return true;
    } catch (error) {
      rpc.showInfoMessage(
        `Failed to save layout: ${getUnknownErrorMessage(error)}`,
        InfoMessageType.error,
      );
      return false;
    }
  }

  async function deleteTerminal(terminalId: string) {
    try {
      await assistantTerminals.deleteTab(terminalId);
    } catch (error) {
      console.debug("Unable to delete assistant terminal", error);
    }
  }

  function desktopTargetKind(path: string): "project" | "worktree" {
    const target = projects.projects.find(
      (project) => normalizeWorkspacePath(project.path) === normalizeWorkspacePath(path),
    );
    return target?.isWorktree ? "worktree" : "project";
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

  function formatTerminalCwdTitle(path: string | undefined): string {
    if (!path) return "Terminal";

    const normalized = normalizeWorkspacePath(path);
    if (!normalized) return "Terminal";

    const homePath = inferHomePath(normalized);
    if (!homePath) return normalized;
    if (normalized === homePath) return "~";

    return `~/${normalized.slice(homePath.length).replace(/^\/+/, "")}`;
  }

  function terminalDisplayTitle(terminal: AssistantTerminalTab): string {
    return formatTerminalCwdTitle(terminal.cwd || terminal.worktreePath || terminal.title);
  }

  function inferHomePath(path: string): string | null {
    const posixHome = path.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/);
    if (posixHome) return posixHome[0];

    const windowsHome = path.match(/^[a-z]:\/Users\/[^/]+(?=\/|$)/i);
    return windowsHome?.[0] ?? null;
  }

  function topRightPaneIdForController(controller: SplitsController): PaneID | undefined {
    const panes = controller.layoutSnapshot().panes;
    if (panes.length === 0) return undefined;

    const tolerance = 1;
    return panes.reduce((best, pane) => {
      const paneTop = pane.frame.y;
      const bestTop = best.frame.y;
      if (paneTop < bestTop - tolerance) return pane;

      if (Math.abs(paneTop - bestTop) <= tolerance) {
        const paneRight = pane.frame.x + pane.frame.width;
        const bestRight = best.frame.x + best.frame.width;
        if (paneRight > bestRight + tolerance) return pane;

        if (Math.abs(paneRight - bestRight) <= tolerance && pane.frame.x > best.frame.x) {
          return pane;
        }
      }

      return best;
    }).paneId;
  }

  function topLeftPaneIdForController(controller: SplitsController): PaneID | undefined {
    const panes = controller.layoutSnapshot().panes;
    if (panes.length === 0) return undefined;

    const tolerance = 1;
    return panes.reduce((best, pane) => {
      const paneTop = pane.frame.y;
      const bestTop = best.frame.y;
      if (paneTop < bestTop - tolerance) return pane;

      if (Math.abs(paneTop - bestTop) <= tolerance) {
        if (pane.frame.x < best.frame.x - tolerance) return pane;
      }

      return best;
    }).paneId;
  }

  function desktopNewTabActions(
    surface: DesktopSplitSurface,
    paneId: PaneID,
  ): DesktopNewTabAction[] {
    return [
      {
        label: "Terminal",
        icon: "terminal",
        onSelect: () => createDesktopTerminalTab(surface, paneId),
      },
      {
        label: "Files",
        icon: "folder-open",
        disabled: !filesRootPath,
        disabledReason: "No working directory",
        onSelect: () => createDesktopFilesTab(surface, paneId),
      },
      {
        label: "Review Diff",
        icon: "diff",
        disabled: diffViewDisabledReason !== undefined,
        disabledReason: diffViewDisabledReason,
        onSelect: () => {
          openDesktopDiffTab({ worktreePath: githubWorktreePath }, surface, paneId);
        },
      },
      {
        label: "GitHub",
        icon: "github",
        disabled: !githubWorktreePath,
        disabledReason: "No working directory",
        onSelect: () => {
          activeSurface = surface;
          createDesktopGithubTab(surface, paneId);
        },
      },
      {
        label: "ACP Events",
        icon: "output",
        onSelect: () => {
          activeSurface = surface;
          createDesktopTrajectoryTab(surface, paneId);
        },
      },
    ];
  }
</script>

{#snippet desktopTabIcon(tab: Tab)}
  {@const descriptor = descriptors[tab.id]}
  {#if descriptor?.kind === "chat"}
    <span class="desktop-chat-tab-icon" aria-hidden="true">
      <RegistryAgentIcon
        iconUrl={chatTabIconUrl}
        size={14}
        {...chatTabIconProps}
        class={chatTabIconProps.class}
      />
    </span>
  {:else if descriptor?.kind === "subagent-chat"}
    <span class="desktop-chat-tab-icon" aria-hidden="true">
      <RegistryAgentIcon
        iconUrl={chatTabIconUrl}
        size={14}
        {...chatTabIconProps}
        class={chatTabIconProps.class}
      />
    </span>
  {:else if descriptor?.kind === "terminal"}
    <Icon name="terminal" size={14} class="opacity-80" aria-hidden="true" />
  {:else if descriptor?.kind === "files"}
    <Icon name="folder-open" size={14} class="opacity-80" aria-hidden="true" />
  {:else if descriptor?.kind === "github"}
    <Icon name="github" size={14} class="opacity-80" aria-hidden="true" />
  {:else if descriptor?.kind === "diff"}
    <Icon name="diff" size={14} class="opacity-80" aria-hidden="true" />
  {:else if descriptor?.kind === "file"}
    <Icon
      type="file"
      name={descriptor?.path ?? ""}
      fallback="file"
      size={14}
      class="opacity-80"
      aria-hidden="true"
    />
  {:else if descriptor?.kind === "trajectory"}
    <Icon name="output" size={14} class="opacity-80" aria-hidden="true" />
  {/if}
{/snippet}

{#snippet desktopTabTrailing(tab: Tab)}
  {@const descriptor = descriptors[tab.id]}
  {#if descriptor?.kind === "chat" && chatTabStatus !== "default"}
    <span
      aria-hidden="true"
      class={["desktop-chat-tab-status", `desktop-chat-tab-status--${chatTabStatus}`]}
      data-testid="desktop-chat-tab-status"
      data-status={chatTabStatus}
    ></span>
  {:else if descriptor?.kind === "subagent-chat"}
    {@const subagentStatus = desktopChatSession.subagents.referenceForKey(
      descriptor.subagentKey,
    )?.status}
    {@const status = desktopSubagentTabStatusKind(subagentStatus, unreadSubagentTabIds.has(tab.id))}
    {#if status !== "default"}
      <span
        aria-hidden="true"
        class={["desktop-chat-tab-status", `desktop-chat-tab-status--${status}`]}
        data-testid="desktop-subagent-tab-status"
        data-status={status}
      ></span>
    {/if}
  {/if}
{/snippet}

{#snippet desktopNewTabButton(surface: DesktopSplitSurface, paneId: PaneID)}
  {#if !isDesktopPaneEmpty(surface, paneId)}
    <div class="desktop-new-tab-button-frame">
      <button
        type="button"
        class="desktop-new-tab-button"
        aria-label="New tab"
        title="New Tab"
        data-tauri-drag-region="false"
        onclick={() => openDesktopNewTabPicker(surface, paneId)}
      >
        <Icon name="plus" aria-hidden="true" size={18} weight={0.85} />
      </button>
    </div>
  {/if}
{/snippet}

{#snippet desktopEmptyPane(surface: DesktopSplitSurface, paneId: PaneID)}
  {@const actions = desktopNewTabActions(surface, paneId)}
  {#if isDesktopSurfaceEmpty(surface)}
    <div class="desktop-empty-pane" aria-label="Open tab">
      <div class="desktop-empty-pane-content">
        <div class="desktop-empty-pane-title">Create new tab</div>
        <div class="desktop-empty-pane-actions">
          {#each actions as action (action.label)}
            <button
              type="button"
              class="desktop-empty-pane-button"
              data-tauri-drag-region="false"
              disabled={action.disabled}
              aria-disabled={action.disabled}
              title={action.disabled ? action.disabledReason : undefined}
              onclick={() => {
                if (action.disabled) return;
                action.onSelect();
              }}
            >
              <Icon name={action.icon} size={15} aria-hidden="true" />
              <span>{action.label}</span>
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}
{/snippet}

{#snippet rightSidebarToggleButton(visible: boolean)}
  <button
    type="button"
    aria-label={visible ? "Hide secondary sidebar" : "Show secondary sidebar"}
    title={sidebarShortcutTitle(visible ? "Hide secondary sidebar" : "Show secondary sidebar")}
    class={desktopFrameActionButtonClass}
    data-tauri-drag-region="false"
    onpointerdown={() => captureFocusBeforeDesktopSurfaceToggle("rightSidebar")}
    onclick={toggleRightSidebar}
  >
    <Icon
      name={visible ? "sidebar-right-open" : "sidebar-right-closed"}
      size={16}
      aria-hidden="true"
    />
  </button>
{/snippet}

{#snippet bottomPanelToggleButton(visible: boolean)}
  <button
    type="button"
    aria-label={visible ? "Hide panel" : "Show panel"}
    title={panelShortcutTitle(visible ? "Hide panel" : "Show panel")}
    class={desktopFrameActionButtonClass}
    data-tauri-drag-region="false"
    onpointerdown={() => captureFocusBeforeDesktopSurfaceToggle("bottomPanel")}
    onclick={toggleBottomPanel}
  >
    <Icon
      name={visible ? "panel-bottom-open" : "panel-bottom-closed"}
      size={16}
      aria-hidden="true"
    />
  </button>
{/snippet}

{#snippet desktopUtilityTabBarActions()}
  <!-- Unlike AcpConversationHeader, the tab strip is never painted with the
       desktop instance color, so the controls keep their themed tone (the
       white-on-color treatment would be invisible on the light theme). -->
  <DesktopGithubControl compact targetPath={terminalWorktreePath} />
  <DesktopOpenTargetControl
    compact
    targetKind={desktopOpenTargetKind}
    targetPath={terminalWorktreePath}
  />
{/snippet}

{#snippet desktopTabBarActions(surface: DesktopSplitSurface, paneId: PaneID)}
  {#if surface === "main" && paneId === mainTopRightPaneId && !rightSidebarVisible}
    <div class="desktop-frame-actions-spacer" aria-hidden="true"></div>
  {:else if surface === "rightSidebar" && paneId === rightSidebarTopRightPaneId && rightSidebarVisible}
    <div class="desktop-frame-actions-spacer" aria-hidden="true"></div>
  {/if}
{/snippet}

{#snippet desktopTabContent(surface: DesktopSplitSurface, tabId: TabID, paneId: PaneID)}
  <!-- `descriptors` can momentarily lack this tab while stale content is being
       torn down (entry swap, tab close): descriptor-dependent reads re-evaluate
       before the branch unmounts, so every deref below must stay undefined-safe
       even inside a kind-narrowed branch. -->
  {@const descriptor = descriptors[tabId]}
  {@const focusToken = focusTokenForDesktopTab(surface, paneId, tabId)}
  {@const isSelected = isSelectedDesktopTab(surface, paneId, tabId)}
  <div
    class="desktop-tab-content"
    tabindex="-1"
    data-desktop-tab-content-surface={surface}
    data-desktop-tab-content-pane-id={paneId}
    data-desktop-tab-content-tab-id={tabId}
  >
    {#if descriptor?.kind === "chat"}
      <AcpChatPane
        chrome={{
          sidebar: {
            collapsed: sidebarCollapsed,
            width: desktopSidebarWidth,
            onExpand: () => onExpandSidebar?.(),
          },
          header: "none",
          terminal: { surface: "external", open: openExternalTerminal },
          frame: "plain",
        }}
        {promptBanners}
        {promptCommandItems}
        {promptMenus}
        {promptFooterLeading}
        {activeConversationId}
        markReadWhenVisible={isSelected}
        onActiveConversationIdChange={handleChatActiveConversationIdChange}
        {onNewConversation}
        {onAddProject}
        {onShowAgentSettings}
        {onShowModelSettings}
      />
    {:else if descriptor?.kind === "subagent-chat"}
      <SubagentChatPane subagentKey={descriptor.subagentKey} />
    {:else if descriptor?.kind === "terminal"}
      <div class="desktop-terminal-split-content">
        {#if descriptor?.status === "failed"}
          <div class="desktop-terminal-message">
            <div>Terminal could not open.</div>
            {#if descriptor?.error}
              <div class="desktop-terminal-error">{descriptor?.error}</div>
            {/if}
          </div>
        {:else}
          <AssistantTerminalView terminalId={descriptor?.terminalId} {focusToken} />
        {/if}
      </div>
    {:else if descriptor?.kind === "files"}
      <DesktopFilesTree
        cacheKey={`${entry?.cacheKey ?? "desktop"}:${tabId}`}
        rootPath={descriptor?.rootPath ?? ""}
        active={isSelected &&
          (surface === "main" ||
            (surface === "rightSidebar" && rightSidebarVisible) ||
            (surface === "bottomPanel" && bottomPanelVisible))}
        openTerminal={(cwd) => openTerminalFromFilesTree(surface, paneId, cwd)}
      />
    {:else if descriptor?.kind === "github"}
      <DesktopGitHubPanel
        worktreePath={descriptor?.worktreePath ?? ""}
        {focusToken}
        onTitleChange={(title) => updateGithubTabTitle(tabId, title)}
      />
    {:else if descriptor?.kind === "diff"}
      {@const request = diffRequestForTab(tabId, descriptor)}
      <DesktopDiffPanel
        worktreePath={descriptor?.worktreePath ?? ""}
        relativePath={request?.relativePath}
        openToken={request?.openToken ?? 0}
      />
    {:else if descriptor?.kind === "file"}
      {#if desktopFileViewerPanel}
        {@const DesktopFileViewerPanel = desktopFileViewerPanel}
        <DesktopFileViewerPanel
          path={descriptor?.path ?? ""}
          cwd={descriptor?.cwd}
          line={descriptor?.line}
          column={descriptor?.column}
          openToken={descriptor?.openToken ?? 0}
          {focusToken}
          initialCodeFontFamily={desktopCodeFontFamily}
          initialCodeFontSize={desktopCodeFontSize}
          onFileContextChange={(file) => handleDesktopFileContextChange(tabId, file)}
        />
      {:else}
        <div class="desktop-terminal-message">File viewer is unavailable.</div>
      {/if}
    {:else if descriptor?.kind === "trajectory"}
      <AcpTrajectoryViewer sidebarCollapsed={false} embedded />
    {:else}
      <div class="desktop-terminal-message">This view is unavailable.</div>
    {/if}
  </div>
{/snippet}

<div class={["desktop-splits-panel", sidebarCollapsed ? "desktop-splits-panel--no-border" : ""]}>
  <div class="desktop-main-panel-top-drag-region" data-tauri-drag-region="deep"></div>

  <div bind:this={desktopSplitsFrameElement} class="desktop-splits-frame">
    {#if entry}
      <!-- Keyed on the entry so a layout-key switch tears the old tabs' content
           down as a unit: without the boundary, mounted content can observe the
           new entry's `descriptors` map (whose keys don't match its tab) before
           it unmounts. -->
      {#key entry}
        <!-- Content lives here and is reparented into the pane slot that owns
             each tab, so moving a tab between panes never remounts its view.
             Anything no slot claims parks here until one does. -->
        <div class="desktop-tab-content-pool" use:desktopTabContentPoolHost aria-hidden="true">
          {#each pooledTabs as pooled (pooled.tabId)}
            <div class="desktop-tab-content-pool-item" use:pooledDesktopTabContent={pooled.tabId}>
              {@render desktopTabContent(pooled.surface, pooled.tabId, pooled.paneId)}
            </div>
          {/each}
        </div>
        <div
          class={[
            "desktop-splits-layout",
            rightSidebarVisible ? "" : "desktop-splits-layout--right-hidden",
          ]}
        >
          <div class="desktop-splits-main-stack">
            <div
              class="desktop-splits-main-surface"
              data-desktop-surface="main"
              data-desktop-surface-active={activeSurface === "main" ? "true" : undefined}
              onfocusin={() => setActiveDesktopSurface("main")}
              onpointerdowncapture={() => setActiveDesktopSurface("main")}
            >
              <SplitsView
                controller={entry.mainController}
                style="--splits-tab-action-icon-size: 12px; --splits-tab-close-size: 16px;"
                tabBarWindowDrag
                usePaneShape
                paneShapeAnimating={paneShapesAnimating}
                onTabContextMenu={handleTabContextMenu}
              >
                {#snippet tabBarLeading(paneId)}
                  {#if paneId === mainTopLeftPaneId}
                    <div
                      class={[
                        "desktop-tab-bar-traffic-light-spacer",
                        sidebarCollapsed ? "" : "desktop-tab-bar-traffic-light-spacer--hidden",
                        sidebarCollapsed && $desktopUpdate.available
                          ? "desktop-tab-bar-traffic-light-spacer--with-update"
                          : "",
                      ]}
                      data-tauri-drag-region="deep"
                      aria-hidden="true"
                    ></div>
                  {/if}
                {/snippet}

                {#snippet tabIcon(tab)}
                  {@render desktopTabIcon(tab)}
                {/snippet}

                {#snippet tabTrailing(tab)}
                  {@render desktopTabTrailing(tab)}
                {/snippet}

                {#snippet newTabButton(paneId)}
                  {@render desktopNewTabButton("main", paneId)}
                {/snippet}

                {#snippet tabBarActions(paneId)}
                  {@render desktopTabBarActions("main", paneId)}
                {/snippet}

                {#snippet children(tab, paneId)}
                  <div class="desktop-tab-content-slot" use:adoptDesktopTabContent={tab.id}></div>
                {/snippet}

                {#snippet emptyPane(paneId)}
                  {@render desktopEmptyPane("main", paneId)}
                {/snippet}
              </SplitsView>
            </div>

            <div
              class={[
                "desktop-bottom-panel-surface",
                bottomPanelVisible ? "desktop-bottom-panel-surface--visible" : "",
                bottomPanelResizing ? "desktop-bottom-panel-surface--resizing" : "",
              ]}
              style:--desktop-bottom-panel-height={`${bottomPanelHeight}px`}
              data-desktop-surface="bottomPanel"
              data-desktop-surface-active={activeSurface === "bottomPanel" ? "true" : undefined}
              onfocusin={() => setActiveDesktopSurface("bottomPanel")}
              onpointerdowncapture={() => setActiveDesktopSurface("bottomPanel")}
              tabindex="-1"
              aria-hidden={bottomPanelVisible ? undefined : "true"}
              inert={!bottomPanelVisible}
            >
              <div
                role="slider"
                aria-label="Resize panel"
                aria-orientation="vertical"
                aria-valuemin={bottomPanelMinHeight}
                aria-valuemax={bottomPanelMaxHeight}
                aria-valuenow={bottomPanelHeight}
                tabindex={bottomPanelVisible ? 0 : -1}
                data-tauri-drag-region="false"
                class={[
                  "desktop-bottom-panel-resize-handle",
                  bottomPanelResizing ? "desktop-bottom-panel-resize-handle--active" : "",
                ]}
                onmousedown={(event) => onBottomPanelResizeStart?.(event)}
                onkeydown={handleBottomPanelResizeKeydown}
              ></div>

              <div class="desktop-bottom-panel-clip">
                <div class="desktop-bottom-panel-content">
                  <SplitsView
                    controller={entry.bottomPanelController}
                    style="--splits-tab-action-icon-size: 12px; --splits-tab-close-size: 16px;"
                    tabBarWindowDrag
                    usePaneShape
                    paneShapeAnimating={paneShapesAnimating && bottomPanelVisible}
                    onTabContextMenu={handleTabContextMenu}
                  >
                    {#snippet tabIcon(tab)}
                      {@render desktopTabIcon(tab)}
                    {/snippet}

                    {#snippet tabTrailing(tab)}
                      {@render desktopTabTrailing(tab)}
                    {/snippet}

                    {#snippet newTabButton(paneId)}
                      {@render desktopNewTabButton("bottomPanel", paneId)}
                    {/snippet}

                    {#snippet tabBarActions(paneId)}
                      {@render desktopTabBarActions("bottomPanel", paneId)}
                    {/snippet}

                    {#snippet children(tab, paneId)}
                      <div
                        class="desktop-tab-content-slot"
                        use:adoptDesktopTabContent={tab.id}
                      ></div>
                    {/snippet}

                    {#snippet emptyPane(paneId)}
                      {@render desktopEmptyPane("bottomPanel", paneId)}
                    {/snippet}
                  </SplitsView>
                </div>
              </div>
            </div>
          </div>

          <div
            class={[
              "desktop-right-sidebar-surface",
              rightSidebarVisible ? "desktop-right-sidebar-surface--visible" : "",
              rightSidebarResizing ? "desktop-right-sidebar-surface--resizing" : "",
            ]}
            style:--desktop-right-sidebar-width={`${rightSidebarWidth}px`}
            data-desktop-surface="rightSidebar"
            data-desktop-surface-active={activeSurface === "rightSidebar" ? "true" : undefined}
            onfocusin={() => setActiveDesktopSurface("rightSidebar")}
            onpointerdowncapture={() => setActiveDesktopSurface("rightSidebar")}
            tabindex="-1"
            aria-hidden={rightSidebarVisible ? undefined : "true"}
            inert={!rightSidebarVisible}
          >
            <div
              role="slider"
              aria-label="Resize right sidebar"
              aria-orientation="vertical"
              aria-valuemin={rightSidebarMinWidth}
              aria-valuemax={rightSidebarMaxWidth}
              aria-valuenow={rightSidebarWidth}
              tabindex={rightSidebarVisible ? 0 : -1}
              data-tauri-drag-region="false"
              class={[
                "desktop-right-sidebar-resize-handle",
                rightSidebarResizing ? "desktop-right-sidebar-resize-handle--active" : "",
              ]}
              onmousedown={(event) => onRightSidebarResizeStart?.(event)}
              onkeydown={handleRightSidebarResizeKeydown}
            ></div>

            <div class="desktop-right-sidebar-clip">
              <div class="desktop-right-sidebar-content">
                <SplitsView
                  controller={entry.rightSidebarController}
                  style="--splits-tab-action-icon-size: 12px; --splits-tab-close-size: 16px;"
                  tabBarWindowDrag
                  usePaneShape
                  paneShapeAnimating={paneShapesAnimating && rightSidebarVisible}
                  onTabContextMenu={handleTabContextMenu}
                >
                  {#snippet tabIcon(tab)}
                    {@render desktopTabIcon(tab)}
                  {/snippet}

                  {#snippet tabTrailing(tab)}
                    {@render desktopTabTrailing(tab)}
                  {/snippet}

                  {#snippet newTabButton(paneId)}
                    {@render desktopNewTabButton("rightSidebar", paneId)}
                  {/snippet}

                  {#snippet tabBarActions(paneId)}
                    {@render desktopTabBarActions("rightSidebar", paneId)}
                  {/snippet}

                  {#snippet children(tab, paneId)}
                    <div class="desktop-tab-content-slot" use:adoptDesktopTabContent={tab.id}></div>
                  {/snippet}

                  {#snippet emptyPane(paneId)}
                    {@render desktopEmptyPane("rightSidebar", paneId)}
                  {/snippet}
                </SplitsView>
              </div>
            </div>
          </div>
        </div>
      {/key}
      <div class="desktop-frame-actions" data-tauri-drag-region="false">
        {@render desktopUtilityTabBarActions()}
        {@render bottomPanelToggleButton(bottomPanelVisible)}
        {@render rightSidebarToggleButton(rightSidebarVisible)}
      </div>
    {/if}
  </div>
</div>

<style lang="postcss">
  .desktop-splits-panel {
    --desktop-splits-tab-top-margin: 6px;
    --desktop-splits-shadow-gutter: 6px;
    /* Light-mode panes use a soft shadow and contact edge.
       Keep the contact edge on the uniform stroke ring so it cannot pool in
       the concave tab shoulders. CSS box-shadow blur is twice the SVG sigma. */
    --desktop-splits-pane-border-color: #bcc7d0;
    --desktop-splits-pane-edge-shadow-color: rgba(0, 0, 0, 0.04);
    --desktop-splits-pane-shoulder-edge-color: var(--desktop-splits-pane-border-color);
    --desktop-splits-pane-edge-shadow:
      0 0 0 0.5px var(--desktop-splits-pane-border-color),
      0 0 3.72px var(--desktop-splits-pane-edge-shadow-color);
    --desktop-splits-pane-shadow: 0 2.064px 22.684px rgba(0, 0, 0, 0.056);
    --desktop-splits-pane-shape-filter: drop-shadow(0 2.064px 11.342px rgba(0, 0, 0, 0.056));
    /* A single pass also avoids a change in shadow weight when motion ends. */
    --desktop-splits-pane-shape-motion-filter: var(--desktop-splits-pane-shape-filter);
    --desktop-splits-pane-shape-edge-ring-color: var(--desktop-splits-pane-edge-shadow-color);
    --desktop-splits-pane-edge-ring-blur: 1.86px;
    --desktop-splits-pane-edge-stroke-color: transparent;
    --desktop-splits-inactive-pane-edge-stroke-color: transparent;
    --desktop-splits-inactive-pane-content-opacity: 0.704;
    --desktop-splits-inactive-pane-border-color: color-mix(
      in srgb,
      var(--desktop-splits-pane-border-color) 67%,
      transparent
    );
    --desktop-splits-inactive-pane-edge-ring-color: var(--desktop-splits-pane-edge-shadow-color);
    --desktop-splits-inactive-pane-edge-shadow:
      0 0 0 0.5px var(--desktop-splits-inactive-pane-border-color),
      0 0 3.72px var(--desktop-splits-pane-edge-shadow-color);
    --desktop-splits-inactive-pane-shoulder-edge-color: var(
      --desktop-splits-inactive-pane-border-color
    );
    --desktop-splits-inactive-pane-shadow: var(--desktop-splits-pane-shadow);
    --desktop-splits-inactive-pane-shape-filter: var(--desktop-splits-pane-shape-filter);
    --desktop-splits-inactive-pane-shape-motion-filter: var(
      --desktop-splits-inactive-pane-shape-filter
    );
    --desktop-splits-panel-top-inset: max(
      0px,
      calc(var(--desktop-splits-tab-top-margin) - var(--desktop-splits-shadow-gutter))
    );
    --desktop-splits-panel-inset: max(
      0px,
      calc(var(--desktop-main-panel-inset, 8px) - var(--desktop-splits-shadow-gutter))
    );
    --desktop-splits-panel-sidebar-gap: max(
      0px,
      calc(var(--desktop-main-panel-sidebar-gap, 8px) - var(--desktop-splits-shadow-gutter))
    );

    position: relative;
    z-index: 10;
    box-sizing: border-box;
    padding: var(--desktop-splits-panel-top-inset) var(--desktop-splits-panel-inset)
      var(--desktop-splits-panel-inset) var(--desktop-splits-panel-sidebar-gap);
    min-width: 0;
    height: 100%;
    min-height: 0;
    align-self: stretch;
    flex: 1 1 0;
  }

  .desktop-splits-panel--no-border {
    padding-left: var(--desktop-splits-panel-inset);
  }

  :global(.vscode-dark) .desktop-splits-panel {
    /* Softer than before (was 0.38): the tight black edge halo was swallowing
       the lighter pane stroke. Keep enough for depth, let the stroke read. */
    --desktop-splits-pane-edge-shadow-color: rgba(0, 0, 0, 0.15);
    --desktop-splits-pane-edge-shadow: 0 0 1.5px var(--desktop-splits-pane-edge-shadow-color);
    --desktop-splits-pane-edge-ring-blur: 1px;
    --desktop-splits-pane-shoulder-edge-color: rgba(0, 0, 0, 0.22);
    --desktop-splits-pane-shadow: 0 4px 24px rgba(0, 0, 0, 0.1), 0 1px 12px rgba(0, 0, 0, 0.2);
    --desktop-splits-pane-shape-filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.21))
      drop-shadow(0 0.5px 2px rgba(0, 0, 0, 0.14));
    --desktop-splits-pane-shape-motion-filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.28));
    --desktop-splits-inactive-pane-edge-ring-color: rgba(0, 0, 0, 0.12);
    --desktop-splits-inactive-pane-content-opacity: 0.797;
    /* Inverted from light mode: the pane surface (#1b1f23) is darker than the
       panel behind it (#1f2428), so a darker outline would sink into the pane.
       A light stroke is what reads as an edge here. */
    --desktop-splits-pane-edge-stroke-color: rgba(255, 255, 255, 0.08);
    --desktop-splits-inactive-pane-edge-stroke-color: rgba(255, 255, 255, 0.05);
    --desktop-splits-inactive-pane-border-color: rgba(255, 255, 255, 0.06);
    --desktop-splits-inactive-pane-edge-shadow: 0 0 1px rgba(0, 0, 0, 0.16);
    --desktop-splits-inactive-pane-shoulder-edge-color: rgba(0, 0, 0, 0.09);
    --desktop-splits-inactive-pane-shadow:
      0 1.5px 10px rgba(0, 0, 0, 0.045), 0 0.5px 3px rgba(0, 0, 0, 0.08);
    /* Single pass for the same shoulder-fillet reason as light mode; the
       alpha carries the compounded weight of the stack it replaces. */
    --desktop-splits-inactive-pane-shape-filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.155));
    --desktop-splits-inactive-pane-shape-motion-filter: var(
      --desktop-splits-inactive-pane-shape-filter
    );
  }

  .desktop-splits-panel--no-border
    .desktop-splits-frame
    :global(.splits-pane:has(.desktop-tab-bar-traffic-light-spacer)) {
    --splits-pane-content-top-left-radius: var(--splits-pane-radius);
  }

  .desktop-main-panel-top-drag-region {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    z-index: 1;
    height: var(--desktop-splits-tab-top-margin);
  }

  .desktop-splits-frame {
    --desktop-frame-actions-width: 122px;

    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: visible;
    border-radius: var(--desktop-main-panel-radius, 10px);
    background: var(--psx-panel);
  }

  .desktop-frame-actions {
    position: absolute;
    top: calc(var(--desktop-splits-shadow-gutter) + 6px);
    right: calc(var(--desktop-splits-shadow-gutter) + 8px);
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 4px;
    pointer-events: none;
  }

  .desktop-frame-actions :global(button) {
    pointer-events: auto;
    /* Match the left sidebar toggle: native arrow cursor, not a pointer. */
    cursor: default;
  }

  .desktop-frame-actions-spacer {
    width: var(--desktop-frame-actions-width);
    height: 22px;
    flex: 0 0 var(--desktop-frame-actions-width);
    pointer-events: none;
  }

  .desktop-new-tab-button-frame {
    position: relative;
    flex: 0 0 var(--splits-tab-action-button-size);
    align-self: center;
    margin: 0 4px;
  }

  .desktop-new-tab-button {
    position: relative;
    display: inline-flex;
    width: var(--splits-tab-action-button-size);
    height: var(--splits-tab-action-button-size);
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--splits-muted-foreground);
    cursor: pointer;
    transform: translate(-1.5px, 1.5px);
  }

  .desktop-new-tab-button:hover {
    background: var(--splits-tab-hover-background);
    color: var(--splits-foreground);
  }

  .desktop-new-tab-button:focus-visible {
    outline: 2px solid var(--splits-focus-ring);
    outline-offset: 1px;
  }

  .desktop-splits-layout {
    --desktop-right-sidebar-surface-gap: calc(
      var(--desktop-main-panel-inset, 8px) - var(--desktop-splits-shadow-gutter) -
        var(--desktop-splits-shadow-gutter)
    );
    --desktop-bottom-panel-surface-gap: var(--desktop-right-sidebar-surface-gap);

    display: flex;
    gap: 0;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .desktop-splits-main-stack {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1 1 0;
    flex-direction: column;
  }

  .desktop-splits-main-surface {
    min-width: 0;
    min-height: 0;
    flex: 1 1 0;
  }

  .desktop-bottom-panel-surface {
    position: relative;
    height: 0;
    margin-top: 0;
    min-width: 0;
    min-height: 0;
    flex: 0 0 auto;
    overflow: visible;
    pointer-events: none;
    /* height/margin are layout properties, so will-change buys nothing here
       (they can never be composited) and only pins extra layer memory. */
    transition:
      height 140ms cubic-bezier(0.2, 0, 0, 1),
      margin-top 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  .desktop-bottom-panel-surface--visible {
    height: var(--desktop-bottom-panel-height);
    margin-top: var(--desktop-bottom-panel-surface-gap);
    pointer-events: auto;
  }

  .desktop-bottom-panel-surface--resizing {
    transition: none;
  }

  /* No overflow clipping: the pane shadows inside must spill over the main
     surface like any other pane shadow. The show/hide slide stays tidy
     without it because the content is anchored to the surface edge that
     remains on screen — whatever sticks out extends past the window edge,
     where the body's overflow: hidden swallows it. */
  .desktop-bottom-panel-clip {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: visible;
  }

  .desktop-bottom-panel-content {
    width: 100%;
    height: var(--desktop-bottom-panel-height);
    min-height: var(--desktop-bottom-panel-height);
    opacity: 0;
    transform: translateY(10px);
    transition:
      opacity 0ms linear 140ms,
      transform 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  .desktop-bottom-panel-surface--visible .desktop-bottom-panel-content {
    opacity: 1;
    /* Release the animation's stacking context once settled so pane shadows
       can paint behind the neighboring surfaces as well as their own. */
    transform: none;
    transition:
      opacity 100ms ease,
      transform 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  /* While closed, skip the panel's whole subtree in layout/paint. The surface
     collapses to height 0 but does not clip (overflow stays visible for pane
     shadows), so without this every terminal/tab in the closed panel still
     relayouts on each frame of any other panel/sidebar animation.
     content-visibility is discrete: transitioned with allow-discrete it acts
     like visibility — content stays rendered for the whole close slide and
     flips to hidden only at the end, so the animation itself is unaffected.
     Guarded by @supports because an unsupported allow-discrete would
     invalidate the whole transition shorthand. */
  @supports (transition-behavior: allow-discrete) {
    .desktop-bottom-panel-content {
      content-visibility: hidden;
      transition:
        opacity 0ms linear 140ms,
        transform 140ms cubic-bezier(0.2, 0, 0, 1),
        content-visibility 140ms allow-discrete;
    }

    /* content-visibility must NOT transition on open: the toggle focuses the
       panel's terminal one tick after the class flips, and elements inside a
       still-skipped (content-visibility: hidden) subtree are unfocusable —
       WebKit keeps the subtree skipped partway into an allow-discrete
       transition, so the focus() call silently no-ops and typing stays in the
       prompt while the panel shows the focus ring. Flipping instantly makes
       the subtree focusable the moment it opens; the close direction (base
       rule above) keeps the delayed flip so the slide stays painted. */
    .desktop-bottom-panel-surface--visible .desktop-bottom-panel-content {
      content-visibility: visible;
      transition:
        opacity 100ms ease,
        transform 140ms cubic-bezier(0.2, 0, 0, 1);
    }
  }

  .desktop-bottom-panel-surface--resizing .desktop-bottom-panel-content {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .desktop-bottom-panel-surface,
    .desktop-bottom-panel-content {
      transition: none;
    }
  }

  .desktop-bottom-panel-resize-handle {
    position: absolute;
    right: var(--desktop-splits-shadow-gutter);
    left: var(--desktop-splits-shadow-gutter);
    top: calc(-0.5 * var(--desktop-bottom-panel-surface-gap) - 4px);
    z-index: 40;
    height: 8px;
    cursor: row-resize;
    border: 0;
    background: transparent;
    padding: 0;
    outline: none;
  }

  .desktop-bottom-panel-resize-handle::before {
    content: "";
    position: absolute;
    right: 8px;
    left: 8px;
    top: 0;
    height: 1px;
    border-radius: 999px;
    background: transparent;
    mask-image: linear-gradient(
      to right,
      transparent,
      #000 40px,
      #000 calc(100% - 40px),
      transparent
    );
    transition: background 120ms ease;
  }

  .desktop-bottom-panel-resize-handle:hover::before,
  .desktop-bottom-panel-resize-handle:focus-visible::before,
  .desktop-bottom-panel-resize-handle--active::before {
    background: var(--psx-focus);
  }

  .desktop-empty-pane {
    --desktop-empty-pane-action-width: 210px;
    --desktop-empty-pane-action-rows: 5;
    --desktop-empty-pane-actions-width: min(100%, var(--desktop-empty-pane-action-width));

    box-sizing: border-box;
    container-type: size;
    display: flex;
    height: 100%;
    min-width: 0;
    min-height: 0;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 16px;

    /* Negative margin to account for blank tabs above */
    margin-top: -17px;
  }

  .desktop-empty-pane-content {
    display: flex;
    width: var(--desktop-empty-pane-actions-width);
    max-width: 100%;
    max-height: 100%;
    min-width: 0;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 10px;
  }

  .desktop-empty-pane-title {
    width: 100%;
    color: var(--psx-foreground-secondary);
    font-size: 12px;
    font-weight: 600;
    line-height: 16px;
    text-align: left;
  }

  .desktop-empty-pane-actions {
    display: grid;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    grid-auto-columns: minmax(0, min(var(--desktop-empty-pane-action-width), 100%));
    grid-auto-flow: column;
    grid-template-rows: repeat(var(--desktop-empty-pane-action-rows), 34px);
    gap: 8px 10px;
  }

  @container (max-height: 227px) and (min-width: 430px) {
    .desktop-empty-pane-content {
      --desktop-empty-pane-actions-width: min(
        100%,
        calc(var(--desktop-empty-pane-action-width) * 2 + 10px)
      );
    }

    .desktop-empty-pane-actions {
      --desktop-empty-pane-action-rows: 3;
    }
  }

  @container (max-height: 143px) and (min-width: 650px) {
    .desktop-empty-pane-content {
      --desktop-empty-pane-actions-width: min(
        100%,
        calc(var(--desktop-empty-pane-action-width) * 3 + 20px)
      );
    }

    .desktop-empty-pane-actions {
      --desktop-empty-pane-action-rows: 2;
    }
  }

  .desktop-empty-pane-button {
    display: inline-flex;
    box-sizing: border-box;
    height: 34px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--psx-border) 78%, transparent);
    border-radius: 6px;
    padding: 0 14px;
    background: color-mix(in srgb, var(--psx-panel) 98%, var(--psx-foreground-primary));
    color: var(--psx-foreground-secondary);
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
  }

  .desktop-empty-pane-button span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .desktop-empty-pane-button:hover:not(:disabled) {
    background: var(--psx-menu-hover-background);
    color: var(--psx-foreground-primary);
  }

  .desktop-empty-pane-button:focus-visible {
    outline: 2px solid var(--psx-focus);
    outline-offset: 2px;
  }

  .desktop-empty-pane-button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .desktop-right-sidebar-surface {
    position: relative;
    width: 0;
    margin-left: 0;
    min-width: 0;
    min-height: 0;
    flex: 0 0 auto;
    overflow: visible;
    pointer-events: none;
    /* width/margin are layout properties, so will-change buys nothing here
       (they can never be composited) and only pins extra layer memory. */
    transition:
      width 140ms cubic-bezier(0.2, 0, 0, 1),
      margin-left 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  .desktop-right-sidebar-surface--visible {
    width: var(--desktop-right-sidebar-width);
    margin-left: var(--desktop-right-sidebar-surface-gap);
    pointer-events: auto;
  }

  .desktop-right-sidebar-surface--resizing {
    transition: none;
  }

  /* No overflow clipping, for the same reason as .desktop-bottom-panel-clip:
     the sidebar pane's shadow must spill over the main surface, and the
     show/hide slide only ever overflows past the window edge. */
  .desktop-right-sidebar-clip {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: visible;
  }

  .desktop-right-sidebar-content {
    width: var(--desktop-right-sidebar-width);
    min-width: var(--desktop-right-sidebar-width);
    height: 100%;
    min-height: 0;
    opacity: 0;
    transform: translateX(10px);
    transition:
      opacity 0ms linear 140ms,
      transform 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  .desktop-right-sidebar-surface--visible .desktop-right-sidebar-content {
    opacity: 1;
    /* As with the bottom panel, keep a separate layer only during motion. */
    transform: none;
    transition:
      opacity 100ms ease,
      transform 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  /* Skip the closed sidebar's subtree in layout/paint; see the matching
     comment on .desktop-bottom-panel-content. */
  @supports (transition-behavior: allow-discrete) {
    .desktop-right-sidebar-content {
      content-visibility: hidden;
      transition:
        opacity 0ms linear 140ms,
        transform 140ms cubic-bezier(0.2, 0, 0, 1),
        content-visibility 140ms allow-discrete;
    }

    /* No content-visibility in the open transition: see the matching comment
       on the bottom panel. */
    .desktop-right-sidebar-surface--visible .desktop-right-sidebar-content {
      content-visibility: visible;
      transition:
        opacity 100ms ease,
        transform 140ms cubic-bezier(0.2, 0, 0, 1);
    }
  }

  .desktop-right-sidebar-surface--resizing .desktop-right-sidebar-content {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .desktop-right-sidebar-surface,
    .desktop-right-sidebar-content {
      transition: none;
    }
  }

  .desktop-right-sidebar-resize-handle {
    position: absolute;
    top: var(--desktop-splits-shadow-gutter);
    bottom: var(--desktop-splits-shadow-gutter);
    left: calc(-0.5 * var(--desktop-right-sidebar-surface-gap) - 4px);
    z-index: 40;
    width: 8px;
    cursor: col-resize;
    border: 0;
    background: transparent;
    padding: 0;
    outline: none;
  }

  .desktop-right-sidebar-resize-handle::before {
    content: "";
    position: absolute;
    top: 8px;
    right: 0;
    bottom: 8px;
    width: 1px;
    border-radius: 999px;
    background: transparent;
    mask-image: linear-gradient(
      to bottom,
      transparent,
      #000 40px,
      #000 calc(100% - 40px),
      transparent
    );
    transition: background 120ms ease;
  }

  .desktop-right-sidebar-resize-handle:hover::before,
  .desktop-right-sidebar-resize-handle:focus-visible::before,
  .desktop-right-sidebar-resize-handle--active::before {
    background: var(--psx-focus);
  }

  /* All settled panes share a paint order: shadows, surfaces, content, rims.
     Isolating each pane lets a later sibling's broad shadow paint over an
     earlier pane's fill and white rim, creating a dark strip at their join. */
  .desktop-splits-frame :global(.splits-pane) {
    isolation: auto;
  }

  .desktop-splits-frame :global(.splits-pane-shape-surface-layer) {
    z-index: 1;
  }

  .desktop-splits-frame :global(.splits-pane-content) {
    z-index: 2;
  }

  .desktop-splits-frame :global(.splits-pane-shape-rim-layer) {
    z-index: 3;
  }

  .desktop-splits-frame :global(.splits-root) {
    --splits-tab-bar-background: transparent;
    --splits-tab-bar-separator-display: none;
    --splits-tab-background: transparent;
    --splits-tab-hover-visual-background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--psx-foreground-primary) 5%, transparent) 0%,
      color-mix(in srgb, var(--psx-foreground-primary) 2.5%, transparent) 58%,
      transparent 100%
    );
    --splits-tab-hover-background: color-mix(
      in srgb,
      var(--psx-foreground-primary) 5%,
      transparent
    );
    --splits-tab-radius: var(--splits-pane-radius);
    --splits-tab-shadow-gutter: var(--desktop-splits-shadow-gutter);
    --splits-first-tab-margin-left: 0px;
    --splits-inactive-tab-bottom-radius: var(--splits-tab-radius);
    --splits-pane-border-color: var(--desktop-splits-pane-border-color);
    --splits-active-tab-background: var(--splits-pane-background);
    --splits-active-tab-border: transparent;
    --splits-active-tab-visual-border: transparent;
    --splits-active-tab-shadow:
      var(--desktop-splits-pane-edge-shadow), var(--desktop-splits-pane-shadow);
    --splits-active-tab-shoulder-edge-width: 1.25px;
    --splits-active-tab-shoulder-edge-color: var(--desktop-splits-pane-shoulder-edge-color);
    --splits-tab-top: 0px;
    --splits-tab-height-extension: 0px;
    --splits-tab-padding-bottom: 1px;
    --splits-split-gap: var(--desktop-main-panel-inset, 8px);
    /* Keep the gap background transparent so pane shadows can spill into the
       shadow gutters of the sibling surfaces (bottom panel, right sidebar),
       which overlap this surface by design. The frame behind paints the same
       var(--psx-panel), so an opaque gap background here would hard-clip a
       neighboring pane's shadow ~2px past its border instead. */
    --splits-split-gap-background: transparent;
    --splits-pane-border: var(--psx-hairline, 1px) solid var(--splits-pane-border-color);
    --splits-pane-radius: var(--desktop-main-panel-radius, 10px);
    --splits-pane-shadow: var(--desktop-splits-pane-shadow);
    --splits-pane-overflow: visible;
    --splits-pane-shell-border: var(--psx-hairline, 1px);
    --splits-pane-shell-background: transparent;
    --splits-pane-shell-shadow: none;
    --splits-pane-shape-top: 0px;
    --splits-pane-shape-height-extension: 0px;
    --splits-pane-shape-shoulder-radius: var(--splits-pane-radius);
    --splits-pane-shape-fill-tab-radius: max(0px, calc(var(--splits-tab-radius) - 3px));
    --splits-pane-shape-fill-shoulder-radius: max(
      0px,
      calc(var(--splits-pane-shape-shoulder-radius) - 3px)
    );
    --splits-pane-shape-fill-pane-radius: max(0px, calc(var(--splits-pane-radius) - 3px));
    --splits-pane-shape-filter: var(--desktop-splits-pane-shape-filter);
    --splits-pane-shape-motion-filter: var(--desktop-splits-pane-shape-motion-filter);
    --splits-pane-shape-edge-ring-color: var(--desktop-splits-pane-shape-edge-ring-color);
    --splits-pane-shape-edge-ring-blur: var(--desktop-splits-pane-edge-ring-blur);
    --splits-pane-shape-edge-stroke-color: var(--desktop-splits-pane-edge-stroke-color);
    --splits-pane-shape-edge-ring-width: 1.5px;
    --splits-pane-shape-border-width: 1px;
    --splits-pane-shape-border-color: var(--splits-pane-border-color);
    --splits-pane-shape-inner-shadow-color: #ffffff;
    --splits-pane-shape-inner-shadow-width: 2px;
    --splits-pane-content-background: var(--splits-pane-background);
    --splits-pane-content-shadow:
      var(--desktop-splits-pane-edge-shadow), var(--desktop-splits-pane-shadow),
      inset 0 0 0 var(--psx-hairline, 1px) var(--splits-pane-border-color);
    --splits-pane-content-top-right-radius: var(--splits-pane-radius);
    --splits-pane-content-detached-top-left-radius: var(--splits-pane-radius);
    --splits-separator: color-mix(in srgb, var(--psx-border) 70%, transparent);

    box-sizing: border-box;
    height: 100%;
    overflow: visible;
    padding: var(--desktop-splits-shadow-gutter);
    background: var(--splits-split-gap-background);
  }

  :global(.vscode-dark) .desktop-splits-frame :global(.splits-root) {
    --splits-pane-border-color: var(--psx-overlay-stroke-dark);
    /* No white inner glow in dark mode: keep the pane edge a clean solid
       stroke matching the dark popover outline (--psx-overlay-stroke-dark). */
    --splits-pane-shape-inner-shadow-color: transparent;
    /* The rim clips the stroke to its outer half, so 1px yields the same
       0.5px outset hairline around both the tab and the pane. */
    --splits-pane-shape-border-width: 1px;
  }

  .desktop-splits-frame
    [data-desktop-surface]:not([data-desktop-surface-active="true"])
    :global(.splits-pane),
  .desktop-splits-frame
    [data-desktop-surface-active="true"]
    :global(.splits-pane:not(:has(.splits-tab-bar-focused))) {
    --desktop-splits-pane-content-opacity: var(--desktop-splits-inactive-pane-content-opacity);
    --splits-active-tab-foreground: var(--psx-foreground-tertiary);
    --splits-active-tab-shadow:
      var(--desktop-splits-inactive-pane-edge-shadow), var(--desktop-splits-inactive-pane-shadow);
    --splits-active-tab-shoulder-edge-color: var(
      --desktop-splits-inactive-pane-shoulder-edge-color
    );
    --splits-pane-border-color: var(--desktop-splits-inactive-pane-border-color);
    --splits-pane-shadow: var(--desktop-splits-inactive-pane-shadow);
    --splits-pane-shape-border-color: var(--desktop-splits-inactive-pane-border-color);
    --splits-pane-shape-filter: var(--desktop-splits-inactive-pane-shape-filter);
    --splits-pane-shape-motion-filter: var(--desktop-splits-inactive-pane-shape-motion-filter);
    --splits-pane-shape-edge-ring-color: var(--desktop-splits-inactive-pane-edge-ring-color);
    --splits-pane-shape-edge-stroke-color: var(--desktop-splits-inactive-pane-edge-stroke-color);
    --splits-pane-content-shadow:
      var(--desktop-splits-inactive-pane-edge-shadow), var(--desktop-splits-inactive-pane-shadow),
      inset 0 0 0 var(--psx-hairline, 1px) var(--splits-pane-border-color);
  }

  .desktop-tab-bar-traffic-light-spacer {
    width: calc(var(--desktop-window-controls-space, 88px) + 24px);
    min-width: calc(var(--desktop-window-controls-space, 88px) + 24px);
    height: 100%;
    flex: 0 0 auto;
    transition:
      width 140ms cubic-bezier(0.2, 0, 0, 1),
      min-width 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  .desktop-tab-bar-traffic-light-spacer--hidden {
    width: 0;
    min-width: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .desktop-tab-bar-traffic-light-spacer {
      transition: none;
    }
  }

  /* Collapsed sidebar + a downloaded update: reserve extra room so the sidebar
     "Update" pill doesn't overlap the first chat tab. */
  .desktop-tab-bar-traffic-light-spacer--with-update {
    width: calc(var(--desktop-window-controls-space, 88px) + 24px + 72px);
    min-width: calc(var(--desktop-window-controls-space, 88px) + 24px + 72px);
  }

  :global(body.desktop-window-fullscreen) .desktop-tab-bar-traffic-light-spacer {
    width: calc(var(--desktop-fullscreen-sidebar-icon-offset, 5px) + 22px + 4px);
    min-width: calc(var(--desktop-fullscreen-sidebar-icon-offset, 5px) + 22px + 4px);
  }

  :global(body.desktop-window-fullscreen) .desktop-tab-bar-traffic-light-spacer--with-update {
    width: calc(var(--desktop-fullscreen-sidebar-icon-offset, 5px) + 22px + 4px + 72px);
    min-width: calc(var(--desktop-fullscreen-sidebar-icon-offset, 5px) + 22px + 4px + 72px);
  }

  :global(body.desktop-window-fullscreen) .desktop-tab-bar-traffic-light-spacer--hidden {
    width: 0;
    min-width: 0;
  }

  .desktop-chat-tab-icon {
    display: inline-flex;
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
  }

  .desktop-chat-tab-status {
    --desktop-chat-tab-status-blue: #3794ff;
    --desktop-chat-tab-status-yellow: #cca700;
    display: inline-block;
    box-sizing: border-box;
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 999px;
    pointer-events: none;
  }

  .desktop-chat-tab-status--waiting {
    background: var(--desktop-chat-tab-status-yellow);
  }

  .desktop-chat-tab-status--unread {
    background: var(--desktop-chat-tab-status-blue);
  }

  .desktop-tab-content {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    outline: none;
  }

  .desktop-tab-content-pool {
    display: none;
  }

  .desktop-tab-content-slot,
  .desktop-tab-content-pool-item {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .desktop-tab-content-slot {
    /* Fade the content as a group, including canvas-rendered terminals. The
       pane's matching fill underneath keeps the tab/content join seamless. */
    opacity: var(--desktop-splits-pane-content-opacity, 1);
  }

  .desktop-terminal-split-content {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--psx-terminal-background);
  }

  .desktop-terminal-message {
    color: var(--psx-foreground-secondary);
    display: flex;
    height: 100%;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 16px;
    text-align: center;
    font-size: 12px;
  }

  .desktop-terminal-error {
    color: var(--psx-foreground-tertiary);
    max-width: 520px;
  }
</style>
