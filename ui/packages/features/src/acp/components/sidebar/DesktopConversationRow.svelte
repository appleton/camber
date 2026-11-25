<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ACPConversationSummary } from "../../navTypes";
  import RegistryAgentIcon from "../RegistryAgentIcon.svelte";
  import { getAcpSidebarController } from "./SidebarController.svelte";

  interface Props {
    session: ACPConversationSummary;
    title?: string;
    onSelect?: () => void | Promise<void>;
    disabled?: boolean;
    selectTitle?: string;
    compact?: boolean;
    titleContent?: Snippet;
    right?: Snippet;
    class?: string;
  }

  let {
    session,
    title: titleOverride,
    onSelect,
    disabled = false,
    selectTitle,
    compact = false,
    titleContent,
    right,
    class: className = "",
  }: Props = $props();

  const sidebar = getAcpSidebarController();
  let rowState = $derived(sidebar.rowState(session));
  let agentIcon = $derived(sidebar.agentPickerIconAppearance(rowState.agentServer));
  let title = $derived(titleOverride || session.title || "Untitled Conversation");
</script>

{#snippet rowContents()}
  <RegistryAgentIcon
    iconUrl={agentIcon.iconUrl}
    size={16}
    class={["desktop-conversation-row-agent-icon", agentIcon.class || rowState.iconClass]
      .filter(Boolean)
      .join(" ")}
  />
  <div class="desktop-conversation-row-copy">
    <div
      class={[
        "desktop-conversation-row-title",
        compact ? "desktop-conversation-row-title-compact" : "",
        rowState.titleClass,
      ]}
    >
      {#if titleContent}
        {@render titleContent()}
      {:else}
        {title}
      {/if}
    </div>
  </div>
{/snippet}

<div
  class={["desktop-conversation-row", compact ? "desktop-conversation-row-compact" : "", className]}
>
  {#if onSelect}
    <button
      type="button"
      class={[
        "desktop-conversation-row-main",
        "desktop-conversation-row-main-button",
        disabled ? "desktop-conversation-row-main-disabled" : "",
      ]}
      {disabled}
      title={selectTitle}
      onclick={() => onSelect?.()}
    >
      {@render rowContents()}
    </button>
  {:else}
    <div class="desktop-conversation-row-main">
      {@render rowContents()}
    </div>
  {/if}
  {#if right}
    <div class="desktop-conversation-row-right">
      {@render right()}
    </div>
  {/if}
</div>

<style lang="postcss">
  .desktop-conversation-row {
    display: flex;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    align-items: center;
    color: inherit;
    padding: 0.625rem 12px;
  }

  .desktop-conversation-row-compact {
    padding-block: 0.25rem;
  }

  .desktop-conversation-row-compact .desktop-conversation-row-main {
    max-width: none;
    flex: 1 1 auto;
  }

  .desktop-conversation-row-compact .desktop-conversation-row-right {
    flex: 0 0 auto;
    margin-left: 0.75rem;
  }

  .desktop-conversation-row-main {
    display: flex;
    min-width: 0;
    max-width: 70%;
    flex: 0 1 70%;
    align-items: center;
    gap: 0.625rem;
    color: inherit;
    text-align: left;
  }

  .desktop-conversation-row-main-button {
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 0;
    font: inherit;
    outline: 0;
  }

  .desktop-conversation-row-main-button:focus-visible {
    outline: 2px solid var(--psx-focus);
  }

  .desktop-conversation-row-main-disabled {
    cursor: default;
    color: var(--psx-foreground-secondary);
    opacity: 0.5;
  }

  :global(.desktop-conversation-row-agent-icon) {
    flex-shrink: 0;
  }

  .desktop-conversation-row-copy {
    min-width: 0;
    flex: 1;
  }

  .desktop-conversation-row-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.875rem;
    line-height: 1.125rem;
  }

  .desktop-conversation-row-title-compact {
    font-size: 0.8125rem;
    line-height: 1rem;
  }

  .desktop-conversation-row-right {
    display: flex;
    min-width: 0;
    flex: 1 1 0;
    align-items: center;
    justify-content: flex-end;
  }
</style>
