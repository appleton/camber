<script lang="ts">
  import Icon from "@camber/components/icon";
  import type { ToolOverrideProps } from "./toolOverrides";
  import { DEFAULT_AGENT_SERVER } from "../../../agentServers";
  import { getACPAgentRegistryRepo } from "../../../features/AgentRegistryRepository.svelte";
  import { getOptionalACPChatSessionScope } from "../../../features/ChatSessionScope.svelte";
  import {
    buildSubagentTranscriptIndex,
    subagentProvidesTranscript,
    subagentStatusLabel,
    type SubagentReference,
  } from "../../../subagents";
  import RegistryAgentIcon from "../../RegistryAgentIcon.svelte";
  import {
    getToolCallExpansionContext,
    isInsideToolCallGroup,
  } from "../../SessionEventsState.svelte";
  import ToolCallContentRenderer from "../../shared/ToolCallContentRenderer.svelte";
  import { getOptionalSubagentTranscriptNavigation } from "../../chat/subagentTranscriptNavigation";
  import { agentPickerIconProps, agentPickerIconUrl } from "../../chat/menus/config/agentConfig";

  let { event, workspaceFolders = [] }: ToolOverrideProps = $props();

  const chatSession = getOptionalACPChatSessionScope();
  const navigation = getOptionalSubagentTranscriptNavigation();
  const registry = optionalAgentRegistry();
  let references = $derived.by(() => {
    const index = chatSession?.subagents ?? buildSubagentTranscriptIndex([event]);
    return index.referencesForTool(event);
  });

  // Pool has no child transcript to open: the parent process consumes the
  // child's stream and reports only its final message, which arrives as this
  // tool call's content. Keep it behind the row rather than dropping it.
  let poolResult = $derived(event.content ?? []);

  // The open/closed choice lives in the transcript's shared expansion state,
  // keyed by toolCallId, so it survives this component remounting when
  // virtualization drops the row off-screen or streaming re-keys it (PE-2402).
  // The local fallback covers rendering without a transcript (stories, tests).
  const expansionSource = getToolCallExpansionContext();
  const insideGroup = isInsideToolCallGroup();
  const expansion = $derived(expansionSource?.());
  let localPoolResultExpanded = $state(false);
  let poolResultExpanded = $derived(
    expansion?.openStateFor(event.toolCallId) ?? localPoolResultExpanded,
  );

  function setPoolResultExpanded(value: boolean) {
    localPoolResultExpanded = value;
    // Expanding a standalone tool pins it so the live fold boundary cannot
    // fold away the result the user just opened (ToolCallExpansionState).
    expansion?.setOpen(event.toolCallId, value, { pin: !insideGroup });
  }

  function activityCount(key: string): number {
    const index = chatSession?.subagents;
    if (!index) return 0;
    return index.claudeEvents(key).length || index.codexEntries(key).length;
  }

  function optionalAgentRegistry(): ReturnType<typeof getACPAgentRegistryRepo> | undefined {
    try {
      return getACPAgentRegistryRepo();
    } catch {
      return undefined;
    }
  }

  function providerAgentServer(reference: SubagentReference): string {
    if (reference.provider === "claude") return "claude-acp";
    if (reference.provider === "pool") return DEFAULT_AGENT_SERVER;
    return "codex-acp";
  }

  function providerIconUrl(reference: SubagentReference): string | undefined {
    return registry ? agentPickerIconUrl(registry, providerAgentServer(reference)) : undefined;
  }

  function providerIconProps(reference: SubagentReference) {
    return registry
      ? agentPickerIconProps(registry, providerAgentServer(reference))
      : { class: "" };
  }

  function rowLabel(reference: SubagentReference): string {
    return reference.provider === "codex" ? actionLabel() : "Delegated to";
  }

  function actionLabel(): string {
    const meta = event._meta as Record<string, unknown> | null | undefined;
    const codex = meta?.codex as Record<string, unknown> | undefined;
    const collaboration = codex?.collaboration as Record<string, unknown> | undefined;
    const action = collaboration?.tool;
    if (action === "spawnAgent") return "Started";
    if (action === "sendInput") return "Messaged";
    if (action === "resumeAgent") return "Resumed";
    if (action === "wait") return "Waited for";
    if (action === "closeAgent") return "Closed";
    return "Subagent";
  }

  const interactiveRowClass =
    "hover:bg-psx-background-secondary text-psx-foreground-secondary hover:text-psx-foreground-primary group flex h-6 max-w-full items-center gap-1.5 rounded-md text-xs transition-colors";
  const staticRowClass =
    "text-psx-foreground-secondary flex h-6 max-w-full items-center gap-1.5 text-xs";
</script>

{#snippet rowContent(reference: SubagentReference)}
  {@const iconProps = providerIconProps(reference)}
  <span class="flex w-4 shrink-0 items-center justify-center">
    <RegistryAgentIcon
      iconUrl={providerIconUrl(reference)}
      size={14}
      {...iconProps}
      class={iconProps.class}
    />
  </span>
  <span class="shrink-0">{rowLabel(reference)}</span>
  <span class="min-w-0 truncate text-current">{reference.title}</span>
  {#if activityCount(reference.key) > 0}
    <span class="shrink-0 opacity-70">{activityCount(reference.key)}</span>
  {/if}
  <span class="text-psx-foreground-tertiary shrink-0">{subagentStatusLabel(reference.status)}</span>
{/snippet}

<div class="flex max-w-full flex-col items-start gap-1">
  {#each references as reference (reference.key)}
    {#if navigation && subagentProvidesTranscript(reference)}
      <button
        type="button"
        class={interactiveRowClass}
        aria-label={`Open subagent transcript: ${reference.title}, ${subagentStatusLabel(reference.status)}`}
        title={`Open ${reference.title} transcript`}
        onclick={() => navigation.open(reference)}
      >
        {@render rowContent(reference)}
        <Icon name="chevron" size={12} class="-rotate-90 opacity-60" aria-hidden="true" />
      </button>
    {:else if reference.provider === "pool" && poolResult.length > 0}
      <div class="flex max-w-full flex-col items-start gap-1">
        <!-- data-disclosure marks this as an inline-content disclosure so the
             transcript's ScrollManager treats the growth as intentional and
             keeps the opened result in view instead of scrolling to bottom. -->
        <button
          type="button"
          class={interactiveRowClass}
          aria-expanded={poolResultExpanded}
          aria-label={`${rowLabel(reference)} ${reference.title}: ${subagentStatusLabel(reference.status)}`}
          title={poolResultExpanded ? "Hide subagent result" : "Show subagent result"}
          data-disclosure
          onclick={() => setPoolResultExpanded(!poolResultExpanded)}
        >
          {@render rowContent(reference)}
          <Icon
            name="chevron"
            size={12}
            class={["shrink-0 opacity-60", !poolResultExpanded && "-rotate-90"]}
            aria-hidden="true"
          />
        </button>
        {#if poolResultExpanded}
          <div
            class="border-psx-border bg-psx-panel max-w-full overflow-hidden rounded-md border text-sm"
          >
            {#each poolResult as content, index (`${content.type}-${index}`)}
              <ToolCallContentRenderer {content} {workspaceFolders} />
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <div
        class={staticRowClass}
        role="status"
        aria-label={`${rowLabel(reference)} ${reference.title}: ${subagentStatusLabel(reference.status)}`}
      >
        {@render rowContent(reference)}
      </div>
    {/if}
  {/each}
</div>
