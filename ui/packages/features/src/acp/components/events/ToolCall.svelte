<script lang="ts">
  import ToolCallContents from "../shared/ToolCallContents.svelte";
  import ToolDiffContent from "../shared/ToolDiffContent.svelte";
  import ToolRoot from "../shared/ToolRoot.svelte";
  import ToolHeader from "../shared/ToolHeader.svelte";
  import ToolBody from "../shared/ToolBody.svelte";
  import ToolFooter from "../shared/ToolFooter.svelte";
  import { Boundary } from "@camber/components/boundary";
  import { HighlightedShellCommand } from "@camber/components/assistant-ui";
  import { CollapsibleContent } from "@camber/components/collapsible";
  import {
    getPermissionDeniedObservation,
    getToolCommand,
    getToolDescription,
    isPermissionDeniedToolCall,
  } from "../shared/toolStatus";
  import { getWrittenFileDiff } from "../shared/toolPaths";
  import { findToolOverride } from "./tool/toolOverrides";
  import type { ToolCall } from "../../types";
  import type { WorkspaceFolder } from "@camber/rpc";

  interface Props {
    event: ToolCall;
    headerClass?: string;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { event, headerClass, workspaceFolders = [] }: Props = $props();

  function stringify(value: unknown): string | undefined {
    if (value == null) return;
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  let hasContent = $derived(!!event.content?.length);
  // A create/write tool's completed `content` only carries a short "Created
  // file …" summary; the file's actual contents live in the raw input. Render
  // them as a new-file diff so the body shows what was written — reading the
  // same `<Diff>` context ToolRoot sets up for the header stats (see
  // getWrittenFileDiff), so the body and header stay in lockstep.
  let writtenFileDiff = $derived(getWrittenFileDiff(event));
  let rawInput = $derived(stringify(event.rawInput));
  let rawOutput = $derived(stringify(event.rawOutput));
  let isPermissionDenied = $derived(isPermissionDeniedToolCall(event));
  let deniedObservation = $derived(getPermissionDeniedObservation(event));
  let command = $derived(getToolCommand(event));
  let description = $derived(getToolDescription(event));
  let toolOverride = $derived(findToolOverride(event));
  let ToolOverrideComponent = $derived(toolOverride?.component);
</script>

{#snippet genericToolCall()}
  <ToolRoot tool={event} {workspaceFolders}>
    <ToolHeader class={headerClass} />

    <ToolBody>
      {#if isPermissionDenied}
        <CollapsibleContent class="relative flex flex-col">
          {#if deniedObservation}
            <div class="border-psx-border text-psx-foreground-secondary border-b px-2.5 py-2">
              {deniedObservation}
            </div>
          {/if}

          {#if description || command}
            <div class="flex flex-col">
              {#if description}
                <div class="text-psx-foreground-secondary px-2.5 pt-2 text-xs italic">
                  {description}
                </div>
              {/if}
              {#if command}
                <div
                  class="font-(family-name:--editor-font-size) block min-h-4 overflow-auto px-2.5 py-2 text-sm"
                >
                  <pre class="whitespace-pre-wrap"><span class="select-none"
                      >$ </span><HighlightedShellCommand {command} /></pre>
                </div>
              {/if}
            </div>
          {/if}
        </CollapsibleContent>
      {:else if writtenFileDiff}
        <CollapsibleContent class="relative flex flex-col gap-2" animated={false}>
          <ToolDiffContent diff={writtenFileDiff} />
        </CollapsibleContent>
      {:else if hasContent}
        <ToolCallContents tool={event} {workspaceFolders} />
      {:else if rawInput || rawOutput}
        <CollapsibleContent class="relative flex max-w-full flex-col">
          <div class="border-psx-border bg-psx-panel overflow-hidden rounded-md border">
            {#if rawInput}
              <div
                class={[
                  "font-(family-name:--editor-font-size) block min-h-4 overflow-auto px-2.5 py-2 text-sm",
                  rawOutput && "border-psx-border border-b",
                ]}
              >
                <pre class="whitespace-pre-wrap break-all">{rawInput}</pre>
              </div>
            {/if}

            {#if rawOutput}
              <div
                class="font-(family-name:--editor-font-size) block min-h-4 overflow-auto px-2.5 py-2 text-sm"
              >
                <pre class="whitespace-pre-wrap break-all">{rawOutput}</pre>
              </div>
            {/if}
          </div>
        </CollapsibleContent>
      {/if}
    </ToolBody>

    <ToolFooter />
  </ToolRoot>
{/snippet}

{#if ToolOverrideComponent}
  <Boundary name={`ACPToolOverride:${toolOverride?.id ?? event.title}`}>
    {#snippet failed(_error, _reset)}
      {@render genericToolCall()}
    {/snippet}

    <ToolOverrideComponent {event} {workspaceFolders} />
  </Boundary>
{:else}
  {@render genericToolCall()}
{/if}
