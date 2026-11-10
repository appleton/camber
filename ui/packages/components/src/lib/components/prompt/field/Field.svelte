<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { cn } from "@camber/tailwind-config/tv";
  import { getDisplay } from "../../../providers/index.js";

  interface Props {
    children?: Snippet;
    class?: ClassValue;
  }

  let { children, class: className }: Props = $props();

  const display = getDisplay();
</script>

<div
  data-prompt-field
  class={cn([
    "relative flex items-center overflow-hidden pr-[5px] has-[+_[data-prompt-form-footer]]:mt-0.5 has-[+_[data-prompt-form-footer]]:-mb-0.5 has-[+_[data-prompt-form-footer]]:-ml-1 has-[+_[data-prompt-form-footer]]:pr-2",
    display.customUI ? "pl-7" : "pl-4",
    className,
  ])}
>
  {@render children?.()}
</div>
