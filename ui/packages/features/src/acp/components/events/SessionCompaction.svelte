<script lang="ts">
  import type { SessionCompaction } from "../../types";
  import ContentRenderer from "../content/ContentRenderer.svelte";
  import TranscriptFold from "./TranscriptFold.svelte";

  let { event }: { event: SessionCompaction } = $props();

  const label = $derived(
    event.status === "failed"
      ? "Context compaction failed"
      : event.status === "cancelled"
        ? "Context compaction cancelled"
        : event.status === "completed"
          ? "Context compacted"
          : "Context compaction",
  );
  const hasSummary = $derived(
    event.summary.some((block) =>
      block.type === "text"
        ? block.text.trim().length > 0
        : block.type === "image" || block.type === "resource" || block.type === "resource_link",
    ),
  );
  const error = $derived(event.error?.trim());
</script>

{#snippet summaryBody()}
  <div class="flex w-full min-w-0 flex-col gap-2">
    {#if error}
      <p>{error}</p>
    {/if}
    <ContentRenderer content={event.summary} />
  </div>
{/snippet}

{#if event.status !== "in_progress"}
  <div data-session-compaction>
    <TranscriptFold {label} children={hasSummary || error ? summaryBody : undefined} />
  </div>
{/if}
