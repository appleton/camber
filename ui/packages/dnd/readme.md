# @camber/dnd

Framework-agnostic drag-and-drop primitives built on **pointer events** (not
the native HTML5 drag-and-drop API).

Currently provides a **reorderable list**: vertical or horizontal, with
pointer-driven "closest edge" detection that stays predictable even when rows
have very different heights (the insertion point follows the pointer, not the
geometry of the dragged element).

Pointer events (rather than native HTML5 DnD) are deliberate: native DnD does
not reliably start a drag from a `<button>` handle, leaves an uncontrollable
drag image / falls back to dragging the text selection, and is flaky inside
Electron. The pointer implementation avoids all of that, shows a drop indicator
instead of a ghost, and is testable with simulated mouse input.

## Reorderable list

Mark the container, the items, and (optionally) a drag handle, then wire the
`reorderable` Svelte action — or call `createReorderable` directly in any
framework.

```svelte
<script lang="ts">
  import { reorderable, moveItem, type ReorderDropTarget } from "@camber/dnd";

  let items = $state([
    { id: "one", label: "One" },
    { id: "two", label: "Two" },
  ]);
  let dropTarget = $state<ReorderDropTarget | null>(null);

  function onReorder(from: number, to: number) {
    items = moveItem(items, from, to);
  }
</script>

<div
  use:reorderable={{
    handleSelector: "[data-reorderable-handle]",
    onReorder,
    onTargetChange: (t) => (dropTarget = t),
  }}
>
  {#each items as item (item.id)}
    <div data-reorderable-item>
      <button data-reorderable-handle>⠿</button>
      {item.label}
    </div>
  {/each}
</div>
```

- Omit `handleSelector` to make the whole item draggable.
- `onReorder(from, to)` uses splice/"move" semantics — apply it with `moveItem`.
- During a drag the zone sets `data-reorderable-dragging` on the dragged item
  and `data-reorderable-over="before|after"` on the drop target, so indicators
  can be pure CSS if you prefer not to use `onTargetChange`.
- Items are read live from the DOM on each pointer move, so
  reordering/adding/removing needs no re-registration.
- An item belongs to its nearest enclosing `data-reorderable-zone`, so zones can
  be nested (e.g. a worktree list inside a project row) without interfering.
- `reorderLayoutOffsets(itemRects, from, to)` projects the reordered list into
  the captured start geometry. Apply its offsets to inner content wrappers
  while the outer items stay in flow to animate a full-size gap at the target
  without moving the hit-test rectangles.

## Non-Svelte usage

```ts
import { createReorderable } from "@camber/dnd";

const handle = createReorderable(containerEl, { onReorder });
// ...later
handle.destroy();
```

The pure helpers (`projectDropTarget`, `resolveMoveTarget`, `moveItem`,
`edgeForPointer`) are exported for testing and custom integrations.
