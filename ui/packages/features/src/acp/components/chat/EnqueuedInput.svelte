<script lang="ts">
  import type { ContentBlock } from "@agentclientprotocol/sdk";
  import Icon from "@camber/components/icon";
  import ContentRenderer from "../content/ContentRenderer.svelte";
  import Tooltip from "../ui/Tooltip.svelte";
  import UserMessageBubble from "../ui/UserMessageBubble.svelte";

  interface Props {
    content: ContentBlock[];
    position?: number;
    total?: number;
    turnActive?: boolean;
    steeringAvailable?: boolean;
    onCancel?: () => void;
    onSendNow?: () => void;
    class?: string;
  }

  let {
    content,
    position = 1,
    total = 1,
    turnActive = true,
    steeringAvailable = false,
    onCancel,
    onSendNow,
    class: className = "",
  }: Props = $props();
</script>

<div class="flex flex-col items-end gap-2 overflow-hidden {className}">
  <UserMessageBubble variant="enqueued" nubbinPosition="bottom-right" collapsible>
    <ContentRenderer {content} isUser />
  </UserMessageBubble>

  <div class="flex items-center gap-2">
    <span class="text-psx-foreground-secondary text-[0.65rem]">
      {position === 1 && turnActive ? "Next after current turn" : `Queued ${position} of ${total}`}
    </span>
    <span class="bg-psx-foreground-secondary h-3 w-px"></span>
    <button type="button" class="send-now-button" onclick={onSendNow}>
      {turnActive ? (steeringAvailable ? "Steer" : "Interrupt & Send Now") : "Send Now"}
    </button>
    <Tooltip placement="top" gutter={4}>
      {#snippet label()}
        Cancel
      {/snippet}
      <button type="button" class="action-button" onclick={onCancel} aria-label="Cancel prompt">
        <Icon name="trash" size={14} />
      </button>
    </Tooltip>
  </div>
</div>

<style lang="postcss">
  @reference "#tailwind.css";

  .action-button {
    @apply text-psx-icon flex h-6 w-6 items-center justify-center rounded-full transition-colors;
    @apply hover:bg-black/10;
    @apply dark:hover:bg-white/10;
    @apply focus-visible:outline-psx-focus focus-visible:outline-2 focus-visible:outline-offset-1;
  }

  .send-now-button {
    @apply text-psx-foreground-secondary flex h-6 items-center rounded-full px-2 text-[0.65rem] font-medium transition-colors;
    @apply hover:text-psx-foreground-primary hover:bg-black/10;
    @apply dark:hover:bg-white/10;
    @apply focus-visible:outline-psx-focus focus-visible:outline-2 focus-visible:outline-offset-1;
  }
</style>
