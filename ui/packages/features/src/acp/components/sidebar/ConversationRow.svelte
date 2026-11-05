<script lang="ts">
  import Icon from "@camber/components/icon";
  import Kbd from "@camber/components/kbd";
  import { formatRelativeTimeWithoutAgo } from "../../shared/time";
  import type { ACPConversationSummary } from "../../navTypes";
  import RegistryAgentIcon from "../RegistryAgentIcon.svelte";
  import StreamingSequenceLoader from "../ui/StreamingSequenceLoader.svelte";
  import RenamableLabel from "./RenamableLabel.svelte";
  import { getAcpSidebarController } from "./SidebarController.svelte";

  interface Props {
    session: ACPConversationSummary;
    agentName: string;
    iconUrl?: string;
    iconClass?: string;
    titleClass?: string;
    iconSize?: number;
    iconSlotSize?: number;
    leadingPaddingClass?: string;
    desktop?: boolean;
    working?: boolean;
    waitingForUser?: boolean;
    unread?: boolean;
    // ⌘1–9 hint shown in place of the time column while ⌘ is held.
    shortcutHint?: string;
    // Small quiet label after the title, e.g. the worktree a nested sub-agent lives in.
    badge?: string;
    onOpen: () => void | Promise<void>;
    onArchive?: (event: MouseEvent) => void | Promise<void>;
    onArchiveNow?: (event: MouseEvent) => void | Promise<void>;
    onContextMenu?: (event: MouseEvent) => void;
  }

  let {
    session,
    agentName,
    iconUrl,
    iconClass = "text-psx-foreground-secondary",
    titleClass = "",
    iconSize = 14,
    iconSlotSize = iconSize,
    leadingPaddingClass = "pl-2",
    desktop = false,
    working = false,
    waitingForUser = false,
    unread = false,
    shortcutHint,
    badge,
    onOpen,
    onArchive,
    onArchiveNow,
    onContextMenu,
  }: Props = $props();

  const sidebar = getAcpSidebarController();
  const renaming = $derived(sidebar.isRenamingConversation(session.id));
  const title = $derived(session.title || "Untitled Conversation");
  // A draft (not-yet-started) conversation has no session id yet.
  const isDraft = $derived(session.sessionId === null);
  const showDraftIcon = $derived(session.draftPromptPresent === true);
  const updatedAtLabel = $derived(
    session.updatedAt ? formatRelativeTimeWithoutAgo(session.updatedAt) : null,
  );

  // Waiting for user input (elicitation / permission prompt) shows an amber dot
  // rather than the working spinner: the agent is blocked on the user, not busy.
  const showTimeColumnIndicator = $derived(working && !waitingForUser);
  const actionButtonClass =
    "text-psx-foreground-secondary hover:text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus flex size-6 shrink-0 items-center justify-center rounded-[5px] focus-visible:outline-2 transition-colors duration-200 ease-out";
</script>

<div
  class={[
    "relative flex min-w-0 flex-1 select-none items-center gap-2 rounded-[6px] pr-2",
    leadingPaddingClass,
  ]}
>
  {#snippet agentIconSlot()}
    <span
      class="sidebar-agent-icon-slot"
      style={`--sidebar-agent-icon-size: ${iconSize}px; --sidebar-agent-icon-slot-size: ${iconSlotSize}px;`}
      aria-hidden="true"
    >
      <RegistryAgentIcon {iconUrl} size={iconSize} class={iconClass} />
    </span>
  {/snippet}
  {#if renaming}
    <!-- py compensates for the input's border box so the row keeps its height. -->
    <div class="flex min-w-0 flex-1 items-center gap-2 py-[5px] text-left">
      {@render agentIconSlot()}
      <RenamableLabel
        value={title}
        ariaLabel={`Rename ${title}`}
        class={desktop ? "text-[13px]/[16px]" : "text-sm"}
        onSubmit={(name) => sidebar.commitRename(name)}
        onCancel={() => sidebar.cancelRename()}
      />
    </div>
  {:else}
    <button
      type="button"
      data-testid="acp-conversation-row"
      class="outline-hidden focus-visible:outline-psx-focus flex min-w-0 flex-1 select-none items-center gap-2 rounded-[6px] py-1.5 text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-2"
      aria-label={`${title} - ${agentName}`}
      onclick={() => onOpen()}
      onauxclick={(event) => {
        if (event.button === 1) onArchiveNow?.(event);
      }}
      oncontextmenu={(event) => onContextMenu?.(event)}
    >
      {@render agentIconSlot()}
      <span
        class={[
          "flex min-w-0 flex-1 items-center gap-1",
          desktop ? "text-[13px]/[16px]" : "text-sm",
          working && !waitingForUser && !desktop && !titleClass && "font-semibold",
          isDraft && "text-psx-foreground-secondary",
          titleClass,
        ]}
      >
        {#if showDraftIcon}
          <Icon name="pencil" size={12} class="shrink-0" aria-hidden="true" />
        {/if}
        <span class="min-w-0 truncate">{title}</span>
        {#if badge}
          <span
            class="text-psx-foreground-tertiary border-psx-border max-w-[45%] shrink-0 truncate rounded-[4px] border px-1 text-[11px]/[14px]"
            title={badge}>{badge}</span
          >
        {/if}
      </span>
    </button>

    <!-- Keep the action gutter stable so hovering never relayouts the row. -->
    <div
      class="pointer-events-none relative z-10 flex min-w-[2rem] shrink-0 items-center justify-end"
    >
      {#if shortcutHint}
        <Kbd
          label={shortcutHint}
          class="text-psx-foreground-secondary text-[11px]/[16px] group-focus-within:invisible group-hover:invisible"
          aria-hidden="true"
        />
      {:else if waitingForUser}
        <span
          class="flex w-4 items-center justify-center group-focus-within:invisible group-hover:invisible"
          role="img"
          aria-label="Waiting for your input"
        >
          <span class="bg-psx-warning-foreground block size-[7px] rounded-full"></span>
        </span>
      {:else if showTimeColumnIndicator}
        <span
          class="text-psx-info-foreground flex size-4 items-center justify-center group-focus-within:invisible group-hover:invisible"
        >
          <StreamingSequenceLoader size={16} ariaLabel="Conversation responding" />
        </span>
      {:else if unread}
        <span
          class="flex w-4 items-center justify-center group-focus-within:invisible group-hover:invisible"
          role="img"
          aria-label="Unread conversation"
        >
          <span class="block size-[7px] rounded-full" style="background: #3794ff;"></span>
        </span>
      {:else if updatedAtLabel && !desktop}
        <span
          class="text-psx-foreground-secondary block text-[13px]/[16px] group-focus-within:invisible group-hover:invisible"
        >
          {updatedAtLabel}
        </span>
      {/if}
      <div
        class="pointer-events-none absolute inset-y-0 -right-1 flex items-center justify-end gap-0.5 opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <button
          type="button"
          class={actionButtonClass}
          aria-label={`Archive ${title}`}
          title="Archive Conversation"
          onclick={(event: MouseEvent) => onArchive?.(event)}
        >
          <Icon name="archive" size={14} />
        </button>
      </div>
    </div>
  {/if}
</div>

<style lang="postcss">
  .sidebar-agent-icon-slot {
    display: inline-flex;
    width: var(--sidebar-agent-icon-slot-size, var(--sidebar-agent-icon-size));
    height: var(--sidebar-agent-icon-slot-size, var(--sidebar-agent-icon-size));
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
</style>
