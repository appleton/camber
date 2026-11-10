<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import type { LocalInferenceState } from "@camber/helperapi/schemas";
  import type { WorkspaceFolder } from "@camber/rpc";
  import DesktopSideBar from "./DesktopSideBar.svelte";
  import SidebarStoryHarness from "./SidebarStoryHarness.svelte";
  import type { ACPNavConversation, ACPNavProject } from "../navTypes";

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const projects: ACPNavProject[] = [
    {
      path: "/Users/poolie/code/assistant",
      name: "assistant",
      isWorktree: false,
      collapsed: false,
      displayOrder: 0,
      createdAt: minutesAgo(60 * 24 * 3),
      updatedAt: minutesAgo(15),
    },
    {
      path: "/Users/poolie/code/assistant/.worktrees/acp-sidebar",
      name: "acp-sidebar",
      isWorktree: true,
      parentPath: "/Users/poolie/code/assistant",
      collapsed: false,
      displayOrder: 0,
      createdAt: minutesAgo(60 * 24),
      updatedAt: minutesAgo(15),
    },
    {
      path: "/Users/poolie/code/assistant/.worktrees/refactor-router",
      name: "refactor-router",
      isWorktree: true,
      parentPath: "/Users/poolie/code/assistant",
      collapsed: false,
      displayOrder: 0,
      createdAt: minutesAgo(60 * 12),
      updatedAt: minutesAgo(120),
    },
    {
      path: "/Users/poolie/code/assistant/.worktrees/crisp-current",
      name: "crisp-current",
      isWorktree: true,
      parentPath: "/Users/poolie/code/assistant",
      collapsed: false,
      displayOrder: 0,
      createdAt: minutesAgo(4),
      updatedAt: minutesAgo(4),
      busy: "creating",
    },
    {
      path: "/Users/poolie/code/assistant/.worktrees/steady-setup",
      name: "steady-setup",
      isWorktree: true,
      parentPath: "/Users/poolie/code/assistant",
      collapsed: false,
      displayOrder: 0,
      createdAt: minutesAgo(5),
      updatedAt: minutesAgo(5),
      busy: "running_setup",
    },
    {
      path: "/Users/poolie/code/assistant/.worktrees/tidy-teardown",
      name: "tidy-teardown",
      isWorktree: true,
      parentPath: "/Users/poolie/code/assistant",
      collapsed: false,
      displayOrder: 0,
      createdAt: minutesAgo(6),
      updatedAt: minutesAgo(6),
      busy: "tearing_down",
    },
    {
      path: "/Users/poolie/code/assistant/.worktrees/deft-delete",
      name: "deft-delete",
      isWorktree: true,
      parentPath: "/Users/poolie/code/assistant",
      collapsed: false,
      displayOrder: 0,
      createdAt: minutesAgo(7),
      updatedAt: minutesAgo(7),
      busy: "deleting",
    },
    {
      path: "/Users/poolie/code/camber-books-api-demo",
      name: "camber-books-api-demo",
      isWorktree: false,
      collapsed: false,
      displayOrder: 1,
      createdAt: minutesAgo(60 * 24 * 10),
      updatedAt: minutesAgo(60 * 6),
    },
  ];

  const conversations: ACPNavConversation[] = [
    {
      id: "conv-1",
      workspacePath: "/Users/poolie/code/assistant",
      agentServer: "poolside",
      sessionId: "session-acp-1",
      cwd: "/Users/poolie/code/assistant",
      title: "Wire up workspace-scoped ACP sidebar",
      updatedAt: minutesAgo(15),
      active: true,
      archived: false,
      workingDirectories: ["/Users/poolie/code/assistant"],
    },
    {
      id: "conv-2",
      workspacePath: "/Users/poolie/code/assistant",
      agentServer: "claude-code",
      sessionId: "session-claude-2",
      cwd: "/Users/poolie/code/assistant",
      title: "Investigate flaky helper test",
      updatedAt: minutesAgo(60),
      active: true,
      archived: false,
      workingDirectories: ["/Users/poolie/code/assistant"],
    },
    {
      id: "conv-3",
      workspacePath: "/Users/poolie/code/assistant/.worktrees/acp-sidebar",
      agentServer: "poolside",
      sessionId: "session-acp-3",
      cwd: "/Users/poolie/code/assistant/.worktrees/acp-sidebar",
      title: "Add storybook coverage for sidebars",
      updatedAt: minutesAgo(20),
      active: true,
      archived: false,
      workingDirectories: ["/Users/poolie/code/assistant/.worktrees/acp-sidebar"],
    },
    {
      id: "conv-4",
      workspacePath: "/Users/poolie/code/assistant/.worktrees/refactor-router",
      agentServer: "poolside",
      sessionId: "session-acp-4",
      cwd: "/Users/poolie/code/assistant/.worktrees/refactor-router",
      title: "Refactor router for ACP host scopes",
      updatedAt: minutesAgo(120),
      active: true,
      archived: false,
      workingDirectories: ["/Users/poolie/code/assistant/.worktrees/refactor-router"],
    },
    {
      id: "conv-5",
      workspacePath: "/Users/poolie/code/camber-books-api-demo",
      agentServer: "poolside",
      sessionId: "session-acp-5",
      cwd: "/Users/poolie/code/camber-books-api-demo",
      title: "Add Book description field",
      updatedAt: minutesAgo(60 * 6),
      active: true,
      archived: false,
      workingDirectories: ["/Users/poolie/code/camber-books-api-demo"],
    },
  ];

  const currentWorkspaceFolders: WorkspaceFolder[] = [
    { path: "/Users/poolie/code/assistant", name: "assistant", index: 0 },
  ];

  const desktopCapabilities = {
    openWorkspace: true,
    addFolderToWorkspace: true,
  };

  // A resident local model, as the sidecar reports it: powers the ambient
  // runtime pill at the sidebar bottom (memory figure, last prompt, idle
  // unload countdown, and the reclaim-memory action).
  const GIB = 1024 ** 3;
  const localModelLoaded: LocalInferenceState = {
    modelsDirectory: "/Users/poolie/.config/camber/models",
    catalog: [
      {
        id: "poolside/Laguna-XS-2.1-NVFP4-mlx",
        repoId: "poolside/Laguna-XS-2.1-NVFP4-mlx",
        name: "Laguna XS 2.1 NVFP4",
        provider: "poolside",
        downloaded: true,
        default: true,
      },
    ],
    runtime: {
      supported: true,
      status: "running",
      agentServer: "local",
      defaultModelId: "poolside/Laguna-XS-2.1-NVFP4-mlx",
      loadedModelId: "poolside/Laguna-XS-2.1-NVFP4-mlx",
      loadedMemoryBytes: 20.1 * GIB,
      lastActivityUnixMs: Date.now() - 4 * 60 * 1000,
      idleUnloadSeconds: 15 * 60,
    },
  };

  const handlers = {
    onCollapsedChange: () => {},
    onNewConversation: () => {},
    onShowSettings: () => {},
    onShowProjectSettings: () => {},
    onShowChat: () => {},
    onResizeStart: () => {},
    onWidthChange: () => {},
    onShowShortcuts: () => {},
    onShowConnectors: () => {},
    onShowAgents: () => {},
  };

  const { Story } = defineMeta({
    component: DesktopSideBar,
    parameters: {
      layout: "fullscreen",
    },
  });
</script>

<Story name="Default">
  {#snippet template()}
    <div class="bg-psx-editor-background flex h-screen">
      <SidebarStoryHarness {projects} {conversations} capabilities={desktopCapabilities}>
        <DesktopSideBar
          collapsed={false}
          currentView="chat"
          {currentWorkspaceFolders}
          {...handlers}
        />
      </SidebarStoryHarness>
    </div>
  {/snippet}
</Story>

<Story name="Local Model Loaded">
  {#snippet template()}
    <div class="bg-psx-editor-background flex h-screen">
      <SidebarStoryHarness
        {projects}
        {conversations}
        capabilities={desktopCapabilities}
        localInference={localModelLoaded}
      >
        <DesktopSideBar
          collapsed={false}
          currentView="chat"
          {currentWorkspaceFolders}
          {...handlers}
        />
      </SidebarStoryHarness>
    </div>
  {/snippet}
</Story>

<Story name="Empty">
  {#snippet template()}
    <div class="bg-psx-editor-background flex h-screen">
      <SidebarStoryHarness projects={[]} conversations={[]} capabilities={desktopCapabilities}>
        <DesktopSideBar
          collapsed={false}
          currentView="chat"
          {currentWorkspaceFolders}
          {...handlers}
        />
      </SidebarStoryHarness>
    </div>
  {/snippet}
</Story>

<Story name="Collapsed">
  {#snippet template()}
    <div class="bg-psx-editor-background flex h-screen">
      <SidebarStoryHarness {projects} {conversations} capabilities={desktopCapabilities}>
        <DesktopSideBar
          collapsed={true}
          showCollapsedActions
          currentView="chat"
          {currentWorkspaceFolders}
          {...handlers}
        />
      </SidebarStoryHarness>
    </div>
  {/snippet}
</Story>

<Story name="Settings">
  {#snippet template()}
    <div class="bg-psx-editor-background flex h-screen">
      <SidebarStoryHarness {projects} {conversations} capabilities={desktopCapabilities}>
        <DesktopSideBar
          collapsed={false}
          currentView="settings"
          {currentWorkspaceFolders}
          {...handlers}
        />
      </SidebarStoryHarness>
    </div>
  {/snippet}
</Story>

<Story name="Collapsed Settings Route">
  {#snippet template()}
    <div class="bg-psx-editor-background flex h-screen">
      <SidebarStoryHarness {projects} {conversations} capabilities={desktopCapabilities}>
        <DesktopSideBar
          collapsed={false}
          currentView="connectors"
          {currentWorkspaceFolders}
          {...handlers}
        />
      </SidebarStoryHarness>
    </div>
  {/snippet}
</Story>
