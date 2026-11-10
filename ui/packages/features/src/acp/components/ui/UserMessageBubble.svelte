<script lang="ts">
  import { UserMessageBubble as SharedUserMessageBubble } from "@camber/components/assistant-ui";
  import type { Snippet } from "svelte";

  interface Props {
    children?: Snippet;
    collapsible?: boolean;
    variant?: "default" | "enqueued" | "steer";
    nubbinPosition?: "top-right" | "bottom-right";
  }

  let {
    children,
    collapsible = false,
    variant = "default",
    nubbinPosition = "top-right",
  }: Props = $props();
</script>

<SharedUserMessageBubble {collapsible} {variant} {nubbinPosition}>
  {@render children?.()}
</SharedUserMessageBubble>
