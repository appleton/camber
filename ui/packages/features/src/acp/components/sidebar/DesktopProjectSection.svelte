<script module lang="ts">
  const githubTooltipIdEncoder = new TextEncoder();
</script>

<script lang="ts">
  import { Badge } from "@camber/components/badge";
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import {
    worktreeBlocksUI,
    worktreeBusyLabel,
    type ACPConversationSummary,
    type ACPNavProject,
  } from "../../navTypes";
  import ConversationGroup from "./ConversationGroup.svelte";
  import RenamableLabel from "./RenamableLabel.svelte";
  import { getAcpSidebarController } from "./SidebarController.svelte";
  import { getACPGithubRepo } from "../../features/GithubRepository.svelte";
  import { githubDotColorClass, githubStatusSummary } from "../../github/githubStatus";
  import GithubWorktreeTooltip from "./GithubWorktreeTooltip.svelte";
  import { withShortcut } from "../../../keybindings";
  import { reorderable } from "@camber/dnd";
  import { suppressContextMenu } from "./contextMenuHelpers";
  import ReorderDragPreview from "./ReorderDragPreview.svelte";
  import { ReorderMotion } from "./ReorderMotion.svelte";
  import ReorderMotionItem from "./ReorderMotionItem.svelte";
  import { cubicIn } from "svelte/easing";
  import { fly } from "svelte/transition";
  import { rowExitAnimation } from "./rowExitAnimation.svelte";
  import { rowExitDurationMs } from "./rowExitTransition";

  interface Props {
    project: ACPNavProject;
    projectSessions: ACPConversationSummary[];
    worktrees: ACPNavProject[];
    searchQuery: string;
    sessionVisibleLimit: number;
    projectContentVisible: boolean;
    projectCollapsed: boolean;
    projectSessionsExpanded: boolean;
    canOpenWorkspace: boolean;
    isCurrentWorkspace: (path: string) => boolean;
    sessionsFor: (workspacePath: string) => ACPConversationSummary[];
    isSessionGroupExpanded: (workspacePath: string) => boolean;
    onToggleProjectCollapsed: (project: ACPNavProject) => void;
    onToggleSessionsExpanded: (workspacePath: string) => void;
    onAddWorktree: (project: { path: string }) => void | Promise<void>;
    onOpenWorkspace: (path: string) => void | Promise<void>;
    onRemoveWorktree: (path: string) => void | Promise<void>;
    onArchiveSession: (session: ACPConversationSummary, event: MouseEvent) => void | Promise<void>;
    onArchiveSessionNow: (
      session: ACPConversationSummary,
      event: MouseEvent,
    ) => void | Promise<void>;
    onProjectContextMenu: (project: ACPNavProject, event: MouseEvent) => void;
    onWorktreeContextMenu: (worktree: ACPNavProject, event: MouseEvent) => void;
    onSessionContextMenu: (session: ACPConversationSummary, event: MouseEvent) => void;
    isSessionExiting?: (session: ACPConversationSummary) => boolean;
    // True while a row is flying out, so empty-state copy holds back until the
    // animation finishes instead of showing under the leaving row.
    rowExitAnimating?: boolean;
    sessionShortcutHint?: (session: ACPConversationSummary) => string | undefined;
    descendantsFor?: (session: ACPConversationSummary) => readonly ACPConversationSummary[];
    isSubAgentsExpanded?: (session: ACPConversationSummary) => boolean;
    onToggleSubAgents?: (session: ACPConversationSummary) => void;
    subAgentBadge?: (
      child: ACPConversationSummary,
      parent: ACPConversationSummary,
    ) => string | undefined;
    onReorderWorktrees: (parentPath: string, from: number, to: number) => void | Promise<void>;
    onWorktreeDragActiveChange: (active: boolean) => void;
  }

  let {
    project,
    projectSessions,
    worktrees,
    searchQuery,
    sessionVisibleLimit,
    projectContentVisible,
    projectCollapsed,
    projectSessionsExpanded,
    canOpenWorkspace,
    isCurrentWorkspace,
    sessionsFor,
    isSessionGroupExpanded,
    onToggleProjectCollapsed,
    onToggleSessionsExpanded,
    onAddWorktree,
    onOpenWorkspace,
    onRemoveWorktree,
    onArchiveSession,
    onArchiveSessionNow,
    onProjectContextMenu,
    onWorktreeContextMenu,
    onSessionContextMenu,
    isSessionExiting,
    rowExitAnimating = false,
    sessionShortcutHint,
    descendantsFor,
    isSubAgentsExpanded,
    onToggleSubAgents,
    subAgentBadge,
    onReorderWorktrees,
    onWorktreeDragActiveChange,
  }: Props = $props();

  const sidebar = getAcpSidebarController();
  const github = getACPGithubRepo();
  const worktreeReorderMotion = new ReorderMotion(
    () => worktrees,
    (worktree) => worktree.path,
    28,
  );
  // Unlike conversation rows, worktree rows are never filtered by the search
  // box, so a row leaving this list always means it was deleted.
  function exitDuration(): number {
    return rowExitDurationMs(true);
  }

  // Svelte can start the same element's outro twice in one removal (observed
  // in the desktop webview), and only the surviving animation dispatches
  // outroend — so each row's exit is counted at most once, keyed by element
  // because every worktree row shares this component scope.
  const countedWorktreeExits = new WeakSet<EventTarget>();

  function handleWorktreeOutroStart(event: Event) {
    const target = event.currentTarget;
    if (!target || countedWorktreeExits.has(target)) return;
    countedWorktreeExits.add(target);
    rowExitAnimation.outroStarted();
  }

  function handleWorktreeOutroEnd(event: Event) {
    const target = event.currentTarget;
    if (!target || !countedWorktreeExits.delete(target)) return;
    rowExitAnimation.outroEnded();
  }

  let showEmptyProjectConversations = $derived(
    searchQuery.trim() === "" &&
      projectContentVisible &&
      projectSessions.length === 0 &&
      worktrees.length === 0,
  );
  let hasProjectContent = $derived(
    projectSessions.length !== 0 || worktrees.length !== 0 || showEmptyProjectConversations,
  );

  let projectName = $derived(project.nickname || project.name);

  // Worktrees only make sense in a git repo. Undefined (status not loaded
  // yet) keeps the button enabled so it doesn't flash disabled on startup.
  let projectIsGitRepo = $derived(github.isRepoFor(project.path) !== false);

  // A collapsed row's nested sub-agent counts: the open chat lives under it.
  function isSessionOrNestedSelected(session: ACPConversationSummary): boolean {
    return (
      sidebar.rowState(session).selected ||
      (descendantsFor?.(session) ?? []).some((child) => sidebar.rowState(child).selected)
    );
  }

  // the project owning the open chat directly (not through a worktree)
  let ownsActiveChat = $derived(projectSessions.some(isSessionOrNestedSelected));
  // the project owning the open chat, directly or through one of its worktrees
  let containsActiveChat = $derived(
    ownsActiveChat ||
      worktrees.some((worktree) => sessionsFor(worktree.path).some(isSessionOrNestedSelected)),
  );

  function handleWorktreeReorder(from: number, to: number) {
    return onReorderWorktrees(project.path, from, to);
  }

  function displayName(item: ACPNavProject): string {
    return item.nickname || item.name;
  }

  function githubTooltipAnchorId(path: string): string {
    const bytes = githubTooltipIdEncoder.encode(path);
    const encodedPath = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `github-worktree-tooltip-${encodedPath}`;
  }
</script>

<section role="group" aria-label={projectName} class="group/project rounded-[8px]">
  <div
    class={[
      "group/projhead flex items-center rounded-[8px] pl-2 pt-1",
      projectContentVisible ? "pb-0" : "hover:bg-psx-menu-hover-background pb-1",
    ]}
  >
    {#snippet projectIcon()}
      <span
        class={[
          "inline-flex size-4 shrink-0 items-center justify-center transition-colors duration-200",
          containsActiveChat ? "text-(--psx-brand)" : "text-psx-foreground-secondary",
        ]}
        aria-hidden="true"
      >
        {#if projectCollapsed}
          <Icon name="folder-closed" size={14} />
        {:else}
          <Icon name="folder-open" size={14} />
        {/if}
      </span>
    {/snippet}
    {#if sidebar.isRenamingWorkspace("project", project.path)}
      <!-- py compensates for the input's border box so the row keeps its height. -->
      <div class="flex min-w-0 flex-1 items-center gap-2 py-[3px] pl-0 pr-1 text-left">
        {@render projectIcon()}
        <RenamableLabel
          value={projectName}
          ariaLabel={`Rename ${projectName}`}
          class="text-[13px]/[16px]"
          onSubmit={(name) => sidebar.commitRename(name)}
          onCancel={() => sidebar.cancelRename()}
        />
      </div>
    {:else}
      <button
        type="button"
        data-reorderable-handle
        class={[
          "text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-[8px] px-0 py-1 text-left focus-visible:outline-2 active:cursor-grabbing",
        ]}
        aria-label={projectCollapsed ? `Expand ${projectName}` : `Collapse ${projectName}`}
        aria-expanded={projectContentVisible}
        onclick={() => onToggleProjectCollapsed(project)}
        oncontextmenu={(event) => onProjectContextMenu(project, event)}
        title={project.path}
      >
        {@render projectIcon()}
        <span class="min-w-0 truncate text-[13px]/[16px]">{projectName}</span>
        <span
          class={[
            "text-psx-foreground-tertiary inline-flex size-3.5 shrink-0 items-center justify-center transition-transform",
            projectCollapsed ? "-rotate-90" : "",
          ]}
          aria-hidden="true"
        >
          <Icon name="chevron" size={12} />
        </span>
      </button>

      {#if ownsActiveChat || (containsActiveChat && !projectContentVisible)}
        <Badge
          intent="emphasis"
          radius="full"
          size="xs"
          class="ml-4 mr-1 shrink-0 px-1.5 pb-0.5 text-xs group-focus-within/project:hidden group-hover/project:hidden"
        >
          Open
        </Badge>
      {/if}

      <button
        type="button"
        class={[
          "text-psx-icon outline-hidden focus-visible:outline-psx-focus size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:flex focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
          "hover:bg-psx-menu-hover-background hidden group-focus-within/project:flex group-hover/project:flex",
        ]}
        aria-label={`New conversation in ${projectName}`}
        title={withShortcut("New conversation", "newConversation")}
        disabled={sidebar.isLoading}
        onclick={(event) => sidebar.newConversation(project.path, event)}
        oncontextmenu={suppressContextMenu}
      >
        <Icon name="new" size={14} />
      </button>

      <button
        type="button"
        class={[
          "text-psx-icon outline-hidden focus-visible:outline-psx-focus size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:flex focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
          "hover:bg-psx-menu-hover-background hidden group-focus-within/project:flex group-hover/project:flex",
        ]}
        aria-label={`Add worktree for ${projectName}`}
        title={projectIsGitRepo
          ? withShortcut("New worktree", "newWorktree")
          : "Worktrees require a git repository"}
        disabled={!projectIsGitRepo}
        onclick={() => onAddWorktree(project)}
        oncontextmenu={suppressContextMenu}
      >
        <Icon name="git-branch" size={14} />
      </button>

      <button
        type="button"
        class="text-psx-icon outline-hidden hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus hidden size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:flex focus-visible:outline-2 group-focus-within/project:flex group-hover/project:flex"
        aria-label={`More actions for ${projectName}`}
        title={`More actions for ${projectName}`}
        aria-haspopup="menu"
        onclick={(event) => onProjectContextMenu(project, event)}
        oncontextmenu={suppressContextMenu}
      >
        <Icon name="more" size={14} aria-hidden="true" />
      </button>
    {/if}
  </div>

  <div
    class={[
      "grid transition-[grid-template-rows] duration-200 ease-out",
      projectContentVisible ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
    ]}
    inert={!projectContentVisible}
    aria-hidden={!projectContentVisible}
  >
    <div class="min-h-0 overflow-hidden">
      <div class={hasProjectContent ? "pb-1 pl-1 pt-0.5" : ""}>
        {#if showEmptyProjectConversations && !rowExitAnimating}
          <div
            class="text-psx-foreground-tertiary flex min-w-0 select-none items-center rounded-[6px] py-1.5 pl-8 pr-2 text-[13px]/[16px]"
          >
            No conversations
          </div>
        {/if}

        <div
          class={projectSessions.length !== 0 || worktrees.length !== 0
            ? "ml-[11.5px] pl-[14px]"
            : ""}
        >
          {#if projectSessions.length !== 0}
            <div
              class={[
                "desktop-conversation-connector before:border-psx-border relative before:pointer-events-none before:absolute before:-left-[14px] before:top-0 before:content-['']",
                worktrees.length !== 0
                  ? "before:bottom-0 before:border-l"
                  : "before:bottom-[14px] before:w-[10px] before:rounded-bl-[5px] before:border-b before:border-l",
                worktrees.length !== 0 &&
                searchQuery.trim() === "" &&
                projectSessions.length > sessionVisibleLimit
                  ? "pb-1"
                  : "",
              ]}
            >
              <ConversationGroup
                sessions={projectSessions}
                workspacePath={project.path}
                {searchQuery}
                expanded={projectSessionsExpanded}
                visibleLimit={sessionVisibleLimit}
                rowIconSlotSize={16}
                rowLeadingPaddingClass="pl-1"
                desktop
                onToggleExpanded={onToggleSessionsExpanded}
                {onArchiveSession}
                {onArchiveSessionNow}
                {onSessionContextMenu}
                {isSessionExiting}
                {sessionShortcutHint}
                {descendantsFor}
                {isSubAgentsExpanded}
                {onToggleSubAgents}
                {subAgentBadge}
              />
            </div>
          {/if}

          <div
            use:reorderable={{
              handleSelector: "[data-reorderable-handle]",
              onReorder: handleWorktreeReorder,
              onDragStart: (index) => {
                worktreeReorderMotion.handleDragStart(index);
                onWorktreeDragActiveChange(true);
              },
              onDragMove: (detail) => worktreeReorderMotion.handleDragMove(detail),
              onDragEnd: () => {
                worktreeReorderMotion.handleDragEnd();
                onWorktreeDragActiveChange(false);
              },
              onTargetChange: (target) => worktreeReorderMotion.handleTargetChange(target),
            }}
          >
            {#each worktrees as worktree, worktreeIndex (worktree.path)}
              {@const worktreeCurrent = isCurrentWorkspace(worktree.path)}
              {@const worktreeName = displayName(worktree)}
              {@const worktreeBusy = worktree.busy}
              {@const worktreeDeleteRequested = worktree.deleteRequested === true}
              <!-- Setup/teardown surface as a tooltip on the spinner and name; the
                   other busy states keep the inline label next to the name. -->
              {@const worktreeBusyTooltip =
                worktreeBusy === "running_setup"
                  ? "Running setup…"
                  : worktreeBusy === "tearing_down"
                    ? "Tearing down…"
                    : undefined}
              {@const worktreeBusyLabelText =
                worktreeBusy && worktreeBusyTooltip === undefined
                  ? worktreeBusyLabel(worktreeBusy)
                  : ""}
              {@const worktreeBlocked =
                worktreeDeleteRequested ||
                (worktreeBusy !== undefined && worktreeBlocksUI(worktreeBusy))}
              {@const canDelete =
                !worktreeDeleteRequested &&
                (worktreeBusy === undefined ||
                  worktreeBusy === "creating" ||
                  worktreeBusy === "running_setup")}
              {@const worktreeSessions = sessionsFor(worktree.path)}
              {@const hasWorktreeSessions = worktreeSessions.length > 0}
              {@const worktreeOwnsActiveChat = worktreeSessions.some(isSessionOrNestedSelected)}
              {@const worktreeContentVisible =
                searchQuery.trim() !== "" || worktree.collapsed !== true}
              {@const worktreeSessionsExpanded =
                searchQuery.trim() !== "" || isSessionGroupExpanded(worktree.path)}
              {@const githubWorktreeStatus = github.worktreeStatusFor(worktree.path)}
              {@const githubStatus = githubWorktreeStatus?.status}
              {@const githubHasPR = Boolean(githubStatus && githubStatus.state !== "none")}
              {@const githubDot =
                worktreeBusy === undefined
                  ? githubDotColorClass(github.categoryFor(worktree.path))
                  : ""}
              {@const githubTooltipId = githubTooltipAnchorId(worktree.path)}
              <div
                data-reorderable-item
                out:fly={{ x: -32, opacity: 0, duration: exitDuration(), easing: cubicIn }}
                onoutrostart={handleWorktreeOutroStart}
                onoutroend={handleWorktreeOutroEnd}
                class={[
                  "desktop-conversation-connector before:border-psx-border relative before:pointer-events-none before:absolute before:-left-[14px] before:top-0 before:content-['']",
                  worktreeIndex === worktrees.length - 1
                    ? "before:h-[14px] before:w-[10px] before:rounded-bl-[5px] before:border-b before:border-l"
                    : "before:bottom-0 before:border-l",
                ]}
              >
                <ReorderMotionItem
                  active={worktreeReorderMotion.active}
                  source={worktreeReorderMotion.isSource(worktree)}
                  style={worktreeReorderMotion.contentStyle(worktree)}
                >
                  <div
                    class={[
                      "group/wthead flex items-center gap-0.5 px-1",
                      worktreeDeleteRequested ? "opacity-60" : "",
                    ]}
                  >
                    {#if sidebar.isRenamingWorkspace("worktree", worktree.path)}
                      <!-- py compensates for the input's border box so the row keeps its height. -->
                      <div class="flex min-w-0 flex-1 items-center gap-2 px-0 py-[5px] text-left">
                        <span
                          class={[
                            "relative inline-flex size-4 shrink-0 items-center justify-center",
                            worktreeOwnsActiveChat
                              ? "text-(--psx-brand)"
                              : "text-psx-foreground-secondary",
                          ]}
                          aria-hidden="true"
                        >
                          <Icon name="git-branch" size={13} />
                        </span>
                        <RenamableLabel
                          value={worktreeName}
                          ariaLabel={`Rename ${worktreeName}`}
                          class="text-[13px]/[16px]"
                          onSubmit={(name) => sidebar.commitRename(name)}
                          onCancel={() => sidebar.cancelRename()}
                        />
                      </div>
                    {:else}
                      <button
                        id={githubTooltipId}
                        type="button"
                        data-reorderable-handle
                        class={[
                          "outline-hidden focus-visible:outline-psx-focus flex min-w-0 cursor-grab select-none items-center gap-2 rounded-[6px] px-0 py-1.5 text-left focus-visible:outline-2 active:cursor-grabbing disabled:cursor-not-allowed",
                          worktreeBlocked
                            ? "text-psx-foreground-secondary"
                            : worktreeCurrent || !canOpenWorkspace
                              ? "text-psx-foreground-primary"
                              : "text-psx-foreground-secondary hover:text-psx-foreground-primary",
                        ]}
                        disabled={worktreeBlocked}
                        onclick={() => {
                          // Where the host supports it (e.g. VS), clicking a worktree opens its
                          // workspace. Otherwise (desktop) the row toggles its conversation list,
                          // so the whole name/icon is a collapse target — not just the chevron.
                          if (!worktreeCurrent && canOpenWorkspace) {
                            onOpenWorkspace(worktree.path);
                          } else if (hasWorktreeSessions) {
                            onToggleProjectCollapsed(worktree);
                          }
                        }}
                        oncontextmenu={(event) => onWorktreeContextMenu(worktree, event)}
                        title={worktreeBusyTooltip ?? (githubHasPR ? undefined : worktree.path)}
                      >
                        <span
                          id={`${githubTooltipId}-trigger`}
                          class={[
                            "relative inline-flex size-4 shrink-0 items-center justify-center transition-colors duration-200",
                            worktreeOwnsActiveChat
                              ? "text-(--psx-brand)"
                              : "text-psx-foreground-secondary",
                          ]}
                        >
                          {#if worktreeBusy !== undefined}
                            <Spinner aria-hidden size={12} />
                          {:else}
                            <Icon name="git-branch" size={13} />
                            {#if githubDot}
                              <span
                                class={[
                                  "ring-psx-panel pointer-events-none absolute -bottom-px -right-0.5 size-1.5 rounded-full ring-[1.5px]",
                                  githubDot,
                                ]}
                                aria-label={githubStatusSummary(githubStatus)}
                              ></span>
                            {/if}
                          {/if}
                        </span>
                        <span class="min-w-0">
                          <span class={["flex min-w-0 items-baseline gap-1.5 text-[13px]/[16px]"]}>
                            <span class="truncate text-[13px]/[16px]">{worktreeName}</span>
                            {#if worktreeBusyLabelText}
                              <span class="text-psx-foreground-tertiary shrink-0 text-[13px]/[16px]"
                                >{worktreeBusyLabelText}</span
                              >
                            {/if}
                          </span>
                        </span>
                      </button>
                      {#if hasWorktreeSessions}
                        <button
                          type="button"
                          class="text-psx-foreground-tertiary outline-hidden hover:text-psx-foreground-primary focus-visible:outline-psx-focus flex size-4 shrink-0 items-center justify-center rounded-[4px] focus-visible:outline-2"
                          aria-label={worktreeContentVisible
                            ? `Collapse ${worktreeName}`
                            : `Expand ${worktreeName}`}
                          aria-expanded={worktreeContentVisible}
                          onclick={() => onToggleProjectCollapsed(worktree)}
                        >
                          <span
                            class={[
                              "inline-flex transition-transform",
                              worktreeContentVisible ? "" : "-rotate-90",
                            ]}
                            aria-hidden="true"
                          >
                            <Icon name="chevron" size={12} />
                          </span>
                        </button>
                      {/if}
                      <div class="min-w-0 flex-1"></div>
                      {#if worktreeBusy === undefined}
                        <GithubWorktreeTooltip
                          anchorId={githubTooltipId}
                          triggerId={`${githubTooltipId}-trigger`}
                          path={worktree.path}
                          status={githubWorktreeStatus}
                        />
                      {/if}
                      <button
                        type="button"
                        class="text-psx-icon outline-hidden hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus hidden size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:flex focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50 group-hover/wthead:flex"
                        aria-label={`New conversation in ${worktreeName}`}
                        title="New Conversation"
                        disabled={sidebar.isLoading || worktreeBlocked}
                        onclick={(event) => sidebar.newConversation(worktree.path, event)}
                        oncontextmenu={suppressContextMenu}
                      >
                        <Icon name="new" size={14} />
                      </button>
                      <button
                        type="button"
                        class={[
                          "text-psx-icon outline-hidden hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:flex focus-visible:outline-2 disabled:opacity-50",
                          worktreeDeleteRequested ? "flex" : "hidden group-hover/wthead:flex",
                        ]}
                        aria-label={`Delete worktree ${worktreeName}`}
                        title="Delete worktree"
                        disabled={!canDelete}
                        onclick={() => onRemoveWorktree(worktree.path)}
                        oncontextmenu={suppressContextMenu}
                      >
                        {#if worktreeDeleteRequested}
                          <Spinner aria-hidden size={12} />
                        {:else}
                          <Icon name="trash" size={14} />
                        {/if}
                      </button>
                      {#if worktreeOwnsActiveChat}
                        <Badge
                          intent="emphasis"
                          radius="full"
                          size="xs"
                          class="ml-4 mr-1 shrink-0 px-1.5 pb-0.5 text-xs group-focus-within/wthead:hidden group-hover/wthead:hidden"
                        >
                          Open
                        </Badge>
                      {/if}
                    {/if}
                  </div>

                  <div
                    class={[
                      "grid transition-[grid-template-rows] duration-200 ease-out",
                      worktreeContentVisible ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                    ]}
                    inert={!worktreeContentVisible}
                    aria-hidden={!worktreeContentVisible}
                  >
                    <div class="min-h-0 overflow-hidden">
                      {#if worktreeSessions.length === 0 && !rowExitAnimating && searchQuery.trim() === "" && worktreeBusy === undefined && !worktreeDeleteRequested}
                        <div
                          class="desktop-conversation-connector before:border-psx-border relative ml-[11.5px] pl-[14px] before:pointer-events-none before:absolute before:bottom-[14px] before:left-0 before:top-0 before:w-[10px] before:rounded-bl-[5px] before:border-b before:border-l before:content-['']"
                        >
                          <div
                            class="text-psx-foreground-tertiary flex min-w-0 select-none items-center rounded-[6px] py-1.5 pl-7 pr-2 text-[13px]/[16px]"
                          >
                            No conversations
                          </div>
                        </div>
                      {/if}
                      <ConversationGroup
                        sessions={worktreeSessions}
                        workspacePath={worktree.path}
                        {searchQuery}
                        expanded={worktreeSessionsExpanded}
                        visibleLimit={sessionVisibleLimit}
                        indent
                        desktop
                        onToggleExpanded={onToggleSessionsExpanded}
                        {onArchiveSession}
                        {onArchiveSessionNow}
                        {onSessionContextMenu}
                        {isSessionExiting}
                        {sessionShortcutHint}
                        {descendantsFor}
                        {isSubAgentsExpanded}
                        {onToggleSubAgents}
                        {subAgentBadge}
                      />
                    </div>
                  </div>
                </ReorderMotionItem>
              </div>
            {/each}
          </div>
        </div>

        {#if worktreeReorderMotion.preview}
          {@const preview = worktreeReorderMotion.preview}
          <ReorderDragPreview style={worktreeReorderMotion.previewStyle()}>
            <Icon name="git-branch" size={13} class="text-psx-foreground-secondary shrink-0" />
            <span class="min-w-0 truncate">{displayName(preview.item)}</span>
          </ReorderDragPreview>
        {/if}
      </div>
    </div>
  </div>
</section>
