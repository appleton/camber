# ACP types and extensions

Camber Assistant talks to agents over the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP). The protocol
itself — session lifecycle, prompts, tool calls, permissions — is documented
upstream; this package only holds what Camber adds on top of the
[`acp-go-sdk`](https://github.com/coder/acp-go-sdk).

What lives here:

- `extensions.go` — the `_poolside/*` JSON-RPC extension methods and
  notifications (session rename, elicitation, ephemeral messages,
  compaction updates, MCP settings). Each constant's godoc describes its
  direction and semantics. These use ACP's extension mechanism, so agents
  that do not know them are unaffected.

Elicitation reaches the helper on two wires with one behavior: pool acp uses
the `_poolside/elicitation` extension, while third-party agents (for example
claude-agent-acp) use the standard unstable `elicitation/create` /
`elicitation/complete` methods, which the helper advertises via the
`elicitation` client capability (form mode only — surfaces do not render url
mode yet). Both converge on the helper's approval store.
- `permission.go` — helpers for ACP permission requests and options.
- `sessionmeta.go` — Camber session metadata carried in ACP `_meta`
  fields.

Consumers: the helper's ACP proxy
(`pkg/camber-helper/internal/handler/acpproxy/`) speaks these methods to
agents; the shared UI state in `ui/packages/features/src/acp/` renders their
client side.
