<script lang="ts">
  import ACPContextDecorator from "../../../.storybook/ACPContextDecorator.svelte";
  import type { ACPNavConversation, ACPNavProject } from "../navTypes";
  import type { getACPConversationRepo } from "../features/ConversationRepository.svelte";
  import DesktopSideBar from "./DesktopSideBar.svelte";
  import SidebarStoryHarness from "./SidebarStoryHarness.svelte";

  interface Props {
    projects: ACPNavProject[];
    conversations: ACPNavConversation[];
    activeConversationId?: string | null;
    expandedSubAgents?: string[];
    archiveSession?: (...args: unknown[]) => Promise<unknown>;
    onConversationRepo?: (repo: ReturnType<typeof getACPConversationRepo>) => void;
  }

  let {
    projects,
    conversations,
    activeConversationId = null,
    expandedSubAgents = [],
    archiveSession,
    onConversationRepo,
  }: Props = $props();

  function noop() {}
</script>

<ACPContextDecorator>
  <SidebarStoryHarness
    {projects}
    {conversations}
    {expandedSubAgents}
    {archiveSession}
    {onConversationRepo}
  >
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
