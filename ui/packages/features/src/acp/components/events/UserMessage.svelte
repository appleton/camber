<script lang="ts">
  import type { UserMessage as UserMessageEvent } from "../../types";
  import UserMessageBubble from "../ui/UserMessageBubble.svelte";
  import UserMessageContext from "./UserMessageContext.svelte";
  import Tooltip from "../ui/Tooltip.svelte";
  import Icon from "@camber/components/icon";
  import ContentRenderer from "../content/ContentRenderer.svelte";
  import { CopyToClipboard } from "../ui";

  interface Props {
    event: UserMessageEvent;
  }

  let { event }: Props = $props();

  let textContent = $derived(
    event.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join(""),
  );

  let contextBlocks = $derived(
    event.content.filter((b) => b.type === "resource" || b.type === "resource_link"),
  );
  let hasContext = $derived(contextBlocks.length > 0);
  let contextVisible = $state(false);

  const actionClass =
    "border-psx-border bg-psx-panel text-psx-icon hover:bg-psx-chrome-hover active:bg-psx-chrome-active flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-psx-focus";
</script>

<div
  data-user-message
  data-steer-message={event.steer ? "" : undefined}
  class="group/message relative flex flex-col items-end"
>
  <UserMessageBubble variant={event.steer ? "steer" : "default"}>
    <ContentRenderer content={event.content} isUser />
  </UserMessageBubble>

  {#if textContent || hasContext}
    <div class="flex -translate-y-2 justify-end">
      <div
        class="flex gap-1 opacity-0 transition-[opacity,transform] duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100"
      >
        {#if hasContext}
          <Tooltip placement="top" gutter={8}>
            {#snippet label()}
              {contextVisible ? "Hide context attachments" : "Show context attachments"}
            {/snippet}
            <button
              type="button"
              class={actionClass}
              aria-label="Toggle context attachments"
              aria-pressed={contextVisible}
              onclick={() => (contextVisible = !contextVisible)}
            >
              <Icon aria-hidden="true" name="email" size={14} />
            </button>
          </Tooltip>
        {/if}

        {#if textContent}
          <CopyToClipboard text={textContent} />
        {/if}
      </div>
    </div>
  {/if}

  {#if hasContext && contextVisible}
    <UserMessageContext blocks={contextBlocks} />
  {/if}
</div>
