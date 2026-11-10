<script lang="ts">
  import Icon from "@camber/components/icon";
  import { ZigZagError } from "@camber/components/zigzag-error";
  import { appState } from "../../hostAdapter";
  import Button from "../ui/CamberButton.svelte";

  interface Props {
    onRetry?: () => void;
    // Whether the composer under this notice accepts input. When it is inert
    // (agent needs authentication, read-only preview) the "keep prompting"
    // promise would sit above an editor that cannot be typed into.
    canPrompt?: boolean;
  }

  let { onRetry, canPrompt = false }: Props = $props();

  const { customUI } = $appState.environment.capabilities;
  const theme = customUI ? "web" : "app";

  // "Couldn't restore" rather than "no longer has": an empty replay can also
  // mean the conversation never got a reply (e.g. its first turn crashed
  // before any agent output), where claiming lost history would be untrue.
  const message = $derived(
    canPrompt
      ? "The agent couldn't restore this conversation's history. You can keep prompting here — the reply will start a new session."
      : "The agent couldn't restore this conversation's history.",
  );
</script>

<!-- Shown when the agent accepted session/load but replayed no transcript. The
     conversation is still in the sidebar, so silently rendering the
     new-conversation hero here reads as "my chat lost its contents" with no
     explanation (PE-2460). When the composer is usable, a message sent from
     here starts a fresh agent session for this same conversation. -->
<div class="flex w-full flex-col items-center gap-2 px-4 py-10 text-center">
  <ZigZagError {theme} variant="interrupted" {message} data-testid="history-unavailable-notice" />
  {#if onRetry}
    <Button appearance="secondary" onclick={() => onRetry?.()} data-testid="history-retry-button">
      {#snippet prefix()}
        <Icon aria-hidden="true" name="regenerate" />
      {/snippet}
      Try again
    </Button>
  {/if}
</div>
