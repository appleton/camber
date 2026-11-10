<script lang="ts">
  import { type Snippet } from "svelte";

  import { AcpHandoffConfirmationProvider } from "@camber/features/acp";

  import GlobalProviders from "../lib/GlobalProviders.svelte";
  import IdentityManager from "../lib/IdentityManager.svelte";
  import MCPProvider from "../lib/mcp/MCPProvider.svelte";
  import Providers from "../lib/Providers.svelte";
  import type { Runtime } from "./runtime/CoreRuntime.svelte";

  interface Props {
    runtime: Runtime;
    children: Snippet;
  }

  let { runtime, children }: Props = $props();
</script>

<svelte:window
  onfocus={runtime.handleWindowFocus}
  onblur={runtime.handleWindowBlur}
  onkeydowncapture={runtime.handleGlobalKeydown}
/>

<AcpHandoffConfirmationProvider>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    ondragover={runtime.handleDragOver}
    ondragleave={runtime.handleDragLeave}
    ondrop={runtime.handleDrop}
    class="contents"
  >
    <IdentityManager>
      <GlobalProviders>
        <Providers>
          <MCPProvider acp={runtime.acpRepo} activeConversationId={runtime.activeConversationId}>
            {@render children()}
          </MCPProvider>
        </Providers>
      </GlobalProviders>
    </IdentityManager>

    {#if runtime.hasFileContext && runtime.isDraggingFile}
      <div class="fullscreen-overlay"></div>
    {/if}
  </div>
</AcpHandoffConfirmationProvider>

<style lang="postcss">
  @reference "#tailwind.css";

  .fullscreen-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    @apply bg-psx-editor-selection-background;
  }
</style>
