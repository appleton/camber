<script lang="ts">
  import { CollapsibleContent } from "@camber/components/collapsible";
  import type { WorkspaceFolder } from "@camber/rpc";
  import type { ToolCall } from "../../../types";
  import ToolRoot from "../../shared/ToolRoot.svelte";
  import ToolBody from "../../shared/ToolBody.svelte";
  import ToolCallContentRenderer from "../../shared/ToolCallContentRenderer.svelte";
  import CuaReplToolHeader from "./CuaReplToolHeader.svelte";
  import McpJsonContent from "./McpJsonContent.svelte";
  import { getCuaReplContent, getCuaReplInput, getCuaReplMethod } from "./cuaReplTool";
  import { prettyPrintJson } from "./mcpTool";

  interface Props {
    event: ToolCall;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { event, workspaceFolders = [] }: Props = $props();
  const input = $derived(getCuaReplInput(event));
  const outputContent = $derived(getCuaReplContent(event));
  const title = $derived(getCuaReplMethod(event) === "js_reset" ? "Reset session" : input.title);
  const rawInput = $derived(
    !input.code && getCuaReplMethod(event) !== "js_reset" ? event.rawInput : undefined,
  );
</script>

{#snippet textSection(value: unknown, label?: string, language?: string)}
  {@const json = language ? undefined : prettyPrintJson(value)}
  {@const text = json ?? (typeof value === "string" ? value : undefined)}
  {#if text}
    <div class="border-psx-border bg-psx-panel overflow-hidden rounded-md border">
      {#if label}
        <div class="border-psx-border border-b px-2.5 py-1.5 text-xs">{label}</div>
      {/if}
      <div class="max-h-80 overflow-auto px-2.5 py-2 font-mono text-sm">
        <McpJsonContent {text} lang={language ?? (json ? "json" : undefined)} />
      </div>
    </div>
  {/if}
{/snippet}

<ToolRoot tool={event} {workspaceFolders}>
  <CuaReplToolHeader {title} />
  <ToolBody>
    <CollapsibleContent class="relative flex max-w-full flex-col gap-2">
      {#if input.code}
        {@render textSection(input.code, "JavaScript", "javascript")}
      {:else if rawInput != null}
        {@render textSection(rawInput, "Input")}
      {/if}

      <!-- Keep screenshots and text in their original order. Accessibility
           snapshots are plain text, so indentation and markup stay literal. -->
      {#each outputContent as content, i (`${content.type}-${i}`)}
        {#if content.type === "content" && content.content.type === "text"}
          {@render textSection(content.content.text)}
        {:else}
          <ToolCallContentRenderer {content} {workspaceFolders} />
        {/if}
      {:else}
        {#if event.rawOutput != null}
          {@render textSection(event.rawOutput, "Output")}
        {/if}
      {/each}
    </CollapsibleContent>
  </ToolBody>
</ToolRoot>
