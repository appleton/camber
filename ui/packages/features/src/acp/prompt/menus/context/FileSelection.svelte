<script lang="ts">
  import type { Selection } from "@camber/rpc";

  interface Props {
    selection: Selection;
  }

  let { selection }: Props = $props();
</script>

<code class="mt-0.5 shrink-0 text-[90%] text-inherit">
  {#if selection[0] === selection[1]}
    L{selection[0]}
  {:else}
    {selection[0]}-{selection[1]}
  {/if}
</code>
