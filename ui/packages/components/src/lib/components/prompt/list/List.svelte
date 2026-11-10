<script lang="ts">
  import { getItems, getMenus, getPrompt } from "../context/prompt.js";
  import { onMount, type Snippet } from "svelte";
  import { createList } from "../context/list.js";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "@camber/tailwind-config/tv";
  import { childrenObserver } from "../../../attachments/childrenObserver.js";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    children?: Snippet;
  }

  let { class: className, children }: Props = $props();

  const {
    elements: { listId, listEl },
  } = getPrompt();

  createList();

  const { search } = getMenus();
  const { selectFirst, selected, filtered } = getItems();

  // While filtering, sections flatten to `display: contents` and items carry a
  // score-based `order`, so the list becomes the flex container that ranks
  // every match by strength regardless of its section.
  let flattened = $derived(Boolean($filtered));

  onMount(() => {
    selectFirst();
  });

  // const sort: Attachment = (node) => {
  //   let sections = $filtered?.sections;
  //   if (!sections) return;

  //   const fragment = document.createDocumentFragment();

  //   for (const [id, itemIds] of sections) {
  //     const section = document.getElementById(id);
  //     const group = section?.querySelector('[role="group"]');
  //     if (!section || !group) continue;

  //     const items = document.createDocumentFragment();

  //     for (const itemId of itemIds) {
  //       const item = document.getElementById(itemId);
  //       if (!item) continue;

  //       if (item.previousElementSibling?.role === "separator") {
  //         items.appendChild(item.previousElementSibling);
  //       }

  //       if (!item.ariaDisabled) {
  //         items.appendChild(item);
  //       }
  //     }

  //     group.appendChild(items);

  //     if (section.previousElementSibling?.role === "separator") {
  //       fragment.appendChild(section.previousElementSibling);
  //     }

  //     fragment.appendChild(section);
  //   }

  //   node.appendChild(fragment);
  // };

  let previousSearch = $state($search);

  function handleSelection() {
    if (!$selected || !document.getElementById($selected) || previousSearch !== $search) {
      previousSearch = $search;
      selectFirst();
    }
  }
</script>

<div
  data-prompt-list
  class={cn(["overflow-y-auto", flattened && "flex flex-col", className])}
  bind:this={$listEl}
  role="listbox"
  aria-label="Suggestions"
  id={listId}
  {@attach childrenObserver({
    subtree: true,
    filter: (element) => element.hasAttribute("data-prompt-item"),
    onRemoveAll: handleSelection,
    onAddAll: handleSelection,
  })}
>
  <!-- {@attach sort} -->
  {@render children?.()}
</div>

<style lang="postcss">
  @reference "#tailwind.css";
  :global(body:not(.web-app)) div {
    &:has(:global([data-prompt-item])) {
      @apply scroll-p-1 p-1;
    }

    :global([role="separator"]) {
      @apply my-1;
    }
  }

  :global(body.web-app) div {
    &:has(:global([data-prompt-item])) {
      @apply scroll-p-3 p-3;
    }

    :global([role="separator"]) {
      @apply my-1;
    }
  }
</style>
