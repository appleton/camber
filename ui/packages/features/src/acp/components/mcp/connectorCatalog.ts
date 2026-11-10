import type { McpFormState } from "./McpServerForm.svelte";

export interface ConnectorCatalogEntry {
  id: string;
  label: string;
  blurb: string;
  category: ConnectorCatalogCategory;
  /**
   * Hidden from the browsed catalog; revealed only when the search query
   * exactly matches the entry's id or label.
   */
  searchOnly?: boolean;
  /** Caveat rendered on the catalog card, e.g. limited-availability notes. */
  note?: string;
  /** Prefilled add-form values. */
  form: Partial<McpFormState>;
}

export type ConnectorCatalogCategory = "productivity" | "development";

export const CONNECTOR_CATALOG_CATEGORIES: ReadonlyArray<{
  id: ConnectorCatalogCategory;
  label: string;
}> = [
  { id: "productivity", label: "Productivity" },
  { id: "development", label: "Development" },
];

export const SLACK_OAUTH_CLIENT_ID = "5293330736241.11587027503268";

function remoteConnector(options: {
  id: string;
  label: string;
  blurb: string;
  category: ConnectorCatalogCategory;
  url: string;
  searchOnly?: boolean;
  note?: string;
  authMode?: "none" | "bearer" | "oauth";
  bearerTokenPlaceholder?: string;
  bearerTokenHelp?: string;
  oauthScopes?: string;
  oauthClientID?: string;
  oauthCallbackPort?: number;
  oauthDeepLink?: boolean;
}): ConnectorCatalogEntry {
  return {
    id: options.id,
    label: options.label,
    blurb: options.blurb,
    category: options.category,
    searchOnly: options.searchOnly,
    note: options.note,
    form: {
      builtinID: options.id,
      name: options.id,
      transport: "http",
      url: options.url,
      authMode: options.authMode ?? "oauth",
      bearerTokenPlaceholder: options.bearerTokenPlaceholder ?? "sk-…",
      bearerTokenHelp: options.bearerTokenHelp ?? "",
      oauthScopes: options.oauthScopes ?? "",
      oauthClientID: options.oauthClientID ?? "",
      oauthCallbackPort: options.oauthCallbackPort ?? 0,
      oauthDeepLink: options.oauthDeepLink ?? false,
    },
  };
}

// Curated catalog of hosted MCP endpoints that Camber can connect to
// directly, plus a small set of useful local stdio servers. OAuth entries use
// either Dynamic Client Registration or a pre-registered public PKCE client.
export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  remoteConnector({
    id: "parallel-search",
    label: "Parallel Search",
    blurb: "Real-time web search and page fetching",
    category: "productivity",
    url: "https://search.parallel.ai/mcp",
    authMode: "none",
  }),
  remoteConnector({
    id: "exa-search",
    label: "Exa Search",
    blurb: "Search the web and retrieve page contents",
    category: "productivity",
    url: "https://mcp.exa.ai/mcp",
    authMode: "none",
  }),
  remoteConnector({
    id: "slack",
    label: "Slack",
    blurb: "Search messages, read threads, and send updates",
    category: "productivity",
    // Camber's Slack app is still pending Slack's approval, so the OAuth
    // flow only completes for Camber-workspace members. Until approval
    // lands, keep the entry out of the browsed catalog (staff are told to
    // search "slack" to reveal it) and flag the limitation on the card.
    searchOnly: true,
    note: "Pending approval — only works for Camber staff for now",
    url: "https://mcp.slack.com/mcp",
    authMode: "oauth",
    oauthScopes:
      "search:read.public search:read.private search:read.mpim search:read.im channels:history groups:history mpim:history im:history chat:write",
    oauthClientID: SLACK_OAUTH_CLIENT_ID,
    // Slack signs in via the camber://oauth/callback deep link only. Slack's
    // public-distribution HTTPS gate rejects http loopback redirect URLs (both
    // 127.0.0.1 and localhost were refused), but custom URI schemes are always
    // accepted, so camber:// is the sole registered redirect. There is no
    // loopback fallback: Slack sign-in requires a deep-link-capable host (the
    // release desktop app). Other OAuth connectors keep the loopback flow.
    oauthDeepLink: true,
  }),
  remoteConnector({
    id: "notion",
    label: "Notion",
    blurb: "Pages, databases, docs, and project context",
    category: "productivity",
    url: "https://mcp.notion.com/mcp",
  }),
  remoteConnector({
    id: "linear",
    label: "Linear",
    blurb: "Issues, projects, cycles, and team workflows",
    category: "productivity",
    url: "https://mcp.linear.app/mcp",
  }),
  remoteConnector({
    id: "granola",
    label: "Granola",
    blurb: "Meeting notes, transcripts, and action items",
    category: "productivity",
    url: "https://mcp.granola.ai/mcp",
  }),
  remoteConnector({
    id: "coda",
    label: "Coda",
    blurb: "Superhuman Docs: docs, tables, and automations",
    category: "productivity",
    // Canonical post-rebrand endpoint; https://coda.io/apis/mcp is the same
    // server. Coda's DCR refuses public clients: it issues a client secret
    // that expires after 180 days, so expect periodic re-registration. The
    // server gates tool access on the mcp:all scope (its 401 challenge sends
    // scope="mcp:all"); without it the token is issued but tool listing 401s.
    url: "https://docs.superhuman.com/apis/mcp",
    oauthScopes: "mcp:all",
  }),
  {
    id: "github",
    label: "GitHub",
    blurb: "Repositories, issues, and pull requests",
    category: "development",
    form: {
      builtinID: "github",
      name: "github",
      transport: "stdio",
      command: "npx",
      args: "-y @modelcontextprotocol/server-github",
      envLines: "GITHUB_PERSONAL_ACCESS_TOKEN=your_token_here",
    },
  },
  remoteConnector({
    id: "huggingface",
    label: "Hugging Face",
    blurb: "Models, datasets, Spaces, and gated model access",
    category: "development",
    url: "https://huggingface.co/mcp",
    oauthScopes: "openid profile read-mcp read-repos",
  }),
  remoteConnector({
    id: "sentry",
    label: "Sentry",
    blurb: "Errors, traces, releases, and issue investigation",
    category: "development",
    url: "https://mcp.sentry.dev/mcp",
  }),
  remoteConnector({
    id: "new-relic",
    label: "New Relic",
    blurb: "Observability data, alerting, and service context",
    category: "development",
    url: "https://mcp.newrelic.com/mcp/",
    oauthScopes: "openid profile mcp:access",
  }),
  remoteConnector({
    id: "vercel",
    label: "Vercel",
    blurb: "Projects, deployments, logs, and documentation",
    category: "development",
    url: "https://mcp.vercel.com",
  }),
  remoteConnector({
    id: "supabase",
    label: "Supabase",
    blurb: "Projects, database queries, and edge functions",
    category: "development",
    // OAuth grants organization-level access. The endpoint accepts query
    // params (?read_only=true, ?project_ref=…, ?features=…) for scoping;
    // Supabase advises read-only against production data.
    url: "https://mcp.supabase.com/mcp",
  }),
  remoteConnector({
    id: "netlify",
    label: "Netlify",
    blurb: "Sites, deploys, env vars, and team services",
    category: "development",
    url: "https://netlify-mcp.netlify.app/mcp",
  }),
  remoteConnector({
    id: "prisma-postgres",
    label: "Prisma Postgres",
    blurb: "Databases, backups, connection strings, and SQL",
    category: "development",
    url: "https://mcp.prisma.io/mcp",
  }),
  {
    id: "postgres",
    label: "PostgreSQL",
    blurb: "Query and inspect your database",
    category: "development",
    form: {
      builtinID: "postgres",
      name: "postgres",
      transport: "stdio",
      command: "npx",
      args: "-y @modelcontextprotocol/server-postgres postgresql://localhost/mydb",
    },
  },
  remoteConnector({
    id: "cloudflare",
    label: "Cloudflare",
    blurb: "Account configuration and product workflows",
    category: "development",
    url: "https://mcp.cloudflare.com/mcp",
  }),
];

export function findConnectorCatalogEntry(server: {
  builtinID?: string;
  name: string;
}): ConnectorCatalogEntry | undefined {
  const builtinID = server.builtinID?.trim().toLowerCase();
  if (builtinID) {
    const byBuiltinID = CONNECTOR_CATALOG.find((entry) => entry.id === builtinID);
    if (byBuiltinID) return byBuiltinID;
  }

  const name = server.name.trim().toLowerCase();
  return CONNECTOR_CATALOG.find(
    (entry) => (entry.form.name ?? entry.id).trim().toLowerCase() === name,
  );
}
