<script lang="ts">
  import { Button } from "@camber/components/button";
  import Icon from "@camber/components/icon";
  import { onMount, tick } from "svelte";
  import AcpChatPane from "./chat/ChatPane.svelte";
  import SidebarIconButton from "./sidebar/SidebarIconButton.svelte";

  interface Props {
    conversationId: string;
    title: string;
    onRestore?: () => void | Promise<void>;
    onDelete: () => void;
    deleteDisabled?: boolean;
    closeDisabled?: boolean;
    onClose: () => void;
  }

  let {
    conversationId,
    title,
    onRestore,
    onDelete,
    deleteDisabled = false,
    closeDisabled = false,
    onClose,
  }: Props = $props();

  const titleId = $props.id();
  let closeButton = $state<HTMLButtonElement | null>(null);
  let restoring = $state(false);

  onMount(() => {
    void tick().then(() => closeButton?.focus());
  });

  async function restoreConversation(): Promise<void> {
    if (!onRestore || restoring) return;
    restoring = true;
    try {
      await onRestore();
    } finally {
      restoring = false;
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape" && !closeDisabled) onClose();
  }}
/>

<!-- Fixed and portaled to <body> by the caller: the preview modals the whole
     app window, not just the settings panel that opened it. Stacks under the
     delete confirmation (z-[110]), which can open on top of the preview. -->
<div
  class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
  data-tauri-drag-region="false"
>
  <div
    class="border-psx-border bg-psx-editor-background text-psx-foreground-primary shadow-overlay dark:shadow-overlay-dark flex h-[80%] w-[75%] min-w-0 flex-col overflow-hidden rounded-xl border"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
  >
    <header
      class="border-psx-border bg-psx-panel flex h-11 shrink-0 items-center gap-3 border-b px-3"
    >
      <h2 id={titleId} class="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
      {#if onRestore}
        <Button
          size="sm"
          prominence="standard"
          class="shrink-0"
          disabled={restoring}
          onclick={restoreConversation}
        >
          {restoring ? "Restoring…" : "Restore"}
        </Button>
      {/if}
      <SidebarIconButton
        icon="trash"
        label={`Delete ${title || "conversation"}`}
        title={deleteDisabled
          ? "This agent does not support deleting sessions"
          : "Delete conversation"}
        size={14}
        buttonSize="size-6"
        disabled={deleteDisabled}
        onclick={onDelete}
      />
      <button
        bind:this={closeButton}
        type="button"
        class="text-psx-icon outline-hidden hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus flex size-7 shrink-0 items-center justify-center rounded-[6px] focus-visible:outline-2"
        aria-label="Close archived conversation"
        onclick={onClose}
      >
        <Icon name="cross" size={16} aria-hidden="true" />
      </button>
    </header>

    <div class="min-h-0 min-w-0 flex-1">
      <AcpChatPane
        chrome={{ header: "none", frame: "plain" }}
        readOnlyPreview
        activeConversationId={conversationId}
        onNewConversation={() => null}
        onAddProject={() => {}}
        onShowAgentSettings={() => {}}
      />
    </div>
  </div>
</div>
