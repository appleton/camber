# @camber/remote-client

Browser-side client for camber-helper's remote access WebSocket
(`pkg/camber-helper/internal/handler/remoteaccess`). The mobile remote app
(`ui/apps/mobile-remote`) is a thin composition of this package plus pairing
and theming UI; nothing in here renders anything.

## What lives here

| Module                 | Role                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wsRpc.ts`             | Generic JSON-RPC 2.0 client over one WebSocket: reconnect with backoff, an outbox while connecting, single-use ticket auth on every connect. Not method-aware.                                                                                                                                                                                                                                                              |
| `sessionStreamGate.ts` | Applies the helper's seq/epoch-stamped live session events exactly once and in order; detects gaps and helper restarts so stale sessions get re-loaded instead of silently missing messages.                                                                                                                                                                                                                                |
| `deviceSession.ts`     | Silent auth recovery: exchanges the persisted device token for a fresh session cookie so routine cookie expiry never bounces the user back to pairing.                                                                                                                                                                                                                                                                      |
| `remoteHost.ts`        | The webview host adapter. Implements the same host RPC surface DesktopHost / the VS Code extension implement, over the WebSocket: generic `jsonrpc` passthrough, terminal translation, reconnect resync (resume + terminal reattach), prompt retry across connection drops. Inbound helper notifications route through the shared table in `@camber/rpc/assistant`, so per-method plumbing lives in ONE place across hosts. |

Storage note: the only thing this package persists is the device token, in
`localStorage` — it is the credential that unlocks everything server-side, so
it must live on the client. Anything else a remote surface needs to remember
belongs helper-side (the acpNav sidebar DB), reachable through the
`camber/acpNav/*` methods.

## Relationship to the helper

The helper side is deliberately generic: remote requests dispatch into the
SAME handler the desktop uses — every method is callable except a small deny
list (`remoteaccess/denylist.go`: protocol lifecycle and remote-access
administration) — and helper→client notifications fan out to every connected
client via `remoteaccess/hub.go`. Adding a feature to remote surfaces
therefore usually means writing NO transport code at all; only a new
notification needs one entry in `HELPER_NOTIFICATION_WEBVIEW_COMMANDS` in
`@camber/rpc/assistant`.

## Future: desktop over WebSocket

If the helper (+ agents) ever runs on a devbox with the desktop app connecting
remotely, that host would be composed from this package:

- `WsRpc` and `SessionStreamGate` apply unchanged — they are transport, not
  mobile behavior. The desktop host would speak the same `/api/session`,
  `/api/ws-ticket`, `/api/ws`, `camber/remote/resume` protocol.
- `RemoteHost.handleHostRequest` is the seam to swap: today it stubs desktop
  capabilities that don't exist on a phone (secrets, file access, settings).
  A desktop-over-ws host implements those against Tauri instead, and keeps the
  generic `jsonrpc` passthrough.
- Server-side, the method deny list is already role-agnostic (everything
  except protocol lifecycle and remote-access administration is callable), so
  a desktop-role client needs no server changes.

## Stripping the feature

Remove `ui/apps/mobile-remote`, this package, and the helper's `remoteaccess`
/ `remoteterminal` sub-packages (plus their wiring in
`internal/handler/remote_access.go`, `remote_terminal.go`,
`session_events.go`). Shared UI keeps working: the mobile components in
`@camber/assistant` (`Mobile*`) and `@camber/features`
(`MobileSideBar`, sheets) are dedicated files with no tendrils into desktop
code paths.
