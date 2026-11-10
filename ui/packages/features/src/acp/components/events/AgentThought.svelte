<script lang="ts">
  import type { ContentBlock } from "@agentclientprotocol/sdk";
  import Icon from "@camber/components/icon";
  import { onDestroy } from "svelte";
  import type { AgentThought as AgentThoughtEvent } from "../../types";
  import ChatProgress from "../ui/ChatProgress.svelte";
  import ContentRenderer from "../content/ContentRenderer.svelte";

  interface Props {
    event: AgentThoughtEvent;
    complete: boolean;
    onExpandedChange?: (expanded: boolean) => void;
  }

  let { event, complete, onExpandedChange }: Props = $props();

  // Markdown height can change on nearly every streamed token, which makes a
  // constrained scrollbar constantly resize. Keep collapsed content current,
  // but commit expanded streaming content at a calmer visual cadence.
  const STREAMING_RENDER_INTERVAL_MS = 100;
  let expanded = $state(false);
  let incomingContent = $derived.by(() => snapshotContent(event.content));
  let renderedContent = $state.raw<ContentBlock[]>(snapshotContent(event.content));
  let latestContent = snapshotContent(event.content);
  let renderTimer: ReturnType<typeof setTimeout> | undefined;

  function snapshotContent(content: ContentBlock[]): ContentBlock[] {
    // TurnMaterializer mutates its content array in place. Copy the array and
    // streamed text blocks so the rendered snapshot cannot change underneath
    // the cadence timer.
    return content.map((block) => (block.type === "text" ? { ...block } : block));
  }

  function cancelScheduledRender() {
    clearTimeout(renderTimer);
    renderTimer = undefined;
  }

  function flushLatestContent() {
    cancelScheduledRender();
    renderedContent = latestContent;
  }

  function scheduleRender() {
    if (renderTimer !== undefined) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      renderedContent = latestContent;
    }, STREAMING_RENDER_INTERVAL_MS);
  }

  function handleExpandedChange(nextExpanded: boolean) {
    expanded = nextExpanded;
    if (!nextExpanded) flushLatestContent();
    onExpandedChange?.(nextExpanded);
  }

  $effect(() => {
    latestContent = incomingContent;
    if (renderedContent === latestContent) return;

    if (!expanded || complete) {
      flushLatestContent();
    } else {
      scheduleRender();
    }
  });

  onDestroy(cancelScheduledRender);
</script>

<ChatProgress {complete} onExpandedChange={handleExpandedChange}>
  {#if event.truncated}
    <div class="text-psx-foreground-secondary mb-2 flex items-start gap-1.5 text-xs/[17px]">
      <Icon name="info" size={12} class="text-psx-icon" />
      <span>
        <span class="text-psx-foreground-primary font-medium">Truncated:</span>
        long thought traces are not rendered for performance reasons.
      </span>
    </div>
  {/if}
  <ContentRenderer content={renderedContent} streaming={!complete} />
</ChatProgress>
