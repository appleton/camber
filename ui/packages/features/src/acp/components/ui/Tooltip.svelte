<script lang="ts">
  import { Tooltip as SharedTooltip } from "@camber/components/assistant-ui";
  import type { Snippet } from "svelte";
  import { appState } from "../../hostAdapter";

  interface Props {
    text?: string | null;
    openDelay?: number;
    gutter?: number;
    placement?: "top" | "bottom" | "left" | "right";
    truncate?: boolean;
    hide?: boolean;
    class?: string;
    children?: Snippet;
    label?: Snippet;
    interactive?: boolean;
  }

  let {
    text = null,
    openDelay = 1000,
    gutter = 2,
    placement = "top",
    truncate = false,
    hide = false,
    class: className,
    children,
    label,
    interactive = false,
  }: Props = $props();
</script>

<SharedTooltip
  {text}
  {openDelay}
  {gutter}
  {placement}
  {truncate}
  {hide}
  class={className}
  {label}
  {interactive}
  customUI={$appState.environment.capabilities.customUI}
>
  {@render children?.()}
</SharedTooltip>
