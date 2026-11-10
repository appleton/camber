<script lang="ts">
  import type { ContentBlock } from "@agentclientprotocol/sdk";
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import { getACPAgentRegistryRepo } from "../../features/AgentRegistryRepository.svelte";
  import { getACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import {
    subagentStatusIsRunning,
    subagentStatusLabel,
    type CodexSubagentEntry,
  } from "../../subagents";
  import type { ToolCall } from "../../types";
  import ContentRenderer from "../content/ContentRenderer.svelte";
  import SessionEventsRenderer from "../SessionEventsRenderer.svelte";
  import RegistryAgentIcon from "../RegistryAgentIcon.svelte";
  import UserMessageBubble from "../ui/UserMessageBubble.svelte";
  import { agentPickerIconProps, agentPickerIconUrl } from "./menus/config/agentConfig";

  interface Props {
    subagentKey: string;
  }

  let { subagentKey }: Props = $props();
  const chatSession = getACPChatSessionScope();
  const registry = getACPAgentRegistryRepo();

  let reference = $derived(chatSession.subagents.referenceForKey(subagentKey));
  let claudeEvents = $derived(chatSession.subagents.claudeEvents(subagentKey));
  let codexEntries = $derived(chatSession.subagents.codexEntries(subagentKey));
  let running = $derived(subagentStatusIsRunning(reference?.status));
  let sourceTool = $derived.by<ToolCall | undefined>(() => {
    const sourceToolCallId = reference?.sourceToolCallId;
    if (!sourceToolCallId) return undefined;
    const event = chatSession.events.find(
      (candidate) =>
        candidate.eventKind === "tool_call" && candidate.toolCallId === sourceToolCallId,
    );
    return event?.eventKind === "tool_call" ? event : undefined;
  });
  let fallbackResult = $derived(resultText(sourceTool));
  let agentServer = $derived(chatSession.sessionAgentServer ?? chatSession.activeAgentServer);
  let agentIconUrl = $derived(agentPickerIconUrl(registry, agentServer));
  let agentIconProps = $derived(agentPickerIconProps(registry, agentServer));

  function resultText(tool: ToolCall | undefined): string | undefined {
    if (!tool) return undefined;
    if (typeof tool.rawOutput === "string" && tool.rawOutput.trim() !== "") return tool.rawOutput;
    if (tool.rawOutput && typeof tool.rawOutput === "object") {
      const output = tool.rawOutput as Record<string, unknown>;
      for (const key of ["result", "message", "text", "content"]) {
        if (typeof output[key] === "string" && output[key].trim() !== "") {
          return output[key];
        }
      }
    }
    return undefined;
  }

  function delegatedTaskContent(prompt: string): ContentBlock[] {
    return [{ type: "text", text: prompt }];
  }

  function codexEntryLabel(entry: CodexSubagentEntry): string {
    if (entry.activity === "started") return "Started";
    if (entry.activity === "interacted") return "Received input";
    if (entry.activity === "interrupted") return "Interrupted";
    if (entry.action === "spawnAgent") return "Delegated task";
    if (entry.action === "sendInput") return "Sent input";
    if (entry.action === "resumeAgent") return "Resumed";
    if (entry.action === "wait") return "Checked status";
    if (entry.action === "closeAgent") return "Closed";
    return entry.event.title || "Activity";
  }
</script>

<div class="bg-psx-background text-psx-foreground flex h-full min-w-0 flex-col">
  <header class="border-psx-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
    <span class="text-psx-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
      <RegistryAgentIcon
        iconUrl={agentIconUrl}
        size={18}
        {...agentIconProps}
        class={agentIconProps.class}
      />
    </span>
    <div class="min-w-0 flex-1">
      <h1 class="truncate text-sm font-medium">{reference?.title ?? "Subagent transcript"}</h1>
      {#if reference}
        <div class="text-psx-foreground-tertiary flex items-center gap-2 text-xs">
          <span>{reference.provider === "claude" ? "Claude subagent" : "Codex subagent"}</span>
          <span aria-hidden="true">·</span>
          <span>{subagentStatusLabel(reference.status)}</span>
        </div>
      {/if}
    </div>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-5">
      {#if !reference}
        <div class="border-psx-border bg-psx-editor-background rounded-xl border px-4 py-3">
          <div class="text-sm font-medium">Transcript unavailable</div>
          <p class="text-psx-foreground-secondary mt-1 text-sm">
            This subagent could not be found in the restored conversation history.
          </p>
        </div>
      {:else}
        {#if reference.prompt}
          <section aria-label="Delegated task" class="flex flex-col items-end gap-1">
            <div class="text-psx-foreground-tertiary text-[11px] font-medium uppercase">
              Delegated task
            </div>
            <UserMessageBubble>
              <ContentRenderer content={delegatedTaskContent(reference.prompt)} isUser />
            </UserMessageBubble>
          </section>
        {/if}

        {#if reference.model || reference.reasoningEffort}
          <div class="text-psx-foreground-tertiary flex flex-wrap gap-2 text-xs">
            {#if reference.model}<span class="bg-psx-editor-background rounded px-1.5 py-0.5"
                >{reference.model}</span
              >{/if}
            {#if reference.reasoningEffort}<span
                class="bg-psx-editor-background rounded px-1.5 py-0.5"
                >{reference.reasoningEffort} reasoning</span
              >{/if}
          </div>
        {/if}

        {#if reference.provider === "claude"}
          {#if claudeEvents.length > 0}
            <SessionEventsRenderer
              events={claudeEvents}
              isPrompting={running}
              toolActivity="detailed"
            />
          {:else if fallbackResult}
            <div class="whitespace-pre-wrap text-sm">{fallbackResult}</div>
          {:else if running}
            <div class="text-psx-foreground-tertiary flex items-center gap-2 text-sm">
              <Spinner size={14} aria-hidden />
              <span>Waiting for subagent output…</span>
            </div>
          {:else}
            <div class="text-psx-foreground-tertiary text-sm">
              No transcript output was provided by the agent.
            </div>
          {/if}
        {:else}
          <p class="text-psx-foreground-tertiary text-xs">
            Codex currently provides subagent activity and results rather than the full child chat.
          </p>
          <ol class="flex flex-col gap-2" aria-label="Subagent activity">
            {#each codexEntries as entry (`${entry.event.toolCallId}:${entry.index}`)}
              <li class="border-psx-border bg-psx-editor-background rounded-lg border px-3 py-2.5">
                <div class="flex items-center gap-2 text-xs">
                  <Icon name="thread" size={14} aria-hidden="true" />
                  <span class="font-medium">{codexEntryLabel(entry)}</span>
                  {#if entry.status}
                    <span class="text-psx-foreground-tertiary ml-auto"
                      >{subagentStatusLabel(entry.status)}</span
                    >
                  {/if}
                </div>
                {#if entry.message}
                  <div class="mt-2 whitespace-pre-wrap text-sm">{entry.message}</div>
                {/if}
              </li>
            {/each}
          </ol>
          {#if codexEntries.length === 0}
            <div class="text-psx-foreground-tertiary text-sm">
              No subagent activity is available.
            </div>
          {/if}
        {/if}
      {/if}
    </main>
  </div>
</div>
