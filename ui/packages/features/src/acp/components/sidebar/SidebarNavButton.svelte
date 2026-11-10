<script lang="ts">
  import Icon, { type IconName } from "@camber/components/icon";
  import Kbd from "@camber/components/kbd";
  import BadgedIcon from "../BadgedIcon.svelte";
  import { suppressContextMenu } from "./contextMenuHelpers";

  interface Props {
    icon: IconName;
    badge?: IconName;
    /** Small connection blob overlaid on the icon (green connected / red not). */
    statusDot?: "connected" | "disconnected";
    label: string;
    ariaLabel?: string;
    selected?: boolean;
    disabled?: boolean;
    title?: string;
    shortcutHint?: string;
    /** Small trailing pill, e.g. "Experimental". */
    pill?: string;
    pillAppearance?: "default" | "vibrant";
    class?: string;
    onclick?: (event: MouseEvent) => void | Promise<void>;
  }

  let {
    icon,
    badge,
    statusDot,
    label,
    ariaLabel,
    selected = false,
    disabled = false,
    title,
    shortcutHint,
    pill,
    pillAppearance = "default",
    class: className = "",
    onclick,
  }: Props = $props();
</script>

<button
  type="button"
  data-tauri-drag-region="false"
  class={[
    "outline-hidden focus-visible:outline-psx-focus flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[13px]/[16px] focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60",
    // Source-list selection, as in the conversations sidebar: the current
    // destination had been painting the same fill as hover, so the settings
    // section you were on looked identical to whichever one you pointed at.
    // Straight off the --psx-highlight-* tokens, which each host resolves for
    // itself — in VS Code they land on the neutral list hover and a transparent
    // ring, which is the look it has today.
    selected
      ? "bg-psx-highlight-background text-psx-foreground-primary shadow-[inset_0_0_0_1px_var(--psx-highlight-border)]"
      : "text-psx-foreground-primary hover:bg-psx-menu-hover-background disabled:text-psx-foreground-tertiary",
    className,
  ]}
  aria-label={ariaLabel}
  aria-current={selected ? "page" : undefined}
  {title}
  {disabled}
  {onclick}
  oncontextmenu={suppressContextMenu}
>
  <span class="relative inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
    {#if badge}
      <BadgedIcon {icon} {badge} size={14} />
    {:else}
      <Icon name={icon} size={14} />
    {/if}
    {#if statusDot}
      <span class="sidebar-nav-status-dot" data-connected={statusDot === "connected"}></span>
    {/if}
  </span>
  <span class="min-w-0 truncate">{label}</span>
  {#if pill}
    <span
      class={[
        "shrink-0 rounded-full px-1.5 py-px text-[10px]/[14px]",
        pillAppearance === "vibrant"
          ? "bg-psx-vibrant/10 text-psx-vibrant ml-auto"
          : "bg-psx-chrome-hover text-psx-foreground-secondary",
      ]}
    >
      {pill}
    </span>
  {/if}
  {#if shortcutHint}
    <!-- Pinned to secondary so the ⌘-hint stays a step dimmer than the label,
         matching the hints in the conversation rows. -->
    <Kbd
      label={shortcutHint}
      class={["ml-auto shrink-0", !selected && "text-psx-foreground-secondary"]}
      aria-hidden="true"
    />
  {/if}
</button>

<style>
  /* Connection blob pinned to the icon's lower-right, ringed in the sidebar
     background so it reads over the glyph strokes. */
  .sidebar-nav-status-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: var(--vscode-terminal-ansiRed);
    outline: 1.5px solid var(--psx-panel);
  }

  .sidebar-nav-status-dot[data-connected="true"] {
    background: var(--vscode-terminal-ansiGreen);
  }
</style>
