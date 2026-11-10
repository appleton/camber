<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { appState } from "../../../hostAdapter";
  import { rpc } from "../../../hostRpc";
  import type { SearchFileMenuControl, SearchFilesOutput } from "@camber/helperapi/schemas";
  import { InfoMessageType, type SearchFile } from "@camber/rpc";
  import * as Prompt from "@camber/components/prompt";
  import { getItems, getMenus, getPrompt } from "@camber/components/prompt";
  import { closeMatch, getMatchDecorationState, type Command } from "@camber/components/editor";
  import { basename, joinPath, type ClassifiedQuery } from "@camber/lib/path-query";
  import {
    navigationTarget,
    parentQuery,
    replacementQuery,
    type FileLike,
  } from "./pathRewrites.js";
  import { attachFilePathToContext } from "./fileContextAttachment";
  import { classifyFileSearchQuery, searchProjectFiles } from "./fileSearch.js";
  import { decideFilePickerAction, type KeyboardSnapshot } from "./filesMenuKeyboard.js";
  import {
    getACPChatSessionScope,
    type ACPChatSessionScope,
  } from "../../../features/ChatSessionScope.svelte";
  import {
    getACPProjectRepo,
    type ACPProjectRepository,
  } from "../../../features/ProjectRepository.svelte";
  import { getContextRepoContext } from "../../../../context";

  // Reserved sentinel values for menu rows that don't map to a real file.
  const PARENT_VALUE = "__file-picker-parent";
  const NO_MATCH_VALUE = "__file-picker-no-match";

  let search = $state("");
  let files = $state<SearchFile[]>([]);
  let controls = $state<SearchFileMenuControl[]>([]);
  let showWorkspace = $state(false);
  let searchComplete = $state(false);
  let hasDisplayedSearchResult = $state(false);
  let helperUnsupported = $state(false);

  const { editor } = getPrompt();
  const { selected: selectedItemId, selectedAction, items: itemsStore, select } = getItems();
  const { close } = getMenus();
  const acpChatSession = optionalACPChatSessionContext();
  const acpProjects = optionalACPProjectContext();
  const contextRepo = getContextRepoContext();
  type ItemId = Exclude<Parameters<typeof select>[0], HTMLElement>;

  // Track which file or folder control the highlighted menu item maps to,
  // so the Tab/Enter handlers know what to do.
  let selectedFile = $state<SearchFile | null>(null);
  let selectedControl = $state<"parent" | "no-match" | null>(null);
  $effect(() => {
    const id = $selectedItemId;
    const allItems = $itemsStore;
    if (!id) {
      selectedFile = null;
      selectedControl = null;
      return;
    }
    const item = allItems.get(id);
    const value = item?.value;
    if (value === PARENT_VALUE) {
      selectedControl = "parent";
    } else if (value === NO_MATCH_VALUE) {
      selectedControl = "no-match";
    } else {
      selectedControl = null;
    }
    selectedFile = files.find((f) => f.path === value) ?? null;
  });

  function classifyQuery(query: string): ClassifiedQuery {
    return classifyFileSearchQuery(query, $appState.environment.operatingSystem);
  }

  function isCurrentControlWithPath(
    control: SearchFileMenuControl,
  ): control is SearchFileMenuControl & { kind: "current"; path: string; displayPath: string } {
    return control.kind === "current" && !!control.path && !!control.displayPath;
  }

  function rewriteMatchAndClose(suffix = "") {
    const ed = $editor;
    if (!ed) return;
    ed.executeCommand(((state, dispatch) => {
      const decoration = getMatchDecorationState(state);
      if (decoration?.status !== "match") return false;
      const { bare } = classifyQuery(decoration.query);
      dispatch?.(
        closeMatch(
          state.tr.insertText(
            `${decoration.trigger}${bare}${suffix}`,
            decoration.range.from,
            decoration.range.to,
          ),
        ),
      );
      close();
      return true;
    }) satisfies Command);
  }

  function replaceMatchQuery(queryText: string) {
    const ed = $editor;
    if (!ed) return;
    ed.executeCommand(((state, dispatch) => {
      const decoration = getMatchDecorationState(state);
      if (decoration?.status !== "match") return false;
      const query = classifyQuery(decoration.query);
      dispatch?.(
        state.tr.insertText(
          `${decoration.trigger}${replacementQuery(queryText, query)}`,
          decoration.range.from,
          decoration.range.to,
        ),
      );
      return true;
    }) satisfies Command);
  }

  function navigateToParent() {
    const { bare } = classifyQuery(search);
    replaceMatchQuery(parentQuery(bare));
  }

  function navigateInto(file: FileLike) {
    const ed = $editor;
    if (!ed) return;
    ed.executeCommand(((state, dispatch) => {
      const decoration = getMatchDecorationState(state);
      if (decoration?.status !== "match") return false;

      const query = classifyQuery(decoration.query);
      const queryText = navigationTarget(query, file);
      const newText = `${decoration.trigger}${queryText}`;
      dispatch?.(state.tr.insertText(newText, decoration.range.from, decoration.range.to));
      return true;
    }) satisfies Command);
  }

  // TODO: migrate this listener to a ProseMirror keymap plugin
  // attached to the editor, so the file picker no longer reaches into
  // `document` to intercept keys. The decision logic itself is already
  // pure (`decideFilePickerAction`), so the plugin would just dispatch
  // its result.
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      const snapshot: KeyboardSnapshot = {
        query: classifyQuery(search),
        files,
        selectedFile,
        selectedControl,
        hasParentControl: controls.some((control) => control.kind === "parent"),
        hasSelectedAction: !!$selectedAction,
        searchComplete,
      };
      const action = decideFilePickerAction(e, snapshot);
      if (action.kind === "passthrough") return;

      e.preventDefault();
      e.stopImmediatePropagation();

      switch (action.kind) {
        case "noop":
          return;
        case "close-quote":
          rewriteMatchAndClose();
          return;
        case "close-quote-and-action":
          $selectedAction?.onAction?.(e);
          return;
        case "rewrite-and-close":
          rewriteMatchAndClose(action.suffix);
          return;
        case "navigate-to-parent":
          navigateToParent();
          return;
        case "navigate-into":
          navigateInto(action.file);
          return;
      }
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  });

  async function handleInsert(value: string) {
    await attachFilePathToContext(value, {
      contextRepo,
      helperSupported: Boolean($appState.isHelperSupported),
      rpc,
    });
  }

  function handleRemove(path: string) {
    contextRepo.removeFile(path);
  }

  // Token used to disregard output of previously triggered searches, so in the case
  // we can process parallel requests on the IDE side we don't ever overwrite results
  // we want with older results. This can happen in Visual Studio, for example, where
  // it allows parallel requests from the web view, and takes advantage of this to cancel
  // searches when a new one has been started.
  let fileSearchToken = 1;
  let renderToken = 0;

  const INITIAL_RENDER_COUNT = 8;
  const BATCH_SIZE = 8;

  $effect(() => {
    const isEmptySearch = search === "";
    fileSearchToken++;
    renderToken++;
    searchComplete = false;
    helperUnsupported = false;
    hasDisplayedSearchResult = false;
    if (!isEmptySearch) return;

    files = [];
    controls = [];
    showWorkspace = false;
  });

  // When the picker is in folder-control mode (parent / current rendered
  // above the listing) the user's natural landing spot is the first child
  // file, falling through to the no-match row if there are none. The shared
  // `<List>` runs `selectFirst()` whenever items register and the search
  // query has changed, which would otherwise pin selection on the parent
  // control. We schedule on rAF to land after items register, then verify
  // the selection actually stuck and retry if `<List>`'s mutation-observer
  // rAF reset it on a later frame.
  let selectionToken = 0;
  $effect(() => {
    if (!searchComplete) return;
    if (controls.length === 0) return;
    const targetValue = files[0]?.path ?? NO_MATCH_VALUE;
    const token = ++selectionToken;
    let attempts = 0;
    const tryOnce = () => {
      if (token !== selectionToken) return;
      let targetId: ItemId | undefined;
      for (const [id, item] of get(itemsStore)) {
        if (item.value === targetValue) {
          targetId = id;
          break;
        }
      }
      if (targetId === undefined) {
        if (++attempts < 5) requestAnimationFrame(tryOnce);
        return;
      }
      select(targetId, false);
      // Verify the selection took on the next frame; <List>'s mutation
      // observer may run after us and reset to selectFirst().
      requestAnimationFrame(() => {
        if (token !== selectionToken) return;
        if (get(selectedItemId) === targetId) return;
        if (++attempts < 5) tryOnce();
      });
    };
    requestAnimationFrame(tryOnce);
  });

  async function searchFiles(search: string) {
    if (search === "") {
      files = [];
      controls = [];
      searchComplete = false;
      hasDisplayedSearchResult = false;
      helperUnsupported = false;
      return;
    }
    searchComplete = false;
    hasDisplayedSearchResult = false;
    helperUnsupported = false;

    if (!$appState.isHelperSupported) {
      files = [];
      controls = [];
      showWorkspace = false;
      searchComplete = true;
      hasDisplayedSearchResult = true;
      helperUnsupported = true;
      return;
    }

    const ourToken = ++fileSearchToken;
    let result: Awaited<ReturnType<typeof searchProjectFiles>>;
    try {
      result = await searchProjectFiles({
        query: search,
        appState: $appState,
        activeWorkspaceCwd: acpChatSession?.activeWorkspaceCwd,
        projects: acpProjects?.projects,
      });
    } catch {
      if (ourToken !== fileSearchToken) return;
      files = [];
      controls = [];
      showWorkspace = false;
      searchComplete = true;
      hasDisplayedSearchResult = true;
      helperUnsupported = false;
      rpc.showInfoMessage("Unable to search files", InfoMessageType.error);
      return;
    }
    if (ourToken !== fileSearchToken) return;

    if (result.kind === "helperUnsupported") {
      files = [];
      controls = [];
      showWorkspace = false;
      searchComplete = true;
      hasDisplayedSearchResult = true;
      helperUnsupported = true;
      return;
    }

    applySearchResponse(result.response, ourToken);
  }

  function applySearchResponse(response: SearchFilesOutput, ourToken: number) {
    searchComplete = true;
    hasDisplayedSearchResult = true;

    showWorkspace = response.workspaces !== undefined && response.workspaces.length > 1;
    controls = response.controls ?? [];

    const allFiles = response.files;
    if (allFiles.length <= INITIAL_RENDER_COUNT) {
      files = allFiles;
      return;
    }

    files = allFiles.slice(0, INITIAL_RENDER_COUNT);

    const ourRenderToken = ++renderToken;
    let rendered = INITIAL_RENDER_COUNT;

    const renderMore = () => {
      if (ourRenderToken !== renderToken || ourToken !== fileSearchToken) return;
      if (rendered >= allFiles.length) return;

      const nextBatch = allFiles.slice(0, rendered + BATCH_SIZE);
      rendered = nextBatch.length;
      files = nextBatch;

      if (rendered < allFiles.length) {
        requestAnimationFrame(renderMore);
      }
    };

    requestAnimationFrame(renderMore);
  }

  const handleSearch = searchFiles;

  function optionalACPChatSessionContext(): ACPChatSessionScope | null {
    try {
      return getACPChatSessionScope();
    } catch {
      return null;
    }
  }

  function optionalACPProjectContext(): ACPProjectRepository | null {
    try {
      return getACPProjectRepo();
    } catch {
      return null;
    }
  }
</script>

<Prompt.Menu.Popup.Root bind:search onSearch={handleSearch} debounce>
  {#if !search}
    <Prompt.Menu.Popup.Header
      icon="files"
      title="Add files"
      subtitle="Type to find a file in this workspace"
    />
  {/if}

  <Prompt.Menu.Popup.List class="max-h-72">
    {#if helperUnsupported}
      <Prompt.Menu.Popup.Empty title="File search unavailable" icon="files" />
    {:else if search && hasDisplayedSearchResult && controls.length === 0 && files.length === 0}
      <Prompt.Menu.Popup.Empty title="No files found" icon="files" />
    {/if}

    <Prompt.Menu.Popup.Section>
      {#each controls as control (control.kind === "parent" ? PARENT_VALUE : control.path)}
        {#if control.kind === "parent"}
          <Prompt.Menu.Popup.Item
            icon="folder"
            title={{ value: "..", score: 0, indices: [] }}
            value={PARENT_VALUE}
            data-testid="file-menu-parent"
          />
        {:else if isCurrentControlWithPath(control)}
          {@const folderName = basename(control.displayPath) || basename(control.path)}
          <Prompt.Menu.Popup.Item
            icon="folder"
            title={{ value: "Attach folder", score: 0, indices: [] }}
            tooltip={control.displayPath}
            value={control.path}
          >
            {#snippet subtitle()}
              {control.displayPath}
            {/snippet}

            <Prompt.Actions.Insert
              type="chip"
              content={{
                label: `${folderName}/`,
                icon: "folder",
                value: control.path,
                clipboard: `\`${control.path}\``,
                tooltip: control.displayPath,
              }}
            />
            <Prompt.Actions.OpenFile path={control.path} />
          </Prompt.Menu.Popup.Item>
        {/if}
      {/each}

      {#each files as { path, name, directory, workspace, isDirectory, displayPath, virtualKind } (path)}
        {@const fileName = typeof name === "string" ? name : name.value}
        {@const directoryName = typeof directory === "string" ? directory : directory.value}
        {@const showDirectory = directoryName !== "."}
        {@const relativePath = joinPath(directoryName, fileName)}
        {@const isChildItem = controls.length > 0}
        <Prompt.Menu.Popup.Item
          icon={isDirectory ? "folder" : { type: "file", name: path }}
          title={name}
          tooltip={displayPath ?? relativePath}
          value={path}
          class={isChildItem ? "ml-4" : undefined}
          data-testid={isChildItem ? "file-menu-child" : undefined}
        >
          {#snippet subtitle({ highlight })}
            {#if !isChildItem}
              {#if showWorkspace && workspace}
                {@render highlight(workspace)}
                {#if showDirectory}
                  ⋅
                {/if}
              {/if}
              {#if showDirectory}
                {@render highlight(directory)}
              {/if}
            {/if}
          {/snippet}

          {#if virtualKind !== "workspace-folder"}
            <Prompt.Actions.Insert
              type="chip"
              content={{
                label: isDirectory ? `${fileName}/` : fileName,
                icon: isDirectory ? "folder" : "file",
                fileIconPath: isDirectory ? undefined : path,
                value: path,
                clipboard: `\`${path}\``,
                tooltip: displayPath ?? path,
              }}
              onInsert={async ({ value }) => {
                if (isDirectory) return;
                await handleInsert(value);
              }}
              onRemove={(value) => {
                if (isDirectory) return;
                handleRemove(value);
              }}
            />
            <Prompt.Actions.OpenFile {path} />
          {/if}
        </Prompt.Menu.Popup.Item>
      {/each}

      {#if controls.length > 0 && files.length === 0}
        <Prompt.Menu.Popup.Item
          icon="files"
          title="No files found"
          value={NO_MATCH_VALUE}
          class="ml-4 opacity-50"
          data-testid="file-menu-no-match"
        />
      {/if}
    </Prompt.Menu.Popup.Section>
  </Prompt.Menu.Popup.List>
</Prompt.Menu.Popup.Root>
