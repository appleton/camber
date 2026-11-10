<script lang="ts">
  import { Button } from "@camber/components/button";
  import { Spinner } from "@camber/components/spinner";
  import Icon from "@camber/components/icon";
  import { formatError } from "@camber/lib/errors";
  import { onDestroy } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import type { ACPConversationSummary, ACPNavProject } from "../../navTypes";
  import { ACP_CHAT_WORKSPACE_PATH } from "../../workspaceScope";
  import type { SessionListFailure } from "../../features/HistoryRepository.svelte";
  import { appState } from "../../hostAdapter";
  import { shortenHomeDirectoryInText } from "../../shared/paths";
  import type { SessionPickerBucket } from "../sessionPickerUtil";
  import Tooltip from "../ui/Tooltip.svelte";
  import DesktopConversationRow from "./DesktopConversationRow.svelte";
  import { getAcpSidebarController } from "./SidebarController.svelte";
  import SearchField from "./SearchField.svelte";
  import SidebarIconButton from "./SidebarIconButton.svelte";
  import SidebarNavButton from "./SidebarNavButton.svelte";

  interface Props {
    searchQuery: string;
    groupedHistorySessions: SessionPickerBucket[];
    state: { status: string; error?: Error };
    sessionCount: number;
    backLabel: string;
    emptyLabel?: string;
    desktop?: boolean;
    pane?: boolean;
    embedded?: boolean;
    showCollapseButton?: boolean;
    // True while agent session lists are being reconciled in the background;
    // the locally persisted archive is already shown.
    reconciling?: boolean;
    // Agent servers whose session list could not be fetched. Non-fatal.
    listFailures?: SessionListFailure[];
    // Desktop archive: projects to filter by, the current selection, and a
    // callback to switch. Omitted on IDE hosts (single workspace, no filter).
    projects?: ACPNavProject[];
    selectedProjectPath?: string | null;
    hasArchivedChats?: boolean;
    onSelectProject?: (path: string) => void | Promise<void>;
    visibleNavSessionForHistorySession: (
      session: ACPConversationSummary,
    ) => ACPConversationSummary | undefined;
    onBack: () => void;
    onCollapse?: () => void;
    onOpenRestoredHistorySession: (
      session: ACPConversationSummary,
      navSession: ACPConversationSummary,
    ) => void | Promise<void>;
    // Opens an archived conversation as a read-only transcript without
    // restoring it to the sidebar.
    onOpenHistorySessionReadOnly?: (session: ACPConversationSummary) => void | Promise<void>;
    onArchiveHistorySession: (
      session: ACPConversationSummary,
      navSession: ACPConversationSummary,
      event: MouseEvent,
    ) => void | Promise<void>;
    onRestoreHistorySession: (
      session: ACPConversationSummary,
    ) => boolean | void | Promise<boolean | void>;
    onDeleteHistorySession: (
      session: ACPConversationSummary,
      event: MouseEvent,
    ) => void | Promise<void>;
  }

  let {
    searchQuery = $bindable(),
    groupedHistorySessions,
    state,
    sessionCount,
    backLabel,
    emptyLabel = "No history for this workspace",
    desktop = false,
    pane = false,
    embedded = false,
    showCollapseButton = false,
    reconciling = false,
    listFailures = [],
    projects = [],
    selectedProjectPath = null,
    hasArchivedChats = false,
    onSelectProject,
    visibleNavSessionForHistorySession,
    onBack,
    onCollapse,
    onOpenRestoredHistorySession,
    onOpenHistorySessionReadOnly,
    onArchiveHistorySession,
    onRestoreHistorySession,
    onDeleteHistorySession,
  }: Props = $props();

  const controller = getAcpSidebarController();
  const ARCHIVED_CONVERSATION_VISIBLE_LIMIT = 8;
  const RESTORE_UNDO_SECONDS = 5;
  const RESTORE_FADE_MS = 200;
  const pendingRestores = new SvelteMap<string, number>();
  const pendingRestoreTimers = new Map<string, ReturnType<typeof setInterval>>();
  const restoreFadeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingRestoreOperations = new Map<string, Promise<boolean | void>>();
  const undoingRestoreSessionKeys = new SvelteSet<string>();
  const fadingRestoredSessionKeys = new SvelteSet<string>();
  const hiddenRestoredSessionKeys = new SvelteSet<string>();

  function getSessionAgentServer(session: { agentServer?: string }): string {
    return controller.getSessionAgentServer(session);
  }

  function canDeleteSession(session: ACPConversationSummary): boolean {
    return controller.canDeleteSession(session);
  }

  function canOpenReadOnly(session: ACPConversationSummary): boolean {
    return Boolean(onOpenHistorySessionReadOnly && session.sessionId) && sessionAvailable(session);
  }

  function sessionAvailable(session: ACPConversationSummary): boolean {
    return session.sessionAvailable !== false;
  }

  function historySessionRowKey(session: ACPConversationSummary): string {
    return `${getSessionAgentServer(session)}:${session.sessionId || session.id}`;
  }

  const failedAgentLabel = $derived(
    listFailures
      .map((failure) =>
        failure.agentServer === "*" ? "some agents" : controller.getAgentName(failure.agentServer),
      )
      .join(", "),
  );

  const visibleGroupedHistorySessions = $derived(
    groupedHistorySessions
      .map((bucket) => ({
        ...bucket,
        sessions: bucket.sessions.filter(
          (item) => !hiddenRestoredSessionKeys.has(historySessionRowKey(item.session)),
        ),
      }))
      .filter((bucket) => bucket.sessions.length > 0),
  );

  const filteredSessionCount = $derived(
    visibleGroupedHistorySessions.reduce((count, bucket) => count + bucket.sessions.length, 0),
  );

  const hasActiveSearch = $derived(searchQuery.trim().length > 0);
  const collapsedBucketKeys = new SvelteSet<string>();
  const searchCollapsedBucketKeys = new SvelteSet<string>();
  const expandedSessionBucketKeys = new SvelteSet<string>();

  $effect(() => {
    if (!hasActiveSearch) {
      searchCollapsedBucketKeys.clear();
    }
  });

  function bucketContentVisible(key: string): boolean {
    return (
      !collapsedBucketKeys.has(key) || (hasActiveSearch && !searchCollapsedBucketKeys.has(key))
    );
  }

  function toggleBucket(key: string): void {
    if (bucketContentVisible(key)) {
      collapsedBucketKeys.add(key);
      if (hasActiveSearch) {
        searchCollapsedBucketKeys.add(key);
      }
    } else {
      collapsedBucketKeys.delete(key);
      searchCollapsedBucketKeys.delete(key);
    }
  }

  function interactWithBucket(key: string): void {
    if (!hasActiveSearch || searchCollapsedBucketKeys.has(key)) return;
    collapsedBucketKeys.delete(key);
  }

  function visibleBucketSessions(bucket: SessionPickerBucket): SessionPickerBucket["sessions"] {
    if (hasActiveSearch || expandedSessionBucketKeys.has(bucket.key)) return bucket.sessions;
    return bucket.sessions.slice(0, ARCHIVED_CONVERSATION_VISIBLE_LIMIT);
  }

  function toggleBucketSessions(key: string): void {
    if (expandedSessionBucketKeys.has(key)) expandedSessionBucketKeys.delete(key);
    else expandedSessionBucketKeys.add(key);
  }

  function setPendingRestore(key: string, remaining?: number): void {
    if (remaining === undefined) pendingRestores.delete(key);
    else pendingRestores.set(key, remaining);
  }

  function clearPendingRestoreTimers(key: string): void {
    const countdownTimer = pendingRestoreTimers.get(key);
    if (countdownTimer) clearInterval(countdownTimer);
    pendingRestoreTimers.delete(key);
    const fadeTimer = restoreFadeTimers.get(key);
    if (fadeTimer) clearTimeout(fadeTimer);
    restoreFadeTimers.delete(key);
  }

  function clearPendingRestore(key: string): void {
    clearPendingRestoreTimers(key);
    fadingRestoredSessionKeys.delete(key);
    hiddenRestoredSessionKeys.delete(key);
    setPendingRestore(key);
  }

  function startPendingRestore(key: string, initialRemaining = RESTORE_UNDO_SECONDS): void {
    clearPendingRestore(key);
    hiddenRestoredSessionKeys.delete(key);
    setPendingRestore(key, initialRemaining);
    const timer = setInterval(() => {
      const remaining = pendingRestores.get(key);
      if (remaining === undefined) {
        clearPendingRestore(key);
        return;
      }
      if (remaining <= 1) {
        clearPendingRestoreTimers(key);
        fadingRestoredSessionKeys.add(key);
        const fadeTimer = setTimeout(() => {
          restoreFadeTimers.delete(key);
          fadingRestoredSessionKeys.delete(key);
          hiddenRestoredSessionKeys.add(key);
          setPendingRestore(key);
        }, RESTORE_FADE_MS);
        restoreFadeTimers.set(key, fadeTimer);
        return;
      }
      setPendingRestore(key, remaining - 1);
    }, 1000);
    pendingRestoreTimers.set(key, timer);
  }

  function restoreHistorySession(session: ACPConversationSummary, bucketKey: string): void {
    const key = historySessionRowKey(session);
    if (pendingRestores.has(key) || pendingRestoreOperations.has(key)) return;
    interactWithBucket(bucketKey);
    startPendingRestore(key);
    const operation = Promise.resolve().then(() => onRestoreHistorySession(session));
    pendingRestoreOperations.set(key, operation);
    void operation
      .then((restored) => {
        if (restored === false) clearPendingRestore(key);
      })
      .catch(() => clearPendingRestore(key))
      .finally(() => pendingRestoreOperations.delete(key));
  }

  async function undoRestore(session: ACPConversationSummary, event: MouseEvent): Promise<void> {
    const key = historySessionRowKey(session);
    if (undoingRestoreSessionKeys.has(key)) return;
    const remaining = pendingRestores.get(key) ?? RESTORE_UNDO_SECONDS;
    clearPendingRestoreTimers(key);
    undoingRestoreSessionKeys.add(key);
    try {
      const restoreOperation = pendingRestoreOperations.get(key);
      if (restoreOperation) {
        try {
          const restored = await restoreOperation;
          if (restored === false) {
            clearPendingRestore(key);
            return;
          }
        } catch {
          clearPendingRestore(key);
          return;
        }
      }
      const navSession = visibleNavSessionForHistorySession(session);
      if (!navSession) {
        clearPendingRestore(key);
        return;
      }
      try {
        await onArchiveHistorySession(session, navSession, event);
        clearPendingRestore(key);
      } catch (error) {
        startPendingRestore(key, remaining);
        throw error;
      }
    } finally {
      undoingRestoreSessionKeys.delete(key);
    }
  }

  onDestroy(() => {
    for (const timer of pendingRestoreTimers.values()) clearInterval(timer);
    pendingRestoreTimers.clear();
    for (const timer of restoreFadeTimers.values()) clearTimeout(timer);
    restoreFadeTimers.clear();
  });

  const projectFilterOptions = $derived(
    [...projects.filter((project) => !project.isWorktree)].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    ),
  );
  const showProjectFilter = $derived(Boolean(onSelectProject) && projectFilterOptions.length > 0);

  function selectProjectFilter(path: string): void {
    void onSelectProject?.(path);
  }

  function bucketCwdTooltip(bucket: SessionPickerBucket): string | null {
    const keyedPath = bucket.key.startsWith("project:") ? bucket.key.slice("project:".length) : "";
    const fallbackPath =
      bucket.sessions[0]?.session.cwd || bucket.sessions[0]?.session.workspacePath;
    const path = keyedPath && keyedPath !== "other" ? keyedPath : fallbackPath;
    return path ? shortenHomeDirectoryInText(path, $appState.homeDirectory) : null;
  }
</script>

{#snippet projectFilter()}
  {#if showProjectFilter}
    <select
      aria-label="Filter archive by project"
      data-tauri-drag-region={desktop ? "false" : undefined}
      class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 rounded-[5px] border px-2 text-[13px]/[18px] outline-none"
      value={selectedProjectPath ?? "/"}
      onchange={(event) => selectProjectFilter(event.currentTarget.value)}
    >
      <option value="/">All projects</option>
      <hr />
      <option value={ACP_CHAT_WORKSPACE_PATH} disabled={!hasArchivedChats}>Chats</option>
      {#each projectFilterOptions as project (project.path)}
        <option value={project.path}>{project.name}</option>
      {/each}
    </select>
  {/if}
{/snippet}

<div
  class={[
    "text-psx-foreground-primary flex flex-col",
    embedded
      ? "relative"
      : pane
        ? "bg-psx-panel relative h-full min-h-0"
        : "bg-psx-panel absolute inset-0 z-30",
  ]}
>
  {#if pane}
    <nav
      class="flex shrink-0 flex-col gap-0.5 px-1.5 pb-1.5 pt-12"
      aria-label="Archived conversations"
      data-tauri-drag-region={desktop ? "deep" : undefined}
    >
      <SidebarNavButton icon="arrow-left" label={backLabel} onclick={onBack} />
      {#if showProjectFilter}
        <div class="px-1 pt-0.5">
          {@render projectFilter()}
        </div>
      {/if}
    </nav>
  {:else if !embedded}
    <div
      class={[
        "mb-1 flex shrink-0 items-center gap-1 border-b border-transparent pr-2",
        desktop ? "h-12 pl-[var(--desktop-window-controls-space,88px)]" : "h-10 pl-2",
      ]}
      data-tauri-drag-region={desktop ? "deep" : undefined}
    >
      <button
        type="button"
        data-tauri-drag-region={desktop ? "false" : undefined}
        class="text-psx-foreground-secondary hover:text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus flex shrink-0 items-center gap-2 rounded-[6px] px-1 py-1 text-[13px]/[16px] transition-colors duration-200 ease-out focus-visible:outline-2"
        aria-label={backLabel}
        title={backLabel}
        onclick={onBack}
      >
        <Icon name="arrow-left" size={14} aria-hidden="true" />
        {backLabel}
      </button>
      <div class="min-w-0 flex-1"></div>

      {#if showCollapseButton}
        <SidebarIconButton
          icon="sidebar-hide"
          label="Collapse projects sidebar"
          dragRegion={desktop}
          onclick={() => onCollapse?.()}
        />
      {/if}
    </div>
  {/if}

  <div
    class={embedded ? "archive-catalog flex shrink-0 items-center gap-2 px-3 py-3" : "px-2 pb-2"}
  >
    <SearchField
      bind:value={searchQuery}
      placeholder={embedded ? "Search archived chats" : "Search history"}
      class="flex-1"
    />
    {#if embedded && showProjectFilter}
      <div class="w-[220px] max-w-[40%] shrink-0">
        {@render projectFilter()}
      </div>
    {/if}
  </div>

  {#if listFailures.length > 0}
    <div
      class="text-psx-foreground-secondary mx-2 mb-1.5 flex items-start gap-1.5 rounded-[6px] px-2 py-1.5 text-[12px]/[15px]"
      role="status"
    >
      <Icon name="alert" size={12} class="mt-0.5 shrink-0" aria-hidden="true" />
      <span class="min-w-0"
        >Couldn't refresh history from {failedAgentLabel}. Showing saved conversations.</span
      >
    </div>
  {/if}
  {#if reconciling && sessionCount > 0}
    <span class="sr-only" role="status">Refreshing archived conversations</span>
  {/if}

  <div
    class={embedded
      ? "archive-history-list archive-catalog px-1.5 pb-1.5"
      : "min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5"}
  >
    {#if state.status === "failure"}
      <div class="text-psx-foreground-secondary px-2 py-4 text-center text-[13px]/[16px]">
        {formatError(state.error ?? new Error("Unknown error"), {
          prefix: "Failed to load history",
        })}
      </div>
    {:else if state.status === "loading"}
      <div
        class="text-psx-foreground-secondary flex items-center justify-center gap-2 px-2 py-4 text-[13px]/[16px]"
      >
        <Spinner size={14} />
        Loading history...
      </div>
    {:else if sessionCount === 0 || (!hasActiveSearch && filteredSessionCount === 0)}
      <div class="text-psx-foreground-secondary px-2 py-4 text-center text-[13px]/[16px]">
        {emptyLabel}
      </div>
    {:else if hasActiveSearch && filteredSessionCount === 0}
      <div
        class="text-psx-foreground-primary mx-auto flex min-w-0 max-w-[80%] items-center justify-center gap-2 px-2 py-6 text-[13px]/[16px]"
      >
        <Icon
          name="search"
          size={14}
          class="text-psx-foreground-primary shrink-0"
          aria-hidden="true"
        />
        <span class="min-w-0 truncate">
          No older conversation found with {searchQuery.trim()}
        </span>
      </div>
    {:else}
      {#each visibleGroupedHistorySessions as bucket (bucket.key)}
        {@const bucketVisible = !embedded || bucketContentVisible(bucket.key)}
        {@const visibleSessions = visibleBucketSessions(bucket)}
        {@const hiddenSessionCount = bucket.sessions.length - visibleSessions.length}
        <section class="history-bucket">
          {#if embedded}
            <h3 class="bg-psx-editor-background sticky top-0 z-10">
              <button
                type="button"
                class="text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-left text-[13px]/[16px] font-medium focus-visible:outline-2"
                aria-label={bucketVisible ? `Collapse ${bucket.title}` : `Expand ${bucket.title}`}
                aria-expanded={bucketVisible}
                onclick={() => toggleBucket(bucket.key)}
              >
                {#if reconciling}
                  <Spinner
                    aria-hidden="true"
                    size={18}
                    class="text-psx-foreground-secondary shrink-0"
                  />
                {:else}
                  <Icon
                    name={bucketVisible ? "folder-open" : "folder-closed"}
                    size={18}
                    class="text-psx-foreground-secondary shrink-0"
                    aria-hidden="true"
                  />
                {/if}
                <Tooltip
                  text={bucketCwdTooltip(bucket)}
                  placement="top"
                  gutter={8}
                  openDelay={200}
                  class="min-w-0"
                >
                  <span class="min-w-0 truncate">{bucket.title}</span>
                </Tooltip>
                <span
                  class={[
                    "text-psx-foreground-tertiary inline-flex size-4 shrink-0 items-center justify-center transition-transform duration-200 ease-out",
                    bucketVisible ? "" : "-rotate-90",
                  ]}
                  aria-hidden="true"
                >
                  <Icon name="chevron" size={13} />
                </span>
              </button>
            </h3>
          {:else}
            <div
              class="bg-psx-panel text-psx-foreground-secondary sticky top-0 z-10 px-2 py-1.5 text-[13px]/[16px]"
            >
              {bucket.title}
            </div>
          {/if}
          <div
            role="group"
            aria-label={`${bucket.title} conversations`}
            class={[
              "grid transition-[grid-template-rows] duration-200 ease-out",
              bucketVisible ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            ]}
            inert={!bucketVisible}
            aria-hidden={!bucketVisible}
          >
            <div class="min-h-0 overflow-hidden">
              <div
                class={embedded
                  ? "desktop-conversation-connector before:border-psx-border relative ml-[11.5px] pl-[14px] before:pointer-events-none before:absolute before:bottom-[14px] before:left-[9px] before:top-0 before:w-[10px] before:rounded-bl-[5px] before:border-b before:border-l before:content-['']"
                  : undefined}
              >
                {#each visibleSessions as item (historySessionRowKey(item.session))}
                  {@const sessionKey = historySessionRowKey(item.session)}
                  {@const navSession = visibleNavSessionForHistorySession(item.session)}
                  {@const pendingRestoreRemaining = pendingRestores.get(sessionKey)}
                  {@const openable =
                    sessionAvailable(item.session) &&
                    (Boolean(navSession) || canOpenReadOnly(item.session))}
                  <DesktopConversationRow
                    session={item.session}
                    compact
                    class={fadingRestoredSessionKeys.has(sessionKey)
                      ? "pointer-events-none opacity-0 transition-opacity duration-200 ease-out"
                      : "transition-opacity duration-200 ease-out"}
                    onSelect={() => {
                      interactWithBucket(bucket.key);
                      if (navSession) {
                        return onOpenRestoredHistorySession(item.session, navSession);
                      }
                      if (canOpenReadOnly(item.session)) {
                        return onOpenHistorySessionReadOnly?.(item.session);
                      }
                    }}
                    disabled={!openable}
                    selectTitle={sessionAvailable(item.session)
                      ? navSession
                        ? undefined
                        : "Open read-only"
                      : "The agent no longer has this conversation"}
                  >
                    {#snippet right()}
                      <div class="flex shrink-0 items-center gap-1">
                        {#if pendingRestoreRemaining !== undefined}
                          <Button
                            size="sm"
                            appearance="outline"
                            prominence="standard"
                            radius="full"
                            class="archive-restore-button w-16 shrink-0 items-center gap-1 text-[11px]/[14px]"
                            aria-label={`Undo restore ${item.session.title || "conversation"}`}
                            disabled={undoingRestoreSessionKeys.has(sessionKey)}
                            onclick={(event) => undoRestore(item.session, event)}
                          >
                            <span>Undo</span>
                            <span class="text-psx-foreground-tertiary tabular-nums"
                              >{pendingRestoreRemaining}</span
                            >
                          </Button>
                        {:else if navSession}
                          <button
                            type="button"
                            class="text-psx-foreground-secondary hover:text-psx-foreground-primary outline-hidden hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus shrink-0 rounded-[6px] px-1.5 py-1 text-[12px]/[16px] font-medium focus-visible:outline-2"
                            aria-label={`Archive ${item.session.title || "conversation"}`}
                            onclick={(event) => {
                              interactWithBucket(bucket.key);
                              return onArchiveHistorySession(item.session, navSession, event);
                            }}
                          >
                            Archive
                          </button>
                        {:else}
                          <Button
                            size="sm"
                            prominence="standard"
                            radius="full"
                            class="archive-restore-button bg-psx-chrome-hover text-psx-foreground-primary hover:bg-psx-menu-hover-background w-16 shrink-0 text-[11px]/[14px] shadow-none"
                            aria-label={`Restore ${item.session.title || "conversation"}`}
                            onclick={() => restoreHistorySession(item.session, bucket.key)}
                          >
                            Restore
                          </Button>
                        {/if}
                        <SidebarIconButton
                          icon="trash"
                          label={`Delete ${item.session.title || "conversation"}`}
                          title={canDeleteSession(item.session)
                            ? "Delete conversation"
                            : "This agent does not support deleting sessions"}
                          size={14}
                          buttonSize="size-6"
                          disabled={!canDeleteSession(item.session)}
                          onclick={(event) => {
                            interactWithBucket(bucket.key);
                            return onDeleteHistorySession(item.session, event);
                          }}
                        />
                      </div>
                    {/snippet}
                  </DesktopConversationRow>
                {/each}
                {#if !hasActiveSearch && bucket.sessions.length > ARCHIVED_CONVERSATION_VISIBLE_LIMIT}
                  <button
                    type="button"
                    class="text-psx-foreground-tertiary outline-hidden hover:bg-psx-menu-hover-background hover:text-psx-foreground-secondary focus-visible:outline-psx-focus flex w-full items-center gap-1 rounded-[6px] px-2 py-1.5 text-left text-[13px]/[16px] focus-visible:outline-2"
                    onclick={() => toggleBucketSessions(bucket.key)}
                  >
                    {hiddenSessionCount > 0 ? `Show ${hiddenSessionCount} more` : "Show less"}
                  </button>
                {/if}
              </div>
            </div>
          </div>
        </section>
      {/each}
    {/if}
  </div>
</div>

<style lang="postcss">
  .archive-catalog {
    width: 100%;
    max-width: 48rem;
  }

  :global(button.archive-restore-button) {
    height: 1.375rem;
    min-height: 1.375rem;
    padding: 0.125rem 0.5rem;
  }
</style>
