<script lang="ts">
  import { createDropdownMenu, melt } from "@melt-ui/svelte";
  import Icon from "@camber/components/icon";
  import { Badge } from "@camber/components/badge";
  import { createACPChatWorkingDirectory } from "../../chatWorkspaces";
  import { appState } from "../../hostAdapter";
  import { getACPProjectRepo } from "../../features/ProjectRepository.svelte";
  import { getACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import { flattenProjectsWithWorktrees } from "../../navTypes";
  import MobileSelectSheet, { type MobileSelectOption } from "../ui/MobileSelectSheet.svelte";
  import { presentNativeMenu, type MenuSpecItem } from "../ui/menuSpec";
  import { supportsNativeMenus } from "./desktopContextMenu";
  import { fileIconDataUri } from "./fileIconDataUri";
  import "./desktopEmptyStateControl.css";

  interface Props {
    onAddProject?: () => void;
    underlineLabel?: boolean;
    /** Larger label sizing for the desktop centered new-conversation empty state. */
    emptyStateDesktop?: boolean;
  }

  let { onAddProject, underlineLabel = false, emptyStateDesktop = false }: Props = $props();

  // Lets a not-yet-started (draft) conversation pick which project / worktree it
  // will run in, mirroring the agent selector. Switching re-creates the pending
  // session in the chosen workspace, preserving the draft conversation id.
  const projectsRepo = getACPProjectRepo();
  const chatSession = getACPChatSessionScope();

  const isDesktop = $derived($appState.environment.assistantHost === "desktop");
  // On the phone the same picker opens as a bottom sheet, and "Add Project…"
  // is not offered: there is no folder picker to open a new project with.
  const isMobile = $derived($appState.environment.assistantHost === "mobile");
  const allProjects = $derived(projectsRepo.projects);

  // Render order: each root project followed by its worktrees (indented).
  const options = $derived(flattenProjectsWithWorktrees(allProjects));

  const currentCwd = $derived(chatSession.pendingSessionCwd);
  const currentProject = $derived(
    allProjects.find((project) => project.path === currentCwd) ?? null,
  );
  const currentLabel = $derived(
    chatSession.isChat
      ? "Chat"
      : currentProject
        ? (currentProject.nickname ?? currentProject.name)
        : "Select project",
  );

  // Only offered for a pending draft, and only when there is at least one
  // project to anchor the conversation to.
  const shouldRender = $derived(
    (isDesktop || isMobile) &&
      allProjects.length > 0 &&
      chatSession.canChangeAgent &&
      chatSession.pendingConversationId !== null,
  );

  let sheetOpen = $state(false);
  const sheetOptions = $derived<MobileSelectOption[]>([
    {
      id: "__chat__",
      label: "Chat",
      icon: "chats",
      selected: chatSession.isChat,
    },
    ...options.map(({ project, depth }) => ({
      id: project.path,
      label: project.nickname ?? project.name,
      icon: project.isWorktree ? ("git-branch" as const) : ("folder" as const),
      indent: depth > 0,
      selected: project.path === currentCwd,
    })),
  ]);

  const {
    elements: { trigger, menu, item },
    states: { open },
  } = createDropdownMenu({
    positioning: { placement: "bottom-start" },
    forceVisible: true,
  });

  function selectProject(path: string): void {
    if (path === "__chat__") {
      void selectChat();
      return;
    }
    if (path !== currentCwd) {
      chatSession.createSession(
        path,
        chatSession.selectedAgentServer,
        chatSession.pendingConversationId,
        { isChat: false },
      );
    }
    $open = false;
  }

  async function selectChat(): Promise<void> {
    const conversationId = chatSession.pendingConversationId;
    if (!conversationId || chatSession.isChat) {
      $open = false;
      return;
    }
    const cwd = await createACPChatWorkingDirectory(conversationId);
    chatSession.createSession(cwd, chatSession.selectedAgentServer, conversationId, {
      isChat: true,
    });
    $open = false;
  }

  const triggerButtonClass = $derived(
    emptyStateDesktop
      ? "desktop-empty-state-control focus:outline-psx-focus focus-visible:outline-2 active:outline-0"
      : "text-psx-foreground-primary hover:bg-psx-chrome-hover focus:outline-psx-focus flex h-7 min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-sm transition-colors focus-visible:outline-2 active:outline-0",
  );

  // Native menu path, built from the same rows/affordances the DOM dropdown
  // below renders: the "Chat" row, one row per project/worktree, and (when
  // offered) the "Add Project…" affordance after a separator.
  const nativeMenus = $derived(supportsNativeMenus($appState.environment));
  const projectMenuItems = $derived<MenuSpecItem[]>([
    {
      kind: "action",
      id: "__chat__",
      label: "Chat",
      icon: "chats",
      checked: chatSession.isChat,
    },
    { kind: "separator", label: "Projects" },
    // Each root project followed by its worktrees (`options` is already
    // flattened that way): the root shows the OS's own icon for the folder at
    // its path (the real macOS folder icon, resolved natively), worktrees
    // show our git-branch glyph indented one level under their parent.
    ...options.map(
      ({ project, depth }): MenuSpecItem => ({
        kind: "action",
        id: project.path,
        label: project.nickname ?? project.name,
        icon: project.isWorktree ? "git-branch" : { file: project.path },
        indent: depth > 0 ? depth : undefined,
        checked: project.path === currentCwd,
      }),
    ),
    ...(onAddProject
      ? ([
          { kind: "separator" },
          {
            kind: "action",
            id: "__add_project__",
            label: "Add Project…",
            icon: "folder-plus",
          },
        ] satisfies MenuSpecItem[])
      : []),
  ]);

  function handleMenuSelect(id: string): void {
    if (id === "__add_project__") {
      onAddProject?.();
      return;
    }
    selectProject(id);
  }

  let triggerButtonEl: HTMLButtonElement | undefined = $state();
  let nativeMenuOpen = $state(false);

  // Native host only: the closed trigger swaps its folder glyph for the real
  // macOS folder icon of the selected project, delivered as PNG bytes because
  // the trigger is webview DOM (the native menu's NSWorkspace icons cannot
  // render here). Worktrees keep the git-branch glyph and Chat the chats
  // glyph; the glyph also stays while the icon loads or when the host yields
  // nothing.
  const triggerIconPath = $derived(
    nativeMenus && !chatSession.isChat && currentProject !== null && !currentProject.isWorktree
      ? currentProject.path
      : undefined,
  );
  let triggerIconDataUri = $state<string | undefined>();
  $effect(() => {
    const path = triggerIconPath;
    triggerIconDataUri = undefined;
    if (path === undefined) return;
    let stale = false;
    void fileIconDataUri(path).then((uri) => {
      if (!stale) triggerIconDataUri = uri;
    });
    return () => {
      stale = true;
    };
  });

  async function openNativeProjectMenu(): Promise<void> {
    if (!triggerButtonEl || nativeMenuOpen) return;
    const rect = triggerButtonEl.getBoundingClientRect();
    nativeMenuOpen = true;
    try {
      const id = await presentNativeMenu(
        projectMenuItems,
        { x: rect.left, y: rect.bottom + 4 },
        { highlightStyle: "themed" },
      );
      if (id !== undefined) handleMenuSelect(id);
    } finally {
      nativeMenuOpen = false;
    }
  }
</script>

{#snippet triggerContent()}
  {#if triggerIconDataUri !== undefined}
    <img src={triggerIconDataUri} alt="" class="size-4 shrink-0" aria-hidden="true" />
  {:else}
    <Icon
      name={chatSession.isChat ? "chats" : currentProject?.isWorktree ? "git-branch" : "folder"}
      size={15}
      class="shrink-0 translate-y-px"
      aria-hidden="true"
    />
  {/if}
  <span
    class={[
      "min-w-0 truncate text-left",
      underlineLabel && !emptyStateDesktop && "underline decoration-dotted underline-offset-2",
    ]}
  >
    {currentLabel}
  </span>
  <Icon name="chevron" size={12} class="shrink-0 opacity-60" aria-hidden="true" />
{/snippet}

{#if shouldRender}
  <div class={["min-w-0 max-w-[260px]", emptyStateDesktop && "desktop-empty-state-control-wrap"]}>
    {#if isMobile}
      <button
        type="button"
        aria-label={`Change chat, project, or worktree — current: ${currentLabel}`}
        class="text-psx-foreground-primary hover:bg-psx-chrome-hover focus:outline-psx-focus flex h-7 min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-sm transition-colors focus-visible:outline-2 active:outline-0"
        onpointerdown={(event) => event.preventDefault()}
        onclick={() => (sheetOpen = true)}
      >
        {@render triggerContent()}
      </button>
      {#if sheetOpen}
        <MobileSelectSheet
          title="Chat, project, or worktree"
          options={sheetOptions}
          onSelect={selectProject}
          onClose={() => (sheetOpen = false)}
        />
      {/if}
    {:else if nativeMenus}
      <button
        type="button"
        bind:this={triggerButtonEl}
        aria-label={`Change chat, project, or worktree — current: ${currentLabel}`}
        aria-haspopup="menu"
        aria-expanded={nativeMenuOpen}
        class={[
          triggerButtonClass,
          nativeMenuOpen && !emptyStateDesktop
            ? "bg-psx-chrome-hover text-psx-foreground-primary"
            : "",
        ]}
        onclick={openNativeProjectMenu}
      >
        {@render triggerContent()}
      </button>
    {:else}
      <button
        type="button"
        use:melt={$trigger}
        aria-label={`Change chat, project, or worktree — current: ${currentLabel}`}
        class={[
          triggerButtonClass,
          $open && !emptyStateDesktop ? "bg-psx-chrome-hover text-psx-foreground-primary" : "",
        ]}
      >
        {@render triggerContent()}
      </button>

      {#if $open}
        <div
          use:melt={$menu}
          class="menu-surface z-50 max-h-[300px] w-[300px] max-w-[calc(100vw-2rem)] overflow-y-auto p-1"
        >
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            use:melt={$item}
            class="text-psx-foreground-primary outline-hidden hover:bg-psx-menu-hover-background data-[highlighted]:bg-psx-menu-hover-background group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
            onclick={() => void selectChat()}
          >
            <Icon name="chats" size={16} class="shrink-0" aria-hidden="true" />
            <span class="min-w-0 truncate">Chat</span>
            {#if chatSession.isChat}
              <Badge size="xs" class="ml-auto uppercase">Selected</Badge>
            {/if}
          </div>

          <div role="separator" class="menu-separator"></div>
          <div class="text-psx-foreground-tertiary px-2 pb-1 pt-0.5 text-xs font-medium">
            Projects
          </div>

          {#each options as { project, depth } (project.path)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              use:melt={$item}
              class="text-psx-foreground-primary outline-hidden hover:bg-psx-menu-hover-background data-[highlighted]:bg-psx-menu-hover-background group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left"
              style:padding-left={depth > 0 ? "1.75rem" : "0.5rem"}
              onclick={() => selectProject(project.path)}
            >
              <Icon
                name={project.isWorktree ? "git-branch" : "folder"}
                size={16}
                class="shrink-0"
                aria-hidden="true"
              />
              <span class="min-w-0 truncate">{project.nickname ?? project.name}</span>
              {#if project.path === currentCwd}
                <Badge size="xs" class="ml-auto uppercase">Selected</Badge>
              {/if}
            </div>
          {/each}

          {#if onAddProject}
            <div class="menu-separator"></div>
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              use:melt={$item}
              class="text-psx-foreground-primary outline-hidden hover:bg-psx-menu-hover-background data-[highlighted]:bg-psx-menu-hover-background flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
              onclick={() => {
                $open = false;
                onAddProject?.();
              }}
            >
              <Icon name="folder-plus" size={16} class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 truncate">Add Project…</span>
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{/if}
