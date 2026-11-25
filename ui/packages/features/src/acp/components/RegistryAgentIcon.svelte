<script lang="ts">
  import Icon from "@camber/components/icon";
  import type { IconName } from "@camber/components/icon";

  interface Props {
    iconUrl?: string;
    fallback?: IconName;
    size?: number;
    class?: string;
  }

  let { iconUrl, fallback = "sparkles", size = 16, class: className = "" }: Props = $props();
  let maskStyle = $derived(
    iconUrl
      ? `width: ${size}px; height: ${size}px; mask: url("${iconUrl}") center / contain no-repeat; -webkit-mask: url("${iconUrl}") center / contain no-repeat;`
      : "",
  );
</script>

{#if iconUrl}
  <span
    aria-hidden="true"
    class={["inline-block shrink-0 self-center bg-current", className]}
    style={maskStyle}
  ></span>
{:else}
  <Icon name={fallback} {size} class={className} aria-hidden="true" />
{/if}
