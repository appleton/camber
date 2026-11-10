<script lang="ts">
  import Icon from "@camber/components/icon";
  import type { IconName } from "@camber/components/icon";

  interface Props {
    iconUrl?: string;
    fallback?: IconName;
    size?: number;
    class?: string;
    overlayIconUrl?: string;
    overlayClass?: string;
  }

  let {
    iconUrl,
    fallback = "sparkles",
    size = 16,
    class: className = "",
    overlayIconUrl,
    overlayClass = "",
  }: Props = $props();
  let maskStyle = $derived(
    iconUrl
      ? `width: ${size}px; height: ${size}px; mask: url("${iconUrl}") center / contain no-repeat; -webkit-mask: url("${iconUrl}") center / contain no-repeat;`
      : "",
  );
  let overlayMaskStyle = $derived(
    overlayIconUrl
      ? `mask: url("${overlayIconUrl}") center / contain no-repeat; -webkit-mask: url("${overlayIconUrl}") center / contain no-repeat;`
      : "",
  );
</script>

{#if iconUrl && overlayIconUrl}
  <span
    aria-hidden="true"
    class={["relative inline-block shrink-0 self-center", className]}
    style={`width: ${size}px; height: ${size}px;`}
  >
    <span class="absolute inset-0 bg-current" style={maskStyle}></span>
    <span class={["absolute inset-0 bg-current", overlayClass]} style={overlayMaskStyle}></span>
  </span>
{:else if iconUrl}
  <span
    aria-hidden="true"
    class={["inline-block shrink-0 self-center bg-current", className]}
    style={maskStyle}
  ></span>
{:else}
  <Icon name={fallback} {size} class={className} aria-hidden="true" />
{/if}
