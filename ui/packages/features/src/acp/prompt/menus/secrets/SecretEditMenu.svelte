<script lang="ts">
  import * as Prompt from "@camber/components/prompt";
  import { Spinner } from "@camber/components/spinner";
  import { getSecretsContext } from "../../../../secrets";
  import Button from "../../../components/ui/CamberButton.svelte";
  import { getSecretsMenuState } from "./secretsMenuState.svelte";

  const menuState = getSecretsMenuState();
  const secrets = getSecretsContext();
  const { pop } = Prompt.getMenus();

  let isEditing = $derived(menuState.editingSecret !== null);

  let name = $state("");
  let description = $state("");
  let value = $state("");
  let saving = $state(false);
  let deleting = $state(false);
  let loadingSecret = $state(false);
  let error = $state<string | null>(null);

  const originalName = $derived(menuState.editingSecret?.name ?? "");

  $effect(() => {
    const secret = menuState.editingSecret;
    error = null;

    if (secret) {
      name = secret.name;
      description = secret.description;
      value = "";
      if (!secret.isConfigured) {
        loadingSecret = false;
        return;
      }
      loadingSecret = true;

      let canceled = false;
      void (async () => {
        try {
          const loadedSecret = await secrets.getSecret(secret.name);
          if (canceled) return;
          name = loadedSecret.name;
          description = loadedSecret.description;
          value = loadedSecret.value;
        } catch (_cause) {
          if (canceled) return;
          error = "Could not load this secret. Please try again.";
        } finally {
          if (!canceled) {
            loadingSecret = false;
          }
        }
      })();

      return () => {
        canceled = true;
      };
    } else {
      name = "";
      description = "";
      value = "";
      loadingSecret = false;
    }
  });

  const nameError = $derived.by(() => {
    if (name.trim() === "") return "Name is required";
    const isDuplicate = menuState.allSecretNames.some(
      (n) => n === name.trim() && n !== originalName,
    );
    if (isDuplicate) return "A secret with this name already exists";
    return null;
  });

  const canSave = $derived(!nameError && !saving && !deleting && !loadingSecret);

  async function reloadAndGoBack() {
    pop();
  }

  async function handleSave() {
    if (!canSave) return;

    saving = true;
    error = null;

    try {
      await secrets.upsertSecret({
        name: name.trim(),
        value,
        description,
        previousName: isEditing ? originalName : undefined,
      });
      reloadAndGoBack();
    } catch (cause) {
      error = "Could not save this secret. Please try again.";
    } finally {
      saving = false;
    }
  }

  async function handleDelete() {
    if (deleting || !isEditing) return;

    deleting = true;
    error = null;

    try {
      await secrets.deleteSecret(originalName);
      reloadAndGoBack();
    } catch (cause) {
      error = "Could not delete this secret. Please try again.";
    } finally {
      deleting = false;
    }
  }

  function handleCancel() {
    pop();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && canSave) {
      e.preventDefault();
      handleSave();
    }
  }
</script>

<Prompt.Menu.Popup.Root>
  <Prompt.Menu.Popup.Header icon="key" title={isEditing ? "Configure secret" : "New secret"}>
    {#snippet subtitle()}
      {#if error}
        <span class="text-psx-error-foreground min-w-0 truncate">{error}</span>
      {:else if isEditing && loadingSecret}
        <span class="min-w-0 truncate">Loading current value...</span>
      {:else if isEditing}
        <span class="min-w-0 truncate">Edit the name, description, and value</span>
      {:else}
        <span class="min-w-0 truncate">Add a new secret to your sandbox</span>
      {/if}
    {/snippet}
  </Prompt.Menu.Popup.Header>

  {#if isEditing && loadingSecret}
    <div class="text-psx-foreground-secondary flex items-center gap-2 px-3 py-2 text-[12px]">
      <Spinner size={12} />
      <span>Loading secret details...</span>
    </div>
  {/if}

  <div class="flex flex-col gap-2 px-3 pt-0.5">
    <label class="flex flex-col gap-0.5">
      <span class="text-psx-foreground-secondary text-[12px] font-medium"> Name </span>
      <input
        type="text"
        bind:value={name}
        onkeydown={handleKeydown}
        placeholder="SECRET_NAME"
        disabled={saving || deleting || loadingSecret}
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        autocomplete="off"
        class="border-psx-border bg-psx-editor-background text-psx-foreground-primary placeholder:text-psx-foreground-tertiary focus:border-psx-focus rounded-md border px-2 py-1.5 font-mono text-[13px] outline-none"
      />
      {#if nameError && name !== ""}
        <span class="text-psx-error-foreground text-[11px]">{nameError}</span>
      {/if}
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-psx-foreground-secondary text-[12px] font-medium"> Description </span>
      <input
        type="text"
        bind:value={description}
        onkeydown={handleKeydown}
        placeholder="Optional description"
        disabled={saving || deleting || loadingSecret}
        class="border-psx-border bg-psx-editor-background text-psx-foreground-primary placeholder:text-psx-foreground-tertiary focus:border-psx-focus rounded-md border px-2 py-1.5 text-[13px] outline-none"
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-psx-foreground-secondary text-[12px] font-medium"> Value </span>
      <input
        type="password"
        bind:value
        onkeydown={handleKeydown}
        placeholder="Secret value"
        disabled={saving || deleting || loadingSecret}
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        autocomplete="off"
        class="border-psx-border bg-psx-editor-background text-psx-foreground-primary placeholder:text-psx-foreground-tertiary focus:border-psx-focus rounded-md border px-2 py-1.5 font-mono text-[13px] outline-none"
      />
    </label>
  </div>

  <div class="flex items-center justify-between px-3 py-3">
    <div>
      {#if isEditing}
        <Button
          appearance="ghost"
          size="small"
          onclick={handleDelete}
          disabled={saving || deleting || loadingSecret}
        >
          {#if deleting}
            <Spinner size={12} />
          {:else}
            Delete
          {/if}
        </Button>
      {/if}
    </div>
    <div class="flex gap-1.5">
      <Button
        appearance="secondary"
        size="small"
        onclick={handleCancel}
        disabled={saving || deleting || loadingSecret}
      >
        Cancel
      </Button>
      <Button size="small" onclick={handleSave} disabled={!canSave}>
        {#if saving}
          <Spinner size={12} />
        {:else}
          Save
        {/if}
      </Button>
    </div>
  </div>
</Prompt.Menu.Popup.Root>
