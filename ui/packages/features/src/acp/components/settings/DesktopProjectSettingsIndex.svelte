<script lang="ts">
  import Icon from "@camber/components/icon";
  import { untrack } from "svelte";
  import { slide } from "svelte/transition";
  import { compareWorktreesByDisplayOrder } from "../../navTypes";
  import { getACPProjectRepo } from "../../features/ProjectRepository.svelte";
  import { appState } from "../../hostAdapter";
  import { shortenHomeDirectoryInText } from "../../shared/paths";
  import ProjectSettingsView from "../ProjectSettingsView.svelte";
  import DesktopSettingsPanelFrame from "./DesktopSettingsPanelFrame.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import { SETTINGS_NAV_ITEMS } from "./settingsSections";

  interface Props {
    expandedProjectPath?: string | null;
    embedded?: boolean;
  }

  let { expandedProjectPath = null, embedded = false }: Props = $props();

  const projects = getACPProjectRepo();
  const projectSettingsNavItem = SETTINGS_NAV_ITEMS["project-settings"];

  let rootProjects = $derived(
    projects.projects.filter((project) => !project.isWorktree).sort(compareWorktreesByDisplayOrder),
  );
  let expandedProjectPaths = $state<string[]>([]);

  // Auto-expand only when the requested project changes, so the section stays
  // collapsible afterwards; tracking expandedProjectPaths here would re-expand
  // it on every collapse.
  $effect(() => {
    const path = expandedProjectPath;
    if (!path) return;
    untrack(() => {
      if (!expandedProjectPaths.includes(path)) {
        expandedProjectPaths = [...expandedProjectPaths, path];
      }
    });
  });

  function toggleProject(path: string) {
    expandedProjectPaths = expandedProjectPaths.includes(path)
      ? expandedProjectPaths.filter((expandedPath) => expandedPath !== path)
      : [...expandedProjectPaths, path];
  }

  function isProjectExpanded(path: string) {
    return expandedProjectPaths.includes(path);
  }
</script>

{#snippet projectSettingsIndexContent()}
  <div class="settings-section-stack">
    {#if rootProjects.length === 0}
      <SettingsSection title="Projects" subtitle="No projects are configured.">
        <p class="text-psx-foreground-secondary px-3 pb-3 pt-3 text-[13px]/[18px]">
          No projects yet.
        </p>
      </SettingsSection>
    {:else}
      {#each rootProjects as project (project.path)}
        <SettingsSection
          title={project.name}
          subtitle={shortenHomeDirectoryInText(project.path, $appState.homeDirectory)}
          subtitleClass="font-mono"
        >
          <button
            type="button"
            class="text-psx-foreground-primary outline-hidden hover:bg-psx-menu-hover-background/50 focus-visible:outline-psx-focus flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left transition duration-200 focus-visible:outline-2"
            aria-label="{isProjectExpanded(project.path)
              ? 'Hide'
              : 'Show'} settings for {project.name}"
            aria-expanded={isProjectExpanded(project.path)}
            onclick={() => toggleProject(project.path)}
          >
            <Icon
              name="chevron"
              size={16}
              class={[
                "text-psx-foreground-tertiary shrink-0 transition-transform",
                isProjectExpanded(project.path) ? "" : "rotate-[-90deg]",
              ]}
            />
            <span class="min-w-0 text-[12px]/[18px]">
              {isProjectExpanded(project.path) ? "Hide settings" : "Show settings"}
            </span>
          </button>

          {#if isProjectExpanded(project.path)}
            <div class="outline-psx-border outline" transition:slide={{ duration: 160 }}>
              <ProjectSettingsView
                projectPath={project.path}
                projectName={project.name}
                embeddedDesktopContent
              />
            </div>
          {/if}
        </SettingsSection>
      {/each}
    {/if}
  </div>
{/snippet}

{#if embedded}
  {@render projectSettingsIndexContent()}
{:else}
  <DesktopSettingsPanelFrame
    title={projectSettingsNavItem.label}
    breadcrumbs={[{ label: projectSettingsNavItem.label, icon: projectSettingsNavItem.icon }]}
  >
    {@render projectSettingsIndexContent()}
  </DesktopSettingsPanelFrame>
{/if}
