<script lang="ts">
  import { createSection } from "../context/section.js";
  import { generateId } from "@camber/lib/string";
  import { getItems } from "../context/prompt.js";
  import type { Snippet } from "svelte";
  import type { Except } from "type-fest";
  import type { Attachment } from "svelte/attachments";

  export interface SectionProps {
    title?: string;
    value?: string;
    alwaysRender?: boolean;
  }

  interface Props extends Except<SectionProps, "title"> {
    title?: SectionProps["title"] | Snippet;
    children?: Snippet;
  }

  let { title, value = $bindable(), alwaysRender, children }: Props = $props();

  const section = createSection({
    title: typeof title === "function" ? undefined : title,
    value,
    alwaysRender,
  });

  const { filtered } = getItems();
  const headingId = generateId();

  let shouldRender = $derived(alwaysRender || ($filtered?.sections.has(section.id) ?? true));

  /**
   * We use `hidden` instead of conditionally rendering because we want to maintain the
   * original list order when clearing the prompt.
   */
  let hidden = $derived(shouldRender ? undefined : true);

  // While filtering, sections flatten away (`display: contents`) and their
  // titles hide, so items from every section rank in one list ordered purely
  // by match strength (see the `order` style in Item).
  let flattened = $derived(Boolean($filtered) && shouldRender);

  const attachment: Attachment = (node) => {
    value = (value || section.title || node.textContent)?.trim().toLowerCase();

    if (!value) return;

    // TODO: update context value
    node.setAttribute("data-value", value);
  };
</script>

<section
  {@attach attachment}
  id={section.id}
  role="presentation"
  {hidden}
  class={flattened ? "contents" : undefined}
>
  {#if title}
    <header
      class="px-1.5 text-sm leading-tight text-psx-foreground-secondary"
      aria-hidden="true"
      id={headingId}
      hidden={flattened ? true : undefined}
    >
      {#if typeof title === "function"}
        {@render title()}
      {:else}
        {title}
      {/if}
    </header>
  {/if}

  <div role="group" aria-labelledby={headingId} class={flattened ? "contents" : undefined}>
    {@render children?.()}
  </div>
</section>

<style lang="postcss">
  @reference "#tailwind.css";
  :global(body:not(.web-app)) header {
    @apply py-1 font-medium;
  }

  :global(body.web-app) header {
    @apply py-1.5 font-normal text-(--color-mono-700);
  }
</style>
