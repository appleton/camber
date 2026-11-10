<script lang="ts">
  import { Badge } from "@camber/components/badge";
  import { Switch } from "@camber/components/switch";
  import type { MCPServerInputs } from "@camber/helperapi/schemas";
  import { getACPMCPSettingsRepo } from "../../features/MCPSettingsRepository.context";
  import type { MenuSpecItem } from "../ui/menuSpec";
  import ConnectorServiceIcon from "./ConnectorServiceIcon.svelte";
  import McpVariableField from "./McpVariableField.svelte";
  import McpRowMenu from "./McpRowMenu.svelte";
  import { findConnectorCatalogEntry } from "./connectorCatalog";

  interface Props {
    server: MCPServerInputs;
  }

  let { server }: Props = $props();

  // Always rendered under the MCP settings provider (from UserMCPServersSection).
  const repo = getACPMCPSettingsRepo()!;

  const NIL_UUID = "00000000-0000-0000-0000-000000000000";

  let disabled = $derived(repo.isServerDisabled(server));
  let desiredEnabled = $state<boolean | null>(null);
  let enabled = $derived(desiredEnabled ?? !disabled);
  let status = $derived(repo.getServerStatus(server));
  let isRemote = $derived(server.serverID !== NIL_UUID && server.serverID !== "");
  let isAuthenticated = $derived.by(() => {
    if (!server.requiresOAuth) return false;
    const local = repo.oauthState[server.serverName];
    return local !== undefined ? local : server.isAuthenticated;
  });
  let hasVariables = $derived((server.variables?.length ?? 0) > 0);
  let catalogEntry = $derived(findConnectorCatalogEntry({ name: server.serverName }));

  let expanded = $state(false);
  let didAutoExpand = $state(false);
  let busy = $state<null | "auth" | "signout">(null);
  let error = $state<string | null>(null);
  let toggleSaveToken = 0;
  let toggleSaveQueue: Promise<void> = Promise.resolve();

  // Surface variable setup automatically when the connector needs it.
  $effect(() => {
    if (!didAutoExpand && enabled && status === "needs_setup" && hasVariables) {
      didAutoExpand = true;
      expanded = true;
    }
  });

  async function toggle(next: boolean) {
    const token = ++toggleSaveToken;
    desiredEnabled = next;
    error = null;
    const operation = toggleSaveQueue.then(async () => {
      await repo.persistServerDisabled(server.serverName, !next);
    });
    toggleSaveQueue = operation.catch(() => undefined);
    try {
      await operation;
      if (token === toggleSaveToken) desiredEnabled = null;
    } catch (e) {
      if (token === toggleSaveToken) {
        desiredEnabled = null;
        error = e instanceof Error ? e.message : "Failed to update connector";
      }
    }
  }

  async function authenticate() {
    busy = "auth";
    error = null;
    try {
      await repo.authenticate(server);
    } catch (e) {
      error = e instanceof Error ? e.message : "Authentication failed";
    } finally {
      busy = null;
    }
  }

  async function signOut() {
    busy = "signout";
    error = null;
    try {
      await repo.deleteSecrets(server);
    } catch (e) {
      error = e instanceof Error ? e.message : "Sign out failed";
    } finally {
      busy = null;
    }
  }

  let menuItems = $derived.by((): MenuSpecItem[] => {
    const menu: MenuSpecItem[] = [];
    if (server.requiresOAuth && !isAuthenticated) {
      menu.push({ kind: "action", id: "authenticate", label: "Authenticate", icon: "key" });
    }
    if (server.requiresOAuth && isAuthenticated) {
      menu.push({ kind: "action", id: "sign-out", label: "Sign out", icon: "block" });
    }
    if (hasVariables) {
      menu.push({
        kind: "action",
        id: "toggle-variables",
        label: expanded ? "Hide setup" : "Set up variables",
        icon: "config",
      });
    }
    if (!server.requiresOAuth && !hasVariables) {
      menu.push({
        kind: "action",
        id: "managed",
        label: "Managed by Camber",
        icon: "info",
        enabled: false,
      });
    }
    return menu;
  });

  function handleMenuSelect(id: string) {
    if (id === "authenticate") void authenticate();
    else if (id === "sign-out") void signOut();
    else if (id === "toggle-variables") expanded = !expanded;
  }
</script>

<div class="border-psx-border flex flex-col border-b last:border-b-0">
  <div class="flex items-center gap-2.5 px-3 py-2.5">
    <ConnectorServiceIcon connectorID={catalogEntry?.id} />
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <div class="flex min-w-0 items-center gap-1.5">
        <span class="text-psx-foreground-primary truncate text-[13px]/[18px] font-medium">
          {server.serverName}
        </span>
        {#if !enabled}
          <Badge intent="neutral" size="xs">Off</Badge>
        {:else if status === "ready"}
          <Badge intent="positive" size="xs">Connected</Badge>
        {:else}
          <Badge intent="warning" size="xs">Needs setup</Badge>
        {/if}
      </div>
      <span class="text-psx-foreground-secondary truncate text-[13px]/[18px]">
        {isRemote ? server.serverURL || "Remote connector" : "Local connector"}
      </span>
    </div>

    <Switch
      checked={enabled}
      onCheckedChange={(v) => void toggle(v)}
      aria-label={enabled ? "Disable connector" : "Enable connector"}
    />

    <McpRowMenu
      busy={busy === "auth" || busy === "signout"}
      widthClass="w-[200px]"
      items={menuItems}
      onSelect={handleMenuSelect}
    />
  </div>

  {#if expanded && hasVariables}
    <div
      class="border-psx-border bg-psx-editor-background/40 flex flex-col gap-2.5 border-t px-3 py-3"
    >
      {#each server.variables as variable (variable.name)}
        <McpVariableField {server} {variable} />
      {/each}
    </div>
  {/if}

  {#if error}
    <div class="text-psx-error-foreground px-3 pb-2 text-[13px]/[18px]">{error}</div>
  {/if}
</div>
