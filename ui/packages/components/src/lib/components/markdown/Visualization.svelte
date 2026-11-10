<script lang="ts">
  import { get } from "svelte/store";
  import FileChip from "./FileChip.svelte";
  import type { MarkdownHostAdapter } from "./host.js";
  import { toAbsolutePosixPath } from "./paths.js";
  import {
    isLocalVisualizationPath,
    MAX_VISUALIZATION_BYTES,
    type VisualizationReference,
  } from "./visualization.js";
  import { buildVisualizationDocument } from "./visualizationDocument.js";

  let {
    reference,
    host,
    basePath,
  }: { reference: VisualizationReference; host: MarkdownHostAdapter; basePath?: string } = $props();
  let root = $state<HTMLDivElement>();
  let frame = $state<HTMLIFrameElement>();
  let documentSource = $state<string>();
  let error = $state<string>();
  let height = $state(240);
  let attempt = $state(0);
  const path = $derived(
    toAbsolutePosixPath(
      reference.path,
      basePath ? [{ path: basePath }] : get(host.state).workspaces,
    ),
  );
  const title = $derived(reference.title ?? reference.path.split(/[\\/]/).pop() ?? "Visualization");

  $effect(() => {
    attempt;
    const currentPath = path;
    const element = root;
    if (!element) return;
    let cancelled = false;
    documentSource = undefined;
    error = undefined;
    height = 240;
    async function load() {
      try {
        if (!isLocalVisualizationPath(currentPath))
          throw new Error("Invalid visualization file path.");
        if (!host.readVisualizationFile)
          throw new Error("Visualization previews are unavailable in this host.");
        const fragment = await host.readVisualizationFile(currentPath);
        if (cancelled) return;
        if (fragment === undefined) throw new Error("The visualization file could not be found.");
        if (new TextEncoder().encode(fragment).byteLength > MAX_VISUALIZATION_BYTES) {
          throw new Error("The visualization exceeds the 1 MB preview limit.");
        }
        const style = getComputedStyle(element!);
        documentSource = buildVisualizationDocument(
          fragment,
          style.color,
          style.getPropertyValue("--psx-panel").trim() || "Canvas",
        );
      } catch (cause) {
        if (!cancelled)
          error = cause instanceof Error ? cause.message : "Unable to load visualization.";
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  });

  function onMessage(event: MessageEvent) {
    if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (
      data?.type !== "camber:visualization-size" ||
      typeof data.height !== "number" ||
      !Number.isFinite(data.height)
    )
      return;
    height = Math.min(1600, Math.max(80, data.height));
  }
</script>

<svelte:window onmessage={onMessage} />

<div bind:this={root} class="visualization" data-mode={reference.mode}>
  <div class="flex items-center justify-between gap-2">
    <FileChip absolutePath={path} displayPath={title} {host} />
  </div>
  {#if error}
    <div role="status" class="text-psx-foreground-secondary">{error}</div>
    {#if host.readVisualizationFile}
      <button type="button" class="text-psx-link" onclick={() => (attempt += 1)}
        >Retry preview</button
      >
    {/if}
  {:else if documentSource !== undefined}
    <iframe
      bind:this={frame}
      {title}
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      srcdoc={documentSource}
      style:height="{height}px"
    ></iframe>
  {:else}
    <div role="status" class="text-psx-foreground-secondary">Loading visualization…</div>
  {/if}
</div>

<style>
  .visualization {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  iframe {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
  }
</style>
