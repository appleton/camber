<script lang="ts">
  import Icon from "@camber/components/icon";
  import type { IconName } from "@camber/components/icon";

  interface Props {
    icon: IconName;
    badge: IconName;
    size?: number;
    class?: string;
  }

  let { icon, badge, size = 16, class: className = "" }: Props = $props();
  let badgeSize = $derived(Math.max(8, Math.round(size * 0.625)));
  // The badge overhangs the corner by 1px, so its center is at
  // (size - badgeSize / 2 + 1) on both axes.
  let badgeCenter = $derived(size - badgeSize / 2 + 1);
  // Carve a transparent hole under the badge so it stays legible on any
  // background instead of overlapping the base icon's strokes.
  let badgeHoleMask = $derived(
    `radial-gradient(circle at ${badgeCenter}px ${badgeCenter}px, transparent ${badgeSize / 2 + 1}px, black ${badgeSize / 2 + 1.5}px)`,
  );
</script>

<span
  aria-hidden="true"
  class={["relative inline-flex shrink-0 self-center", className]}
  style={`width: ${size}px; height: ${size}px;`}
>
  <span
    class="absolute inset-0 inline-flex"
    style={`mask: ${badgeHoleMask}; -webkit-mask: ${badgeHoleMask};`}
  >
    <Icon name={icon} {size} />
  </span>
  <Icon name={badge} size={badgeSize} class="absolute -bottom-px -right-px" />
</span>
