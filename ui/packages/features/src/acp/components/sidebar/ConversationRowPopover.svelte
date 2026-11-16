<script lang="ts">
  import { onDestroy } from "svelte";
  import { cubicIn } from "svelte/easing";
  import { fly } from "svelte/transition";
  import type { ACPConversationSummary } from "../../navTypes";
  import ConversationRow from "./ConversationRow.svelte";
  import {
    getAcpSidebarController,
    type SidebarConversationPreviewTarget,
  } from "./SidebarController.svelte";
  import { rowExitAnimation } from "./rowExitAnimation.svelte";
  import { rowExitDurationMs } from "./rowExitTransition";

  interface Props {
    session: ACPConversationSummary;
    agentName: string;
    iconUrl?: string;
    selected?: boolean;
    iconClass?: string;
    titleClass?: string;
    iconSize?: number;
    iconSlotSize?: number;
    leadingPaddingClass?: string;
    working?: boolean;
    waitingForUser?: boolean;
    unread?: boolean;
    shortcutHint?: string;
    desktop?: boolean;
    // Read when the row leaves the list, so the exit animation is reserved for
    // rows the user archived rather than rows a search or collapse filtered out.
    isExiting?: () => boolean;
    onOpen: () => void | Promise<void>;
    onArchive?: (event: MouseEvent) => void | Promise<void>;
    onArchiveNow?: (event: MouseEvent) => void | Promise<void>;
    onContextMenu?: (event: MouseEvent) => void;
  }

  let {
    session,
    agentName,
    iconUrl,
    selected = false,
    iconClass = "text-psx-foreground-secondary",
    titleClass = "",
    iconSize = 14,
    iconSlotSize = iconSize,
    leadingPaddingClass = "pl-2",
    working = false,
    waitingForUser = false,
    unread = false,
    shortcutHint,
    desktop = false,
    isExiting,
    onOpen,
    onArchive,
    onArchiveNow,
    onContextMenu,
  }: Props = $props();

  const sidebar = getAcpSidebarController();
  const reviewKey = $derived(sidebar.reviewSessionKey(session));
  let rowElement = $state<HTMLDivElement | null>(null);

  // Svelte evaluates transition params when the outro starts, so this reads
  // the caller's exiting state at the moment the row is actually removed. That
  // gate is also what makes the outro safe to mark |global: emptying a group
  // tears down the wrapper around the row list, which would skip a local
  // transition, while collapsing or unmounting the sidebar still resolves to a
  // zero duration and no animation.
  function exitDuration(): number {
    return rowExitDurationMs(isExiting?.() === true);
  }

  // Reports real exit outros to the shared animation state so empty-state
  // copy waits for outroend. The exiting flag is captured at outrostart:
  // delete clears it in a finally that can run before the outro finishes.
  // Svelte can start the same element's outro twice in one removal (observed
  // in the desktop webview), and only the surviving animation dispatches
  // outroend — so each exit is counted at most once.
  let exitOutroCounted = false;

  function handleOutroStart() {
    if (exitOutroCounted || isExiting?.() !== true) return;
    exitOutroCounted = true;
    rowExitAnimation.outroStarted();
  }

  function handleOutroEnd() {
    if (!exitOutroCounted) return;
    exitOutroCounted = false;
    rowExitAnimation.outroEnded();
  }

  function previewTarget(): SidebarConversationPreviewTarget | null {
    if (!rowElement) return null;
    return {
      key: reviewKey,
      anchor: rowElement,
      session,
      agentName,
      iconUrl,
      iconClass,
      iconSize,
      desktop,
    };
  }

  function handlePointerEnter(event: PointerEvent) {
    const target = previewTarget();
    if (target) sidebar.openConversationPreview(target, event);
  }

  function handleContextMenu(event: MouseEvent) {
    sidebar.closeConversationPreview();
    onContextMenu?.(event);
  }

  $effect(() => {
    const target = previewTarget();
    if (target) sidebar.refreshConversationPreview(target);
  });

  onDestroy(() => {
    if (rowElement) sidebar.unmountConversationPreviewRow(reviewKey, rowElement);
  });
</script>

<div
  bind:this={rowElement}
  role="presentation"
  out:fly|global={{ x: -32, opacity: 0, duration: exitDuration(), easing: cubicIn }}
  onoutrostart={handleOutroStart}
  onoutroend={handleOutroEnd}
  onpointerenter={handlePointerEnter}
  onpointerleave={() => sidebar.leaveConversationPreview(reviewKey)}
  onpointerdown={() => sidebar.cancelConversationPreviewOpen(reviewKey)}
  class={[
    "outline-hidden hover:bg-psx-menu-hover-background group relative flex w-full min-w-0 items-center rounded-[6px]",
    // Source-list selection, styled in the desktop stylesheet off this class
    // rather than here: the fill and its ring are desktop-only — see app.css.
    selected && desktop ? "desktop-sidebar-row-selected" : "",
    "text-psx-foreground-primary",
  ]}
>
  <ConversationRow
    {session}
    {agentName}
    {iconUrl}
    {iconClass}
    {titleClass}
    {iconSize}
    {iconSlotSize}
    {leadingPaddingClass}
    {working}
    {waitingForUser}
    {unread}
    {shortcutHint}
    {desktop}
    {onOpen}
    {onArchive}
    {onArchiveNow}
    onContextMenu={handleContextMenu}
  />
</div>
