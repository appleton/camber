# @camber/splits

Svelte split-pane tabs for JavaScript and Svelte.

## Usage

```svelte
<script lang="ts">
  import { SplitsController, SplitsView } from "@camber/splits";

  const controller = new SplitsController();

  $effect(() => {
    controller.createTab("Notes.md", { icon: "doc.text" });
  });
</script>

<SplitsView {controller}>
  {#snippet children(tab, paneId)}
    <section>
      <h2>{tab.title}</h2>
      <p>Pane {paneId}</p>
    </section>
  {/snippet}
</SplitsView>
```

## Controller

```ts
const controller = new SplitsController({
  newTabPosition: "current",
  contentViewLifecycle: "keepAllAlive",
});

const paneId = controller.splitPane({
  orientation: "horizontal",
  withTab: { title: "main.ts" },
});

controller.splitPane("vertical"); // Creates an Untitled tab in the new pane.
controller.toggleZoom();
```

Splitting a pane creates a new tab by default. When the last tab in a split pane
is closed, the pane is closed too. Pass `withTab: false` only when an explicitly
empty split pane is required.

The controller implements Svelte's store contract, so it can be subscribed to
directly when a consumer needs raw layout state.
