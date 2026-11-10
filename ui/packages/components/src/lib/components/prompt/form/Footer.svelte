<script lang="ts">
  import { cn } from "@camber/tailwind-config/tv";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLElement> {}

  let { children, class: className, ...rest }: Props = $props();
</script>

<footer {...rest} data-prompt-form-footer class={cn(["flex items-center", className])}>
  {@render children?.()}
</footer>
