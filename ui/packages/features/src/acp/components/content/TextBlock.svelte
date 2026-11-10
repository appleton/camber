<script lang="ts">
  import { MarkdownBlock } from "@camber/components/markdown";
  import type { TextContent } from "@agentclientprotocol/sdk";
  import { markdownHost } from "../../markdownHost";
  import { getOptionalACPChatSessionScope } from "../../features/ChatSessionScope.svelte";

  type Props = TextContent & {
    isUser?: boolean;
    allowVisualizations?: boolean;
    streaming?: boolean;
    scrollElement?: HTMLElement;
  };

  let {
    text,
    isUser = false,
    allowVisualizations = false,
    streaming = false,
    scrollElement,
  }: Props = $props();

  const chatSession = getOptionalACPChatSessionScope();
  let content = $derived(text.trim());
</script>

{#if content.length > 0}
  <MarkdownBlock
    {content}
    {isUser}
    {allowVisualizations}
    visualizationBasePath={chatSession?.activeWorkspaceCwd ?? undefined}
    {streaming}
    {scrollElement}
    host={markdownHost}
  />
{/if}
