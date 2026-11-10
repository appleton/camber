<script lang="ts" module>
  export type McpTransport = "stdio" | "http";
  export type McpAuthMode = "none" | "bearer" | "oauth";

  export interface McpFormState {
    builtinID: string;
    name: string;
    transport: McpTransport;
    command: string;
    args: string;
    envLines: string;
    url: string;
    headerLines: string;
    authMode: McpAuthMode;
    bearerToken: string;
    bearerTokenPlaceholder: string;
    bearerTokenHelp: string;
    oauthScopes: string;
    oauthClientID: string;
    oauthCallbackPort: number;
    oauthDeepLink: boolean;
  }

  export const EMPTY_MCP_FORM: McpFormState = {
    builtinID: "",
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    envLines: "",
    url: "",
    headerLines: "",
    authMode: "none",
    bearerToken: "",
    bearerTokenPlaceholder: "sk-…",
    bearerTokenHelp: "",
    oauthScopes: "",
    oauthClientID: "",
    oauthCallbackPort: 0,
    oauthDeepLink: false,
  };

  export function mcpFormStateWithDefaults(initial?: Partial<McpFormState>): McpFormState {
    const definedInitial = Object.fromEntries(
      Object.entries(initial ?? {}).filter(([, value]) => value !== undefined),
    ) as Partial<McpFormState>;
    return { ...EMPTY_MCP_FORM, ...definedInitial };
  }
</script>

<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Button } from "@camber/components/button";
  import { Spinner } from "@camber/components/spinner";
  import type { MCPServerEntry } from "../../features/UserMCPServersRepository.svelte";
  import { getUserMCPServersRepo } from "../../features/UserMCPServersRepository.svelte";
  import { extractErrorMessage } from "../../errors";

  interface Props {
    initial?: Partial<McpFormState>;
    onClose: () => void;
  }

  let { initial, onClose }: Props = $props();

  const repo = getUserMCPServersRepo();

  let form = $state<McpFormState>(mcpFormStateWithDefaults(initial));
  let formError = $state<string | null>(null);

  type TestState = "idle" | "testing" | "ok" | "failed";
  let testState = $state<TestState>("idle");
  let testTools = $state<string[]>([]);
  let testError = $state<string | null>(null);
  let testedKey = $state<string | null>(null);
  let lastTestResult = $state<Awaited<ReturnType<typeof repo.testConfig>> | null>(null);

  // OAuth connect flow: the connector is saved first (the helper needs it in
  // the store to authenticate), then we run the browser sign-in while staying
  // on this screen. Cancel rolls back the connector we added.
  let phase = $state<"edit" | "connecting">("edit");
  let addedName = $state<string | null>(null);
  let connectError = $state<string | null>(null);
  // The form the connect error belongs to. Editing the form (e.g. switching the
  // Authentication radio) makes entryKey diverge, which hides the stale banner —
  // mirrors how testedKey invalidates the test result.
  let connectErrorKey = $state<string | null>(null);

  const inputClass =
    "border-psx-input-border bg-psx-input-background text-psx-foreground-primary outline-hidden placeholder:text-psx-foreground-secondary placeholder:opacity-50 focus-visible:outline-psx-focus h-8 min-w-0 rounded-md border px-2.5 font-mono text-[13px]/[18px] focus-visible:outline-2";
  const labelClass = "text-psx-foreground-primary text-[13px]/[18px] font-medium";

  // OAuth servers authenticate in the browser after they are added, so they
  // cannot be probed up front — they bypass the test gate.
  let isOAuth = $derived(form.transport === "http" && form.authMode === "oauth");
  let entryKey = $derived(JSON.stringify(buildEntry(form)));
  let tested = $derived(testState === "ok" && entryKey === testedKey);
  let testFailed = $derived(testState === "failed" && entryKey === testedKey);
  let showConnectError = $derived(connectError !== null && entryKey === connectErrorKey);
  let canAdd = $derived(isOAuth || tested);

  function parseKeyValueLines(lines: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of lines.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
    return out;
  }

  function buildEntry(f: McpFormState): MCPServerEntry {
    const entry: MCPServerEntry = { name: f.name.trim(), enabled: true };
    if (f.builtinID.trim()) entry.builtinID = f.builtinID.trim();
    if (f.transport === "stdio") {
      entry.command = f.command.trim();
      const rawArgs = f.args.trim();
      if (rawArgs) entry.args = rawArgs.split(/\s+/);
      const env = parseKeyValueLines(f.envLines);
      if (Object.keys(env).length > 0) entry.env = env;
    } else {
      entry.url = f.url.trim();
      entry.authMode = f.authMode;
      const headers = parseKeyValueLines(f.headerLines);
      if (Object.keys(headers).length > 0) entry.headers = headers;
      if (f.authMode === "bearer" && f.bearerToken.trim()) entry.bearerToken = f.bearerToken.trim();
      const oauthScopes = f.oauthScopes?.trim() ?? "";
      if (f.authMode === "oauth" && oauthScopes) entry.oauthScopes = oauthScopes;
      const oauthClientID = f.oauthClientID?.trim() ?? "";
      if (f.authMode === "oauth" && oauthClientID) {
        entry.oauthClientId = oauthClientID;
        entry.oauthCallbackPort = f.oauthCallbackPort;
      }
      if (f.authMode === "oauth" && f.oauthDeepLink) entry.oauthDeepLink = true;
    }
    return entry;
  }

  function validate(f: McpFormState): string | null {
    const name = f.name.trim();
    if (!name) return "Name is required";
    if (!/^[a-zA-Z0-9_\-]+$/.test(name)) return "Name may only contain letters, digits, _ and -";
    if (f.transport === "stdio" && !f.command.trim())
      return "Command is required for stdio servers";
    if (f.transport === "http" && !f.url.trim()) return "URL is required for HTTP servers";
    if (f.builtinID === "slack" && f.authMode === "oauth" && !(f.oauthClientID?.trim() ?? "")) {
      return "Slack OAuth is not configured in this build.";
    }
    return null;
  }

  async function runTest() {
    if (testState === "testing") return;
    formError = null;
    const err = validate(form);
    if (err) {
      formError = err;
      return;
    }
    const key = entryKey;
    testState = "testing";
    testError = null;
    testTools = [];
    try {
      const result = await repo.testConfig(buildEntry(form));
      testedKey = key;
      if (result.ok) {
        testState = "ok";
        testTools = result.toolNames ?? [];
        lastTestResult = result;
      } else {
        testState = "failed";
        testError = result.error || "Could not connect to this server.";
      }
    } catch (e) {
      testedKey = key;
      testState = "failed";
      testError = e instanceof Error ? e.message : "Test failed";
    }
  }

  async function submitForm() {
    if (repo.isSaving || phase === "connecting") return;
    formError = null;
    connectError = null;
    const err = validate(form);
    if (err) {
      formError = err;
      return;
    }
    const entry = buildEntry(form);

    // Add-only form (no edit mode): refuse to overwrite an existing connector.
    // Otherwise upsert silently replaces it — and an OAuth add that is then
    // cancelled would delete the original outright (see handleCancel). The
    // connector this form itself half-added is exempt: retrying a failed
    // OAuth connect resubmits the same name, and tripping here would wedge it.
    if (entry.name !== addedName && repo.servers.some((s) => s.name === entry.name)) {
      formError = `A connector named "${entry.name}" already exists.`;
      return;
    }

    if (isOAuth) {
      // Save first (idempotent) so the helper can authenticate by name.
      try {
        if (addedName !== entry.name) {
          // Renamed between attempts: abandon the half-add under the old name.
          if (addedName) await repo.delete(addedName).catch(() => {});
          await repo.upsert(entry);
          addedName = entry.name;
        }
      } catch (e) {
        formError = extractErrorMessage(e, "Save failed");
        return;
      }
      // Run the browser sign-in and wait for it to finish before leaving.
      phase = "connecting";
      try {
        await repo.authenticate(entry.name);
        addedName = null; // connected — keep the connector
        // Probe with the resolved token so the row shows a tool count, matching
        // how stdio connectors report after their test.
        void repo.testConnection(entry.name);
        onClose();
      } catch (e) {
        connectError = friendlyConnectError(
          extractErrorMessage(e, "Could not connect. The sign-in did not complete."),
        );
        connectErrorKey = entryKey;
        phase = "edit";
      }
      return;
    }

    // Non-OAuth: already validated via Test connection. Carry that result over
    // so the connector shows as ready immediately, no re-test needed.
    try {
      await repo.upsert(entry);
      if (lastTestResult) repo.recordTestResult(entry.name, lastTestResult);
      onClose();
    } catch (e) {
      formError = extractErrorMessage(e, "Save failed");
    }
  }

  // Helper errors are terse and developer-facing; translate the known OAuth
  // dead end into guidance. Servers whose OAuth provider offers no Dynamic
  // Client Registration (e.g. Slack's official MCP) only admit pre-registered
  // clients, which we don't support — retrying can never succeed.
  function friendlyConnectError(message: string): string {
    if (/registration_endpoint|dynamic client registration/i.test(message)) {
      return (
        "This server's OAuth provider doesn't let apps register automatically " +
        "(no Dynamic Client Registration), so Camber can't sign in to it. " +
        "Connect with a bearer token instead, or use a proxy that supports it."
      );
    }
    return message;
  }

  // Cancel rolls back a connector we added but didn't finish connecting.
  // Works mid-connect too: it abandons the pending browser sign-in and removes
  // the connector we just added.
  async function handleCancel() {
    const name = addedName;
    addedName = null;
    phase = "edit";
    if (name) {
      try {
        await repo.delete(name);
      } catch {
        // best effort — leave it if removal fails
      }
    }
    onClose();
  }
</script>

<form
  class="flex flex-col gap-3"
  onsubmit={(e) => {
    e.preventDefault();
    if (canAdd) void submitForm();
    else void runTest();
  }}
>
  <!-- name -->
  <div class="flex flex-col gap-1">
    <label for="mcp-name" class={labelClass}>Name</label>
    <input
      id="mcp-name"
      bind:value={form.name}
      placeholder="my-connector"
      spellcheck="false"
      autocorrect="off"
      autocapitalize="off"
      autocomplete="off"
      class={inputClass}
    />
  </div>

  <!-- transport segmented tabs -->
  <div class="flex flex-col gap-1">
    <span class={labelClass}>Transport</span>
    <div
      class="border-psx-input-border bg-psx-input-background flex gap-0.5 rounded-md border p-0.5"
    >
      {#each [["stdio", "Local (stdio)"], ["http", "Remote (HTTP)"]] as [val, label] (val)}
        <button
          type="button"
          class={[
            "flex-1 rounded-[5px] px-2 py-1 text-[13px]/[18px] font-medium transition-colors",
            "outline-hidden focus-visible:outline-psx-focus focus-visible:outline-2",
            form.transport === val
              ? "bg-psx-panel text-psx-foreground-primary ring-psx-border shadow-sm ring-1"
              : "text-psx-foreground-primary",
          ]}
          onclick={() => (form.transport = val as McpTransport)}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  {#if form.transport === "stdio"}
    <div class="flex flex-col gap-1">
      <label for="mcp-command" class={labelClass}>Command</label>
      <input
        id="mcp-command"
        bind:value={form.command}
        placeholder="npx"
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        autocomplete="off"
        class={inputClass}
      />
    </div>

    <div class="flex flex-col gap-1">
      <label for="mcp-args" class={labelClass}>
        Arguments <span class="font-normal opacity-60">(space-separated)</span>
      </label>
      <input
        id="mcp-args"
        bind:value={form.args}
        placeholder="-y @modelcontextprotocol/server-filesystem /path"
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        autocomplete="off"
        class={inputClass}
      />
    </div>

    <div class="flex flex-col gap-1">
      <label for="mcp-env" class={labelClass}>
        Environment variables <span class="font-normal opacity-60">(KEY=value, one per line)</span>
      </label>
      <textarea
        id="mcp-env"
        bind:value={form.envLines}
        placeholder={"API_KEY=abc123\nDEBUG=true"}
        spellcheck="false"
        autocapitalize="off"
        rows={3}
        class={[inputClass, "h-auto resize-none py-1.5"]}
      ></textarea>
    </div>
  {:else}
    <div class="flex flex-col gap-1">
      <label for="mcp-url" class={labelClass}>URL</label>
      <input
        id="mcp-url"
        bind:value={form.url}
        placeholder="https://my-mcp-server.example.com/mcp"
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        autocomplete="off"
        class={inputClass}
      />
    </div>

    <div class="flex flex-col gap-1">
      <label for="mcp-headers" class={labelClass}>
        Headers <span class="font-normal opacity-60">(optional, Key=value, one per line)</span>
      </label>
      <textarea
        id="mcp-headers"
        bind:value={form.headerLines}
        placeholder={"X-Api-Key=abc123\nX-Workspace=acme"}
        spellcheck="false"
        autocapitalize="off"
        rows={2}
        class={[inputClass, "h-auto resize-none py-1.5"]}
      ></textarea>
    </div>

    <div class="flex flex-col gap-1">
      <span class={labelClass}>Authentication</span>
      <div class="flex gap-3">
        {#each [["none", "None"], ["bearer", "Bearer token"], ["oauth", "OAuth"]] as [val, label] (val)}
          <label
            class="text-psx-foreground-primary flex cursor-pointer items-center gap-1.5 text-[13px]/[18px]"
          >
            <input type="radio" bind:group={form.authMode} value={val} class="accent-psx-link" />
            {label}
          </label>
        {/each}
      </div>
    </div>

    {#if form.authMode === "bearer"}
      <div class="flex flex-col gap-1">
        <label for="mcp-bearer" class={labelClass}>Bearer token</label>
        <input
          id="mcp-bearer"
          bind:value={form.bearerToken}
          type="password"
          placeholder={form.bearerTokenPlaceholder}
          spellcheck="false"
          autocorrect="off"
          autocapitalize="off"
          autocomplete="off"
          class={inputClass}
        />
        {#if form.bearerTokenHelp}
          <p class="text-psx-foreground-secondary m-0 text-[11px]/[16px]">
            {form.bearerTokenHelp}
          </p>
        {/if}
      </div>
    {:else if form.authMode === "oauth"}
      <div class="flex flex-col gap-1">
        <label for="mcp-scopes" class={labelClass}>
          OAuth scopes <span class="font-normal opacity-60">(space-separated, optional)</span>
        </label>
        <input
          id="mcp-scopes"
          bind:value={form.oauthScopes}
          placeholder="read write"
          spellcheck="false"
          autocorrect="off"
          autocapitalize="off"
          autocomplete="off"
          class={inputClass}
        />
      </div>
    {/if}
  {/if}

  {#if formError}
    <p class="text-psx-error-foreground m-0 text-[13px]/[18px]">{formError}</p>
  {/if}

  <!-- test / auth status -->
  {#if phase === "connecting"}
    <div
      class="border-psx-border bg-psx-editor-background/40 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[13px]/[18px]"
    >
      <Spinner size={14} class="mt-px shrink-0" />
      <span class="text-psx-foreground-secondary">
        Finish signing in in your browser. This connector is removed if you cancel.
      </span>
    </div>
  {:else if showConnectError}
    <div
      class="border-psx-border bg-psx-error-background/30 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[13px]/[18px]"
    >
      <Icon name="error" size={14} class="text-psx-error-foreground mt-px shrink-0" />
      <span class="text-psx-error-foreground">{connectError}</span>
    </div>
  {:else if tested}
    <div
      class="border-psx-border bg-psx-editor-background/40 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[13px]/[18px]"
    >
      <Icon name="checked" size={14} class="text-psx-foreground-primary mt-px shrink-0" />
      <span class="text-psx-foreground-secondary">
        Connected — {testTools.length} tool{testTools.length === 1 ? "" : "s"} found{testTools.length
          ? `: ${testTools.slice(0, 6).join(", ")}${testTools.length > 6 ? "…" : ""}`
          : "."}
      </span>
    </div>
  {:else if testFailed}
    <div
      class="border-psx-border bg-psx-error-background/30 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[13px]/[18px]"
    >
      <Icon name="error" size={14} class="text-psx-error-foreground mt-px shrink-0" />
      <span class="text-psx-error-foreground">{testError}</span>
    </div>
  {/if}

  <div class="flex items-center gap-3 pt-1">
    {#if phase === "connecting"}
      <Button type="button" prominence="increased" size="sm">
        <span class="inline-flex items-center gap-1.5 opacity-80">
          <Spinner size={12} />
          Connecting…
        </span>
      </Button>
    {:else if canAdd}
      <Button type="submit" prominence="increased" size="sm">
        {#if repo.isSaving}
          <span class="inline-flex items-center gap-1.5 opacity-80">
            <Spinner size={12} />
            Adding…
          </span>
        {:else}
          {isOAuth ? (showConnectError ? "Retry connection" : "Add & connect") : "Add connector"}
        {/if}
      </Button>
    {:else}
      <Button type="submit" prominence="increased" size="sm">
        {#if testState === "testing"}
          <span class="inline-flex items-center gap-1.5 opacity-80">
            <Spinner size={12} />
            Testing…
          </span>
        {:else}
          Test connection
        {/if}
      </Button>
    {/if}
    <Button type="button" appearance="ghost" size="sm" onclick={handleCancel}>Cancel</Button>
  </div>
</form>
