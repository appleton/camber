<script lang="ts">
  import Icon from "@camber/components/icon";
  import Kbd from "@camber/components/kbd";
  import { slide } from "svelte/transition";
  import { getACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import { appState } from "../../hostAdapter";
  import { shortcutHint } from "../../../keybindings";

  const chatSession = getACPChatSessionScope();
  // Resolve the toggle hint from the keybinding service (works on desktop and IDE);
  // the `$appState` reference keeps it reactive to the VS Code getKeybindings update.
  let planModeToggleKeybinding = $derived(
    shortcutHint("togglePlanMode") ?? $appState.keybindings["camber.togglePlanMode"],
  );

  async function disablePlanMode(): Promise<void> {
    try {
      await chatSession.togglePlanMode();
    } catch (error) {
      console.error("Failed to toggle ACP plan mode", error);
    }
  }
</script>

<!-- Collaboration-mode plan (build/plan kept apart from permissions) uses the
     compact PlanModeIndicator beside the mode control instead of this banner. -->
{#if chatSession.isPlanModeActive && !chatSession.planModeViaCollaboration}
  <div
    class="mx-px flex items-center gap-1.5 rounded-full border border-blue-400/50 bg-blue-200/10 px-1 py-1.5 text-sm text-blue-500 dark:text-blue-300"
    transition:slide={{ duration: 200 }}
  >
    <Icon name="plan" weight={1.2} class="ml-1 h-3.5 w-3.5 shrink-0" />
    <div class="flex-1">
      <span class="font-medium">Plan mode</span>
    </div>
    {#if planModeToggleKeybinding}
      <Kbd label={`${planModeToggleKeybinding} to cycle`} />
    {/if}
    <button
      type="button"
      onclick={disablePlanMode}
      title="Disable Plan Mode"
      class="flex shrink-0 items-center justify-center rounded p-1 opacity-75 hover:opacity-100"
    >
      <Icon name="cross" weight={1.5} class="h-3 w-3" />
    </button>
  </div>
{/if}
