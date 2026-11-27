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
        : "Context compacted",
  );
</script>

{#snippet summaryBody()}
  <div class="flex w-full min-w-0 flex-col gap-2">
    {#if event.error}
      <p>{event.error}</p>
    {/if}
    <ContentRenderer content={event.summary} />
  </div>
{/snippet}

{#if event.status !== "in_progress"}
  <div data-session-compaction>
    <TranscriptFold
      {label}
      children={event.summary.length || event.error ? summaryBody : undefined}
    />
  </div>
{/if}
