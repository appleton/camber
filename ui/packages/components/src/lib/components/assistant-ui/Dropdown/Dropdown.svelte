<script lang="ts">
  import { createDropdownMenu, melt } from "@melt-ui/svelte";
  import Icon, { type IconName } from "../../icon/index.js";
  import { tick } from "svelte";
  import { setContext, untrack, type Snippet } from "svelte";

  interface Props {
    icon: IconName;
    iconClass?: string;
    label: string;
    placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
    searchable?: boolean;
    searchPlaceholder?: string;
    disableFocusFirstItem?: boolean;
    /** Roomier menu, for lists whose items carry a description line. */
    wide?: boolean;
    header?: Snippet;
    // Children receive the live search query so list owners can filter AND
    // rank their items by match quality (items also self-filter as a fallback).
    children?: Snippet<[{ query: string }]>;
    // Optional custom trigger: when provided, it replaces the default pill
    // button contents. The melt trigger wiring stays on the button, so callers
    // only supply the visual (inline coloured text, signal bars, a bare icon…)
    // and receive the open state for active styling.
    trigger?: Snippet<[{ open: boolean }]>;
    triggerClass?: string;
    triggerLabel?: string;
    menuClass?: string;
  }

  let {
    icon,
    iconClass,
    label,
    placement = "bottom-start",
    searchable = false,
    searchPlaceholder = "Search...",
    disableFocusFirstItem = false,
    wide = false,
    header,
    children,
    trigger,
    triggerClass,
    triggerLabel,
    menuClass,
  }: Props = $props();

  const menu = createDropdownMenu({
    positioning: { placement: untrack(() => placement) },
    forceVisible: true,
    typeahead: untrack(() => !searchable),
    disableFocusFirstItem: untrack(() => searchable || disableFocusFirstItem),
  });

  const {
    elements: { trigger: triggerEl, menu: menuEl },
    states: { open },
  } = menu;

  let searchQuery = $state("");
  let visibleItemCount = $state(0);
  let menuRef: HTMLDivElement | undefined = $state();
  let searchInputRef: HTMLInputElement | undefined = $state();
  let suppressInitialItemFocus = false;
  const trimmedSearchQuery = $derived(searchQuery.trim());
  const showEmptySearchResults = $derived(
    searchable && trimmedSearchQuery.length > 0 && visibleItemCount === 0,
  );

  $effect(() => {
    if (!$open) {
      searchQuery = "";
      return;
    }
    if (searchable && searchInputRef) {
      requestAnimationFrame(() => searchInputRef?.focus());
    }
  });

  $effect(() => {
    if (!$open || !disableFocusFirstItem) {
      suppressInitialItemFocus = false;
      return;
    }

    suppressInitialItemFocus = true;
    const timeout = window.setTimeout(() => {
      suppressInitialItemFocus = false;
    }, 50);
    return () => window.clearTimeout(timeout);
  });

  $effect(() => {
    searchQuery;
    children;
    tick().then(() => {
      visibleItemCount = menuRef?.querySelectorAll<HTMLElement>('[role="menuitem"]').length ?? 0;
    });
  });

  // Enter selects the top of the (relevance-sorted) list.
  function handleSearchEnter() {
    if (!menuRef) return;
    const visibleItems = menuRef.querySelectorAll<HTMLElement>('[role="menuitem"]');
    visibleItems[0]?.click();
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      handleSearchEnter();
      return;
    }
    if (["Escape", "ArrowDown", "ArrowUp", "Tab"].includes(e.key)) return;
    if (e.metaKey || e.ctrlKey) return;
    e.stopPropagation();
  }

  // Melt moves focus to the menu/items after open, so the search input rarely
  // holds focus when the user starts typing. Route printable keys typed
  // anywhere in the menu into the search box instead of letting them get lost.
  function routeMenuKeydown(e: KeyboardEvent) {
    if (!searchable || !searchInputRef || e.target === searchInputRef) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Backspace") {
      searchQuery = searchQuery.slice(0, -1);
      searchInputRef.focus();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key.length !== 1) return;
    searchQuery += e.key;
    searchInputRef.focus();
    e.preventDefault();
    e.stopPropagation();
  }

  function handleMenuFocusIn(event: FocusEvent) {
    if (!suppressInitialItemFocus || event.target === menuRef) return;
    suppressInitialItemFocus = false;
    menuRef?.focus({ preventScroll: true });
  }

  setContext("dropdown", menu);
  setContext("dropdown-search", {
    get query() {
      return searchQuery;
    },
  });
</script>

{#if trigger}
  <button
    type="button"
    use:melt={$triggerEl}
    aria-label={triggerLabel ?? label}
    class={triggerClass ??
      "flex max-w-full min-w-0 items-center rounded-md focus:outline-psx-focus focus-visible:outline-2 active:outline-0"}
  >
    {@render trigger({ open: $open })}
  </button>
{:else}
  <button
    type="button"
    use:melt={$triggerEl}
    class="relative flex max-w-full min-w-0 items-center gap-0.5 truncate rounded-xl py-1 pr-1 pl-2 text-sm text-psx-foreground-secondary shadow-low transition-all focus:outline-psx-focus focus-visible:outline-2 active:outline-0 dark:shadow-low-dark {$open
      ? 'bg-psx-chrome-active/50'
      : 'bg-psx-chrome'}"
  >
    <Icon name={icon} size={14} class={["shrink-0", iconClass]} aria-hidden="true" />
    <span class="truncate">{label}</span>
    <Icon name="chevron" aria-hidden="true" />
  </button>
{/if}

{#if $open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={menuRef}
    use:melt={$menuEl}
    onfocusin={handleMenuFocusIn}
    onkeydowncapture={routeMenuKeydown}
    class={[
      "z-50 max-h-[300px] max-w-[calc(100vw-2rem)] overflow-y-auto menu-surface p-1",
      wide ? "w-[450px]" : "w-[300px]",
      disableFocusFirstItem && "focus:outline-none",
      menuClass,
    ]}
  >
    {#if header || searchable}
      <div class="mb-1 pb-1">
        {#if header}
          <div class="flex items-center gap-1 px-1 py-1">
            {@render header()}
          </div>
        {/if}
        {#if searchable}
          <div class="px-0.5 pt-0.5">
            <!-- Options are identifiers (model ids, mode names), not prose.
                 autocorrect is separate from spellcheck in WebKit: without it
                 macOS rewrites a half-typed model name mid-search. -->
            <input
              bind:this={searchInputRef}
              type="text"
              bind:value={searchQuery}
              onkeydown={handleSearchKeydown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              spellcheck="false"
              autocorrect="off"
              autocapitalize="off"
              autocomplete="off"
              class="w-full rounded-md border border-psx-border bg-psx-editor-background px-2 py-1 text-sm text-psx-foreground-primary outline-none placeholder:text-psx-foreground-secondary/50 focus:border-psx-focus"
            />
          </div>
        {/if}
      </div>
    {/if}
    {@render children?.({ query: trimmedSearchQuery })}
    {#if showEmptySearchResults}
      <div class="flex items-center gap-2 px-2 pt-1 pb-2 text-psx-foreground-secondary">
        <Icon name="search" size={14} aria-hidden="true" />
        <span>No results found for {trimmedSearchQuery}</span>
      </div>
    {/if}
  </div>
{/if}
