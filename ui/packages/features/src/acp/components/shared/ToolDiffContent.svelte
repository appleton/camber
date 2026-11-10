<script lang="ts">
  import { onMount } from "svelte";
  import { PatchDiff } from "@camber/components/file-diff";
  import Icon from "@camber/components/icon";
  import type { ToolCallDiffContent } from "../../types";
  import Tooltip from "../ui/Tooltip.svelte";
  import CopyToClipboard from "../ui/CopyToClipboard.svelte";
  import { diffLayoutPreference } from "./diffLayoutPreference.svelte";

  interface Props {
    diff: ToolCallDiffContent;
  }

  const DEFER_DIFF_CHARACTERS = 20_000;

  let { diff }: Props = $props();
  const newContent = $derived(diff.newText);
  const shouldDefer = (diff.oldText?.length ?? 0) + diff.newText.length > DEFER_DIFF_CHARACTERS;
  let renderDiff = $state(!shouldDefer);

  // Let the disclosure's lightweight shell paint before Pierre parses,
  // highlights, and lays out the diff. A short timer fallback covers hidden or
  // occluded webviews where requestAnimationFrame may be suspended.
  onMount(() => {
    if (!shouldDefer) return;

    let frame: number | undefined;
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const showDiff = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (renderTimer !== undefined) clearTimeout(renderTimer);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      frame = undefined;
      renderTimer = undefined;
      fallbackTimer = undefined;
      renderDiff = true;
    };

    if (typeof requestAnimationFrame === "undefined") {
      renderTimer = setTimeout(showDiff, 0);
    } else {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        renderTimer = setTimeout(showDiff, 0);
      });
      fallbackTimer = setTimeout(showDiff, 100);
    }

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (renderTimer !== undefined) clearTimeout(renderTimer);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    };
  });
</script>

<!-- Rendered with the shared pierre-based PatchDiff (same renderer as the
     desktop Diff tab) so diffs look identical everywhere in the app. The
     surrounding ToolRoot Diff context still carries the header stats. -->
<div class="relative max-w-full">
  {#if renderDiff}
    <PatchDiff
      oldFile={{ name: diff.path, contents: diff.oldText ?? "" }}
      newFile={{ name: diff.path, contents: diff.newText }}
      layout={diffLayoutPreference.current}
      disableFileHeader
      compact
    />
  {:else}
    <div class="text-psx-foreground-secondary flex min-h-8 items-center px-3 text-xs" role="status">
      Preparing diff…
    </div>
  {/if}
  <div class="absolute right-3 top-3 flex items-center gap-1">
    <Tooltip placement="top" gutter={8}>
      {#snippet label()}{diffLayoutPreference.current === "split"
          ? "Unified view"
          : "Side-by-side view"}{/snippet}
      <button
        type="button"
        class="text-psx-icon hover:bg-psx-menu-hover-background flex h-6 w-6 items-center justify-center rounded-md"
        aria-pressed={diffLayoutPreference.current === "split"}
        aria-label={diffLayoutPreference.current === "split"
          ? "Switch to unified diff view"
          : "Switch to side-by-side diff view"}
        onclick={() => diffLayoutPreference.toggle()}
      >
        <Icon name="compare" size={14} />
      </button>
    </Tooltip>
    <CopyToClipboard text={newContent} />
  </div>
</div>
