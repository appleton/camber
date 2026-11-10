<script lang="ts">
  import Icon from "@camber/components/icon";
  import { ZigZagError } from "@camber/components/zigzag-error";
  import truncate from "lodash/truncate";
  import { appState } from "../../hostAdapter";
  import Button from "../ui/CamberButton.svelte";
  import { formatACPError, formatACPErrorSummary, type ACPRequestError } from "../../errors";

  interface Props {
    error: ACPRequestError;
    isStreaming?: boolean;
    prefix?: string;
    buttonLabel?: string;
    onRetry?: () => void;
  }

  let {
    error,
    isStreaming = false,
    prefix = "Could not send prompt",
    buttonLabel = "Retry",
    onRetry,
  }: Props = $props();

  const { customUI } = $appState.environment.capabilities;
  const theme = customUI ? "web" : "app";

  // The tooltip keeps the agent's full text (including any upstream payload)
  // for anyone diagnosing; the visible line stays readable.
  const formattedError = $derived(formatACPError(error, { prefix }));
  const errorMessage = $derived(
    truncate(formatACPErrorSummary(error, { prefix }), { length: 280 }),
  );
</script>

<div class="flex flex-col items-start gap-2">
  <ZigZagError
    {theme}
    variant="error"
    message={errorMessage}
    title={formattedError}
    data-testid="error-message"
  />
  {#if onRetry}
    <Button
      appearance="secondary"
      onclick={() => onRetry?.()}
      disabled={isStreaming}
      data-testid="retry-tool-button"
      class="error-message-button"
    >
      {#snippet prefix()}
        <Icon aria-hidden="true" name="regenerate" />
      {/snippet}
      {buttonLabel}
    </Button>
  {/if}
</div>

<style lang="postcss">
  :global(body.web-app .error-message-button) {
    @apply border-(--color-mono-300) bg-(--color-mono-100) text-(--color-mono-700) hover:border-(--color-mono-400) hover:bg-(--color-mono-200) active:border-(--color-mono-500) active:bg-(--color-mono-300) transition-all duration-150;
  }
</style>
