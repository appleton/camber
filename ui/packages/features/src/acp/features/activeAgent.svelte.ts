// The agent server of the user's most-recently-active ACP chat. In VS Code the
// sidebar is a separate webview from the chat editors, so it can't see the
// focused editor's agent directly — the host broadcasts it here so the sidebar
// (e.g. the connectors page) can reflect which ACP agent is in use.
let activeAgentServer = $state<string | null>(null);
// Whether that agent accepts MCP servers (from ACP capabilities). Relevant for
// non-pool agents. null = not known yet (don't warn).
let activeAgentSupportsMcp = $state<boolean | null>(null);
// Whether the active Camber model permits user/custom MCP servers. This is
// per-model and only the live chat session knows it (the sidebar's config probe
// uses a different/default model), so the chat broadcasts it here. null =
// unknown / non-pool (don't warn).
let activeAgentAllowsCustomMcp = $state<boolean | null>(null);

export function setACPActiveAgentServer(
  agentServer: string | null,
  supportsMcp: boolean | null = null,
  allowsCustomMcp: boolean | null = null,
): void {
  activeAgentServer = agentServer;
  activeAgentSupportsMcp = supportsMcp;
  activeAgentAllowsCustomMcp = allowsCustomMcp;
}

export function getACPActiveAgentServer(): string | null {
  return activeAgentServer;
}

export function getACPActiveAgentSupportsMcp(): boolean | null {
  return activeAgentSupportsMcp;
}

export function getACPActiveAgentAllowsCustomMcp(): boolean | null {
  return activeAgentAllowsCustomMcp;
}
