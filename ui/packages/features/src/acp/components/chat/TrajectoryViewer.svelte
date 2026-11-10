<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "@camber/components/icon";
  import { FileCodeView } from "@camber/components/file-diff";
  import { Switch } from "@camber/components/switch";
  import { appState } from "../../hostAdapter";
  import { normalizeAgentServerName } from "../../agentServers";
  import { getACPContext } from "../../features/SessionRepository.svelte";
  import { getACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import { getOptionalACPConnectionPoolContext } from "../../connectionPoolContext";
  import { ACP_DEBUG_DUMP_LOADED_EVENT, type ACPDumpEntry } from "../../debugDump";
  import { buildTrajectoryRows, scopeTrajectoryToConversation } from "../../trajectory";
  import { saveACPTrajectory } from "../../dumpACPConversation";

  interface Props {
    onClose?: () => void;
    sidebarCollapsed?: boolean;
    embedded?: boolean;
  }

  let { onClose, sidebarCollapsed = false, embedded = false }: Props = $props();

  const acp = getACPContext();
  const chatSession = getACPChatSessionScope();
  const acpConnectionPool = getOptionalACPConnectionPoolContext();

  const isDesktop = $derived($appState.environment.assistantHost === "desktop");
  // Reserve space for the macOS traffic lights only when the chat pane sits at the
  // window's left edge (sidebar collapsed); otherwise the controls are over the sidebar.
  const headerLeftPad = $derived(
    !isDesktop || embedded
      ? "pl-2"
      : sidebarCollapsed
        ? "pl-[var(--desktop-window-controls-space,88px)]"
        : "pl-4",
  );
  const agentServer = $derived(chatSession.sessionAgentServer ?? chatSession.activeAgentServer);
  const conversationId = $derived(chatSession.pendingConversationId ?? chatSession.conversationId);
  const capture = acpConnectionPool?.debug.capture;

  let collapse = $state(true);
  let captureState = $state(capture?.state());
  const collecting = $derived.by(() => {
    if (!captureState || !capture || !conversationId) return false;
    return capture.isConversationCollecting(agentServer, conversationId, chatSession.sessionId);
  });
  const canToggleCollecting = $derived(capture !== undefined && conversationId !== null);
  let selectedIndex = $state(0);
  let snapshot = $state<ACPDumpEntry[]>([]);
  let query = $state("");

  function setCollecting(enabled: boolean) {
    if (!capture || !conversationId) return;
    capture.setConversationCollecting(agentServer, conversationId, chatSession.sessionId, enabled);
  }

  const SIDEBAR_WIDTH_STORAGE_KEY = "camber.acp.trajectorySidebarWidth";
  const SIDEBAR_DEFAULT_WIDTH = 320;
  const SIDEBAR_MIN_WIDTH = 200;
  // Keep at least this much room for the JSON detail pane while resizing.
  const DETAIL_MIN_WIDTH = 280;

  function getSavedSidebarWidth(): number {
    const value = globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
    if (Number.isNaN(parsed)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.max(parsed, SIDEBAR_MIN_WIDTH);
  }

  let splitWidth = $state(0);
  let sidebarWidth = $state(getSavedSidebarWidth());
  let sidebarResizing = $state(false);
  let sidebarResizeStartX = 0;
  let sidebarResizeStartWidth = 0;

  const sidebarMaxWidth = $derived(
    splitWidth > 0
      ? Math.max(SIDEBAR_MIN_WIDTH, splitWidth - DETAIL_MIN_WIDTH)
      : Number.MAX_SAFE_INTEGER,
  );
  const appliedSidebarWidth = $derived(
    Math.min(Math.max(sidebarWidth, SIDEBAR_MIN_WIDTH), sidebarMaxWidth),
  );

  function setSidebarWidth(width: number) {
    sidebarWidth = Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), sidebarMaxWidth);
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, sidebarWidth.toString());
  }

  function startSidebarResize(event: MouseEvent) {
    sidebarResizing = true;
    sidebarResizeStartX = event.clientX;
    sidebarResizeStartWidth = appliedSidebarWidth;
    document.body.classList.add("acp-trajectory-resizing");
    event.preventDefault();
  }

  function moveSidebarResize(event: MouseEvent) {
    if (!sidebarResizing) return;
    setSidebarWidth(sidebarResizeStartWidth + event.clientX - sidebarResizeStartX);
  }

  function stopSidebarResize() {
    if (!sidebarResizing) return;
    sidebarResizing = false;
    document.body.classList.remove("acp-trajectory-resizing");
  }

  function handleSidebarResizeKeydown(event: KeyboardEvent) {
    const step = event.shiftKey ? 32 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth(appliedSidebarWidth - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth(appliedSidebarWidth + step);
    }
  }

  function refresh() {
    snapshot = acpConnectionPool?.debug.dump(agentServer) ?? [];
  }

  // New frames arrive per streamed chunk; batch them into one re-dump so the
  // viewer stays live without cloning the log on every event. setTimeout (not
  // rAF) so the panel keeps streaming while the window is occluded.
  const STREAM_REFRESH_INTERVAL_MS = 250;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  function queueRefresh() {
    refreshTimer ??= setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, STREAM_REFRESH_INTERVAL_MS);
  }

  const scopedEntries = $derived(scopeTrajectoryToConversation(snapshot, chatSession.sessionId));
  const rows = $derived(buildTrajectoryRows(scopedEntries, { collapse }));
  const selectedRow = $derived(rows[selectedIndex] ?? rows[rows.length - 1] ?? null);
  const detailJson = $derived(selectedRow ? JSON.stringify(selectedRow.detail, null, 2) : "");

  const q = $derived(query.trim().toLowerCase());
  const filteredRows = $derived(
    q
      ? rows.filter((row) =>
          `${row.title} ${row.summary} ${row.proto} ${row.method ?? ""} ${row.kind}`
            .toLowerCase()
            .includes(q),
        )
      : rows,
  );

  function handleKeydown(event: KeyboardEvent) {
    if (!embedded && event.key === "Escape") {
      event.preventDefault();
      onClose?.();
    }
  }

  async function save() {
    await saveACPTrajectory(
      scopedEntries,
      chatSession.sessionId,
      $appState.environment.assistantHost,
    );
  }

  onMount(() => {
    refresh();
    const handler = () => refresh();
    acp.emitter.addEventListener(ACP_DEBUG_DUMP_LOADED_EVENT, handler);
    const unsubscribeCapture = capture?.subscribe((state) => (captureState = state));
    const unsubscribeEntries = acpConnectionPool?.debug.subscribeEntries((server) => {
      if (server === normalizeAgentServerName(agentServer)) queueRefresh();
    });
    return () => {
      acp.emitter.removeEventListener(ACP_DEBUG_DUMP_LOADED_EVENT, handler);
      unsubscribeCapture?.();
      unsubscribeEntries?.();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      stopSidebarResize();
    };
  });

  const iconButtonClass =
    "text-psx-icon hover:bg-psx-menu-hover-background outline-hidden focus-visible:outline-psx-focus flex size-7 shrink-0 items-center justify-center rounded-[6px] focus-visible:outline-2";
</script>

<svelte:window
  onkeydown={handleKeydown}
  onmousemove={(event) => moveSidebarResize(event)}
  onmouseup={() => stopSidebarResize()}
/>

<div
  class={[
    "bg-psx-editor-background text-psx-foreground-primary flex min-h-0 flex-col",
    embedded ? "relative h-full" : "absolute inset-0 z-30",
  ]}
  data-tauri-drag-region={!embedded && isDesktop ? "deep" : undefined}
>
  <div
    class={[
      "border-psx-border flex shrink-0 items-center gap-2 border-b pr-2",
      isDesktop ? "h-12" : "h-10",
      headerLeftPad,
    ]}
    data-tauri-drag-region={!embedded && isDesktop ? "deep" : undefined}
  >
    {#if !embedded}
      <button
        type="button"
        class="text-psx-foreground-primary hover:bg-psx-menu-hover-background outline-hidden focus-visible:outline-psx-focus flex shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-sm focus-visible:outline-2"
        data-tauri-drag-region={!embedded && isDesktop ? "false" : undefined}
        aria-label="Close ACP Events"
        title="Back"
        onclick={() => onClose?.()}
      >
        <Icon name="arrow-left" size={16} aria-hidden="true" />
        <span class="font-medium">ACP Events</span>
      </button>
    {/if}
    <span class="text-psx-foreground-secondary shrink-0 text-xs">
      {q ? `${filteredRows.length} / ${rows.length}` : rows.length} events
    </span>

    <div class="min-w-0 flex-1"></div>

    <div
      class="flex shrink-0 items-center gap-2"
      data-tauri-drag-region={!embedded && isDesktop ? "false" : undefined}
      title="Merge consecutive streaming message/thought chunks into a single event"
    >
      <button
        type="button"
        class="text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus rounded-[6px] text-xs focus-visible:outline-2"
        onclick={() => (collapse = !collapse)}
      >
        Collapse streaming events
      </button>
      <Switch bind:checked={collapse} aria-label="Collapse streaming events" />
    </div>

    <div
      class="flex shrink-0 items-center gap-2"
      data-tauri-drag-region={!embedded && isDesktop ? "false" : undefined}
      title="Collect new ACP events for this conversation into the in-memory log"
    >
      <button
        type="button"
        class="text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus rounded-[6px] text-xs focus-visible:outline-2"
        disabled={!canToggleCollecting}
        onclick={() => setCollecting(!collecting)}
      >
        {collecting ? "Collecting" : "Collection stopped"}
      </button>
      <Switch
        checked={collecting}
        disabled={!canToggleCollecting}
        onCheckedChange={(enabled) => setCollecting(enabled)}
        aria-label="Collect ACP events for this conversation"
      />
    </div>

    <button
      type="button"
      class={iconButtonClass}
      data-tauri-drag-region={!embedded && isDesktop ? "false" : undefined}
      aria-label="Save ACP events"
      title="Save ACP Events"
      disabled={scopedEntries.length === 0}
      onclick={() => void save()}
    >
      <Icon name="export" size={15} />
    </button>
  </div>

  {#if !acpConnectionPool}
    <div class="text-psx-foreground-secondary flex flex-1 items-center justify-center text-sm">
      ACP Events is unavailable.
    </div>
  {:else if rows.length === 0}
    <div class="text-psx-foreground-secondary flex flex-1 items-center justify-center text-sm">
      {collecting
        ? "No ACP events recorded for this conversation yet."
        : "Event collection is stopped for this conversation. Turn on Collect to record new ACP events."}
    </div>
  {:else}
    <div class="flex min-h-0 flex-1" bind:clientWidth={splitWidth}>
      <div
        class="border-psx-border relative flex shrink-0 flex-col border-r"
        style:width={`${appliedSidebarWidth}px`}
      >
        <div class="border-psx-border border-b p-1.5">
          <input
            bind:value={query}
            type="text"
            placeholder="Filter events"
            aria-label="Filter events"
            spellcheck="false"
            autocorrect="off"
            autocapitalize="off"
            autocomplete="off"
            class="border-psx-border bg-psx-editor-background text-psx-foreground-primary outline-hidden placeholder:text-psx-foreground-tertiary focus-visible:outline-psx-focus w-full rounded-[6px] border px-2 py-1 text-xs focus-visible:outline-2"
          />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          {#if filteredRows.length === 0}
            <div class="text-psx-foreground-tertiary px-2 py-4 text-center text-xs">
              No events match “{query.trim()}”.
            </div>
          {:else}
            {#each filteredRows as row (row.index)}
              {#if !q && row.turnStart}
                <div
                  class="bg-psx-editor-background text-psx-foreground-secondary border-psx-border sticky top-0 z-10 border-b px-2 py-1 text-[10px] font-medium uppercase tracking-wide"
                >
                  Turn {row.turnNumber}
                </div>
              {/if}
              <button
                type="button"
                class={[
                  "flex w-full min-w-0 flex-col gap-0.5 px-2 py-1.5 text-left",
                  "outline-hidden focus-visible:outline-psx-focus -outline-offset-2 focus-visible:outline-2",
                  selectedRow?.index === row.index
                    ? "bg-psx-menu-hover-background"
                    : "hover:bg-psx-menu-hover-background",
                ]}
                onclick={() => (selectedIndex = row.index)}
              >
                <div class="flex w-full min-w-0 items-center gap-1.5">
                  {#if row.direction === "outgoing"}
                    <span
                      class="arrow-out shrink-0 font-mono text-[13px] leading-none"
                      aria-hidden="true">←</span
                    >
                  {/if}
                  <span class="min-w-0 flex-1 truncate text-[13px]/[16px]">{row.title}</span>
                  {#if row.chunkCount > 1}
                    <span class="text-psx-foreground-tertiary shrink-0 text-[10px]">
                      ×{row.chunkCount}
                    </span>
                  {/if}
                  <span class="text-psx-foreground-tertiary shrink-0 font-mono text-[10px]">
                    {row.proto}
                  </span>
                </div>
                {#if row.summary}
                  <div
                    class="text-psx-foreground-secondary w-full min-w-0 truncate text-[12px]/[15px]"
                  >
                    {row.summary}
                  </div>
                {/if}
              </button>
            {/each}
          {/if}
        </div>

        <div
          role="slider"
          aria-label="Resize events list"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={splitWidth > 0 ? sidebarMaxWidth : appliedSidebarWidth}
          aria-valuenow={appliedSidebarWidth}
          tabindex={0}
          data-tauri-drag-region={!embedded && isDesktop ? "false" : undefined}
          class={[
            "outline-hidden focus-visible:outline-psx-focus absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize focus-visible:outline-2",
            "before:absolute before:inset-y-0 before:left-1/2 before:w-[2px] before:-translate-x-1/2 before:bg-transparent before:transition-colors",
            "hover:before:bg-psx-focus focus-visible:before:bg-psx-focus",
            sidebarResizing ? "before:bg-psx-focus" : "",
          ]}
          onmousedown={startSidebarResize}
          onkeydown={handleSidebarResizeKeydown}
        ></div>
      </div>

      <div class="min-w-0 flex-1 overflow-hidden">
        <FileCodeView
          class="acp-trajectory-code h-full"
          content={detailJson}
          filename="trajectory.json"
          wrap
        />
      </div>
    </div>
  {/if}
</div>

<style>
  .arrow-out {
    color: var(--psx-terminal-blue, #3b82f6);
  }

  :global(.acp-trajectory-code.psx-file-code-view) {
    height: 100%;
  }

  :global(body.acp-trajectory-resizing) {
    cursor: col-resize !important;
    user-select: none;
  }

  :global(body.acp-trajectory-resizing *) {
    cursor: col-resize !important;
  }
</style>
