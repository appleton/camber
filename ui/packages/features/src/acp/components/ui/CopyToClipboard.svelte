<script lang="ts">
  import { CopyToClipboard as SharedCopyToClipboard } from "@camber/components/assistant-ui";
  import { InfoMessageType } from "@camber/rpc";
  import { appState, trackClick } from "../../hostAdapter";
  import { rpc } from "../../hostRpc";

  interface Props {
    text: string;
    forCode?: boolean;
    disabled?: boolean;
    disabledTooltip?: string;
  }

  let {
    text,
    forCode = false,
    disabled = false,
    disabledTooltip = "Nothing to copy",
  }: Props = $props();

  function writeToClipboard(value: string) {
    return rpc.writeToClipboard?.(value);
  }

  function showCopyError(error: Error) {
    return rpc.showInfoMessage(
      `Error copying to clipboard: ${error.message}`,
      InfoMessageType.error,
    );
  }
</script>

<SharedCopyToClipboard
  {text}
  {forCode}
  {disabled}
  {disabledTooltip}
  capabilities={$appState.environment.capabilities}
  {writeToClipboard}
  onCopyError={showCopyError}
  {trackClick}
/>
