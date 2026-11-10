<script lang="ts">
  import { cn } from "@camber/tailwind-config/tv";
  import type { SvelteHTMLElements } from "svelte/elements";

  type Props = SvelteHTMLElements["span"] & {
    size?: number;
  };

  let { size = 16, class: className, ...rest }: Props = $props();
</script>

<span
  {...rest}
  class={cn(["relative inline-block shrink-0 align-middle", className])}
  role="status"
  style="width: {size}px; height: {size}px"
>
  <svg aria-hidden="true" class="spinner size-full" fill="currentColor" viewBox="0 0 16 16">
    <rect x="7.25" y="1.25" width="1.5" height="4" rx="0.75" />
    <rect x="7.25" y="1.25" width="1.5" height="4" rx="0.75" transform="rotate(45 8 8)" />
    <rect x="7.25" y="1.25" width="1.5" height="4" rx="0.75" transform="rotate(90 8 8)" />
    <rect x="7.25" y="1.25" width="1.5" height="4" rx="0.75" transform="rotate(135 8 8)" />
    <rect x="7.25" y="1.25" width="1.5" height="4" rx="0.75" transform="rotate(180 8 8)" />
    <rect x="7.25" y="1.25" width="1.5" height="4" rx="0.75" transform="rotate(225 8 8)" />
    <rect x="7.25" y="1.25" width="1.5" height="4" rx="0.75" transform="rotate(270 8 8)" />
    <rect x="7.25" y="1.25" width="1.5" height="4" rx="0.75" transform="rotate(315 8 8)" />
  </svg>
</span>

<style lang="postcss">
  .spinner rect {
    animation: spinner-fade 800ms linear infinite;
  }

  .spinner rect:nth-child(1) {
    animation-delay: -700ms;
  }

  .spinner rect:nth-child(2) {
    animation-delay: -600ms;
  }

  .spinner rect:nth-child(3) {
    animation-delay: -500ms;
  }

  .spinner rect:nth-child(4) {
    animation-delay: -400ms;
  }

  .spinner rect:nth-child(5) {
    animation-delay: -300ms;
  }

  .spinner rect:nth-child(6) {
    animation-delay: -200ms;
  }

  .spinner rect:nth-child(7) {
    animation-delay: -100ms;
  }

  @keyframes spinner-fade {
    0% {
      opacity: 1;
    }

    100% {
      opacity: 0.16;
    }
  }
</style>
