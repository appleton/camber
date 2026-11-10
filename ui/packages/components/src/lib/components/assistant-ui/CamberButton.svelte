<script lang="ts">
  import { emptyMeltElement, melt } from "@melt-ui/svelte";
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import type { Except } from "type-fest";

  type Action = (node: HTMLElement, parameter?: any) => void | { destroy?: () => void };
  const noopAction: Action = () => {};

  export interface ButtonProps extends Except<HTMLButtonAttributes, "prefix"> {
    appearance?: "primary" | "secondary" | "ghost" | "pill" | "pillInset";
    iconOnly?: boolean;
    size?: "mini" | "small" | "regular";
    meltElement?: any;
    prefix?: Snippet;
    suffix?: Snippet;
    justifyBetween?: boolean;
    clickTrackOptions?: unknown;
    trackClick?: Action;
  }

  let {
    appearance = "primary",
    disabled = false,
    title = "",
    iconOnly = false,
    type = "button",
    size = "regular",
    meltElement = emptyMeltElement,
    class: className,
    children,
    prefix,
    suffix,
    justifyBetween = false,
    clickTrackOptions,
    trackClick = noopAction,
    ...rest
  }: ButtonProps = $props();
</script>

<button
  {disabled}
  {title}
  {type}
  class={["base group/button", size, className]}
  class:primaryButton={appearance === "primary"}
  class:secondaryButton={appearance === "secondary"}
  class:ghostButton={appearance === "ghost"}
  class:pillButton={appearance === "pill"}
  class:pillInset={appearance === "pillInset"}
  use:melt={$meltElement}
  use:trackClick={clickTrackOptions}
  {...rest}
>
  {#if appearance === "pill" && !disabled}
    <span class="absolute inset-0 rounded-full opacity-50 transition"></span>
  {/if}

  {#if iconOnly}
    <span class="relative flex shrink-0 items-center">
      {@render children?.()}
    </span>
  {:else}
    <div
      class="relative flex items-center px-px"
      class:truncate={!justifyBetween}
      class:justify-between={justifyBetween}
      class:w-full={justifyBetween}
      class:gap-1.5={size === "regular"}
      class:gap-0.5={size === "small" || size === "mini"}
    >
      <span class="flex items-center px-px empty:hidden" class:-ml-0.5={size !== "small"}>
        {@render prefix?.()}
      </span>
      <span
        class="label flex items-center"
        class:truncate={!justifyBetween}
        class:min-w-0={justifyBetween}
        class:overflow-hidden={justifyBetween}
        class:translate-y-[-0.5px]={size === "small"}
      >
        {@render children?.()}
      </span>
      <span class="flex items-center px-px empty:hidden" class:-mr-0.5={size !== "small"}>
        {@render suffix?.()}
      </span>
    </div>
  {/if}
</button>

<style lang="postcss">
  @reference "#tailwind.css";
  .base {
    @apply relative flex min-w-6 items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-psx-focus;
  }

  .regular {
    @apply min-h-8 rounded-md px-2.5;
  }

  .small {
    @apply min-h-6 rounded-md px-1.5;
  }

  .mini {
    @apply h-[20px] rounded-sm px-1;
  }

  .label > * {
    @apply min-w-0;
  }

  .primaryButton {
    @apply border border-psx-button-primary-border text-psx-button-primary-foreground hover:border-psx-button-primary-hover-border disabled:cursor-default disabled:border-psx-button-secondary-border disabled:text-psx-button-secondary-foreground disabled:opacity-50;

    /* tailwind doesn't support `background` shorthand for gradients + colors */
    background: var(--psx-button-primary-background);

    &:hover {
      background: var(--psx-button-primary-hover-background);
    }

    &:active {
      background: var(--psx-button-primary-background);
    }

    &:disabled {
      background: var(--psx-button-secondary-background);
    }
  }

  .secondaryButton {
    @apply border border-psx-button-secondary-border bg-psx-button-secondary-background text-psx-button-secondary-foreground hover:border-psx-button-secondary-hover-border hover:bg-psx-button-secondary-hover-background active:bg-psx-button-secondary-background disabled:cursor-default disabled:bg-psx-button-secondary-background disabled:text-psx-button-secondary-foreground disabled:opacity-50;
  }

  .ghostButton {
    @apply border border-transparent text-psx-foreground-secondary hover:bg-psx-chrome-hover active:bg-psx-chrome-active disabled:cursor-default disabled:bg-transparent disabled:opacity-50;
  }

  :global(body.web-app) .pillButton {
    @apply bg-(--color-mono-000) text-(--color-mono-700) group-active/button:text-(--color-pri-800) hover:bg-(--color-mono-200) hover:text-(--color-mono-900) focus-visible:outline-(--color-pri-800) active:text-(--color-pri-800) dark:bg-(--color-mono-200) dark:hover:bg-(--color-mono-100);
  }

  .pillButton {
    @apply max-w-full rounded-full bg-psx-panel text-psx-foreground-secondary shadow-low transition group-hover/button:bg-psx-chrome-hover group-active/button:bg-psx-chrome-active focus-visible:outline-offset-2 dark:shadow-low-dark;

    &:disabled {
      @apply cursor-not-allowed text-psx-foreground-tertiary;
    }
  }

  .pillButton.small {
    @apply text-[12px];
  }

  .pillInset {
    @apply min-h-6 rounded-none border border-transparent bg-psx-border pr-2 pl-1.5 text-[13px] text-psx-link transition hover:bg-psx-chrome-hover active:bg-psx-chrome-active disabled:cursor-default disabled:bg-transparent disabled:opacity-50;
  }
</style>
