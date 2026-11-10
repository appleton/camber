<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Button } from "@camber/components/button";
  import { Spinner } from "@camber/components/spinner";
  import { Tooltip } from "@camber/components/tooltip";
  import type { InputVariable, MCPServerInputs } from "@camber/helperapi/schemas";
  import { getACPMCPSettingsRepo } from "../../features/MCPSettingsRepository.context";

  interface Props {
    server: MCPServerInputs;
    variable: InputVariable;
  }

  let { server, variable }: Props = $props();

  // Always rendered under the MCP settings provider (via PoolMcpServerRow).
  const repo = getACPMCPSettingsRepo()!;

  let hasDescription = $derived(!!variable.description && variable.description.trim().length > 0);

  // null means not set, "" means explicitly empty.
  let currentValue = $derived.by(() => {
    const localVal = repo.variableValues[server.serverName]?.[variable.name];
    if (localVal !== undefined) return localVal;
    return variable.value ?? null;
  });
  let isSet = $derived(currentValue !== null);

  let isEditing = $state(false);
  let localValue = $state("");
  let inputRef = $state<HTMLInputElement | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);

  function startEdit() {
    isEditing = true;
    localValue = currentValue ?? "";
    error = null;
    setTimeout(() => inputRef?.focus(), 0);
  }

  async function save() {
    saving = true;
    error = null;
    try {
      await repo.setVariableValue(server, variable.name, localValue.trim());
      isEditing = false;
      localValue = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save";
    } finally {
      saving = false;
    }
  }

  function cancel() {
    isEditing = false;
    localValue = "";
    error = null;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !saving) void save();
    else if (e.key === "Escape") cancel();
  }
</script>

<div class="flex flex-col gap-1">
  <div class="flex items-center gap-2">
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <div class="text-psx-foreground-primary flex min-w-0 items-center gap-1">
        <span class="truncate font-mono text-[11px]" title={variable.name}>{variable.name}</span>
        {#if hasDescription}
          <Tooltip text={variable.description || ""} show={hasDescription}>
            <button type="button" class="flex items-center" aria-label="About this variable">
              <Icon name="info" size={12} class="text-psx-icon" />
            </button>
          </Tooltip>
        {/if}
      </div>

      {#if isEditing}
        <input
          bind:this={inputRef}
          type="text"
          bind:value={localValue}
          onkeydown={handleKeydown}
          placeholder="Enter value"
          disabled={saving}
          spellcheck="false"
          autocorrect="off"
          autocapitalize="off"
          autocomplete="off"
          class="border-psx-input-border bg-psx-input-background text-psx-foreground-primary outline-hidden placeholder:text-psx-foreground-secondary focus-visible:outline-psx-focus h-7 w-full min-w-0 rounded-md border px-2 font-mono text-xs placeholder:opacity-50 focus-visible:outline-2"
        />
      {:else if currentValue === null}
        <span class="text-psx-warning-foreground text-[11px] italic">Not set</span>
      {:else if currentValue === ""}
        <span class="text-psx-foreground-secondary font-mono text-[11px]">Empty</span>
      {:else}
        <span class="text-psx-foreground-secondary text-[11px]">••••••••••</span>
      {/if}
    </div>

    <div class="flex shrink-0 gap-1.5">
      {#if isEditing}
        <Button type="button" size="sm" appearance="ghost" onclick={cancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" size="sm" onclick={() => void save()} disabled={saving}>
          {#if saving}<Spinner size={12} />{:else}Set{/if}
        </Button>
      {:else}
        <Button
          type="button"
          size="sm"
          prominence={isSet ? "standard" : "increased"}
          onclick={startEdit}
        >
          {isSet ? "Edit" : "Configure"}
        </Button>
      {/if}
    </div>
  </div>

  {#if error}
    <span class="text-psx-error-foreground text-[11px]">{error}</span>
  {/if}
</div>
