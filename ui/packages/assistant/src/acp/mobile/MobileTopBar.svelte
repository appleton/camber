<script lang="ts">
  import Icon from "@camber/components/icon";
  import type { Snippet } from "svelte";

  // Per-page navigation bar for the mobile shell. Root pages show the
  // remote-access mark (the controlled laptop, badged with the camber
  // roundel); pushed pages show a back button and center their title between
  // equal-width side slots so it stays optically centered.
  interface Props {
    title: string;
    showLogo?: boolean;
    onBack?: () => void;
    backLabel?: string;
    /** Bar background: the chat page sits on the editor surface, the
     * conversation list on the panel surface (matching the desktop sidebar). */
    tone?: "editor" | "panel";
    /** When set, a status dot before the title shows transport liveness. */
    connected?: boolean;
    /** When set, the title renders as a chip on this background colour —
     * camberqa worktree instances match the desktop app's title chip. */
    titleColor?: string;
    /** Right-aligned icon buttons. */
    actions?: Snippet;
  }

  let {
    title,
    showLogo = false,
    onBack,
    backLabel = "Back",
    tone = "editor",
    connected,
    titleColor,
    actions,
  }: Props = $props();
</script>

<header class={["mobile-top-bar border-b border-psx-border/60", `mobile-top-bar-${tone}`]}>
  <div class="flex min-w-0 items-center">
    {#if onBack}
      <button
        type="button"
        class="mobile-top-bar-button -ml-1 text-psx-foreground-primary outline-hidden focus-visible:outline-2 focus-visible:outline-psx-focus active:bg-psx-menu-hover-background"
        aria-label={backLabel}
        onclick={onBack}
      >
        <Icon name="arrow-left" size={20} />
      </button>
    {:else if showLogo}
      <span
        class="flex size-10 shrink-0 items-center justify-center text-psx-foreground-primary"
        aria-hidden="true"
      >
        <span class="relative inline-flex">
          <Icon name="remote-access" size={24} weight={1.25} />
          <span class="mobile-top-bar-logo-badge">
            <Icon name="roundel" size={10} weight={1.75} />
          </span>
        </span>
      </span>
    {/if}
  </div>

  <span
    class={[
      "flex min-w-0 flex-1 items-center gap-2 text-[17px] font-semibold text-psx-foreground-primary",
      onBack ? "justify-center text-center" : "text-left",
    ]}
  >
    {#if connected !== undefined}
      <span
        class="mobile-top-bar-status"
        data-connected={connected}
        role="img"
        aria-label={connected ? "Connected" : "Disconnected"}
      ></span>
    {/if}
    {#if titleColor}
      <span
        class="flex h-[24px] min-w-0 items-center rounded-[7px] px-2 text-[15px]/[18px] font-medium text-white"
        style:background-color={titleColor}
      >
        <span class="min-w-0 truncate">{title}</span>
      </span>
    {:else}
      <span class="min-w-0 truncate">{title}</span>
    {/if}
  </span>

  <div class="flex items-center justify-end">
    {@render actions?.()}
    {#if onBack && !actions}
      <!-- Balance the back button so the centered title doesn't drift. -->
      <span class="size-10 shrink-0" aria-hidden="true"></span>
    {/if}
  </div>
</header>

<style>
  .mobile-top-bar {
    display: flex;
    flex: none;
    gap: 4px;
    align-items: center;
    padding: 6px 10px;
    padding-top: calc(6px + env(safe-area-inset-top));
    background: var(--mobile-top-bar-background);
  }

  .mobile-top-bar-editor {
    --mobile-top-bar-background: var(--psx-editor-background);
  }

  .mobile-top-bar-panel {
    --mobile-top-bar-background: var(--psx-panel);
  }

  .mobile-top-bar-button {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 10px;
  }

  /* Roundel overlay, bottom-right of the laptop mark. The backing disc
     matches the bar background so the badge reads on top of the glyph
     strokes rather than colliding with them. */
  .mobile-top-bar-logo-badge {
    position: absolute;
    right: -4px;
    bottom: -2px;
    display: inline-flex;
    padding: 1px;
    border-radius: 9999px;
    background: var(--mobile-top-bar-background);
  }

  .mobile-top-bar-status {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    background: var(--vscode-terminal-ansiRed);
  }

  .mobile-top-bar-status[data-connected="true"] {
    background: var(--vscode-terminal-ansiGreen);
  }
</style>
