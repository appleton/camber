<script lang="ts">
  import Icon from "@camber/components/icon";
  import { getACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import { appState } from "../../hostAdapter";
  import "./promptFooterLabel.css";

  const chatSession = getACPChatSessionScope();

  const nudgeLabel = $derived($appState.environment.assistantHost !== "vs");

  async function disablePlanMode(): Promise<void> {
    try {
      await chatSession.togglePlanMode();
    } catch (error) {
      console.error("Failed to toggle ACP plan mode", error);
    }
  }
</script>

<!-- Collaboration-mode plan state stays quiet: an agent whose collaboration
     option is a plain build/plan switch gets this small chip beside the mode
     control instead of the full-width plan banner. The /plan command toggles
     it, and clicking it switches straight back to build. Agents offering more
     collaboration modes get the picker (PromptModeControl) instead. -->
{#if chatSession.isPlanModeActive && chatSession.collaborationModeSurface === "plan-toggle"}
  <button
    type="button"
    onclick={disablePlanMode}
    aria-label="Disable Plan Mode"
    title="Disable Plan Mode"
    class="hover:bg-psx-chrome-hover group flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm text-blue-500 transition-colors dark:text-blue-300"
  >
    <Icon name="bulb" size={14} class="shrink-0" aria-hidden="true" />
    <span class={[nudgeLabel && "prompt-footer-label"]}>Plan</span>
    <!-- Always laid out so the chip keeps one width: hovering reveals the
         dismiss affordance rather than nudging the controls beside it. -->
    <Icon
      name="cross"
      weight={1.5}
      class="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-75 group-focus-visible:opacity-75"
      aria-hidden="true"
    />
  </button>
{/if}
