<script lang="ts">
  import { Badge } from "@camber/components/badge";
  import { Button } from "@camber/components/button";
  import Icon from "@camber/components/icon";
  import { Switch } from "@camber/components/switch";
  import type { MCPServersTestConnectionOutput } from "@camber/helperapi/schemas";
  import {
    getUserMCPServersRepo,
    type MCPServerEntry,
  } from "../../features/UserMCPServersRepository.svelte";
  import { catalogCardClass } from "../settings/catalogCardStyles";
  import type { MenuSpecItem } from "../ui/menuSpec";
  import type { McpFormState } from "./McpServerForm.svelte";
  import SearchField from "../sidebar/SearchField.svelte";
  import ConnectorServiceIcon from "./ConnectorServiceIcon.svelte";
  import McpRowMenu from "./McpRowMenu.svelte";
  import {
    CONNECTOR_CATALOG,
    CONNECTOR_CATALOG_CATEGORIES,
    type ConnectorCatalogEntry,
    findConnectorCatalogEntry,
  } from "./connectorCatalog";

  interface Props {
    servers: MCPServerEntry[];
    testResults: Record<string, MCPServersTestConnectionOutput>;
    needsOAuthSignIn: (server: MCPServerEntry) => boolean;
    onAddCustom: () => void;
    onPick: (form: Partial<McpFormState>) => void;
  }

  type CatalogStatus = {
    tone: "connected" | "not-connected" | "needs-attention" | "disabled";
    label: "Connected" | "Not connected" | "Needs attention" | "Disabled";
    detail?: string;
  };

  type ConnectorCard = {
    key: string;
    id: string;
    label: string;
    blurb: string;
    note?: string;
    connectorID?: string;
    form?: Partial<McpFormState>;
    server?: MCPServerEntry;
  };

  let { servers, testResults, needsOAuthSignIn, onAddCustom, onPick }: Props = $props();
  const repo = getUserMCPServersRepo();
  let searchQuery = $state("");
  // Keyed by server name — authenticate() failures aren't surfaced by
  // repo.isAuthenticating (it resets to null once the attempt settles), so
  // each card tracks its own most recent sign-in failure to show inline.
  let authErrors = $state<Record<string, string>>({});

  async function handleAuthenticate(server: MCPServerEntry) {
    const { name } = server;
    if (authErrors[name]) {
      const next = { ...authErrors };
      delete next[name];
      authErrors = next;
    }
    try {
      await repo.authenticate(name);
    } catch {
      authErrors = { ...authErrors, [name]: repo.error ?? "Authentication failed" };
    }
  }

  let normalizedQuery = $derived(searchQuery.trim().toLowerCase());
  let groups = $derived.by(() => {
    const matchesSearch = (card: ConnectorCard) =>
      !normalizedQuery ||
      [card.label, card.blurb, card.id, card.server?.name, card.server?.url, card.server?.command]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalizedQuery));

    const installedEntries = servers.map(installedCard).filter(matchesSearch);
    const installedGroup = {
      id: "installed",
      label: "Installed",
      entries: installedEntries,
    };
    // searchOnly entries stay out of the browsed catalog and only appear when
    // the query names them exactly (staff are told the magic word).
    const revealedBySearch = (entry: ConnectorCatalogEntry) =>
      normalizedQuery === entry.id || normalizedQuery === entry.label.toLowerCase();

    const categoryGroups = CONNECTOR_CATALOG_CATEGORIES.map((category) => {
      const entries = CONNECTOR_CATALOG.filter(
        (entry) =>
          entry.category === category.id &&
          !serverFor(entry) &&
          (!entry.searchOnly || revealedBySearch(entry)),
      )
        .map(catalogCard)
        .filter(matchesSearch);
      return {
        ...category,
        entries,
      };
    });

    return [installedGroup, ...categoryGroups].filter((group) => group.entries.length > 0);
  });

  function normalized(value: string | undefined): string {
    return (value ?? "").trim().toLowerCase();
  }

  function catalogCard(entry: ConnectorCatalogEntry): ConnectorCard {
    return {
      key: `catalog:${entry.id}`,
      id: entry.id,
      label: entry.label,
      blurb: entry.blurb,
      note: entry.note,
      connectorID: entry.id,
      form: entry.form,
    };
  }

  function installedCard(server: MCPServerEntry): ConnectorCard {
    const entry = findConnectorCatalogEntry(server);
    return {
      key: `installed:${server.name}`,
      id: entry?.id ?? server.builtinID ?? server.name,
      label: entry?.label ?? server.name,
      blurb: entry?.blurb ?? serverDetail(server),
      connectorID: entry?.id ?? server.builtinID,
      server,
    };
  }

  function serverDetail(server: MCPServerEntry): string {
    return server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
  }

  function serverFor(entry: ConnectorCatalogEntry): MCPServerEntry | undefined {
    return (
      servers.find((server) => normalized(server.builtinID) === entry.id) ??
      servers.find(
        (server) =>
          !server.builtinID && normalized(server.name) === normalized(entry.form.name ?? entry.id),
      )
    );
  }

  function statusFor(server: MCPServerEntry | undefined): CatalogStatus {
    if (!server) return { tone: "not-connected", label: "Not connected" };
    if (!server.enabled) return { tone: "disabled", label: "Disabled" };
    if (server.authMode === "oauth" && needsOAuthSignIn(server)) {
      return { tone: "needs-attention", label: "Needs attention", detail: "Sign in" };
    }

    const testResult = testResults[server.name];
    if (testResult && !testResult.ok) {
      return { tone: "needs-attention", label: "Needs attention", detail: "Test failed" };
    }
    return {
      tone: "connected",
      label: "Connected",
      detail: testResult?.ok ? `${testResult.toolCount} tools` : undefined,
    };
  }

  function badgeIntent(status: CatalogStatus): "positive" | "warning" | "neutral" {
    if (status.tone === "connected") return "positive";
    if (status.tone === "needs-attention") return "warning";
    return "neutral";
  }

  function statusIcon(status: CatalogStatus): "checked" | "alert" | "block" {
    if (status.tone === "connected") return "checked";
    if (status.tone === "needs-attention") return "alert";
    return "block";
  }

  function menuItemsFor(server: MCPServerEntry): MenuSpecItem[] {
    const items: MenuSpecItem[] = [
      { kind: "action", id: "test-connection", label: "Test connection", icon: "run" },
    ];
    if (server.authMode === "oauth") {
      const authenticated = repo.isOAuthAuthenticated(server);
      items.push({
        kind: "action",
        id: authenticated ? "sign-out" : "authenticate",
        label: authenticated ? "Sign out" : "Authenticate",
        icon: authenticated ? "block" : "key",
      });
    }
    items.push({ kind: "separator" });
    items.push({ kind: "action", id: "delete", label: "Delete", icon: "trash", destructive: true });
    return items;
  }

  function handleMenuSelect(server: MCPServerEntry, id: string) {
    if (id === "test-connection") void repo.testConnection(server.name);
    else if (id === "authenticate") void handleAuthenticate(server);
    else if (id === "sign-out") void repo.signOut(server.name);
    else if (id === "delete") void repo.delete(server.name);
  }
</script>

{#snippet cardContent(entry: ConnectorCard)}
  <div class="flex min-w-0 flex-1 items-center gap-3 text-left">
    <ConnectorServiceIcon connectorID={entry.connectorID} />
    <div class="min-w-0 flex-1">
      <div class="text-psx-foreground-primary truncate text-[13px]/[18px] font-medium">
        {entry.label}
      </div>
      <div
        class="text-psx-foreground-secondary mt-0.5 truncate text-[12px]/[16px]"
        title={entry.blurb}
      >
        {entry.blurb}
      </div>
      {#if entry.note}
        <div
          class="text-psx-warning-foreground mt-0.5 flex items-start gap-1 text-[12px]/[16px]"
          data-connector-note
        >
          <Icon name="alert" size={12} class="mt-px shrink-0" />
          <span>{entry.note}</span>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet statusBadge(status: CatalogStatus)}
  <Badge
    intent={badgeIntent(status)}
    size="xs"
    radius="full"
    class="shrink-0 whitespace-nowrap"
    data-status={status.tone}
  >
    {#if status.tone === "not-connected"}
      <span class="size-2.5 rounded-full border border-current" aria-hidden="true"></span>
    {:else}
      <Icon name={statusIcon(status)} size={11} />
    {/if}
    {status.label}
    {#if status.detail}<span class="opacity-70">· {status.detail}</span>{/if}
  </Badge>
{/snippet}

{#snippet installedControls(server: MCPServerEntry)}
  <Switch
    checked={server.enabled}
    onCheckedChange={(enabled) => void repo.setEnabled(server.name, enabled)}
    aria-label={server.enabled ? `Disable ${server.name}` : `Enable ${server.name}`}
  />

  <McpRowMenu
    busy={repo.isTesting === server.name}
    items={menuItemsFor(server)}
    onSelect={(id) => handleMenuSelect(server, id)}
  />
{/snippet}

<div class="connector-catalog flex flex-col gap-3">
  <div class="connector-catalog-controls">
    <SearchField bind:value={searchQuery} placeholder="Search connectors" class="w-full" />
    <Button
      type="button"
      size="sm"
      appearance="outline"
      class="connector-catalog-add w-full"
      onclick={onAddCustom}
    >
      <Icon name="plus" size={14} />
      Add Custom MCP
    </Button>
  </div>

  {#if groups.length === 0}
    <div
      class="border-psx-border bg-psx-panel text-psx-foreground-secondary rounded-lg border px-3 py-6 text-center text-[13px]/[18px]"
    >
      No connectors match “{searchQuery.trim()}”.
    </div>
  {:else}
    <div class="flex flex-col gap-5">
      {#each groups as group (group.id)}
        <section class="flex flex-col gap-2" aria-labelledby={`connector-category-${group.id}`}>
          <div class="pl-3">
            <h4
              id={`connector-category-${group.id}`}
              class="text-psx-foreground-primary text-[12px]/[16px] font-medium"
            >
              {group.label}
            </h4>
          </div>

          <div class="connector-catalog-grid">
            {#each group.entries as entry (entry.key)}
              {@const server = entry.server}
              {@const status = statusFor(server)}
              {#if server}
                <div
                  class={`${catalogCardClass} flex min-w-0 flex-col gap-1 rounded-xl px-3 py-2.5`}
                  data-connector-id={entry.id}
                >
                  <div class="flex min-h-[38px] min-w-0 items-center gap-2">
                    {@render cardContent(entry)}
                    <div
                      class="ml-2 flex shrink-0 flex-col items-end gap-1.5"
                      data-installed-card-actions
                    >
                      {@render statusBadge(status)}
                      <div class="flex items-center gap-2">
                        {@render installedControls(server)}
                      </div>
                    </div>
                  </div>
                  {#if authErrors[server.name]}
                    <div class="flex items-start gap-1.5 pl-[42px]" data-connector-auth-error>
                      <Icon
                        name="error"
                        size={12}
                        class="text-psx-error-foreground mt-px shrink-0"
                      />
                      <span class="text-psx-error-foreground text-[12px]/[16px]">
                        {authErrors[server.name]}
                      </span>
                    </div>
                  {/if}
                </div>
              {:else}
                <button
                  type="button"
                  class={`${catalogCardClass} outline-hidden focus-visible:outline-psx-focus flex min-h-[58px] min-w-0 cursor-default items-center rounded-xl px-3 py-2.5 focus-visible:outline-2`}
                  data-connector-id={entry.id}
                  aria-label={`Connect ${entry.label}`}
                  onclick={() => entry.form && onPick(entry.form)}
                >
                  {@render cardContent(entry)}
                  <div class="ml-2 shrink-0">{@render statusBadge(status)}</div>
                </button>
              {/if}
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style lang="postcss">
  .connector-catalog {
    width: 100%;
    max-width: 56rem;
    margin-inline: auto;
    container-type: inline-size;
  }

  .connector-catalog-controls {
    display: grid;
    width: 75%;
    margin-inline: auto;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }

  .connector-catalog-add {
    width: auto;
  }

  @container (max-width: 40rem) {
    .connector-catalog-controls {
      width: 100%;
      grid-template-columns: minmax(0, 1fr);
    }

    .connector-catalog-add {
      width: 100%;
    }
  }

  .connector-catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 27rem), 1fr));
    gap: 8px;
  }
</style>
