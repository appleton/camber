<script lang="ts" module>
  export type ContentProps = {
    search?: string;
    onSearch?: (search: string) => void;
  };
</script>

<script lang="ts">
  import { fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import type { ClassValue, KeyboardEventHandler } from "svelte/elements";
  import { getPrompt, getMenus, getItems } from "../context/prompt.js";
  import { closeMatch } from "../../editor/plugins/matchDecoration.js";
  import { type Snippet } from "svelte";
  import { floating } from "../../../actions/floating.js";
  import { getDisplay } from "../../../providers/index.js";

  interface Props extends ContentProps {
    children?: Snippet;
    class?: ClassValue;
    debounce?: boolean;
  }

  let {
    search = $bindable(),
    onSearch,
    children,
    class: className,
    debounce = true,
    ...rest
  }: Props = $props();

  const {
    editor,
    elements: { rootEl, contentEl },
  } = getPrompt();

  const { close, search: searchValue } = getMenus();

  const { customUI } = getDisplay();
  const { selectedAction, selectNext, selectFirst, selectLast, selectPrevious } = getItems();

  $effect(() => {
    search = $searchValue;
  });

  $effect(() => {
    const searchText = $searchValue;
    if (searchText !== undefined) {
      if (debounce) {
        const timer = setTimeout(() => onSearch?.(searchText), 150);
        return () => clearTimeout(timer);
      } else {
        onSearch?.(searchText);
      }
    }
  });

  const keydown: KeyboardEventHandler<Document> = async (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (e.metaKey) {
          selectLast();
        }
        // TODO: select first of next section
        // else if (e.altKey)
        else {
          selectNext();
        }
        break;

      case "ArrowUp":
        e.preventDefault();
        if (e.metaKey) {
          selectFirst();
        }
        // TODO: select first of previous section
        // else if (e.altKey)
        else {
          selectPrevious();
        }
        break;

      case "Home":
        e.preventDefault();
        selectFirst();
        break;

      case "End":
        e.preventDefault();
        selectLast();
        break;

      case "Tab":
        if (e.shiftKey) break;
      // fallthrough
      case "Enter":
        e.preventDefault();
        if ($selectedAction) {
          $selectedAction.onAction?.(e);
        } else {
          $editor?.executeCommand((state, dispatch) => {
            dispatch?.(closeMatch(state.tr));
            return true;
          });
          close();
        }
        break;
    }
  };

  function interactOutside(e: PointerEvent | FocusEvent) {
    if (e.target instanceof Element && e.target.closest("[data-prompt-trigger]")) {
      return;
    }

    $editor?.executeCommand((state, dispatch) => {
      const { tr } = state;
      dispatch?.(closeMatch(tr));
      return true;
    });
    close();
  }
</script>

<svelte:document onkeydown={keydown} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  in:fade={{ duration: customUI ? 80 : 0, easing: cubicOut }}
  out:fade={{ duration: customUI ? 60 : 0, easing: cubicOut }}
  {...rest}
  class={[
    className,
    "menu prompt-menu-surface isolate flex max-h-[min(var(--floating-available-height),50svh)] w-full flex-col overflow-hidden shadow-lg select-none",
  ]}
  tabindex={-1}
  bind:this={$contentEl}
  use:floating={{
    anchor: $rootEl,
    onPointerDownOutside: interactOutside,
    onFocusOutside: interactOutside,
  }}
>
  {@render children?.()}
</div>

<style lang="postcss">
  @reference "#tailwind.css";
  :global(body:not(.web-app)) div {
    @apply rounded-[10px] outline-1 outline-black/5 dark:outline-white/30;
    background-color: var(--psx-prompt-menu-background, var(--psx-panel));
  }

  :global(body.web-app) .menu {
    @apply rounded-3xl outline-1 outline-black/10 backdrop-blur-md dark:outline-white/10;
    &::after {
      @apply absolute inset-0 -z-10 rounded-[inherit] bg-(--color-mono-100) opacity-40;
      content: "";
    }
  }
</style>
