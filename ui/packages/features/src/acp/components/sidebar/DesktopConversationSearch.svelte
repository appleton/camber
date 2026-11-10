<script lang="ts">
  import Icon from "@camber/components/icon";
  import type { IconName } from "@camber/components/icon";
  import Kbd from "@camber/components/kbd";
  import type { SearchFile } from "@camber/helperapi/schemas";
  import { joinPath } from "@camber/lib/path-query";
  import { InfoMessageType } from "@camber/rpc";
  import { Command, defaultFilter } from "cmdk-sv";
  import { onMount, tick, untrack } from "svelte";
  import {
    sortConversationSummaries,
    type ACPConversationSummary,
    type ACPNavProject,
  } from "../../navTypes";
  import {
    DESKTOP_NEW_TAB_EVENT,
    type DesktopNewTabAvailability,
    type DesktopNewTabKind,
  } from "../chat/desktopCommandPicker";
  import { appState } from "../../hostAdapter";
  import { rpc } from "../../hostRpc";
  import { searchProjectFiles } from "../../prompt/menus/files/fileSearch";
  import { sourceTitleFromHandoffContext } from "../../features/session/handoffContext";
  import { stripInjectedContextFromText } from "../../features/session/hostContext";
  import { formatRelativeTimeWithoutAgo } from "../../shared/time";
  import DotsLoader from "../ui/DotsLoader.svelte";
  import DesktopConversationRow from "./DesktopConversationRow.svelte";
  import { conversationProjectLabel } from "./conversationProjectLabel";
  import { getAcpSidebarController } from "./SidebarController.svelte";
  import {
    CONVERSATION_SHORTCUT_LIMIT,
    conversationShortcutIndexFromKeyboardEvent,
  } from "./conversationShortcuts";
  import {
    orderConversationSearchItems,
    readRecentlyViewedConversations,
    recordRecentlyViewedConversation,
    writeRecentlyViewedConversations,
    type ConversationSearchOrderState,
  } from "./conversationSearchOrder";
  import { isConversationVisibleInSearch } from "./conversationSearchVisibility";
  import {
    fileOpenerIdForSelection,
    IN_APP_FILE_OPENER_ID,
    isExternalFileOpenShortcut,
  } from "./desktopConversationSearchFileOpen";

  interface Props {
    open: boolean;
    initialQuery?: string;
    openToken?: number;
    sessions: ACPConversationSummary[];
    projects: ACPNavProject[];
    excludedConversationIds?: string[];
    activeConversationId?: string | null;
    activeWorkspaceCwd?: string | null;
    newTabAvailability?: DesktopNewTabAvailability;
    shortcutHintsVisible?: boolean;
  }

  interface ConversationSearchRow {
    session: ACPConversationSummary;
    title: string;
    identity: string;
    searchValue: string;
    matchScore: number;
  }

  interface ConversationSearchGroup {
    key: string;
    rows: ConversationSearchRow[];
  }

  interface NewTabSearchAction {
    kind: DesktopNewTabKind;
    label: string;
    detail: string;
    icon: IconName;
    aliases?: string[];
  }

  interface ResolvedNewTabSearchAction extends NewTabSearchAction {
    disabled: boolean;
    disabledReason?: string;
  }

  interface DesktopSettings {
    fileOpenerId: string;
  }

  type DesktopOpenRPC = typeof rpc & {
    getDesktopSettings(): Promise<DesktopSettings>;
    openPathWithOpener(path: string, openerId: string): Promise<void>;
  };

  type SingleLineItemIcon = { type: "product"; name: IconName } | { type: "file"; path: string };

  interface SingleLineItem {
    icon: SingleLineItemIcon;
    label: string;
    detail?: string;
    disabled?: boolean;
  }

  type FileSearchText = SearchFile["name"] | string;

  interface FileSearchItem {
    path: string;
    name: SearchFile["name"];
    detailParts: FileSearchText[];
    showExternalOpenerHint: boolean;
  }

  let {
    open = $bindable(),
    initialQuery = "",
    openToken = 0,
    sessions,
    projects,
    excludedConversationIds = [],
    activeConversationId = null,
    activeWorkspaceCwd = null,
    newTabAvailability = {},
    shortcutHintsVisible = false,
  }: Props = $props();

  const sidebar = getAcpSidebarController();
  const desktopRpc = rpc as DesktopOpenRPC;
  const DESKTOP_SETTINGS_CHANGED_EVENT = "camber:desktop-settings-changed";
  const SEARCH_INPUT_ID = "desktop-conversation-search-input";
  const CONVERSATION_RESULT_LIMIT = 50;
  const FILE_RESULT_LIMIT = 50;
  const NEW_TAB_ACTIONS: NewTabSearchAction[] = [
    {
      kind: "terminal",
      label: "Terminal",
      detail: "Open a new terminal",
      icon: "terminal",
      aliases: ["shell", "console"],
    },
    {
      kind: "files",
      label: "Files",
      detail: "Open file tree",
      icon: "folder-open",
      aliases: ["file tree", "explorer"],
    },
    {
      kind: "diff",
      label: "Review Diff",
      detail: "Review all uncommitted changes",
      icon: "diff",
      aliases: ["git", "changes", "review"],
    },
    {
      kind: "changes",
      label: "Stage and Commit",
      detail: "Open changes to stage and commit",
      icon: "diff",
      aliases: ["git", "changes", "commit", "stage", "stash", "source control"],
    },
    // The legacy Review panel is soft-removed; the git-backed staging workflow
    // below replaces it. Restore this entry if the review panel comes back.
    // {
    //   kind: "review",
    //   label: "Review",
    //   detail: "Review model edits",
    //   icon: "review",
    //   aliases: ["task", "diff"],
    // },
    {
      kind: "trajectory",
      label: "ACP Events",
      detail: "Inspect ACP events",
      icon: "output",
      aliases: ["events", "trajectory", "log"],
    },
    {
      kind: "github",
      label: "GitHub",
      detail: "Pull-request status and checks",
      icon: "github",
      aliases: ["pr", "pull request", "git"],
    },
  ];

  let search = $state("");
  let selectedCommandValue = $state("");
  let files = $state<SearchFile[]>([]);
  let showWorkspace = $state(false);
  let fileSearchComplete = $state(false);
  let fileSearchUnavailable = $state(false);
  let desktopFileOpenerId = $state(
    typeof $appState.environment.desktopFileOpenerId === "string"
      ? $appState.environment.desktopFileOpenerId
      : "default",
  );
  let fileSearchToken = 0;
  let previousOpenToken = 0;
  let recentlyViewedConversationKeys = $state(readRecentlyViewedConversations());
  let excludedConversationIdSet = $derived(new Set(excludedConversationIds));

  let trimmedSearch = $derived(search.trimStart());
  let isNewTabSearch = $derived(trimmedSearch.startsWith("+"));
  let fileQuery = $derived(isNewTabSearch ? trimmedSearch.slice(1).trimStart() : "");
  let showFileSearch = $derived(isNewTabSearch && fileQuery !== "");
  let showFileSearchHint = $derived(isNewTabSearch && fileQuery === "");
  let resolvedNewTabActions = $derived.by(() =>
    NEW_TAB_ACTIONS.map((action) => {
      const availability = newTabAvailability[action.kind];
      return {
        ...action,
        disabled: availability?.disabled === true,
        disabledReason: availability?.disabledReason,
      };
    }),
  );
  let filteredNewTabActions = $derived.by(() => {
    if (!isNewTabSearch) return [];
    if (fileQuery === "") return resolvedNewTabActions;
    return resolvedNewTabActions.filter(
      (action) => defaultFilter(newTabActionSearchValue(action), fileQuery) > 0,
    );
  });
  let showNewTabActions = $derived(isNewTabSearch && filteredNewTabActions.length > 0);
  let currentSelectableValues = $derived.by(() => {
    if (isNewTabSearch) {
      return [
        ...filteredNewTabActions.filter((action) => !action.disabled).map(newTabActionSearchValue),
        ...files.map(fileSearchValue),
      ];
    }

    return groupedRows.flatMap((group) => group.rows.map((row) => row.identity));
  });

  onMount(() => {
    void desktopRpc
      .getDesktopSettings()
      .then((settings) => {
        if (settings) applyDesktopSettings(settings);
      })
      .catch((error) => console.debug("Unable to load desktop settings", error));

    const onSettingsChanged = (event: Event) => {
      const settings = (event as CustomEvent<DesktopSettings | undefined>).detail;
      if (settings) applyDesktopSettings(settings);
    };
    window.addEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => window.removeEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
  });

  // Build the stable parts of each search row ahead of typing. Besides moving
  // project and agent lookups off the keystroke path, keeping this recency-
  // sorted gives every downstream ordering its newest-first tiebreak.
  let conversationSearchIndex = $derived.by(() =>
    sessions
      .filter(
        (session) =>
          !excludedConversationIdSet.has(session.id) &&
          isConversationVisibleInSearch(session, projects),
      )
      .map((session, index) => {
        const title = searchTitle(session);
        const searchValue = itemSearchValue(session, title);
        return {
          session,
          title,
          identity: itemIdentity(session, index),
          searchValue,
          matchScore: 1,
        };
      })
      .sort((left, right) => sortConversationSummaries(left.session, right.session)),
  );

  // Keep the derived index warm while the sidebar is mounted so opening the
  // command menu does not pay the indexing cost.
  $effect(() => {
    void conversationSearchIndex.length;
  });

  let conversationRows = $derived.by(() => {
    if (isNewTabSearch) return [];
    const query = search.trim();
    if (!query) {
      // The blank menu reads as a timeline — last changed, not last viewed —
      // but conversations needing attention still jump the queue.
      return orderConversationSearchItems(conversationSearchIndex, [], searchOrderState).slice(
        0,
        CONVERSATION_RESULT_LIMIT,
      );
    }

    const rows = conversationSearchIndex
      .map((row) => ({
        ...row,
        matchScore: defaultFilter(row.searchValue, query),
      }))
      .filter((row) => row.matchScore > 0);

    return orderConversationSearchItems(rows, recentlyViewedConversationKeys, searchOrderState)
      .sort((left, right) => right.matchScore - left.matchScore)
      .slice(0, CONVERSATION_RESULT_LIMIT);
  });
  let groupedRows = $derived.by(() => {
    return conversationRows.length > 0
      ? ([
          {
            key: "CHAT",
            rows: conversationRows,
          },
        ] satisfies ConversationSearchGroup[])
      : [];
  });
  let filteredRowCount = $derived(
    groupedRows.reduce((count, group) => count + group.rows.length, 0),
  );
  // Conversation rows in priority order. The first CONVERSATION_SHORTCUT_LIMIT
  // remain reachable through ⌘1–9 without rendering shortcut hints in the list.
  let orderedConversationRows = $derived(groupedRows.flatMap((group) => group.rows));

  $effect(() => {
    if (!open) return;
    const token = openToken;
    if (token === previousOpenToken) return;
    previousOpenToken = token;
    search = initialQuery;
    void focusSearchInput();
  });

  $effect(() => {
    if (!activeConversationId) return;
    const session = sessions.find((candidate) => candidate.id === activeConversationId);
    if (session) markConversationViewed(session);
  });

  $effect(() => {
    if (!open) return;

    const selectableValues = currentSelectableValues;
    const firstSelectableValue = selectableValues[0];
    if (!firstSelectableValue) return;

    const currentValue = untrack(() => selectedCommandValue);
    if (trimmedSearch === "+" || !selectableValues.includes(currentValue)) {
      selectedCommandValue = firstSelectableValue;
    }
  });

  $effect(() => {
    if (!open || !showFileSearch) {
      resetFileSearch();
      return;
    }

    const query = fileQuery;
    preparePendingFileSearch();
    const timer = setTimeout(() => {
      void searchFiles(query);
    }, 150);
    return () => clearTimeout(timer);
  });

  async function focusSearchInput() {
    await tick();
    document.getElementById(SEARCH_INPUT_ID)?.focus();
  }

  async function handleSelect(session: ACPConversationSummary) {
    markConversationViewed(session);
    closeSearch();
    await sidebar.openSession(session, session.cwd);
  }

  function markConversationViewed(session: ACPConversationSummary) {
    const next = recordRecentlyViewedConversation(
      recentlyViewedConversationKeys,
      recentlyViewedKey(session),
    );
    if (next.every((key, index) => key === recentlyViewedConversationKeys[index])) return;
    recentlyViewedConversationKeys = next;
    writeRecentlyViewedConversations(next);
  }

  function handleDialogKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      // Consume the key entirely — if it reached the window listeners it would
      // interrupt the running turn via the prompt editor's Escape handling.
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
      return;
    }

    // ⌘1–9 jumps to the numbered conversation result. ⌘-digit is a command
    // chord, so it never types into the search input. Scoped to conversation
    // mode — the "+" new-tab/file view has no conversation shortcuts.
    if (!isNewTabSearch && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      const shortcutIndex = conversationShortcutIndexFromKeyboardEvent(event);
      const row =
        shortcutIndex === undefined || shortcutIndex > CONVERSATION_SHORTCUT_LIMIT
          ? undefined
          : orderedConversationRows[shortcutIndex - 1];
      if (row) {
        event.preventDefault();
        event.stopPropagation();
        void handleSelect(row.session);
      }
    }
  }

  function handleDialogKeyDownCapture(event: KeyboardEvent) {
    if (!showFileSearch || !isExternalFileOpenShortcut(event)) {
      return;
    }

    const file = files.find((candidate) => fileSearchValue(candidate) === selectedCommandValue);
    if (!file) return;

    event.preventDefault();
    event.stopPropagation();
    openFile(file.path, fileOpenerIdForSelection(desktopFileOpenerId, true));
  }

  function closeSearch() {
    open = false;
    search = "";
    selectedCommandValue = "";
    resetFileSearch();
  }

  function resetFileSearch() {
    fileSearchToken++;
    files = [];
    showWorkspace = false;
    fileSearchComplete = false;
    fileSearchUnavailable = false;
  }

  function preparePendingFileSearch() {
    fileSearchToken++;
    fileSearchComplete = false;
    fileSearchUnavailable = false;
  }

  async function searchFiles(query: string) {
    const token = ++fileSearchToken;
    fileSearchComplete = false;
    fileSearchUnavailable = false;

    if (!$appState.isHelperSupported) {
      files = [];
      showWorkspace = false;
      fileSearchComplete = true;
      fileSearchUnavailable = true;
      return;
    }

    let result: Awaited<ReturnType<typeof searchProjectFiles>>;
    try {
      result = await searchProjectFiles({
        query,
        appState: $appState,
        activeWorkspaceCwd,
        projects,
        desktopWorkspaceScope: "cwd",
        excludeOpenFilesOutsideWorkspaces: true,
      });
    } catch {
      if (token !== fileSearchToken) return;
      files = [];
      showWorkspace = false;
      fileSearchComplete = true;
      rpc.showInfoMessage("Unable to search files", InfoMessageType.error);
      return;
    }

    if (token !== fileSearchToken) return;
    fileSearchComplete = true;

    if (result.kind === "helperUnsupported") {
      files = [];
      showWorkspace = false;
      fileSearchUnavailable = true;
      return;
    }

    showWorkspace =
      result.response.workspaces !== undefined && result.response.workspaces.length > 1;
    files = result.response.files.filter(isOpenableFile).slice(0, FILE_RESULT_LIMIT);
  }

  function isOpenableFile(file: SearchFile): boolean {
    return !file.isDirectory && file.virtualKind !== "workspace-folder";
  }

  function matchableValue(value: FileSearchText): string {
    return typeof value === "string" ? value : value.value;
  }

  function fileSearchValue({ path, displayPath, directory, name }: SearchFile): string {
    const fileName = matchableValue(name);
    const directoryName = matchableValue(directory);
    const relativePath = joinPath(directoryName, fileName);
    return [path, displayPath, relativePath].filter(Boolean).join(" ");
  }

  function openNewTab(kind: DesktopNewTabKind) {
    const action = resolvedNewTabActions.find((candidate) => candidate.kind === kind);
    if (action?.disabled) return;
    closeSearch();
    window.dispatchEvent(
      new CustomEvent(DESKTOP_NEW_TAB_EVENT, {
        detail: { kind },
        cancelable: true,
      }),
    );
  }

  function applyDesktopSettings(settings: DesktopSettings) {
    desktopFileOpenerId = settings.fileOpenerId || "default";
  }

  function openFile(path: string, openerId = IN_APP_FILE_OPENER_ID) {
    closeSearch();
    void desktopRpc.openPathWithOpener(path, openerId).catch((error) => {
      console.debug("Unable to open file", error);
    });
  }

  function fileSearchEmptyLabel(): string {
    if (fileSearchUnavailable) return "File search unavailable";
    if (!fileSearchComplete) return "Searching files";
    if (filteredNewTabActions.length === 0) return "No tabs or files found";
    return "No files found";
  }

  function fileDetailParts({
    directory,
    showDirectory,
    workspace,
  }: {
    directory: SearchFile["directory"];
    showDirectory: boolean;
    workspace?: SearchFile["workspace"];
  }): FileSearchText[] {
    const parts: FileSearchText[] = [];
    if (showWorkspace && workspace) parts.push(workspace);
    if (showDirectory) parts.push(directory);
    if (parts.length > 0) return parts;
    return ["."];
  }

  function newTabActionDetail(action: ResolvedNewTabSearchAction): string {
    if (action.disabled && action.disabledReason) {
      return action.disabledReason;
    }
    return action.detail;
  }

  function newTabActionSearchValue(action: NewTabSearchAction): string {
    return [action.label, action.detail, ...(action.aliases ?? [])].join(" ");
  }

  function highlightedMatchableHtml(value: FileSearchText): string {
    if (typeof value !== "string") {
      return highlightIndicesHtml(value.value, value.indices);
    }
    return highlightIndicesHtml(value, findMatchIndices(value, fileQuery));
  }

  function highlightedConversationTitleHtml(title: string): string {
    return highlightIndicesHtml(title, findMatchIndices(title, search.trim()));
  }

  function highlightIndicesHtml(value: string, indices: readonly number[]): string {
    if (!value || indices.length === 0) return escapeHtml(value);

    const matchedIndices = new Set(
      indices.filter((index) => Number.isInteger(index) && index >= 0 && index < value.length),
    );
    if (matchedIndices.size === 0) return escapeHtml(value);

    let html = "";
    let highlighting = false;
    for (let index = 0; index < value.length; index += 1) {
      const shouldHighlight = matchedIndices.has(index);
      if (shouldHighlight && !highlighting) {
        html += '<span data-state="matched">';
        highlighting = true;
      } else if (!shouldHighlight && highlighting) {
        html += "</span>";
        highlighting = false;
      }
      html += escapeHtml(value[index]);
    }
    if (highlighting) html += "</span>";
    return html;
  }

  function findMatchIndices(value: string, query: string): number[] {
    if (!value || !query) return [];

    const queryChars = query.toLocaleLowerCase().split("");
    const indices: number[] = [];
    let queryIndex = 0;

    for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
      if (queryIndex >= queryChars.length) break;
      if (value[valueIndex].toLocaleLowerCase() !== queryChars[queryIndex]) continue;
      indices.push(valueIndex);
      queryIndex += 1;
    }

    return queryIndex === queryChars.length ? indices : [];
  }

  function escapeHtml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function itemSearchValue(session: ACPConversationSummary, title: string): string {
    const agentName = sidebar.getAgentName(sidebar.getSessionAgentServer(session));
    return [title, conversationProjectLabel(session, projects), agentName]
      .filter(Boolean)
      .join(" ");
  }

  function searchTitle(session: ACPConversationSummary): string {
    const storedTitle = session.title?.trim();
    if (!storedTitle) return "Untitled Conversation";

    const handoffTitle = sourceTitleFromHandoffContext(storedTitle);
    if (handoffTitle) return handoffTitle;

    return stripInjectedContextFromText(storedTitle).trim() || "Untitled Conversation";
  }

  function searchOrderState(row: ConversationSearchRow): ConversationSearchOrderState {
    const rowState = sidebar.rowState(row.session);
    return {
      key: recentlyViewedKey(row.session),
      updatedAt: row.session.updatedAt,
      waitingForUser: rowState.waitingForUser,
      unread: rowState.unread,
    };
  }

  function itemIdentity(session: ACPConversationSummary, index: number): string {
    return [
      "conversation-search",
      index,
      sidebar.getSessionAgentServer(session),
      session.sessionId ?? "",
      session.id,
      session.cwd,
    ].join(":");
  }

  function recentlyViewedKey(session: ACPConversationSummary): string {
    return `${sidebar.getSessionAgentServer(session)}:${session.id}`;
  }
</script>

{#if open}
  <button
    type="button"
    class="desktop-conversation-search-overlay"
    aria-label="Close conversation search"
    tabindex="-1"
    onclick={closeSearch}
  ></button>

  <div
    class="desktop-conversation-search-dialog"
    role="dialog"
    aria-modal="true"
    aria-label="Search conversations"
    tabindex="-1"
    onkeydowncapture={handleDialogKeyDownCapture}
    onkeydown={handleDialogKeyDown}
  >
    <Command.Root
      loop
      shouldFilter={false}
      bind:value={selectedCommandValue}
      label="Search conversations"
      class="desktop-conversation-search-root"
    >
      <div class="desktop-conversation-search-header">
        <Icon name="search" size={16} class="desktop-conversation-search-icon" aria-hidden="true" />
        <Command.Input
          id={SEARCH_INPUT_ID}
          bind:value={search}
          placeholder="Search conversations... (Type + to open a new tab)"
          aria-label="Search conversations"
          spellcheck={false}
          autocorrect="off"
          autocapitalize="off"
          autocomplete="off"
          class="desktop-conversation-search-input select-text"
        />
      </div>

      <div class="desktop-conversation-search-results">
        <Command.List class="desktop-conversation-search-list">
          {#if isNewTabSearch}
            {#if showNewTabActions}
              <div class="desktop-conversation-search-group">
                <div class="desktop-conversation-search-group-heading">
                  <span>New Tab</span>
                </div>
                {#each filteredNewTabActions as action (action.kind)}
                  <!-- Command.Item derives aria-disabled from `disabled`. Passing
                       aria-disabled explicitly would render aria-disabled="false" on
                       enabled items, which cmdk-sv's selectFirstItem treats as disabled
                       (element.ariaDisabled is the truthy string "false"), so the first
                       action would never be pre-selected when the picker opens. -->
                  <Command.Item
                    value={newTabActionSearchValue(action)}
                    disabled={action.disabled}
                    onSelect={() => openNewTab(action.kind)}
                    class={[
                      "desktop-conversation-search-item",
                      action.disabled ? "desktop-conversation-search-item-disabled" : "",
                    ]}
                  >
                    {@render singleLineItem({
                      icon: { type: "product", name: action.icon },
                      label: action.label,
                      detail: newTabActionDetail(action),
                      disabled: action.disabled,
                    })}
                  </Command.Item>
                {/each}
              </div>
            {/if}

            {#if showFileSearchHint}
              <div class="desktop-conversation-search-group">
                <div class="desktop-conversation-search-group-heading">
                  <span>Files</span>
                </div>
                <Command.Item
                  value="file-search-hint"
                  disabled
                  aria-disabled="true"
                  class={[
                    "desktop-conversation-search-item",
                    "desktop-conversation-search-item-disabled",
                  ]}
                >
                  {@render singleLineItem({
                    icon: { type: "product", name: "search" },
                    label: "Type to open a file in the workspace",
                    disabled: true,
                  })}
                </Command.Item>
              </div>
            {/if}

            {#if showFileSearch}
              {#if files.length === 0}
                <div class="desktop-conversation-search-empty">{fileSearchEmptyLabel()}</div>
              {/if}

              {#if files.length > 0}
                <div class="desktop-conversation-search-group">
                  <div class="desktop-conversation-search-group-heading">
                    <span>Files</span>
                  </div>
                  {#each files as file (file.path)}
                    {@const directoryName = matchableValue(file.directory)}
                    {@const showDirectory = directoryName !== "."}
                    {@const detailParts = fileDetailParts({
                      directory: file.directory,
                      showDirectory,
                      workspace: file.workspace,
                    })}
                    <Command.Item
                      value={fileSearchValue(file)}
                      onSelect={() => openFile(file.path)}
                      class="desktop-conversation-search-item"
                    >
                      {@render fileSearchItem({
                        path: file.path,
                        name: file.name,
                        detailParts,
                        showExternalOpenerHint: shortcutHintsVisible,
                      })}
                    </Command.Item>
                  {/each}
                </div>
              {/if}
            {/if}
          {:else}
            {#if filteredRowCount === 0}
              <div class="desktop-conversation-search-empty">No conversations found</div>
            {/if}

            {#each groupedRows as group (group.key)}
              <div class="desktop-conversation-search-group">
                {#each group.rows as row (row.identity)}
                  {@render conversationItem(row)}
                {/each}
              </div>
            {/each}
          {/if}
        </Command.List>
      </div>
    </Command.Root>
  </div>
{/if}

{#snippet singleLineItem(item: SingleLineItem)}
  <div class="desktop-conversation-search-item-inner desktop-conversation-search-item-inner-inline">
    <span
      class={[
        "desktop-conversation-search-inline-icon",
        item.disabled ? "desktop-conversation-search-inline-icon-disabled" : "",
      ]}
      aria-hidden="true"
    >
      {#if item.icon.type === "file"}
        <Icon type="file" name={item.icon.path} fallback="file" size={16} />
      {:else}
        <Icon name={item.icon.name} size={16} />
      {/if}
    </span>
    <span class="desktop-conversation-search-inline-copy">
      <span
        class={[
          "desktop-conversation-search-inline-title",
          item.disabled ? "desktop-conversation-search-inline-title-disabled" : "",
        ]}>{item.label}</span
      >
      {#if item.detail}
        <span
          class={[
            "desktop-conversation-search-inline-detail",
            item.disabled ? "desktop-conversation-search-inline-detail-disabled" : "",
          ]}>{item.detail}</span
        >
      {/if}
    </span>
  </div>
{/snippet}

{#snippet fileSearchItem(item: FileSearchItem)}
  <div class="desktop-conversation-search-item-inner desktop-conversation-search-item-inner-inline">
    <span class="desktop-conversation-search-inline-icon" aria-hidden="true">
      <Icon type="file" name={item.path} fallback="file" size={16} />
    </span>
    <span class="desktop-conversation-search-inline-copy">
      <span class="desktop-conversation-search-inline-title"
        >{@html highlightedMatchableHtml(item.name)}</span
      >
      {#if item.detailParts.length > 0}
        <span class="desktop-conversation-search-inline-detail">
          {#each item.detailParts as part, index}
            {#if index > 0}
              <span class="desktop-conversation-search-inline-separator">-</span>
            {/if}
            <span>{@html highlightedMatchableHtml(part)}</span>
          {/each}
        </span>
      {/if}
      {#if item.showExternalOpenerHint}
        <span
          class="desktop-conversation-search-inline-detail desktop-conversation-search-external-opener-hint"
        >
          <span>Open in…</span>
          <Kbd label="⌘↵" />
        </span>
      {/if}
    </span>
  </div>
{/snippet}

{#snippet conversationItem(row: ConversationSearchRow)}
  {@const session = row.session}
  {@const rowState = sidebar.rowState(session)}
  {@const project = conversationProjectLabel(session, projects)}
  {@const updatedAt = session.updatedAt ? formatRelativeTimeWithoutAgo(session.updatedAt) : null}
  <Command.Item
    value={row.identity}
    onSelect={() => handleSelect(session)}
    class={[
      "desktop-conversation-search-item",
      rowState.selected ? "desktop-conversation-search-item-active" : "",
    ]}
  >
    <DesktopConversationRow {session} title={row.title}>
      {#snippet titleContent()}
        {@html highlightedConversationTitleHtml(row.title)}
      {/snippet}
      {#snippet right()}
        <div class="desktop-conversation-search-project">
          {#if project}
            <Icon name="folder" size={12} class="shrink-0" aria-hidden="true" />
            <span class="desktop-conversation-search-project-name">{project}</span>
          {/if}
        </div>
        <div class="desktop-conversation-search-trailing">
          {#if rowState.waitingForUser}
            <span
              class="desktop-conversation-search-waiting"
              role="img"
              aria-label="Waiting for your input"
            ></span>
          {:else if rowState.working}
            <span class="desktop-conversation-search-status text-psx-info-foreground">
              <DotsLoader size={14} color="currentColor" ariaLabel="Conversation responding" />
            </span>
          {:else if rowState.unread}
            <span
              class="desktop-conversation-search-unread"
              role="img"
              aria-label="Unread conversation"
            ></span>
          {:else if updatedAt}
            <span class="desktop-conversation-search-updated-at">{updatedAt}</span>
          {/if}
        </div>
      {/snippet}
    </DesktopConversationRow>
  </Command.Item>
{/snippet}

<style lang="postcss">
  @reference "#tailwind.css";

  .desktop-conversation-search-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    border: 0;
    background: rgb(255 255 255 / 50%);
    padding: 0;
  }

  :global(.vscode-dark) .desktop-conversation-search-overlay,
  :global(.psx-dark) .desktop-conversation-search-overlay {
    background: rgb(0 0 0 / 50%);
  }

  .desktop-conversation-search-dialog {
    /* Center the fixed maximum footprint unless the 130px cap puts it higher.
       This stays independent of the live result count, keeping the input fixed
       while the list shrinks. */
    --desktop-conversation-search-top: max(1rem, min(130px, calc(50vh - 16rem)));
    --desktop-conversation-search-shadow-high: color-mix(
      in srgb,
      var(--psx-foreground-primary) 46%,
      transparent
    );
    --desktop-conversation-search-shadow-low: color-mix(
      in srgb,
      var(--psx-foreground-primary) 32%,
      transparent
    );

    position: fixed;
    top: var(--desktop-conversation-search-top);
    left: 50%;
    z-index: 101;
    display: flex;
    width: min(46rem, calc(100vw - 2rem));
    max-height: min(32rem, calc(100vh - var(--desktop-conversation-search-top) - 1rem));
    min-width: 0;
    min-height: 0;
    box-sizing: border-box;
    transform: translateX(-50%);
    overflow: hidden;
    outline: 1px solid rgb(0 0 0 / 5%);
    border-radius: 12px;
    background: rgb(255 255 255 / 78%);
    /* Elevation only — the single `border` above draws the outline. A
       `0 0 0 1px` ring here would stack a second hairline just outside it,
       reading as a doubled border/shadow. */
    box-shadow:
      0 28px 80px -30px var(--desktop-conversation-search-shadow-high),
      0 14px 34px -22px var(--desktop-conversation-search-shadow-low);
    -webkit-backdrop-filter: blur(4px);
    backdrop-filter: blur(4px);
  }

  :global(.vscode-dark) .desktop-conversation-search-dialog,
  :global(.psx-dark) .desktop-conversation-search-dialog {
    --desktop-conversation-search-shadow-high: rgb(0 0 0 / 56%);
    --desktop-conversation-search-shadow-low: rgb(0 0 0 / 42%);

    outline-color: rgb(255 255 255 / 10%);
    background: rgb(27 31 35 / 75%);
  }

  :global(.desktop-conversation-search-root) {
    display: flex;
    width: 100%;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    border-radius: 8px;
    background: transparent;
  }

  .desktop-conversation-search-header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    flex-shrink: 0;
    align-items: center;
    gap: 0.625rem;
    border-bottom: 1px solid rgb(0 0 0 / 5%);
    background: transparent;
    /* 8px results gutter + 12px row inset = 20px, aligned with suggestion icons */
    padding: 0.75rem 20px;
  }

  :global(.vscode-dark) .desktop-conversation-search-header,
  :global(.psx-dark) .desktop-conversation-search-header {
    border-bottom-color: rgb(255 255 255 / 8%);
  }

  :global(.desktop-conversation-search-icon) {
    flex-shrink: 0;
    color: var(--psx-foreground-secondary);
  }

  :global(.desktop-conversation-search-input) {
    display: block;
    flex: 1 1 0;
    width: 100%;
    min-width: 0;
    max-width: none;
    box-sizing: border-box;
    border: 0;
    background: transparent;
    color: var(--psx-foreground-primary);
    font-size: 0.9375rem;
    line-height: 1.25rem;
    outline: 0;
  }

  :global(.desktop-conversation-search-input::placeholder) {
    color: var(--psx-foreground-tertiary);
  }

  .desktop-conversation-search-results {
    min-height: 0;
    flex: 1;
    max-block-size: min(26rem, calc(100vh - 12rem));
    box-sizing: border-box;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.5rem;
    scrollbar-gutter: stable;
    scrollbar-width: auto;
    scroll-padding-block: 0.5rem;
  }

  :global(.desktop-conversation-search-list) {
    display: block;
  }

  .desktop-conversation-search-empty {
    color: var(--psx-foreground-secondary);
    padding: 2rem 0.75rem;
    text-align: center;
    font-size: 0.8125rem;
    line-height: 1rem;
  }

  .desktop-conversation-search-group + .desktop-conversation-search-group {
    margin-top: 0.375rem;
  }

  .desktop-conversation-search-group-heading {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
    color: var(--psx-foreground-secondary);
    font-size: 0.75rem;
    line-height: 1rem;
  }

  .desktop-conversation-search-group-heading {
    padding: 0.375rem 12px 0.25rem;
  }

  .desktop-conversation-search-group-heading span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.desktop-conversation-search-item),
  :global(.desktop-conversation-search-item *) {
    cursor: default;
  }

  :global(.desktop-conversation-search-item) {
    display: block;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    color: var(--psx-foreground-primary);
    outline: 0;
  }

  :global(.desktop-conversation-search-item) {
    border-radius: 8px;
  }

  .desktop-conversation-search-item-inner {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 12px;
  }

  .desktop-conversation-search-item-inner-inline {
    padding-block: 0.5rem;
  }

  :global(.desktop-conversation-search-item[data-selected="true"]) {
    background: var(--psx-highlight-background);
    box-shadow: inset 0 0 0 1px var(--psx-highlight-border);
  }

  :global(.desktop-conversation-search-item-active) {
    color: var(--psx-menu-active-foreground);
  }

  :global(.desktop-conversation-search-item-disabled),
  :global(.desktop-conversation-search-item-disabled *) {
    cursor: not-allowed;
  }

  :global(.desktop-conversation-search-item-disabled[data-selected="true"]) {
    background: transparent;
    box-shadow: none;
  }

  .desktop-conversation-search-inline-icon {
    display: inline-flex;
    width: 1rem;
    height: 1rem;
    flex: 0 0 1rem;
    align-items: center;
    justify-content: center;
    color: var(--psx-foreground-secondary);
  }

  .desktop-conversation-search-inline-copy {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: baseline;
    gap: 0.5rem;
    white-space: nowrap;
  }

  .desktop-conversation-search-inline-title,
  .desktop-conversation-search-inline-detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .desktop-conversation-search-external-opener-hint {
    display: inline-flex;
    overflow: visible;
    flex: 0 0 auto;
    align-items: center;
    justify-content: flex-end;
    gap: 0.375rem;
  }

  .desktop-conversation-search-inline-title {
    flex: 0 1 auto;
    color: var(--psx-foreground-primary);
    font-size: 0.875rem;
    line-height: 1.125rem;
  }

  .desktop-conversation-search-inline-detail {
    flex: 1 1 auto;
    color: var(--psx-foreground-secondary);
    font-size: 0.8125rem;
    line-height: 1rem;
  }

  .desktop-conversation-search-inline-separator {
    margin-inline: 0.375rem;
  }

  :global(.desktop-conversation-search-item [data-state="matched"]) {
    color: var(--psx-menu-highlight, #0969da);
  }

  :global(.desktop-conversation-search-item[data-selected="true"]) :global([data-state="matched"]) {
    color: var(--psx-menu-active-highlight, #0969da);
  }

  .desktop-conversation-search-inline-icon-disabled,
  .desktop-conversation-search-inline-title-disabled,
  .desktop-conversation-search-inline-detail-disabled {
    color: var(--psx-foreground-tertiary);
  }

  .desktop-conversation-search-project {
    display: flex;
    min-width: 0;
    flex: 1 1 0;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    color: var(--psx-foreground-secondary);
    font-size: 0.75rem;
    line-height: 1rem;
    white-space: nowrap;
  }

  .desktop-conversation-search-project-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .desktop-conversation-search-trailing {
    display: flex;
    width: 2.5rem;
    height: 1rem;
    flex: 0 0 2.5rem;
    align-items: center;
    justify-content: flex-end;
  }

  .desktop-conversation-search-updated-at {
    color: var(--psx-foreground-secondary);
    font-size: 0.75rem;
    line-height: 1rem;
    white-space: nowrap;
  }

  .desktop-conversation-search-status {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }

  .desktop-conversation-search-unread {
    display: block;
    width: 0.4375rem;
    height: 0.4375rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background: #3794ff;
  }

  .desktop-conversation-search-waiting {
    display: block;
    width: 0.4375rem;
    height: 0.4375rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--psx-warning-foreground);
  }

  @media (max-width: 640px) {
    .desktop-conversation-search-dialog {
      width: calc(100vw - 1rem);
    }
  }
</style>
