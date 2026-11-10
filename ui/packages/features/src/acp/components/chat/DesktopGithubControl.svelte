<script lang="ts">
  import Icon, { type IconName } from "@camber/components/icon";
  import type { GitHubLinksOutput } from "@camber/helperapi";
  import { getACPGithubRepo } from "../../features/GithubRepository.svelte";
  import { githubDotColorClass } from "../../github/githubStatus";
  import { appState } from "../../hostAdapter";
  import { rpc } from "../../hostRpc";
  import { supportsNativeMenus } from "./desktopContextMenu";
  import { presentNativeMenu, type MenuSpecItem } from "../ui/menuSpec";

  interface Props {
    targetPath?: string;
    compact?: boolean;
    hasDesktopInstanceColor?: boolean;
  }

  let { targetPath, compact = false, hasDesktopInstanceColor = false }: Props = $props();

  const github = getACPGithubRepo();

  // Whether to show the control at all: only for paths with a GitHub remote.
  // Works at a project root too, not just worktrees.
  let supported = $derived(targetPath ? github.supportedFor(targetPath) : false);
  // The current branch's PR status, used to decorate the button with a dot.
  let dotClass = $derived(targetPath ? githubDotColorClass(github.categoryFor(targetPath)) : "");

  let open = $state(false);
  let container = $state<HTMLDivElement>();
  let links = $state<GitHubLinksOutput | null>(null);
  let linksPath = $state("");
  let loading = $state(false);

  // macOS desktop presents this as an OS-native menu; other desktop platforms
  // fall back to the DOM menu below.
  const native = $derived(supportsNativeMenus($appState.environment));
  let menuTriggerButton = $state<HTMLButtonElement>();

  const mainButtonSizeClass = $derived(compact ? "h-[22px] px-1.5" : "h-7 px-2");
  const menuButtonSizeClass = $derived(compact ? "h-[22px] w-3" : "h-7 w-4");
  const iconSize = $derived(compact ? 16 : 17);
  const chevronIconSize = $derived(compact ? 10 : 11);
  const buttonTone = $derived(
    hasDesktopInstanceColor
      ? "text-white/85 hover:bg-white/10"
      : "text-psx-icon hover:bg-psx-menu-hover-background",
  );

  // Fetches (and caches) the GitHub destinations for the current target path.
  async function ensureLinks(): Promise<GitHubLinksOutput | null> {
    if (!targetPath) return null;
    if (links && linksPath === targetPath) return links;
    loading = true;
    try {
      const result = await github.links(targetPath);
      links = result;
      linksPath = targetPath;
      return result;
    } catch {
      return null;
    } finally {
      loading = false;
    }
  }

  function openExternal(url: string | undefined) {
    open = false;
    if (url) rpc.openExternalURL(url);
  }

  async function openPullRequest() {
    const resolved = await ensureLinks();
    openExternal(resolved?.prUrl);
  }

  const prLabel = $derived(links?.prExists ? "Open Current PR" : "Open New PR");

  // Single source of truth for the menu's actions: the DOM menu renders these
  // as rows below, the native menu maps them to spec items. Both dispatch
  // through runGithubMenuAction.
  type GithubMenuActionId = "openPr" | "openPulls" | "openIssues" | "openRepo";

  interface GithubMenuAction {
    id: GithubMenuActionId;
    label: string;
    icon: IconName;
  }

  const githubMenuActions = $derived<GithubMenuAction[]>([
    { id: "openPr", label: prLabel, icon: "git-branch" },
    { id: "openPulls", label: "Open All Pull Requests", icon: "review" },
    { id: "openIssues", label: "Open Issues", icon: "alert" },
    { id: "openRepo", label: "Open Repository", icon: "github" },
  ]);

  function runGithubMenuAction(id: string) {
    switch (id as GithubMenuActionId) {
      case "openPr":
        openExternal(links?.prUrl);
        return;
      case "openPulls":
        openExternal(links?.pullsUrl);
        return;
      case "openIssues":
        openExternal(links?.issuesUrl);
        return;
      case "openRepo":
        openExternal(links?.repoUrl);
        return;
    }
  }

  async function toggleMenu() {
    if (open) {
      open = false;
      return;
    }
    open = true;
    await ensureLinks();
    if (native) await openNativeMenu();
  }

  // Native menus can't be updated once shown, so present them only after
  // ensureLinks() (awaited by toggleMenu above) has resolved.
  async function openNativeMenu() {
    if (!menuTriggerButton) {
      open = false;
      return;
    }
    const rect = menuTriggerButton.getBoundingClientRect();
    try {
      const items: MenuSpecItem[] = githubMenuActions.map((action) => ({
        kind: "action",
        id: action.id,
        label: action.label,
        icon: action.icon,
        enabled: !loading,
      }));
      const id = await presentNativeMenu(
        items,
        { x: rect.right, y: rect.bottom + 4, align: "end" },
        { highlightStyle: "themed" },
      );
      if (id) runGithubMenuAction(id);
    } finally {
      open = false;
    }
  }

  function closeOnOutsidePointerDown(event: PointerEvent) {
    if (!open || !container || container.contains(event.target as Node)) return;
    open = false;
  }

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape") open = false;
  }
</script>

<svelte:window onpointerdown={closeOnOutsidePointerDown} onkeydown={closeOnEscape} />

{#if supported && targetPath}
  <div bind:this={container} class="relative shrink-0">
    <div class="flex shrink-0 items-center">
      <button
        type="button"
        class={[
          "outline-hidden focus-visible:outline-psx-focus flex shrink-0 items-center gap-1.5 rounded-l-[6px] transition-colors ease-out focus-visible:outline-2",
          mainButtonSizeClass,
          buttonTone,
        ]}
        aria-label={prLabel}
        title={prLabel}
        data-tauri-drag-region="false"
        onclick={openPullRequest}
      >
        {#if dotClass}
          <span
            class={["pointer-events-none size-2 shrink-0 rounded-full", dotClass]}
            aria-hidden="true"
          ></span>
        {/if}
        <Icon name="github" size={iconSize} aria-hidden="true" />
      </button>
      <button
        type="button"
        bind:this={menuTriggerButton}
        class={[
          "outline-hidden focus-visible:outline-psx-focus flex shrink-0 items-center justify-center rounded-r-[6px] transition-colors ease-out focus-visible:outline-2",
          menuButtonSizeClass,
          buttonTone,
        ]}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="GitHub actions"
        title="GitHub Actions"
        data-tauri-drag-region="false"
        onclick={toggleMenu}
      >
        <Icon name="chevron" size={chevronIconSize} class="opacity-70" aria-hidden="true" />
      </button>
    </div>

    {#if open && !native}
      <div
        class="menu-surface absolute right-0 z-50 mt-1 w-56 overflow-hidden p-1"
        role="menu"
        aria-label="GitHub"
      >
        {#each githubMenuActions as action (action.id)}
          <button
            type="button"
            role="menuitem"
            class="hover:bg-psx-menu-hover-background flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left disabled:opacity-50"
            disabled={loading}
            data-tauri-drag-region="false"
            onclick={() => runGithubMenuAction(action.id)}
          >
            <Icon name={action.icon} size={14} class="text-psx-icon shrink-0" />
            <span class="min-w-0 flex-1 truncate">{action.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
