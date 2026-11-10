<script lang="ts" module>
  type InternalBadgeVariants = VariantProps<typeof badge>;
  export type BadgeVariants = Except<InternalBadgeVariants, "iconOnly">;
  export type BadgeProps = BadgeVariants &
    WithChild<"span", BadgeVariants> & {
      prominence?: Prominence;
      size?: Size;
    };

  export const badge = tv({
    base: [
      "inline-flex items-center justify-center",
      "bleed-y py-[calc((var(--tw-min-h)-var(--tw-line-height))/2)]",
      "gap-1 text-auto ui-xs:min-h-4 ui-sm:min-h-5 ui-md:min-h-6 ui-md:gap-1.5 ui-lg:min-h-7",
      "ui-increased:text-psx-foreground-primary",
    ],
    variants: {
      iconOnly: {
        true: "aspect-square",
        false: "px-1 ui-md:px-1.5",
      },
      intent: {
        emphasis: "bg-(--psx-brand)/15 text-(--psx-brand)",
        warning: "bg-psx-warning-badge/15 text-psx-warning-foreground",
        positive:
          "bg-psx-diff-insert text-psx-diff-insert-foreground ui-standard:text-psx-diff-insert-foreground",
        neutral: "bg-psx-chrome text-psx-foreground-secondary",
        critical:
          "bg-psx-diff-delete text-psx-diff-delete-foreground ui-standard:text-psx-diff-delete-foreground",
        info: "bg-blue-500/10 text-blue-400",
      },
      radius: {
        none: "rounded-none",
        default: "rounded",
        auto: "rounded-auto",
        full: "rounded-full",
      },
    },
  });
</script>

<script lang="ts">
  import { mergeProps } from "bits-ui";
  import type { WithChild } from "../../types/child.js";
  import { createAttachmentKey, type Attachment } from "svelte/attachments";
  import type { Except } from "type-fest";
  import { type VariantProps, tv, cn } from "@camber/tailwind-config/tv";
  import type { Prominence } from "../../utils/prominence.js";
  import type { Size } from "../../utils/size.js";

  let {
    prominence,
    intent = "info",
    size,
    radius = "default",
    children,
    child,
    ...rest
  }: BadgeProps = $props();

  const key = createAttachmentKey();

  let iconOnly = $state(false);

  let variants = $derived({
    intent,
    radius,
    iconOnly,
  } satisfies InternalBadgeVariants);

  const attachment: Attachment = (element) => {
    function setIconOnly() {
      const textContent = element.textContent.trim();
      iconOnly =
        (element.children.length > 0 && textContent === "") ||
        (element.children.length === 0 && textContent.length === 1);
    }

    setIconOnly();

    const observer = new MutationObserver((mutations) => {
      const hasTextChange = mutations.some(
        (mutation) => mutation.type === "characterData" || mutation.type === "childList",
      );

      if (hasTextChange) {
        setIconOnly();
      }
    });

    observer.observe(element, {
      childList: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
    };
  };

  let mergedProps = $derived(
    mergeProps(rest, {
      [key]: attachment,
      "data-size": size,
      "data-prominence": prominence,
      class: badge({ ...variants, class: cn(rest.class) }),
    }),
  );
</script>

{#if child}
  {@render child({
    props: mergedProps,
    ...variants,
  })}
{:else}
  <span {...mergedProps}>
    {@render children?.()}
  </span>
{/if}
