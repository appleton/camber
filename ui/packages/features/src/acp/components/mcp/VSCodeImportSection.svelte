<script lang="ts">
  import { Badge } from "@camber/components/badge";
  import { Button } from "@camber/components/button";
  import type { VSCodeMcpServer } from "@camber/rpc";
  import { type McpFormState } from "./McpServerForm.svelte";
  import HintTooltip from "./HintTooltip.svelte";

  // "From VS Code" import list: MCP servers discovered in the user's VS Code
  // mcp.json that aren't already added here. The parent passes the pre-filtered
  // importable set; this component owns the preview/show-more paging and the
  // VSCodeMcpServer -> add-form mapping.
  let {
    servers,
    onAdd,
  }: { servers: VSCodeMcpServer[]; onAdd: (initial: Partial<McpFormState>) => void } = $props();

  const TRANSPORT_HINT =
    "Transport — “http” connects to a remote URL; “stdio” runs a local command on your machine.";
  const SOURCE_HINT =
    "Where it's configured — “workspace” is this project's .vscode/mcp.json; “user” is your global VS Code mcp.json.";
  const PREVIEW_LIMIT = 10;

  let showAll = $state(false);
  let visible = $derived(showAll ? servers : servers.slice(0, PREVIEW_LIMIT));

  function toForm(s: VSCodeMcpServer): Partial<McpFormState> {
    if (s.url) {
      return {
        name: s.name,
        transport: "http",
        url: s.url,
        headerLines: mapToLines(s.headers),
        authMode: "none",
      };
    }
    return {
      name: s.name,
      transport: "stdio",
      command: s.command ?? "",
      args: (s.args ?? []).join(" "),
      envLines: mapToLines(s.env),
    };
  }

  function mapToLines(map: Record<string, string> | undefined): string {
    if (!map) return "";
    return Object.entries(map)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }
</script>

{#if servers.length > 0}
  <div class="flex flex-col gap-1.5">
    <div class="flex items-baseline justify-between px-0.5">
      <h3 class="text-psx-foreground-primary text-xs font-semibold uppercase tracking-wide">
        From VS Code
      </h3>
      <span class="text-psx-foreground-secondary text-[11px]">{servers.length}</span>
    </div>
    <p class="text-psx-foreground-secondary px-0.5 text-[13px]/[18px]">
      MCP servers from your VS Code <code>mcp.json</code>. Add them to use here.
    </p>

    <div class="border-psx-border bg-psx-panel overflow-hidden rounded-lg border">
      {#each visible as server (server.name)}
        <div class="border-psx-border flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="text-psx-foreground-primary truncate text-[13px]/[18px] font-medium">
                {server.name}
              </span>
              <HintTooltip text={TRANSPORT_HINT}>
                <Badge intent="neutral" size="xs">{server.url ? "http" : "stdio"}</Badge>
              </HintTooltip>
              <HintTooltip text={SOURCE_HINT}>
                <Badge intent="neutral" size="xs">{server.source}</Badge>
              </HintTooltip>
            </div>
            <span class="text-psx-foreground-secondary truncate font-mono text-[11px]">
              {server.url ?? [server.command, ...(server.args ?? [])].join(" ")}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            appearance="outline"
            onclick={() => onAdd(toForm(server))}
          >
            Add
          </Button>
        </div>
      {/each}

      {#if servers.length > PREVIEW_LIMIT}
        <button
          type="button"
          class="text-psx-foreground-secondary hover:bg-psx-menu-hover-background hover:text-psx-foreground-primary border-psx-border outline-hidden focus-visible:outline-psx-focus w-full border-t px-3 py-2 text-center text-[13px]/[18px] focus-visible:outline-2"
          onclick={() => (showAll = !showAll)}
        >
          {showAll ? "Show less" : `Show ${servers.length - PREVIEW_LIMIT} more`}
        </button>
      {/if}
    </div>
  </div>
{/if}
