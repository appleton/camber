<script lang="ts" module>
  import { createContext } from "svelte";
  import type { WorkspaceFolder } from "@camber/rpc";
  import type { ToolCall, ToolCallDiffContent } from "../../types";

  export type ToolContext = {
    tool: ToolCall;
    icon?: IconName | IconProps | "loading";
    open: boolean;
    diff?: ToolCallDiffContent;
    /**
     * Header stats aggregated across every diff content block. Only set for
     * multi-block tool calls; the ambient Diff context (built from the first
     * block) already carries the stats otherwise.
     */
    diffStats?: { additions: number; deletions: number };
    workspaceFolders: WorkspaceFolder[];
    homeDirectory?: string;
  };

  export const [getToolContext, setToolContext] = createContext<ToolContext>();
</script>

<script lang="ts">
  import { Boundary } from "@camber/components/boundary";
  import { Collapsible } from "@camber/components/collapsible";
  import { Diff, diffLines } from "@camber/components/diff";
  import type { IconName, IconProps } from "@camber/components/icon";
  import type { Snippet } from "svelte";
  import { getReadableFileInfo } from "../../shared/paths";
  import { getToolCallExpansionContext, isInsideToolCallGroup } from "../SessionEventsState.svelte";
  import { getToolIcon } from "./toolIcon";
  import { getToolPath, getWrittenFileDiff } from "./toolPaths";
  import { isPermissionDeniedToolCall } from "./toolStatus";
  import { appState } from "../../hostAdapter";

  interface Props {
    tool: ToolCall;
    icon?: IconName | IconProps;
    workspaceFolders?: WorkspaceFolder[];
    children?: Snippet;
  }

  let { tool, workspaceFolders = [], children }: Props = $props();

  let toolPath = $derived(getToolPath(tool));
  let parsedToolPath = $derived(
    toolPath ? getReadableFileInfo(toolPath, workspaceFolders, $appState.homeDirectory) : undefined,
  );
  let icon = $derived.by<IconName | IconProps | "loading" | undefined>(() => {
    if (tool.status === "in_progress") return "loading";
    return getToolIcon(tool, parsedToolPath?.absolutePath ?? parsedToolPath?.fileName);
  });

  // Prefer a synthetic diff built from a write tool's raw input: a completed
  // write replaces its diff `content` block with a summary, so reading only the
  // block would make the header's diff stats flicker off the moment it lands.
  let diff = $derived(
    getWrittenFileDiff(tool) ?? tool.content?.find((content) => content.type === "diff"),
  );
  let parsedPath = $derived(
    diff ? getReadableFileInfo(diff.path, workspaceFolders, $appState.homeDirectory) : undefined,
  );

  // A multi-hunk edit arrives as several diff content blocks; the Diff context
  // below only covers the first, so its stats would underreport the header.
  let diffStats = $derived.by(() => {
    const blocks = tool.content?.filter((content) => content.type === "diff") ?? [];
    if (getWrittenFileDiff(tool) || blocks.length < 2) return undefined;
    let additions = 0;
    let deletions = 0;
    for (const block of blocks) {
      const { stats } = diffLines(block.oldText ?? "", block.newText);
      additions += stats.additions;
      deletions += stats.deletions;
    }
    return { additions, deletions };
  });

  const expansionSource = getToolCallExpansionContext();
  const insideGroup = isInsideToolCallGroup();
  const expansion = $derived(expansionSource?.());

  // The user's expand/collapse choice lives in the transcript's shared
  // expansion state, keyed by toolCallId, so it survives this component
  // remounting when streaming re-keys the row (PE-2402). The local fallback
  // covers tools rendered without a transcript (stories, previews) and the
  // default before the user has toggled.
  let localOpen = $state(isPermissionDeniedToolCall(tool));
  const open = $derived(expansion?.openStateFor(tool.toolCallId) ?? localOpen);

  function setOpen(value: boolean) {
    localOpen = value;
    // Expanding a standalone tool pins it: the live fold boundary freezes
    // there so streaming cannot fold the block away (ToolCallExpansionState).
    expansion?.setOpen(tool.toolCallId, value, { pin: !insideGroup });
  }

  setToolContext({
    get tool() {
      return tool;
    },
    get open() {
      return open;
    },
    get icon() {
      return icon;
    },
    get diff() {
      return diff;
    },
    get diffStats() {
      return diffStats;
    },
    get workspaceFolders() {
      return workspaceFolders;
    },
    get homeDirectory() {
      return $appState.homeDirectory;
    },
  });
</script>

{#snippet root()}
  <!-- w-full (not fit-content via self-start) so expanded bodies span the
       thread column and align with the surrounding content instead of
       shrinking to their own width; the header stays w-fit, so collapsed
       tools look the same. -->
  <Collapsible
    bind:open={() => open, setOpen}
    class="text-psx-foreground-secondary relative flex w-full max-w-full shrink-0 flex-col"
  >
    {@render children?.()}
  </Collapsible>
{/snippet}

<Boundary name={tool.title}>
  {#if diff}
    <Diff
      oldFilename={parsedPath?.fileName}
      newFilename={parsedPath?.fileName}
      oldContent={diff.oldText ?? undefined}
      newContent={diff.newText}
    >
      {@render root()}
    </Diff>
  {:else}
    {@render root()}
  {/if}
</Boundary>
