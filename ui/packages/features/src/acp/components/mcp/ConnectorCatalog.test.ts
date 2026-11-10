import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { MCPServerEntry } from "../../features/UserMCPServersRepository.svelte";
import ConnectorCatalog from "./ConnectorCatalog.svelte";
import { SLACK_OAUTH_CLIENT_ID } from "./connectorCatalog";

const defaultProps = {
  servers: [] as MCPServerEntry[],
  testResults: {},
  needsOAuthSignIn: () => false,
  onAddCustom: vi.fn(),
  onPick: vi.fn(),
};

describe("ConnectorCatalog", () => {
  it("shows recommended connectors grouped by category", () => {
    const { container } = render(ConnectorCatalog, { props: defaultProps });

    expect(screen.getByRole("heading", { name: "Productivity" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Development" })).toBeInTheDocument();
    // The hover fill and ring resolve from --psx-highlight-*, which each host
    // sets for itself; the card only names the tokens.
    expect(screen.getByRole("button", { name: "Connect Notion" })).toHaveClass(
      "hover:bg-psx-highlight-background",
      "hover:border-psx-highlight-border",
      "transition-colors",
    );
    expect(screen.getByRole("button", { name: "Connect Vercel" })).toBeInTheDocument();
    expect(container.querySelector('[data-connector-id="parallel-search"] img')).not.toBeNull();
    expect(container.querySelector('[data-connector-id="exa-search"] img')).not.toBeNull();
    expect(container.querySelector('[data-connector-id="granola"] img')).not.toBeNull();
    expect(screen.queryByText("Canva")).not.toBeInTheDocument();

    const section = screen.getByRole("heading", { name: "Productivity" }).closest("section");
    expect(section).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Productivity" }).parentElement?.children,
    ).toHaveLength(1);
    const connectorIDs = [...section!.querySelectorAll<HTMLElement>("[data-connector-id]")].map(
      (connector) => connector.dataset.connectorId,
    );
    expect(connectorIDs).toEqual([
      "parallel-search",
      "exa-search",
      "notion",
      "linear",
      "granola",
      "coda",
    ]);
  });

  it("reveals Slack only on an exact search match, with its approval note", async () => {
    render(ConnectorCatalog, { props: defaultProps });
    const search = screen.getByRole("searchbox", { name: "Search connectors" });

    // Hidden while browsing and on partial or blurb matches.
    expect(screen.queryByRole("button", { name: "Connect Slack" })).not.toBeInTheDocument();
    await fireEvent.input(search, { target: { value: "sla" } });
    expect(screen.queryByRole("button", { name: "Connect Slack" })).not.toBeInTheDocument();
    await fireEvent.input(search, { target: { value: "messages" } });
    expect(screen.queryByRole("button", { name: "Connect Slack" })).not.toBeInTheDocument();

    await fireEvent.input(search, { target: { value: " Slack " } });
    const card = screen.getByRole("button", { name: "Connect Slack" });
    expect(
      within(card).getByText("Pending approval — only works for Camber staff for now"),
    ).toBeInTheDocument();
  });

  it("prioritizes development connectors and omits removed recommendations", () => {
    render(ConnectorCatalog, { props: defaultProps });

    const section = screen.getByRole("heading", { name: "Development" }).closest("section");
    expect(section).not.toBeNull();

    const connectorIDs = [...section!.querySelectorAll<HTMLElement>("[data-connector-id]")].map(
      (connector) => connector.dataset.connectorId,
    );
    expect(connectorIDs).toEqual([
      "github",
      "huggingface",
      "sentry",
      "new-relic",
      "vercel",
      "supabase",
      "netlify",
      "prisma-postgres",
      "postgres",
      "cloudflare",
    ]);
  });

  it("filters connectors by name and description", async () => {
    render(ConnectorCatalog, { props: defaultProps });

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search connectors" }), {
      target: { value: "database" },
    });

    expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
    expect(screen.getByText("Prisma Postgres")).toBeInTheDocument();
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();
  });

  it("moves installed connectors into the first section and shows their connected tool count", () => {
    const { container } = render(ConnectorCatalog, {
      props: {
        ...defaultProps,
        servers: [
          {
            builtinID: "slack",
            name: "team-chat",
            enabled: true,
            authMode: "bearer",
            url: "https://mcp.slack.com/mcp",
          },
        ],
        testResults: {
          "team-chat": { ok: true, toolCount: 13, toolNames: [] },
        },
      },
    });

    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Installed",
      "Productivity",
      "Development",
    ]);

    const slackCard = container.querySelector('[data-connector-id="slack"]');
    expect(slackCard).not.toBeNull();
    expect(slackCard).toHaveClass("hover:bg-psx-highlight-background", "transition-colors");
    expect(slackCard?.closest("section")?.getAttribute("aria-labelledby")).toBe(
      "connector-category-installed",
    );
    expect(container.querySelectorAll('[data-connector-id="slack"]')).toHaveLength(1);
    expect(within(slackCard as HTMLElement).getByText("Connected")).toBeInTheDocument();
    expect(within(slackCard as HTMLElement).getByText("· 13 tools")).toBeInTheDocument();
    const actions = slackCard?.querySelector("[data-installed-card-actions]");
    expect(actions?.children[0]).toHaveAttribute("data-status", "connected");
    expect(actions?.children[1]).toContainElement(
      within(slackCard as HTMLElement).getByRole("switch", { name: "Disable team-chat" }),
    );
    expect(
      within(slackCard as HTMLElement).getByRole("switch", { name: "Disable team-chat" }),
    ).toBeInTheDocument();
    expect(
      within(slackCard as HTMLElement).getByRole("button", { name: "Connector actions" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Slack" })).not.toBeInTheDocument();
  });

  it("keeps custom installed connectors manageable in the Installed section", () => {
    const { container } = render(ConnectorCatalog, {
      props: {
        ...defaultProps,
        servers: [
          {
            name: "internal-tools",
            enabled: false,
            command: "internal-mcp",
            args: ["--serve"],
          },
        ],
      },
    });

    const card = container.querySelector('[data-connector-id="internal-tools"]');
    expect(card).not.toBeNull();
    expect(card?.closest("section")?.getAttribute("aria-labelledby")).toBe(
      "connector-category-installed",
    );
    expect(within(card as HTMLElement).getByText("internal-tools")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("internal-mcp --serve")).toBeInTheDocument();
    expect(
      within(card as HTMLElement).getByRole("switch", { name: "Enable internal-tools" }),
    ).toBeInTheDocument();
    expect(
      within(card as HTMLElement).getByRole("button", { name: "Connector actions" }),
    ).toBeInTheDocument();
  });

  it("uses Camber's pre-registered public OAuth client for Slack", async () => {
    const onPick = vi.fn();
    render(ConnectorCatalog, { props: { ...defaultProps, onPick } });

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search connectors" }), {
      target: { value: "slack" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));

    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        builtinID: "slack",
        name: "slack",
        url: "https://mcp.slack.com/mcp",
        authMode: "oauth",
        oauthClientID: SLACK_OAUTH_CLIENT_ID,
        // Deep-link only: no loopback port, camber://oauth/callback redirect.
        oauthCallbackPort: 0,
        oauthDeepLink: true,
        oauthScopes: expect.stringContaining("search:read.public"),
      }),
    );
  });

  it("defaults omitted OAuth scopes before opening a catalog connector", async () => {
    const onPick = vi.fn();
    render(ConnectorCatalog, { props: { ...defaultProps, onPick } });

    await fireEvent.click(screen.getByRole("button", { name: "Connect Notion" }));

    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        authMode: "oauth",
        oauthScopes: "",
      }),
    );
  });

  it("keeps custom MCP setup available beside search", async () => {
    const onAddCustom = vi.fn();
    render(ConnectorCatalog, { props: { ...defaultProps, onAddCustom } });

    await fireEvent.click(screen.getByRole("button", { name: "Add Custom MCP" }));

    expect(onAddCustom).toHaveBeenCalledOnce();
  });
});
