<script lang="ts">
  import { CollapsibleContent } from "@camber/components/collapsible";
  import type { WorkspaceFolder } from "@camber/rpc";
  import type { ToolCall } from "../../../types";
  import ToolRoot from "../../shared/ToolRoot.svelte";
  import ToolBody from "../../shared/ToolBody.svelte";
  import ToolFooter from "../../shared/ToolFooter.svelte";
  import ToolCallContentRenderer from "../../shared/ToolCallContentRenderer.svelte";
  import McpToolHeader from "./McpToolHeader.svelte";
  import McpJsonContent from "./McpJsonContent.svelte";
  import { getMcpToolInfo, prettyPrintJson } from "./mcpTool";

  interface Props {
    event: ToolCall;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { event, workspaceFolders = [] }: Props = $props();

  let info = $derived(getMcpToolInfo(event));

  type TextSection = { key: string; text: string; lang?: string };

  function section(key: string, value: unknown): TextSection | undefined {
    if (value == null) return;
    const pretty = prettyPrintJson(value);
    if (pretty !== undefined) return { key, text: pretty, lang: "json" };
    return typeof value === "string" ? { key, text: value } : undefined;
  }

  // Text blocks in an MCP result carry the tool's raw payload (usually a
  // serialized JSON document), not markdown; render them pretty-printed
  // instead of through the markdown pipeline the generic tool body uses.
  let textSections = $derived(
    (event.content ?? [])
      .flatMap((item, i) =>
        item.type === "content" && item.content.type === "text"
          ? [section(`content-${i}`, item.content.text)]
          : [],
      )
      .filter((item): item is TextSection => item !== undefined),
  );
  // Non-text blocks (images, resources, diffs) keep the standard renderers.
  let otherContent = $derived(
    (event.content ?? []).filter(
      (item) => !(item.type === "content" && item.content.type === "text"),
    ),
  );
  // Without structured content, fall back to the raw request/response like the
  // generic tool call does — still pretty-printed.
  let fallbackSections = $derived(
    textSections.length || otherContent.length
      ? []
      : [section("input", event.rawInput), section("output", event.rawOutput)].filter(
          (item): item is TextSection => item !== undefined,
        ),
  );
  let sections = $derived([...textSections, ...fallbackSections]);
</script>

<ToolRoot tool={event} {workspaceFolders}>
  <McpToolHeader {info} />

  <ToolBody>
    {#if sections.length || otherContent.length}
      <CollapsibleContent class="relative flex max-w-full flex-col gap-2">
        {#if sections.length}
          <div class="border-psx-border bg-psx-panel overflow-hidden rounded-md border">
            {#each sections as item, i (item.key)}
              <!-- max-h-80 matches the shell output cap (ExecCommandToolCall),
                   so a large JSON payload scrolls instead of stretching the
                   thread. -->
              <div
                class={[
                  "font-(family-name:--editor-font-size) block max-h-80 min-h-4 overflow-auto px-2.5 py-2 text-sm",
                  i < sections.length - 1 && "border-psx-border border-b",
                ]}
              >
                <McpJsonContent text={item.text} lang={item.lang} />
              </div>
            {/each}
          </div>
        {/if}

        {#each otherContent as content, i (`${content.type}-${i}`)}
          <ToolCallContentRenderer {content} {workspaceFolders} />
        {/each}
      </CollapsibleContent>
    {/if}
  </ToolBody>

  <ToolFooter />
</ToolRoot>
