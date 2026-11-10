<script lang="ts">
  import Icon from "@camber/components/icon";
  import AssistantTerminalView from "./AssistantTerminalView.svelte";
  import { getAssistantTerminalRepo } from "../features/AssistantTerminalRepository.svelte";

  interface Props {
    worktreePath: string;
    width: number;
    resizing: boolean;
    onClose: () => void;
    onResizeStart: (event: MouseEvent) => void;
  }

  let { worktreePath, width, resizing, onClose, onResizeStart }: Props = $props();

  const assistantTerminals = getAssistantTerminalRepo();
  const activeTab = $derived(assistantTerminals.activeTab);
  // The panel is only mounted while the user has it open, so its terminal takes
  // focus on arrival and on every tab the user creates or picks. Terminals do
  // not focus themselves on render — see AssistantTerminalView.
  let focusToken = $state(1);

  $effect(() => {
    void assistantTerminals.ensureTabForWorktree(worktreePath);
  });

  async function createTab() {
    await assistantTerminals.createTab(worktreePath);
    focusToken += 1;
  }

  function selectTab(id: string) {
    assistantTerminals.selectTab(id);
    focusToken += 1;
  }

  async function deleteTab(id: string, event: MouseEvent) {
    event.stopPropagation();
    await assistantTerminals.deleteTab(id);
    if (!assistantTerminals.tabs.some((tab) => tab.worktreePath === worktreePath)) {
      onClose();
      return;
    }
    focusToken += 1;
  }

  async function handleTabAuxClick(id: string, event: MouseEvent) {
    if (event.button !== 1) return;
    event.preventDefault();
    await deleteTab(id, event);
  }
</script>

<aside
  class={["terminal-panel", resizing ? "terminal-panel--resizing" : ""]}
  style:width={`${width}px`}
>
  <button
    type="button"
    class="terminal-resize-handle"
    aria-label="Resize terminal panel"
    onmousedown={onResizeStart}
  ></button>
  <header class="terminal-header">
    <div class="terminal-tabs" role="tablist" aria-label="Terminals">
      {#each assistantTerminals.activeTabs as tab (tab.id)}
        <div
          role="tab"
          aria-selected={assistantTerminals.activeTab?.id === tab.id}
          onauxclick={(event) => handleTabAuxClick(tab.id, event)}
          class={[
            "terminal-tab",
            assistantTerminals.activeTab?.id === tab.id ? "terminal-tab--active" : "",
          ]}
        >
          <button type="button" class="terminal-tab-select" onclick={() => selectTab(tab.id)}>
            <Icon name={tab.exitCode === undefined ? "terminal" : "terminal-done"} size={13} />
            <span>{tab.title}</span>
          </button>
          <button
            type="button"
            class="terminal-tab-close"
            aria-label={`Close ${tab.title}`}
            title="Close Terminal"
            onclick={(event) => deleteTab(tab.id, event)}
          >
            <Icon name="cross" size={11} />
          </button>
        </div>
      {/each}
      <button
        type="button"
        class="terminal-icon-button terminal-tab-add"
        aria-label="New terminal"
        title="New Terminal"
        onclick={createTab}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  </header>
  <AssistantTerminalView terminalId={activeTab?.id} {focusToken} />
</aside>

<style lang="postcss">
  .terminal-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-left: var(--psx-hairline, 1px) solid var(--psx-border);
    background: var(--psx-editor-background);
    color: var(--psx-foreground-primary);
  }

  .terminal-resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 20;
    width: 5px;
    cursor: col-resize;
    background: transparent;
  }

  .terminal-resize-handle:hover {
    background: color-mix(in srgb, var(--psx-focus) 40%, transparent);
  }

  .terminal-header {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    height: 34px;
    min-height: 34px;
    padding: 0 8px;
    border-bottom: 1px solid var(--psx-border);
    background: var(--psx-editor-background);
  }

  .terminal-tabs {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    align-self: stretch;
    gap: 2px;
    min-width: 0;
    overflow: hidden;
  }

  .terminal-tab {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
    height: 100%;
    max-width: 150px;
    color: var(--psx-foreground-secondary);
    font-size: 12px;
  }

  .terminal-tab::after {
    content: "";
    position: absolute;
    right: 8px;
    bottom: 0;
    left: 8px;
    height: 2px;
    border-radius: 999px;
    background: transparent;
  }

  .terminal-tab--active {
    color: var(--psx-foreground-primary);
  }

  .terminal-tab--active::after {
    background: var(--psx-focus);
  }

  .terminal-tab:hover {
    color: var(--psx-foreground-primary);
  }

  .terminal-tab-select {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    gap: 5px;
    min-width: 0;
    height: 100%;
    padding: 0 7px;
  }

  .terminal-tab-select span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .terminal-tab-close {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    margin-right: 3px;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    opacity: 0;
  }

  .terminal-tab:hover .terminal-tab-close,
  .terminal-tab--active .terminal-tab-close {
    opacity: 0.7;
  }

  .terminal-tab-close:hover {
    background: var(--psx-menu-hover-background);
    opacity: 1;
  }

  .terminal-icon-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 5px;
    color: var(--psx-foreground-secondary);
  }

  .terminal-icon-button:hover {
    color: var(--psx-foreground-primary);
    background: var(--psx-menu-hover-background);
  }

  .terminal-tab-add {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
  }
</style>
