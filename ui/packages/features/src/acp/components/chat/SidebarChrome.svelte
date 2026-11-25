<script lang="ts">
  import { appState } from "../../hostAdapter";
  import { rpc } from "../../hostRpc";
  import { acpWorkspaceFolders } from "../../workspaceScope";
  import AcpConnectorsView from "../ConnectorsView.svelte";
  import DesktopSettingsView from "../DesktopSettingsView.svelte";
  import IDESettingsMenu from "../sidebar/IDESettingsMenu.svelte";
  import IDESideBar from "../IDESideBar.svelte";
  import { IDE_SETTINGS_SECTIONS } from "../settings/settingsSections";

  // Connectors is its own destination now, so it is not offered as a settings tab.
  const SETTINGS_SECTIONS = IDE_SETTINGS_SECTIONS.filter((section) => section !== "connectors");

  let view = $state<"conversations" | "agents" | "connectors">("conversations");
  let currentWorkspaceFolders = $derived(acpWorkspaceFolders($appState));

  async function openPendingChat() {
    await rpc.openAcpChat({});
  }
</script>

<div class="bg-psx-panel flex h-screen min-w-0">
  {#if view === "agents"}
    <div class="min-w-0 flex-1 pb-12">
      <!-- The sidebar is too narrow for the settings section nav; each section
           opens full-view from the Settings menu instead. -->
      <DesktopSettingsView
        section="agents"
        availableSections={SETTINGS_SECTIONS}
        sectionNav={false}
        onDone={() => (view = "conversations")}
      />
    </div>
  {:else if view === "connectors"}
    <div class="min-w-0 flex-1 pb-12">
      <AcpConnectorsView onDone={() => (view = "conversations")} />
    </div>
  {:else}
    <IDESideBar
      collapsed={false}
      fillWidth
      collapsible={false}
      showHeaderActions={false}
      {currentWorkspaceFolders}
      onCollapsedChange={() => {}}
      onNewConversation={openPendingChat}
      onShowConnectors={() => (view = "connectors")}
      onShowAgents={() => (view = "agents")}
      onShowChat={() => (view = "conversations")}
    />
  {/if}

  {#if view !== "conversations"}
    <IDESettingsMenu
      currentView={view}
      onShowAgents={() => (view = "agents")}
      onShowConnectors={() => (view = "connectors")}
    />
  {/if}
</div>
