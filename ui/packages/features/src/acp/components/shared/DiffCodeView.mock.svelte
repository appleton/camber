<script lang="ts" module>
  import { vi } from "vitest";

  /** Spies shared with tests; cleared via vi.clearAllMocks(). */
  export const diffCodeViewMock = {
    scrollToItem: vi.fn(),
    scrollToTop: vi.fn(),
  };
</script>

<script lang="ts">
  // Test stand-in for @camber/components/file-diff DiffCodeView: jsdom
  // cannot host @pierre/diffs' shadow-DOM CodeView, so render each item's
  // patch as text (plus its custom header) so assertions can see content,
  // order, and collapse state.
  interface MockItem {
    id: string;
    patch: string;
    collapsed?: boolean;
    version: number;
    oldFile?: { name: string; contents: string };
    newFile?: { name: string; contents: string };
  }

  interface Props {
    items: MockItem[];
    renderCustomHeader?: (fileDiff: { name: string }) => Element | null | undefined;
    [key: string]: unknown;
  }

  let { items, renderCustomHeader = undefined }: Props = $props();

  export function scrollToItem(id: string, behavior?: string): void {
    diffCodeViewMock.scrollToItem(id, behavior);
  }

  export function scrollToTop(): void {
    diffCodeViewMock.scrollToTop();
  }

  // Attach the real header element (a live mounted component in production
  // code) so reactivity and event handlers survive, mirroring how pierre
  // slots the returned element into its shadow header row.
  function attachHeader(target: HTMLElement, item: MockItem): void {
    const element = renderCustomHeader?.({ name: item.id });
    target.replaceChildren();
    if (element instanceof Element) target.appendChild(element);
  }
</script>

<div data-testid="diff-code-view-mock">
  {#each items as item (item.id)}
    <div
      data-testid="diff-item"
      data-item-id={item.id}
      data-collapsed={item.collapsed ? "true" : "false"}
      data-version={item.version}
      data-enriched={item.oldFile && item.newFile ? "true" : "false"}
    >
      <div data-testid="diff-item-header" {@attach (node) => attachHeader(node, item)}></div>
      <pre data-testid="diff-item-patch">{item.patch}</pre>
    </div>
  {/each}
</div>
