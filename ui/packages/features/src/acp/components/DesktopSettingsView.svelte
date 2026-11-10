<script lang="ts">
  import Icon from "@camber/components/icon";
  import { KeyboardShortcutsSection } from "../../keybindings";
  import BadgedIcon from "./BadgedIcon.svelte";
  import { appState } from "../hostAdapter";
  import AcpAgentConfigurationSection from "./AgentConfigurationSection.svelte";
  import DesktopArchivedChatsSection from "./DesktopArchivedChatsSection.svelte";
  import DesktopGitHubConnectorSection from "./DesktopGitHubConnectorSection.svelte";
  import DesktopPreferencesSection from "./DesktopPreferencesSection.svelte";
  import DesktopRemoteAccessSection from "./DesktopRemoteAccessSection.svelte";
  import LocalInferenceSettingsSection from "./LocalInferenceSettingsSection.svelte";
  import VoiceRecognitionSettingsSection from "./VoiceRecognitionSettingsSection.svelte";
  import UserMCPServersSection from "./UserMCPServersSection.svelte";
  import DesktopSettingsPanelFrame from "./settings/DesktopSettingsPanelFrame.svelte";
  import SettingsSection from "./settings/SettingsSection.svelte";
  import {
    DESKTOP_SETTINGS_SECTIONS,
    SETTINGS_HEADINGS,
    SETTINGS_NAV_ITEMS,
    type DesktopSettingsSection,
    type SettingsSection as SettingsSectionName,
  } from "./settings/settingsSections";

  // "all" stacks every section on one page. The section prop renders one
  // settings section while the page-level left nav controls switching sections.
  // sectionNav=false suppresses that left nav for hosts too narrow to fit it
  // (the IDE sidebar); the header then names the section itself.
  interface Props {
    centerHeader?: boolean;
    sidebarWidth?: number;
    section?: SettingsSectionName;
    availableSections?: readonly DesktopSettingsSection[];
    sectionNav?: boolean;
    onSectionChange?: (section: DesktopSettingsSection) => void;
    onShowConnectors?: () => void;
    onShowChat?: () => void;
    activeConversationId?: string | null;
    onActiveConversationIdChange?: (id: string | null) => void;
    onDone?: () => void;
    desktopFrame?: boolean;
  }

  let {
    centerHeader = false,
    sidebarWidth = 260,
    section = "all",
    availableSections = DESKTOP_SETTINGS_SECTIONS,
    sectionNav = true,
    onSectionChange,
    onShowConnectors,
    onShowChat,
    activeConversationId = null,
    onActiveConversationIdChange,
    onDone,
    desktopFrame = false,
  }: Props = $props();
  let isDesktop = $derived($appState.environment.assistantHost === "desktop");

  let heading = $derived(SETTINGS_HEADINGS[section]);
  let showSectionNav = $derived(
    sectionNav && !desktopFrame && section !== "all" && availableSections.length > 1,
  );
  let headerTitle = $derived(sectionNav ? SETTINGS_HEADINGS.all.title : heading.title);
  let headerSubtitle = $derived(
    !sectionNav || section === "all" ? heading.subtitle : "Configure Camber Assistant.",
  );
  let frameBreadcrumbs = $derived(
    section === "all"
      ? undefined
      : [{ label: heading.title, icon: SETTINGS_NAV_ITEMS[section].icon }],
  );
</script>

{#snippet settingsSection(sectionName: DesktopSettingsSection)}
  {#if sectionName === "preferences"}
    <DesktopPreferencesSection />
  {:else if sectionName === "shortcuts"}
    <KeyboardShortcutsSection host="desktop" />
  {:else if sectionName === "github"}
    <DesktopGitHubConnectorSection showHeading={false} />
  {:else if sectionName === "agents"}
    <AcpAgentConfigurationSection />
  {:else if sectionName === "models"}
    {#if isDesktop}
      <LocalInferenceSettingsSection {onShowConnectors} />
    {/if}
  {:else if sectionName === "voice"}
    {#if isDesktop}
      <VoiceRecognitionSettingsSection />
    {/if}
  {:else if sectionName === "archived"}
    <DesktopArchivedChatsSection
      {onShowChat}
      {activeConversationId}
      {onActiveConversationIdChange}
    />
  {:else}
    <SettingsSection
      title={SETTINGS_HEADINGS[sectionName].title}
      pill={SETTINGS_NAV_ITEMS[sectionName].pill}
      subtitle={SETTINGS_HEADINGS[sectionName].subtitle}
    >
      {#if sectionName === "connectors"}
        <UserMCPServersSection showHeading={false} />
      {:else if sectionName === "remote"}
        <DesktopRemoteAccessSection />
      {/if}
    </SettingsSection>
  {/if}
{/snippet}

{#snippet settingsContent()}
  {#if section === "all"}
    {#if isDesktop}
      {@render settingsSection("preferences")}
      {@render settingsSection("shortcuts")}
    {/if}

    {@render settingsSection("connectors")}
    {#if isDesktop}
      {@render settingsSection("models")}
      {@render settingsSection("voice")}
    {/if}
    {@render settingsSection("github")}
    {@render settingsSection("agents")}
    {#if isDesktop}
      {@render settingsSection("archived")}
      {@render settingsSection("remote")}
    {/if}
  {:else if section === "preferences"}
    {#if isDesktop}
      {@render settingsSection("preferences")}
    {/if}
  {:else if section === "shortcuts"}
    {@render settingsSection("shortcuts")}
  {:else if section === "models"}
    {@render settingsSection("models")}
  {:else if section === "voice"}
    {@render settingsSection("voice")}
  {:else if section === "connectors"}
    {@render settingsSection("connectors")}
  {:else if section === "github"}
    {@render settingsSection("github")}
  {:else if section === "agents"}
    {@render settingsSection("agents")}
  {:else if section === "archived"}
    {#if isDesktop}
      {@render settingsSection("archived")}
    {/if}
  {:else if section === "remote"}
    {#if isDesktop}
      {@render settingsSection("remote")}
    {/if}
  {/if}
{/snippet}

{#if desktopFrame}
  <DesktopSettingsPanelFrame
    title={heading.title}
    subtitle={heading.subtitle}
    breadcrumbs={frameBreadcrumbs}
  >
    <div class="settings-section-stack">
      {@render settingsContent()}
    </div>
  </DesktopSettingsPanelFrame>
{:else}
  <section
    class="bg-psx-editor-background text-psx-foreground-primary flex h-full min-w-0 flex-col"
  >
    <div
      class={[
        "border-psx-border relative flex h-12 shrink-0 items-center justify-between border-b py-1.5 pr-4",
        isDesktop && !centerHeader ? "pl-[var(--desktop-window-controls-space,88px)]" : "pl-4",
      ]}
      data-tauri-drag-region={isDesktop ? "deep" : undefined}
    >
      {#if centerHeader}
        <div
          class="pointer-events-none relative z-10 shrink-0"
          style={`width: ${sidebarWidth}px;`}
          aria-hidden="true"
        ></div>
      {/if}

      <div
        class={[
          "pointer-events-none relative z-10 min-w-0",
          centerHeader ? "flex-1 text-center" : "",
        ]}
      >
        <h1 class="truncate text-base font-semibold">{headerTitle}</h1>
        <p class="text-psx-foreground-secondary truncate text-[13px]/[18px]">
          {headerSubtitle}
        </p>
      </div>

      {#if onDone}
        <div
          class={["relative z-10", centerHeader ? "flex shrink-0 justify-end" : ""]}
          style={centerHeader ? `width: ${sidebarWidth}px;` : undefined}
        >
          <button
            type="button"
            data-tauri-drag-region="false"
            class="text-psx-foreground-secondary outline-hidden hover:bg-psx-menu-hover-background hover:text-psx-foreground-primary focus-visible:outline-psx-focus flex shrink-0 items-center gap-1 rounded-[6px] px-2 py-1 text-xs focus-visible:outline-2"
            onclick={onDone}
          >
            <Icon name="arrow-left" size={14} aria-hidden="true" />
            <span>Back to Conversations</span>
          </button>
        </div>
      {/if}
    </div>

    <div class="flex min-h-0 flex-1">
      {#if showSectionNav}
        <aside class="border-psx-border bg-psx-panel w-[232px] shrink-0 border-r p-2">
          <nav class="flex flex-col gap-1" aria-label="Settings sections">
            {#each availableSections as item}
              <button
                type="button"
                class={[
                  "outline-hidden focus-visible:outline-psx-focus flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm focus-visible:outline-2",
                  // Source-list selection, as in the conversations sidebar: the
                  // selected section had been painting the same fill as hover.
                  // Straight off the --psx-highlight-* tokens rather than the
                  // desktop stylesheet, because this nav also renders in the
                  // sidebar-only panel — in VS Code they resolve to the neutral
                  // list hover and a transparent ring, which is today's look.
                  section === item
                    ? "bg-psx-highlight-background text-psx-foreground-primary shadow-[inset_0_0_0_1px_var(--psx-highlight-border)]"
                    : "text-psx-foreground-primary hover:bg-psx-menu-hover-background",
                ]}
                aria-current={section === item ? "page" : undefined}
                onclick={() => onSectionChange?.(item)}
              >
                {#if SETTINGS_NAV_ITEMS[item].badge}
                  <BadgedIcon
                    icon={SETTINGS_NAV_ITEMS[item].icon}
                    badge={SETTINGS_NAV_ITEMS[item].badge}
                    size={16}
                    class="shrink-0"
                  />
                {:else}
                  <Icon name={SETTINGS_NAV_ITEMS[item].icon} size={16} class="shrink-0" />
                {/if}
                <span class="min-w-0 truncate">{SETTINGS_NAV_ITEMS[item].label}</span>
                {#if SETTINGS_NAV_ITEMS[item].pill}
                  <span
                    class="bg-psx-chrome-hover text-psx-foreground-secondary shrink-0 rounded-full px-1.5 py-px text-[10px]/[14px]"
                  >
                    {SETTINGS_NAV_ITEMS[item].pill}
                  </span>
                {/if}
              </button>
            {/each}
          </nav>
        </aside>
      {/if}

      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div
          class={[
            "settings-section-stack",
            !isDesktop && section === "agents" && "ide-agent-settings-section-stack",
          ]}
        >
          {@render settingsContent()}
        </div>
      </div>
    </div>
  </section>
{/if}
