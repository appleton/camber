<script lang="ts">
  import { Badge } from "@camber/components/badge";
  import Icon from "@camber/components/icon";

  interface Props {
    count: number;
    type: "addition" | "deletion";
    /** Badge size; defaults to the ambient UI size. */
    size?: "xs" | "sm" | "md" | "lg";
  }

  let { count, type, size }: Props = $props();

  function pluralize(count: number, word: string): string {
    return count === 1 ? word : `${word}s`;
  }
</script>

{#if count > 0}
  <Badge class="font-mono" intent={type === "addition" ? "positive" : "critical"} {size}>
    <Icon aria-hidden="true" name={type === "addition" ? "plus" : "minus"} />
    {count}
    <span class="sr-only"> {pluralize(count, type)}</span>
  </Badge>
{/if}
