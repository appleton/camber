<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Icon from "@camber/components/icon";
  import AcpChatEmptyState from "./ChatEmptyState.svelte";

  const { Story } = defineMeta({
    component: AcpChatEmptyState,
    parameters: { layout: "fullscreen" },
  });
</script>

<!--
  Standalone layout preview for the new-conversation empty state. The header
  controls slot mirrors AcpEmptyStateProjectSelector's trigger (folder icon +
  name + chevron, capped at max-w-[260px]) so the title + picker one-line layout
  can be reviewed without the full chat-session context.
-->

<Story name="With project picker">
  {#snippet template()}
    <div class="bg-psx-editor-background h-screen">
      <AcpChatEmptyState adjacentHeaderControls title="Start a new conversation in">
        {#snippet headerControls()}
          <div class="min-w-0 max-w-[260px]">
            <button
              type="button"
              class="text-psx-foreground-secondary shadow-low bg-psx-chrome flex min-w-0 max-w-full items-center gap-1.5 rounded-xl py-1 pl-2 pr-1.5 text-sm"
            >
              <Icon name="folder" size={14} class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 truncate text-left">assistant</span>
              <Icon name="chevron" class="shrink-0" aria-hidden="true" />
            </button>
          </div>
        {/snippet}
      </AcpChatEmptyState>
    </div>
  {/snippet}
</Story>

<Story name="Long worktree name">
  {#snippet template()}
    <div class="bg-psx-editor-background h-screen">
      <AcpChatEmptyState adjacentHeaderControls title="Start a new conversation in">
        {#snippet headerControls()}
          <div class="min-w-0 max-w-[260px]">
            <button
              type="button"
              class="text-psx-foreground-secondary shadow-low bg-psx-chrome flex min-w-0 max-w-full items-center gap-1.5 rounded-xl py-1 pl-2 pr-1.5 text-sm"
            >
              <Icon name="git-branch" size={14} class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 truncate text-left">
                very-long-worktree-name-that-should-truncate
              </span>
              <Icon name="chevron" class="shrink-0" aria-hidden="true" />
            </button>
          </div>
        {/snippet}
      </AcpChatEmptyState>
    </div>
  {/snippet}
</Story>
