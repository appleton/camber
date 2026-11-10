<script lang="ts">
  import type { PaneID, Tab } from "../types.js";

  interface Props {
    tab: Tab;
    paneId: PaneID;
    mode?: "editor" | "preview" | "terminal";
  }

  let { tab, paneId, mode = "editor" }: Props = $props();

  let edits = $state(0);

  const fileKind = $derived.by(() => {
    if (tab.title.endsWith(".svelte")) return "Svelte component";
    if (tab.title.endsWith(".ts")) return "TypeScript";
    if (tab.title.endsWith(".md")) return "Markdown";
    if (tab.title.endsWith(".json")) return "JSON";
    return mode === "terminal" ? "Shell" : "Document";
  });

  const sampleText = $derived.by(() => {
    if (mode === "terminal") {
      return [
        "$ pnpm -F @camber/splits storybook",
        "Storybook 10.0.7",
        "Local: http://localhost:6009",
      ].join("\n");
    }

    if (mode === "preview") {
      return [
        "# Preview",
        "",
        "This tab is rendered in a separate pane. Drag tabs between panes or use the split buttons in each tab bar.",
      ].join("\n");
    }

    return [
      `<script lang="ts">`,
      `  export let title = ${JSON.stringify(tab.title)};`,
      `</scr` + `ipt>`,
      "",
      `<section class="document">`,
      `  <h1>{title}</h1>`,
      `</section>`,
    ].join("\n");
  });
</script>

<article class="sample-content" data-mode={mode}>
  <header>
    <div>
      <strong>{tab.title}</strong>
      <span>{fileKind} · pane {paneId.slice(0, 8)}</span>
    </div>
    <button type="button" onclick={() => (edits += 1)}>Local edits {edits}</button>
  </header>

  <pre>{sampleText}</pre>
</article>

<style>
  .sample-content {
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    background: var(--splits-pane-background);
    color: var(--splits-foreground);
    font:
      13px/1.45 system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--splits-separator);
    padding: 12px 14px;
  }

  header div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  strong,
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    color: var(--splits-muted-foreground);
    font-size: 12px;
  }

  button {
    flex: 0 0 auto;
    border: 1px solid var(--splits-separator);
    border-radius: 5px;
    padding: 5px 9px;
    background: color-mix(in srgb, var(--splits-foreground) 3%, var(--splits-pane-background));
    color: inherit;
    font: inherit;
  }

  button:hover {
    background: var(--splits-tab-hover-background);
  }

  pre {
    margin: 0;
    min-height: 0;
    flex: 1;
    overflow: auto;
    padding: 16px;
    color: var(--splits-foreground);
    font:
      12px/1.6 "Jetbrains Mono",
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    tab-size: 2;
    white-space: pre-wrap;
  }

  [data-mode="terminal"] pre {
    background: color-mix(in srgb, black 82%, var(--splits-pane-background));
    color: rgb(134, 239, 172);
  }
</style>
