<script lang="ts">
  import {
    CamberButton as SharedCamberButton,
    type ButtonProps,
  } from "@camber/components/assistant-ui";
  import { trackClick } from "../telemetry/interactions";

  let { children, prefix, suffix, trackClick: _trackClick, ...rest }: ButtonProps = $props();
</script>

<SharedCamberButton {...rest} {prefix} {suffix} {trackClick}>
  {@render children?.()}
</SharedCamberButton>
