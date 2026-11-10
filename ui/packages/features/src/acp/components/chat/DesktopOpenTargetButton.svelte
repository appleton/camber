<script lang="ts">
  import Icon from "@camber/components/icon";
  import { withShortcut } from "../../../keybindings";
  import { appState } from "../../hostAdapter";
  import type { DesktopOpenerInfo } from "../../desktopOpeners";
  import { supportsNativeMenus } from "./desktopContextMenu";
  import type { NativeMenuIcon } from "./nativeMenuIcons";
  import { presentNativeMenu, type MenuSpecItem } from "../ui/menuSpec";

  export type DesktopTargetOpener = DesktopOpenerInfo;

  interface Props {
    compact?: boolean;
    disabled?: boolean;
    hasDesktopInstanceColor?: boolean;
    openers: DesktopTargetOpener[];
    targetKind: "project" | "worktree";
    value: string;
    onOpen: (opener: DesktopTargetOpener) => void;
  }

  let {
    compact = false,
    disabled = false,
    hasDesktopInstanceColor = false,
    openers,
    targetKind,
    value,
    onOpen,
  }: Props = $props();

  let open = $state(false);
  let container = $state<HTMLDivElement>();

  // macOS desktop presents this as an OS-native menu; other desktop platforms
  // fall back to the DOM menu below.
  const native = $derived(supportsNativeMenus($appState.environment));
  let menuTriggerButton = $state<HTMLButtonElement>();
  let nativeMenuOpen = $state(false);

  const selected = $derived(openers.find((opener) => opener.id === value) ?? openers[0]);
  const label = $derived(`Open ${targetKind} in...`);
  const appIconSizeClass = $derived(compact ? "size-[18px]" : "size-5");
  const appIconPixelSize = $derived(compact ? 18 : 17);
  const mainButtonSizeClass = $derived(compact ? "size-[22px]" : "size-7");
  const menuButtonSizeClass = $derived(compact ? "h-[22px] w-3" : "h-7 w-4");
  const chevronIconSize = $derived(compact ? 10 : 11);
  const buttonTone = $derived(
    hasDesktopInstanceColor
      ? "text-white/85 hover:bg-white/10"
      : "text-psx-icon hover:bg-psx-menu-hover-background",
  );

  function openWith(opener?: DesktopTargetOpener) {
    if (!opener) return;
    open = false;
    onOpen(opener);
  }

  // Mirrors the DOM menu's appIcon snippet: a data URI wins and renders as
  // full-color artwork (never a recolored mask), otherwise fall back to a
  // product icon by opener kind. Padded artwork gets the same slight upscale
  // as the DOM rows' scale-105.
  function openerMenuIcon(opener: DesktopTargetOpener): NativeMenuIcon {
    if (opener.iconDataUri) {
      return hasPaddedIcon(opener)
        ? { image: opener.iconDataUri, scale: 1.05 }
        : { image: opener.iconDataUri };
    }
    if (opener.kind === "inApp") return "file-active";
    if (opener.kind === "editorEnv" || opener.kind === "terminal") return "terminal";
    return "file";
  }

  // Single source of truth for the menu's rows: the DOM menu below iterates
  // `openers` directly and calls openWith(opener); the native menu maps the
  // same list to spec items and dispatches through openWith too.
  const openerMenuItems = $derived<MenuSpecItem[]>(
    openers.map((opener) => ({
      kind: "action",
      id: opener.id,
      label: opener.label,
      icon: openerMenuIcon(opener),
    })),
  );

  function toggleMenu() {
    if (native) {
      void openNativeMenu();
      return;
    }
    open = !open;
  }

  async function openNativeMenu() {
    if (!menuTriggerButton || nativeMenuOpen || disabled) return;
    const rect = menuTriggerButton.getBoundingClientRect();
    nativeMenuOpen = true;
    try {
      const id = await presentNativeMenu(
        openerMenuItems,
        { x: rect.right, y: rect.bottom + 4, align: "end" },
        { highlightStyle: "themed" },
      );
      openWith(openers.find((opener) => opener.id === id));
    } finally {
      nativeMenuOpen = false;
    }
  }

  function closeOnOutsidePointerDown(event: PointerEvent) {
    if (!open || !container || container.contains(event.target as Node)) return;
    open = false;
  }

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape") open = false;
  }

  // VS Code's icon artwork has unusually wide transparent padding, so it
  // renders smaller than other app icons at the same box size.
  function hasPaddedIcon(opener: DesktopTargetOpener) {
    return opener.id.includes("VSCode") || opener.label.startsWith("Visual Studio Code");
  }
</script>

<svelte:window onpointerdown={closeOnOutsidePointerDown} onkeydown={closeOnEscape} />

<div bind:this={container} class="relative shrink-0">
  <div class={[buttonTone, "flex shrink-0 items-center rounded-[6px]"]}>
    <button
      type="button"
      class={[
        "outline-hidden focus-visible:outline-psx-focus flex shrink-0 items-center justify-center rounded-l-[6px] mix-blend-multiply transition-colors ease-out focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60 dark:mix-blend-screen",
        mainButtonSizeClass,
        buttonTone,
      ]}
      aria-label={label}
      title={withShortcut(label, "openInIde")}
      {disabled}
      data-tauri-drag-region="false"
      onclick={() => openWith(selected)}
    >
      {@render appIcon(selected, appIconSizeClass, appIconPixelSize)}
    </button>
    <button
      type="button"
      bind:this={menuTriggerButton}
      class={[
        "outline-hidden focus-visible:outline-psx-focus flex shrink-0 items-center justify-center rounded-r-[6px] transition-colors ease-out focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60",
        menuButtonSizeClass,
        buttonTone,
      ]}
      aria-haspopup="menu"
      aria-expanded={native ? nativeMenuOpen : open}
      aria-label={`${label} options`}
      title={`${label} options`}
      {disabled}
      data-tauri-drag-region="false"
      onclick={toggleMenu}
    >
      <Icon name="chevron" size={chevronIconSize} class="opacity-70" aria-hidden="true" />
    </button>
  </div>

  {#if open}
    <div
      class="menu-surface absolute right-0 z-50 mt-1 max-h-80 w-56 overflow-y-auto p-1"
      role="menu"
      aria-label={`Open ${targetKind} in`}
    >
      <div class="text-psx-foreground-tertiary px-2 py-1.5 text-xs font-medium">
        Open {targetKind} in...
      </div>
      {#each openers as opener (opener.id)}
        <button
          type="button"
          role="menuitem"
          class="hover:bg-psx-menu-hover-background flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left"
          data-tauri-drag-region="false"
          onclick={() => openWith(opener)}
        >
          {@render appIcon(opener, "size-5")}
          <span class="min-w-0 flex-1 truncate">{opener.label}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

{#snippet appIcon(opener?: DesktopTargetOpener, sizeClass = "size-5", iconSize = 17)}
  <span class={["flex shrink-0 items-center justify-center overflow-visible", sizeClass]}>
    {#if opener?.iconDataUri}
      <img
        src={opener.iconDataUri}
        alt=""
        class={["size-full object-contain", hasPaddedIcon(opener) && "scale-105"]}
      />
    {:else if opener?.kind === "inApp"}
      <Icon name="file-active" size={iconSize} />
    {:else if opener?.kind === "editorEnv" || opener?.kind === "terminal"}
      <Icon name="terminal" size={iconSize - 3} />
    {:else}
      <Icon name="file" size={iconSize} />
    {/if}
  </span>
{/snippet}
