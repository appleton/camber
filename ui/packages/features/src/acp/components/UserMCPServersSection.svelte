<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import type { VSCodeMcpServer } from "@camber/rpc";
  import { rpc } from "../hostRpc";
  import { getUserMCPServersRepo } from "../features/UserMCPServersRepository.svelte";
  import { getACPMCPSettingsRepo } from "../features/MCPSettingsRepository.context";
  import {
    getACPActiveAgentAllowsCustomMcp,
    getACPActiveAgentSupportsMcp,
  } from "../features/activeAgent.svelte";
  import McpServerForm, { type McpFormState } from "./mcp/McpServerForm.svelte";
  import PoolMcpServerRow from "./mcp/PoolMcpServerRow.svelte";
  import ConnectorCatalog from "./mcp/ConnectorCatalog.svelte";
  import { CONNECTOR_CATALOG } from "./mcp/connectorCatalog";
  import {
    consumePendingConnectorCatalogAdd,
    onConnectorCatalogAddRequest,
  } from "./mcp/connectorDeepLink";
  import HintTooltip from "./mcp/HintTooltip.svelte";
  import VSCodeImportSection from "./mcp/VSCodeImportSection.svelte";

  interface Props {
    showHeading?: boolean;
  }

  let { showHeading = true }: Props = $props();

  const repo = getUserMCPServersRepo();
  const sessionRepo = getACPMCPSettingsRepo();

  let showForm = $state(false);
  let formInitial = $state<Partial<McpFormState> | undefined>(undefined);

  // MCP servers the user already configured in VS Code (empty off VS Code).
  let vscodeServers = $state<VSCodeMcpServer[]>([]);

  let userServers = $derived(repo.servers);
  // Pool connectors split into remotely-configured (registered, real server ID)
  // and locally-configured (nil UUID). De-dupe by name within each group so the
  // keyed lists never collide.
  let remotePool = $derived(dedupeByName(sessionRepo?.remoteServers ?? []));
  let localPool = $derived(dedupeByName(sessionRepo?.localServers ?? []));
  let poolCount = $derived(remotePool.length + localPool.length);
  let installedNames = $derived(userServers.map((s) => s.name));
  let installedSet = $derived(new Set(installedNames.map((n) => n.toLowerCase())));
  let importableVSCode = $derived(
    vscodeServers.filter((s) => !installedSet.has(s.name.toLowerCase())),
  );

  function dedupeByName<T extends { serverName: string }>(servers: T[]): T[] {
    const seen = new Set<string>();
    return servers.filter((s) => {
      if (seen.has(s.serverName)) return false;
      seen.add(s.serverName);
      return true;
    });
  }

  // --- Pool/session connector wiring -------------------------------------
  // The pool injects MCP servers per-session. We must spin up (or reuse) a
  // settings-capable session and fetch its servers, otherwise this list is
  // empty. Mirrors the trigger logic the old prompt menu used.
  // Only relevant when the active agent is the Camber agent.
  let isPoolAgent = $derived(sessionRepo?.isActiveAgentPool() ?? false);
  // Whether the active Camber model allows user/custom MCP servers. This is
  // per-model, and the live chat session is the only place that knows it. IDE
  // sidebars receive the authoritative value broadcast by their chat panel;
  // desktop can read it from the active session-backed settings repository.
  // Never fall back to a sidebar config probe because it can use a different
  // (default) model. When the policy is explicitly false, the user's own
  // connectors won't be injected — warn them. `null` (unknown / no active pool
  // chat) stays quiet.
  let activeAllowsCustomMcp = $derived(
    getACPActiveAgentAllowsCustomMcp() ??
      sessionRepo?.activeSessionAllowsCustomMCPServers() ??
      null,
  );
  let customMcpBlocked = $derived(isPoolAgent && activeAllowsCustomMcp === false);

  // Some non-pool agents don't support MCP connectors at all (e.g. lightweight
  // agents). Each chat broadcasts whether its agent advertises MCP capability;
  // when it's explicitly false, warn that connectors won't work there. The pool
  // agent always supports MCP (it handles servers itself), so this never applies
  // to it — there, custom-MCP availability is governed by `customMcpBlocked`.
  let agentMcpUnsupported = $derived(!isPoolAgent && getACPActiveAgentSupportsMcp() === false);

  // At most one connector warning applies — the two conditions are mutually
  // exclusive (one needs the pool agent, the other a non-pool agent).
  let mcpWarning = $derived.by((): { title: string; body: string } | null => {
    if (customMcpBlocked) {
      return {
        title: "Custom connectors are off for this agent",
        body: "This Camber agent has custom MCP servers disabled, so your connectors won't run here. Ask an admin to enable it, or switch agents.",
      };
    }
    if (agentMcpUnsupported) {
      return {
        title: "This agent doesn't support connectors",
        body: "Your connectors won't run in this chat. Switch to an agent that supports MCP.",
      };
    }
    return null;
  });

  let settingsKey = $derived(sessionRepo?.activeSettingsKey() ?? null);
  let shouldEnsureSession = $derived(
    !!sessionRepo && isPoolAgent && !settingsKey && sessionRepo.canEnsureSettingsSession(),
  );
  let ensuredSession = $state(false);
  // Set when an ensure attempt completed without producing a probe session, so
  // we stop showing the spinner instead of latching ensuredSession forever (e.g.
  // the probe rebuild failed). Cleared when the agent/session changes.
  let probeUnavailable = $state(false);
  let lastFetchedKey = $state<string | null>(null);

  // True while we're still establishing the session / fetching, including the
  // window between mount and the first fetch where isLoading is briefly false.
  // Without this, the empty-state text flashes before data arrives.
  let poolLoading = $derived(
    isPoolAgent &&
      poolCount === 0 &&
      !sessionRepo?.error &&
      !probeUnavailable &&
      ((sessionRepo?.isLoading ?? false) || shouldEnsureSession),
  );

  $effect(() => {
    if (shouldEnsureSession && !ensuredSession) {
      ensuredSession = true;
      probeUnavailable = false;
      void (async () => {
        try {
          await sessionRepo?.ensureSettingsSession();
        } catch {
          // ensureConfigProbe swallows its own errors; the check below also
          // covers the case where the probe simply never materialized.
        }
        // One-shot: if no probe session appeared, stop the spinner rather than
        // latch forever. Reopening the view retries.
        if (shouldEnsureSession && !sessionRepo?.activeSettingsKey()) {
          probeUnavailable = true;
        }
      })();
    } else if (!shouldEnsureSession) {
      ensuredSession = false;
      probeUnavailable = false;
    }
  });

  $effect(() => {
    if (!sessionRepo) return;
    if (settingsKey && settingsKey !== lastFetchedKey) {
      lastFetchedKey = settingsKey;
      void sessionRepo.refresh();
    } else if (!settingsKey && lastFetchedKey) {
      lastFetchedKey = null;
      sessionRepo.reset();
    }
  });

  onMount(() => {
    void repo.load();
    // Host returns undefined off VS Code (no such method) — treat as empty.
    void rpc
      .listVSCodeMcpServers?.()
      .then((servers) => {
        vscodeServers = servers ?? [];
      })
      .catch(() => {});
  });

  function openAddForm(initial?: Partial<McpFormState>) {
    formInitial = initial;
    showForm = true;
  }

  function openCatalogConnector(id: string) {
    const entry = CONNECTOR_CATALOG.find((candidate) => candidate.id === id);
    if (!entry) return;
    openAddForm(entry.form);
  }

  function openPendingCatalogConnector() {
    const id = consumePendingConnectorCatalogAdd();
    if (id) {
      openCatalogConnector(id);
    }
  }

  onMount(() => {
    openPendingCatalogConnector();
    return onConnectorCatalogAddRequest(openCatalogConnector);
  });
</script>

{#if showHeading}
  <div class="px-3 pb-1 pt-2">
    <h2 class="text-psx-foreground-primary text-sm font-medium">Connectors</h2>
  </div>
{/if}

<section class={["flex flex-col gap-5 px-3 pb-4", showHeading ? "" : "pt-3"]}>
  {#if repo.isSupported === false}
    <div
      class="border-psx-border bg-psx-panel text-psx-foreground-secondary rounded-lg border px-3 py-3 text-[13px]/[18px]"
    >
      Connector management requires a newer version of the helper. Reload with an updated binary to
      use this feature.
    </div>
  {:else if showForm}
    <!-- Add / configure a connector. Leaving is via the form's Cancel (which
         rolls back a half-connected connector) or a successful add. -->
    <div class="add-connector-view mx-auto flex w-full max-w-[56rem] flex-col gap-2">
      <h3 class="text-psx-foreground-primary px-0.5 text-xs font-semibold uppercase tracking-wide">
        Add connector
      </h3>
      <div class="border-psx-border bg-psx-panel rounded-lg border p-3">
        <McpServerForm initial={formInitial} onClose={() => (showForm = false)} />
      </div>
    </div>
  {:else}
    {#if mcpWarning}
      <div
        class="border-psx-warning-badge/40 bg-psx-warning-badge/10 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]/[18px]"
      >
        <Icon name="alert" size={14} class="text-psx-warning-foreground mt-px shrink-0" />
        <div class="flex flex-col gap-0.5">
          <span class="text-psx-foreground-primary font-medium">{mcpWarning.title}</span>
          <span class="text-psx-foreground-secondary">{mcpWarning.body}</span>
        </div>
      </div>
    {/if}

    <ConnectorCatalog
      servers={userServers}
      testResults={repo.testResults}
      needsOAuthSignIn={(server) => repo.needsOAuthSignIn(server)}
      onAddCustom={() => openAddForm()}
      onPick={(form) => openAddForm(form)}
    />

    <!-- Camber connectors (only when the active agent is Camber) -->
    {#if sessionRepo && isPoolAgent}
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between px-0.5">
          <div class="flex items-center gap-1">
            <h3 class="text-psx-foreground-primary text-xs font-semibold uppercase tracking-wide">
              Camber connectors
            </h3>
            <HintTooltip
              text="MCP servers the Camber agent provides. Enabling or disabling one applies globally, across all your Camber chats."
            >
              <span class="text-psx-icon flex items-center" aria-label="About Camber connectors">
                <Icon name="info" size={12} />
              </span>
            </HintTooltip>
          </div>
          {#if poolCount > 0}
            <span class="text-psx-foreground-secondary text-[11px]">{poolCount}</span>
          {/if}
        </div>

        {#if poolLoading}
          <div
            class="border-psx-border bg-psx-panel text-psx-foreground-secondary flex items-center gap-2 rounded-lg border px-3 py-3 text-[13px]/[18px]"
          >
            <Spinner size={14} />
            Loading connectors…
          </div>
        {:else if sessionRepo.error}
          <div
            class="border-psx-border bg-psx-panel text-psx-error-foreground rounded-lg border px-3 py-3 text-[13px]/[18px]"
          >
            {sessionRepo.error}
          </div>
        {:else if poolCount === 0}
          <div
            class="border-psx-border bg-psx-panel text-psx-foreground-secondary rounded-lg border px-3 py-3 text-[13px]/[18px]"
          >
            No connectors from the Camber agent.
          </div>
        {:else}
          {#if remotePool.length > 0}
            <span
              class="text-psx-foreground-secondary px-0.5 pt-1 text-[10px] uppercase tracking-wide"
            >
              Remotely configured
            </span>
            <div class="border-psx-border bg-psx-panel overflow-hidden rounded-lg border">
              {#each remotePool as server (server.serverID)}
                <PoolMcpServerRow {server} />
              {/each}
            </div>
          {/if}
          {#if localPool.length > 0}
            <span
              class="text-psx-foreground-secondary px-0.5 pt-1 text-[10px] uppercase tracking-wide"
            >
              Locally configured
            </span>
            <div class="border-psx-border bg-psx-panel overflow-hidden rounded-lg border">
              {#each localPool as server (server.serverName)}
                <PoolMcpServerRow {server} />
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- From VS Code -->
    <VSCodeImportSection servers={importableVSCode} onAdd={openAddForm} />
  {/if}
</section>
