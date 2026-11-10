<script lang="ts">
  import Icon from "@camber/components/icon";
  import {
    AcpChatPane,
    AssistantTerminalView,
    getAssistantTerminalRepo,
    MobileSideBar,
    type ACPConversationSummary,
  } from "@camber/features/acp";
  import { tick } from "svelte";

  import ACPAgentUpdateBanner from "./AgentUpdateBanner.svelte";
  import AssistantConfigErrorBanner from "./AssistantConfigErrorBanner.svelte";
  import type { MobileAppearance } from "./mobile/appearance";
  import MobileFileViewer from "./mobile/MobileFileViewer.svelte";
  import type { MobileHostStatus } from "./mobile/hostStatus";
  import type { MobileNavigation, MobileRoute, MobileView } from "./mobile/navigation";
  import MobilePageStack from "./mobile/MobilePageStack.svelte";
  import { resyncAfterReconnect, type StaleSession } from "./mobile/resyncAfterReconnect";
  import MobileSettingsView from "./mobile/MobileSettingsView.svelte";
  import MobileTopBar from "./mobile/MobileTopBar.svelte";
  import type { Runtime } from "./runtime/CoreRuntime.svelte";

  interface Props {
    core: Runtime;
    // See MobilePanel: history-backed navigation for URL-bearing hosts
    // (route restore, URL sync, native back), and a reconnect resync hook.
    navigation?: MobileNavigation;
    registerResync?: (resync: (staleSessions?: StaleSession[]) => void) => void;
    // Hands the host the shell's file-open handler: the transport's openFile
    // host RPC (file chips, tool cards, markdown links) pushes the file
    // viewer page through it.
    registerOpenFile?: (open: (path: string, line?: number) => void) => void;
    // Mobile-local appearance settings (theme); owned and persisted by the host.
    appearance?: MobileAppearance;
    // Name + liveness of the controlled desktop, shown in the list top bar.
    hostStatus?: MobileHostStatus;
  }

  const { core, navigation, registerResync, registerOpenFile, appearance, hostStatus }: Props =
    $props();

  const VIEW_DEPTH: Record<MobileView, number> = { list: 0, chat: 1, settings: 1, file: 2 };

  const initialRoute = navigation?.initialRoute ?? null;
  // "chat" and "file" initial routes can't open until the conversation list
  // has loaded (see the restore effect below); "settings" restores immediately.
  const initialConversationId =
    initialRoute?.view === "chat" || initialRoute?.view === "file"
      ? initialRoute.conversationId
      : null;

  let view = $state<MobileView>(initialRoute?.view === "settings" ? "settings" : "list");

  // File pushed on top of the chat page; the path survives in the URL so a
  // reload restores the viewer.
  let filePath = $state<string | null>(null);
  let fileLine = $state<number | undefined>(undefined);
  const fileName = $derived(filePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? "File");

  // One-shot: set only by the explicit "new conversation" action so the fresh
  // composer takes focus. Never set when opening an existing conversation (that
  // would pop the keyboard on every tap), and cleared after the mount consumes
  // it so a later remount — e.g. returning from settings — does not refocus.
  let autofocusPrompt = $state(false);

  const assistantTerminals = getAssistantTerminalRepo();

  const activeSession = $derived(
    core.acpRepo.getSessionByConversationId(core.activeConversationId),
  );

  const activeTitle = $derived.by(() => {
    const id = core.activeConversationId;
    if (!id) return "Conversation";
    const summary = core.acpConversationRepo.sessions.find((c) => c.id === id);
    return summary?.title || "New conversation";
  });

  // CamberQA worktree instance (dev only): the list top bar shows the
  // worktree's name — preferring its sidebar nickname, like the desktop's
  // title chip — on the slot colour, instead of the host name.
  const camberqaWorktreeLabel = $derived.by(() => {
    const worktreeName = hostStatus?.camberqa?.worktreeName?.trim();
    if (!worktreeName) return null;
    // The longest-path match mirrors DesktopSideBar.camberqaWorktreeProject:
    // several projects can share a worktree name; the deepest is the newest.
    let match: { nickname?: string; path: string } | null = null;
    for (const project of core.acpProjectRepo.projects) {
      if (!project.isWorktree || project.name !== worktreeName) continue;
      if (!match || project.path.length > match.path.length) match = project;
    }
    return match?.nickname || worktreeName;
  });
  const camberqaWorktreeColor = $derived(
    camberqaWorktreeLabel ? hostStatus?.camberqa?.color?.trim() || undefined : undefined,
  );

  function showList() {
    view = "list";
    void core.acpConversationRepo.refresh({ showLoading: false });
    void core.acpProjectRepo.refresh({ showLoading: false });
  }

  async function newConversation(cwd?: string) {
    const project = core.acpProjectRepo.projects.find((p) => !p.isWorktree);
    const workspacePath = cwd ?? project?.path;
    if (!workspacePath) return;
    const agentServer = core.acpRepo.agents.defaultAgentServer || "poolside";
    const conversation = await core.acpConversationRepo.createPendingConversation(
      workspacePath,
      workspacePath,
      agentServer,
      [workspacePath],
    );
    core.activeConversationId = core.acpRepo.createSession(
      workspacePath,
      conversation.agentServer,
      conversation.id,
      {
        ...(conversation.workspacePath === "CHAT" ? { isChat: true } : {}),
        isPendingConversationPersisted: true,
      },
    ).conversationId;
    autofocusPrompt = true;
    view = "chat";
    // The composer's onMount reads autofocusPrompt during this flush; clear it
    // afterwards so it stays a one-shot for this new conversation only.
    await tick();
    autofocusPrompt = false;
  }

  // Open a conversation from the list. Unlike the desktop sidebar's
  // AcpSidebarController.openSession, this never gates navigation on a prior
  // session's load state (on mobile that silently swallows taps once the
  // active conversation is busy) and always seeds the conversationId so a
  // loaded record stays attached to the tapped list row instead of spawning a
  // detached "new conversation".
  async function openConversation(session: ACPConversationSummary) {
    view = "chat";
    const agentServer = session.agentServer || "poolside";
    const cwd = session.cwd || "/";

    if (!session.sessionId) {
      core.activeConversationId = core.acpRepo.createSession(cwd, agentServer, session.id, {
        ...(session.workspacePath === "CHAT" ? { isChat: true } : {}),
        isPendingConversationPersisted: true,
      }).conversationId;
      return;
    }

    core.activeConversationId = session.id;
    const seed = { ...session, sessionId: session.sessionId };
    const loaded = await core.acpRepo.loadSessionRecord(
      session.sessionId,
      cwd,
      [],
      seed,
      agentServer,
      session.workspacePath === "CHAT" ? { isChat: true } : {},
    );
    // Re-check after the await: a slow load (e.g. a busy conversation with a
    // long transcript) must not yank the view back once the user has tapped
    // another row or created a new conversation in the meantime.
    if (loaded && core.activeConversationId === session.id) {
      core.activeConversationId = loaded.conversationId;
    }
  }

  // --- Terminal panel -------------------------------------------------------
  // One helper-side terminal per worktree: opening the panel reuses the live
  // tab for the active conversation's cwd or spawns one. The tab (and its
  // scrollback, retained in the shared terminal repo and helper-side) outlives
  // the panel, so closing and reopening restores the session.
  let terminalOpen = $state(false);
  let terminalCwd = $state<string | null>(null);
  let terminalId = $state<string | null>(null);
  let terminalError = $state<string | null>(null);
  // Bumped to focus the terminal when the panel opens or is retargeted; see
  // AssistantTerminalView's focusToken. (On iOS this focus is deferred out of
  // the tap gesture, so it readies the terminal but the keyboard is actually
  // raised by tapping into it — focusTerminalFromGesture.)
  let terminalFocusToken = $state(0);

  const activeCwd = $derived.by(() => {
    const id = core.activeConversationId;
    if (!id) return null;
    return core.acpConversationRepo.sessions.find((c) => c.id === id)?.cwd ?? null;
  });

  const terminalTab = $derived(
    terminalId ? (assistantTerminals.tabs.find((tab) => tab.id === terminalId) ?? null) : null,
  );

  // Re-target the terminal when the panel is open and the active conversation
  // moved to a different worktree.
  $effect(() => {
    if (!terminalOpen) return;
    const cwd = activeCwd;
    if (!cwd || cwd === terminalCwd) return;
    terminalCwd = cwd;
    terminalId = null;
    void openTerminalFor(cwd);
  });

  async function openTerminalFor(cwd: string) {
    terminalError = null;
    try {
      // Pick up terminals that outlived a page reload (the host re-subscribes
      // and replays their scrollback as part of the list call).
      await assistantTerminals.setWorktreePath(cwd);
      const existing = assistantTerminals.tabs.find(
        (tab) => tab.worktreePath === cwd && tab.exitCode === undefined,
      );
      if (existing) {
        terminalId = existing.id;
        return;
      }
      const tab = await assistantTerminals.createTab(cwd);
      terminalId = tab?.id ?? null;
    } catch (error) {
      terminalError = error instanceof Error ? error.message : String(error);
    }
  }

  function toggleTerminal() {
    terminalOpen = !terminalOpen;
    if (terminalOpen) terminalFocusToken += 1;
  }

  async function clearTerminal() {
    if (terminalId) await assistantTerminals.clear(terminalId);
  }

  async function restartTerminal() {
    const previous = terminalId;
    terminalId = null;
    if (previous) await assistantTerminals.deleteTab(previous);
    if (terminalCwd) await openTerminalFor(terminalCwd);
  }

  // In-app back buttons pop through the host's history so they share one
  // code path with the platform back button; without a navigation host they
  // fall back to going straight to the list.
  function goBack() {
    if (navigation) {
      navigation.back();
      return;
    }
    showList();
  }

  // Open the file viewer page. Paths from tool events and chips may be
  // relative to the conversation's worktree; resolve them so the helper can
  // serve the file.
  function openFileView(path: string, line?: number) {
    let resolved = path;
    if (!/^([/\\]|[A-Za-z]:[/\\])/.test(path)) {
      const cwd = activeCwd;
      if (!cwd) return;
      resolved = `${cwd.replace(/[/\\]+$/, "")}/${path}`;
    }
    filePath = resolved;
    fileLine = line;
    view = "file";
  }

  // Apply a route popped outside the shell (native back/forward gesture).
  function applyRoute(route: MobileRoute) {
    if (route.view === "file" && route.filePath) {
      // Adopt the route's conversation (forward-pop or pasted deep link):
      // without it the shell would report a file route with no conversation,
      // which serializes to the root and clobbers the URL.
      const id = route.conversationId;
      if (id && id !== core.activeConversationId) {
        const summary = core.acpConversationRepo.sessions.find((s) => s.id === id);
        if (summary) void openConversation(summary);
      }
      filePath = route.filePath;
      fileLine = undefined;
      view = "file";
      return;
    }
    if (route.view === "settings") {
      view = "settings";
      return;
    }
    if (route.view === "chat") {
      const id = route.conversationId;
      if (id && id === core.activeConversationId) {
        view = "chat";
        return;
      }
      const summary = id
        ? core.acpConversationRepo.sessions.find((s: ACPConversationSummary) => s.id === id)
        : undefined;
      if (summary) {
        void openConversation(summary);
        return;
      }
      // Unknown conversation (deleted, never synced): fall back to the list.
    }
    showList();
  }

  $effect(() => {
    if (!navigation) return;
    const unsubscribe = navigation.onPopRoute(applyRoute);
    return () => {
      unsubscribe();
    };
  });

  // True once a deep "chat" initial route has been applied (or given up on).
  let routeRestored = $state(initialConversationId == null);

  // Report shell-initiated navigation so the host can push/replace history
  // entries. Muted until a pending chat restore resolves: the shell sits on
  // the list while the conversation list loads, and reporting that would
  // clobber the deep URL being restored.
  $effect(() => {
    const route: MobileRoute = {
      view,
      conversationId: view === "chat" || view === "file" ? core.activeConversationId : null,
      filePath: view === "file" ? filePath : null,
    };
    if (!routeRestored) return;
    navigation?.routeChanged(route);
  });

  // Restore the initial route once the conversation list has loaded. Give up
  // silently if the conversation no longer exists (deleted, other machine).
  $effect(() => {
    if (routeRestored) return;
    const summary = core.acpConversationRepo.sessions.find((s) => s.id === initialConversationId);
    if (summary) {
      routeRestored = true;
      void openConversation(summary);
      // A deep file URL restores the viewer on top of the restored chat.
      if (initialRoute?.view === "file" && initialRoute.filePath) {
        filePath = initialRoute.filePath;
        view = "file";
      }
      return;
    }
    const status = core.acpConversationRepo.refreshState.status;
    if (status === "success" || status === "failure") {
      routeRestored = true;
    }
  });

  registerOpenFile?.((path, line) => openFileView(path, line));

  // After a transport reconnect (or a mid-stream gap) the host calls this.
  // Sessions the helper resumed already received their missed events through
  // the live stream; only the listed stale ones need a full replay, which
  // wholesale-replaces their transcript.
  registerResync?.((staleSessions) => resyncAfterReconnect(core, staleSessions));
</script>

<div class="mobile-app">
  <MobilePageStack page={view} depth={VIEW_DEPTH[view]}>
    {#snippet children(page)}
      {#if page === "list"}
        <MobileTopBar
          title={camberqaWorktreeLabel || hostStatus?.name || "Conversations"}
          titleColor={camberqaWorktreeColor}
          showLogo
          tone="panel"
          connected={hostStatus ? hostStatus.connected : undefined}
        >
          {#snippet actions()}
            <button
              type="button"
              class="mobile-bar-action text-psx-foreground-primary outline-hidden focus-visible:outline-2 focus-visible:outline-psx-focus active:bg-psx-menu-hover-background"
              aria-label="New conversation"
              onclick={() => newConversation()}
            >
              <Icon name="new" size={20} />
            </button>
            <button
              type="button"
              class="mobile-bar-action text-psx-foreground-primary outline-hidden focus-visible:outline-2 focus-visible:outline-psx-focus active:bg-psx-menu-hover-background"
              aria-label="Settings"
              onclick={() => (view = "settings")}
            >
              <Icon name="gear" size={20} />
            </button>
          {/snippet}
        </MobileTopBar>
        <div class="mobile-list">
          <MobileSideBar
            activeConversationId={core.activeConversationId}
            {activeSession}
            camberqa={hostStatus?.camberqa ?? null}
            onShowChat={() => {
              view = "chat";
            }}
            onNewConversation={newConversation}
            onOpenConversation={openConversation}
            onActiveConversationIdChange={(id) => {
              core.activeConversationId = id;
            }}
          />
        </div>
      {:else if page === "chat"}
        <MobileTopBar title={activeTitle} onBack={goBack} backLabel="Back to conversations">
          {#snippet actions()}
            <button
              type="button"
              class={[
                "mobile-bar-action outline-hidden focus-visible:outline-2 focus-visible:outline-psx-focus active:bg-psx-menu-hover-background",
                terminalOpen ? "text-psx-info-foreground" : "text-psx-foreground-primary",
              ]}
              aria-label={terminalOpen ? "Hide terminal" : "Show terminal"}
              aria-pressed={terminalOpen}
              onclick={toggleTerminal}
            >
              <Icon name="terminal" size={18} />
            </button>
          {/snippet}
        </MobileTopBar>
        {#if terminalOpen}
          <div class="mobile-terminal">
            <div class="mobile-terminal-bar">
              <span class="mobile-terminal-title">
                {terminalCwd
                  ? (terminalCwd.split("/").filter(Boolean).pop() ?? "Terminal")
                  : "Terminal"}
              </span>
              {#if terminalTab?.exitCode !== undefined}
                <span class="mobile-terminal-status">exited ({terminalTab?.exitCode})</span>
                <button type="button" class="mobile-terminal-button" onclick={restartTerminal}>
                  Restart
                </button>
              {:else}
                <button type="button" class="mobile-terminal-button" onclick={clearTerminal}>
                  Clear
                </button>
              {/if}
            </div>
            {#if terminalError}
              <div class="mobile-terminal-error">{terminalError}</div>
            {:else}
              <AssistantTerminalView {terminalId} focusToken={terminalFocusToken} />
            {/if}
          </div>
        {/if}
        <div class="mobile-chat" style:display={terminalOpen ? "none" : "flex"}>
          <!-- header "none": the shell's top bar above is the single header on
               mobile — the pane must not stack its own "Chatting with …" bar
               under it. No sidebar/terminal chrome either: the shell owns the
               mobile terminal panel above. -->
          <AcpChatPane
            editorSurface
            chrome={{ header: "none", frame: "plain" }}
            onNewConversation={newConversation}
            onAddProject={() => {}}
            onShowAgentSettings={() => {}}
            activeConversationId={core.activeConversationId}
            onActiveConversationIdChange={(id) => {
              core.activeConversationId = id;
            }}
            markReadWhenVisible={!terminalOpen}
            {autofocusPrompt}
          >
            {#snippet promptBanners()}
              <AssistantConfigErrorBanner />
              <ACPAgentUpdateBanner />
            {/snippet}
          </AcpChatPane>
        </div>
      {:else if page === "file"}
        <MobileTopBar title={fileName} onBack={goBack} backLabel="Back to conversation" />
        {#if filePath}
          <MobileFileViewer path={filePath} line={fileLine} />
        {/if}
      {:else}
        <MobileTopBar title="Settings" onBack={goBack} />
        <MobileSettingsView {appearance} />
      {/if}
    {/snippet}
  </MobilePageStack>
</div>

<style>
  .mobile-app {
    display: flex;
    flex-direction: column;
    width: 100%;
    /* Size to the visual viewport (the area above the software keyboard), not
       100dvh — iOS keeps 100dvh at the full keyboard-less height, which would
       leave the bottom-anchored prompt stranded behind the keyboard. Normal
       flow (not position:fixed, which iOS renders unreliably while the keyboard
       is up) so the prompt sits flush above the keyboard. Falls back to 100dvh
       where visualViewport is unavailable. See installMobileViewportTracking. */
    height: var(--visual-viewport-height, 100dvh);
    background: var(--psx-editor-background);
    color: var(--vscode-foreground);
  }

  .mobile-bar-action {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 10px;
  }

  .mobile-list {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: env(safe-area-inset-bottom);

    /* The list is this surface's sidebar: sit it on the panel background so
       it matches the desktop sidebar in both themes. */
    background: var(--psx-panel);
  }

  .mobile-chat {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .mobile-terminal {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--psx-terminal-background, var(--psx-editor-background));
    padding-bottom: env(safe-area-inset-bottom);
  }

  .mobile-terminal-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgb(128 128 128 / 25%));
    flex: none;
  }

  .mobile-terminal-title {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile-terminal-status {
    font-size: 12px;
    color: var(--psx-foreground-secondary, currentcolor);
  }

  .mobile-terminal-button {
    background: none;
    border: 1px solid var(--vscode-panel-border, rgb(128 128 128 / 40%));
    border-radius: 6px;
    color: var(--vscode-foreground);
    font-size: 13px;
    padding: 4px 10px;
    cursor: pointer;
  }

  .mobile-terminal-error {
    padding: 16px;
    font-size: 13px;
    color: var(--psx-error-foreground, #f14c4c);
  }
</style>
