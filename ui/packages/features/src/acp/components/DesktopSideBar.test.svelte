<script lang="ts">
  import ACPContextDecorator from "../../../.storybook/ACPContextDecorator.svelte";
  import type { ACPNavConversation, ACPNavProject } from "../navTypes";
  import DesktopSideBar from "./DesktopSideBar.svelte";
  import SidebarStoryHarness from "./SidebarStoryHarness.svelte";

  interface Props {
    projects: ACPNavProject[];
    conversations: ACPNavConversation[];
    activeConversationId?: string | null;
    expandedSubAgents?: string[];
    archiveSession?: (...args: unknown[]) => Promise<unknown>;
  }

  let {
    projects,
    conversations,
    activeConversationId = null,
    expandedSubAgents = [],
    archiveSession,
  }: Props = $props();

  function noop() {}
</script>

<ACPContextDecorator>
  <SidebarStoryHarness {projects} {conversations} {expandedSubAgents} {archiveSession}>
    <DesktopSideBar
      collapsed={false}
      currentView="chat"
      currentWorkspaceFolders={[]}
      {activeConversationId}
      onCollapsedChange={noop}
      onNewConversation={noop}
      onShowSettings={noop}
      onShowProjectSettings={noop}
      onShowChat={noop}
      onResizeStart={noop}
      onWidthChange={noop}
    />
  </SidebarStoryHarness>
</ACPContextDecorator>
