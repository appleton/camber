<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Orientation } from "../../types/orientation.js";
  import type { Except } from "type-fest";
  import { cn } from "@camber/tailwind-config/tv";

  interface Props extends Except<HTMLAttributes<HTMLDivElement>, "children"> {
    orientation?: Orientation;
  }

  const { orientation = "horizontal", class: className, ...rest }: Props = $props();
</script>

<div
  class={cn([
    "shrink-0 self-stretch bg-psx-border",
    orientation === "vertical" ? "w-px" : "h-px",
    className,
  ])}
  role="separator"
  data-orientation={orientation}
  aria-orientation={orientation}
  aria-hidden="true"
  {...rest}
></div>
