# @camber/mobile-remote

Mobile remote-control PWA for the Camber desktop assistant, served by
camber-helper over Tailscale (see
`pkg/camber-helper/internal/handler/remoteaccess/`).

The app is deliberately thin. It renders no chat UI of its own:

- **Shared UI** comes from `@camber/assistant` (`MobilePanel` →
  `MobileShell`) and `@camber/features` (dedicated `Mobile*` components).
- **Transport** comes from `@camber/remote-client` (WebSocket JSON-RPC,
  sequenced session-event gating, device-token auth recovery, the webview
  host adapter). Read that package's README for the architecture and the
  future desktop-over-WebSocket story.
- **This app** owns only the entry gating (pair screen vs app), the pairing
  flow, phone-local theming, the connection pill, and hash routing.

## Storage

The mobile app uses phone-local `localStorage` for device-local credentials,
settings, and caches. These entries include:

- the **device token** (`deviceSession.ts` in remote-client) — the credential
  that mints session cookies; it cannot live behind the auth wall it unlocks;
- the **theme preference** (`settings.ts`) — per-device by design (phone can
  run light while the desktop runs dark), and needed before the socket is up
  to avoid a wrong-theme first paint;
- the **ACP agent registry cache** (`AgentRegistryRepository.svelte.ts` in
  features) — a fallback when the registry cannot be fetched.

User state that needs to be shared with the desktop belongs helper-side in the
acpNav sidebar DB via `camber/acpNav/*` methods. Do not add new mobile-app
`localStorage` keys.

## Running

- `pnpm dev:helper` — builds and spawns camber-helper with remote access
  enabled against this app's dev server, prints a pairing URL.
- `pnpm dev` — the Vite dev server alone (the helper proxies to it when
  `CAMBER_REMOTE_DEV_SERVER` is set).
- `pnpm embed` — builds the bundle and copies it into the helper's
  `//go:embed` dir so the UI ships inside the helper binary.
- `pnpm test:unit`, `pnpm check:types` — the usual checks.
