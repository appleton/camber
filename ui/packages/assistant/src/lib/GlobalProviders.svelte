<!-- 
 @component
 Provides global functionality that can be referenced in components.

 @example
 ```svelte
 <GlobalProviders>
   <App />
 </GlobalProviders>
 ```
 -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { appState } from "./store";
  import { rpc } from "./rpc/client";
  import {
    BrowserProvider,
    ClipboardProvider,
    DisplayProvider,
    LanguagesProvider,
    LogProvider,
    EnvironmentProvider,
    FilesystemProvider,
  } from "@camber/components/providers";
  import { serializeError } from "serialize-error";
  import { InfoMessageType } from "@camber/rpc";

  interface Props {
    children: Snippet;
  }

  let props: Props = $props();

  let envName = $derived($appState.environment.assistantEnv);
  let wrapLines = $derived($appState.userSettings.wrapLines);
  let languages = $derived($appState.languages);
</script>

<EnvironmentProvider name={envName}>
  {#snippet children({ name })}
    <LogProvider
      onError={(error, message) => {
        message ??= error instanceof Error ? error.message : String(error);
        if (name === "development") {
          rpc.showInfoMessage(message, InfoMessageType.error);
          return;
        }

        console.error(error);
        // TODO: move to TelemetryProvider
        rpc.reportError(serializeError(error));
      }}
    >
      <LanguagesProvider {languages}>
        <DisplayProvider {wrapLines}>
          <BrowserProvider
            onOpen={(url) => {
              void rpc.openExternalURL(url instanceof URL ? url.toString() : url);
            }}
          >
            <ClipboardProvider onWrite={(text) => rpc.writeToClipboard(text)}>
              <FilesystemProvider onOpen={(path) => rpc.openFile(path)}>
                {@render props.children()}
              </FilesystemProvider>
            </ClipboardProvider>
          </BrowserProvider>
        </DisplayProvider>
      </LanguagesProvider>
    </LogProvider>
  {/snippet}
</EnvironmentProvider>
