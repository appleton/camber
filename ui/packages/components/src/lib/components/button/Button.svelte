<script lang="ts" module>
  type InternalButtonVariants = VariantProps<typeof button>;
  export type ButtonVariants = Except<InternalButtonVariants, "iconOnly">;
  export type ButtonProps = ButtonVariants &
    WithChild<"button", ButtonVariants> & {
      prominence?: Prominence;
      size?: Size;
    };

  export const button = tv({
    base: [
      "inline-flex justify-center font-sans text-auto",
      "transition-colors empty:transition-none focus-visible:transition-none",
      "gap-1 ui-md:gap-1.5 ui-lg:gap-2",
      "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-psx-focus",
      "disabled:pointer-events-none disabled:opacity-50",
    ],
    variants: {
      appearance: {
        default: [
          "active:brightness-110 disabled:bg-psx-button-secondary-background",
          "ui-standard:bg-psx-button-secondary-background ui-standard:text-psx-button-secondary-foreground",
          "ui-standard:hover:bg-psx-button-secondary-hover-background ui-standard:active:bg-psx-button-secondary-background",
          "ui-increased:bg-psx-button-primary-background ui-increased:text-psx-button-primary-foreground ui-increased:hover:bg-psx-button-primary-hover-background",
          // No disabled foreground override: a disabled primary keeps its
          // accent fill, so swapping in the secondary (dark) foreground put
          // near-black text on it. `disabled:opacity-50` already reads as
          // disabled without recolouring the label.
        ],
        outline:
          "bg-psx-panel ring-1 ring-psx-border hover:bg-psx-chrome-hover focus-visible:outline-offset-2 active:bg-psx-chrome-active disabled:bg-transparent",
        ghost: [
          "relative bleed after:absolute after:inset-0", // bleed but maintain touch area
          "hover:bg-psx-chrome-hover active:bg-psx-chrome-active disabled:bg-transparent",
        ],
        link: "underline decoration-transparent underline-offset-2 hover:decoration-current",
        plain: "",
      },
      shape: {
        rectangle: "",
        square: "aspect-square",
      },
      radius: {
        none: "rounded-none",
        default: "rounded",
        auto: "rounded-auto",
        full: "rounded-full",
      },
      iconOnly: {
        true: "",
      },
    },
    compoundVariants: [
      {
        appearance: ["link", "plain"],
        class: "items-baseline",
      },
      {
        appearance: ["default", "outline"],
        class: "shadow-xs",
      },
      {
        appearance: ["default", "outline", "ghost"],
        class: "items-center ui-xs:min-h-6 ui-sm:min-h-7 ui-md:min-h-8 ui-lg:min-h-9",
      },
      {
        appearance: ["default", "outline", "ghost"],
        iconOnly: false,
        class: [
          "ui-xs:px-2 ui-sm:px-2.5 ui-md:px-3 ui-lg:px-3.5",
          "py-[calc((var(--tw-min-h)-var(--tw-line-height))/2)]",
        ],
      },
      {
        appearance: ["default", "outline", "ghost"],
        iconOnly: true,
        class: [
          "ui-xs:size-6 ui-sm:size-7 ui-md:size-8 ui-lg:size-9",
          "p-[calc((var(--tw-size)-1em)/2)]",
        ],
      },
      {
        appearance: ["outline", "ghost", "link", "plain"],
        class:
          "ui-standard:text-psx-foreground-secondary ui-standard:hover:text-psx-foreground-primary ui-increased:text-psx-foreground-primary",
      },
    ],
  });
</script>

<script lang="ts">
  import { mergeProps } from "bits-ui";
  import { boolAttr } from "../../utils/boolAttr.js";
  import { createAttachmentKey, type Attachment } from "svelte/attachments";
  import type { Except } from "type-fest";
  import type { WithChild } from "../../types/child.js";
  import { cx, tv, type VariantProps } from "@camber/tailwind-config/tv";
  import type { Prominence } from "../../utils/prominence.js";
  import type { Size } from "../../utils/size.js";

  let {
    appearance = "default",
    prominence,
    shape = "rectangle",
    radius = "default",
    size,
    children,
    child,
    ...rest
  }: ButtonProps = $props();

  const key = createAttachmentKey();

  let iconOnly = $state(false);

  let variants = $derived({
    appearance,
    shape,
    radius,
    iconOnly,
  } satisfies InternalButtonVariants);

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
      "data-disabled": boolAttr(child && rest.disabled),
      class: button({ ...variants, class: cx(rest.class) }),
    }),
  );
</script>

{#if child}
  {@render child({
    props: mergedProps,
    ...variants,
  })}
{:else}
  <button type="button" {...mergedProps}>
    {@render children?.()}
  </button>
{/if}
