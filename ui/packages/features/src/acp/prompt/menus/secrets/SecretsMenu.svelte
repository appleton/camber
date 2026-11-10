<script lang="ts">
  import * as Prompt from "@camber/components/prompt";
  import { Spinner } from "@camber/components/spinner";
  import { getSecretsContext } from "../../../../secrets";
  import type { SecretSummary } from "@camber/helperapi/schemas";
  import { isRPCError, isUserConfigInvalidError } from "@camber/rpc/generics";
  import { tick } from "svelte";
  import { menus } from "../menus";
  import { selectSecretForEdit, selectNewSecret } from "./secretsMenuState.svelte";

  const secrets = getSecretsContext();
  const { selectFirst } = Prompt.getItems();

  const secretErrorMessages: Record<string, string> = {
    ERROR_READING_INDEX:
      "Could not read your local secrets index. Check file permissions and try again.",
    ERROR_PARSING_INDEX: "Something went wrong parsing the secret index. Please contact support.",
    ERROR_READING_SECRET:
      "Could not read a secret from your system keychain. Check keychain access and try again.",
    ERROR_PARSING_SECRET: "A saved secret entry is invalid. Please contact support.",
  };

  async function loadSecrets(): Promise<{
    suggested: SecretSummary[];
    custom: SecretSummary[];
    allNames: string[];
  }> {
    return secrets.getSandboxMenuSecrets();
  }

  function toSecretErrorMessage(cause: unknown): string {
    const error = isRPCError(cause) ? cause.message : String(cause);
    if (isUserConfigInvalidError(cause)) {
      return "Fails to load secret due to invalid settings file";
    }

    for (const [code, message] of Object.entries(secretErrorMessages)) {
      if (error.includes(code)) {
        return message;
      }
    }

    return "Failed to load secrets";
  }

  async function focusFirst() {
    await tick();
    selectFirst();
  }

  let secretsPromise = loadSecrets();
</script>

{#snippet secretItem(secret: SecretSummary, allNames: string[])}
  <Prompt.Menu.Popup.Item
    class="secret-item"
    icon="key"
    title={secret.name}
    subtitle={secret.description}
  >
    <Prompt.Actions.Push
      prominence="standard"
      menu={menus["secret-edit"].value}
      onPush={() => selectSecretForEdit(secret, allNames)}
    />
  </Prompt.Menu.Popup.Item>
{/snippet}

<Prompt.Menu.Popup.Root>
  <Prompt.Menu.Popup.Header
    icon="key"
    title="Secrets"
    subtitle="Create or delete secrets, and control which the agent can use"
  />

  <Prompt.Menu.Popup.List>
    {#await secretsPromise}
      <div class="flex items-center justify-center gap-2 py-3">
        <Spinner size={16} class="opacity-50" />
        <span class="text-psx-foreground-secondary text-[12px]">Loading secrets...</span>
      </div>
    {:then { suggested, custom, allNames }}
      {void focusFirst()}

      {#if suggested.length > 0}
        <Prompt.Menu.Popup.Section title="Suggested by sandbox">
          {#each suggested as secret (secret.name)}
            {@render secretItem(secret, allNames)}
          {/each}
        </Prompt.Menu.Popup.Section>
      {/if}

      {#if suggested.length > 0 && custom.length > 0}
        <Prompt.Menu.Popup.Separator />
      {/if}

      {#if custom.length > 0}
        <Prompt.Menu.Popup.Section title="Custom secrets">
          {#each custom as secret (secret.name)}
            {@render secretItem(secret, allNames)}
          {/each}
        </Prompt.Menu.Popup.Section>
      {/if}

      <Prompt.Menu.Popup.Separator />

      <Prompt.Menu.Popup.Section>
        <Prompt.Menu.Popup.Item icon="plus" title="Add New Secret">
          <Prompt.Actions.Push
            icon="enter"
            prominence="standard"
            menu={menus["secret-edit"].value}
            onPush={() => selectNewSecret(allNames)}
          />
        </Prompt.Menu.Popup.Item>
      </Prompt.Menu.Popup.Section>
    {:catch error}
      <Prompt.Menu.Popup.Empty title={toSecretErrorMessage(error)} icon="alert" />
    {/await}
  </Prompt.Menu.Popup.List>
</Prompt.Menu.Popup.Root>

<style lang="postcss">
  @reference "#tailwind.css";
  :global(.configure-wrapper) {
    grid-template-columns: 0fr;
    transition: grid-template-columns 0ms 100ms;
  }
  :global(.configure-action) {
    opacity: 0;
    transition: opacity 100ms ease;
  }
  :global([data-prompt-item]:hover .configure-wrapper),
  :global([data-prompt-item][data-selected] .configure-wrapper) {
    grid-template-columns: 1fr;
    transition: grid-template-columns 0ms;
  }
  :global([data-prompt-item]:hover .configure-action),
  :global([data-prompt-item][data-selected] .configure-action) {
    opacity: 1;
  }
  :global(.secret-item .title-highlight:first-child) {
    @apply font-mono text-[12px];
  }
  :global(.configure-icon) {
    grid-template-columns: 0fr;
    transition: grid-template-columns 150ms ease;
  }
  :global(.configure-action:hover .configure-icon) {
    grid-template-columns: 1fr;
  }
</style>
