# UI AGENTS.md

Use existing Svelte and TypeScript patterns. Tests live beside source files.
Prefer focused package commands over whole-workspace checks while iterating.

## Map

| Area | Where |
| --- | --- |
| Shared assistant shell | `ui/packages/assistant/` |
| Shared ACP UI/state | `ui/packages/features/src/acp/` |
| Shared components | `ui/packages/components/` |
| Host/webview RPC | `ui/packages/rpc/` |
| Helper API bindings | `ui/packages/helperapi/` |
| Split-pane tabs (desktop) | `ui/packages/splits/` |
| Desktop host | `ui/apps/desktop-assistant/` |
| VS Code host | `ui/apps/vscode-assistant/` |
| Visual Studio host | `ui/apps/vs-assistant/` |
| Mobile remote host | `ui/apps/mobile-remote/` |
| Remote WebSocket client | `ui/packages/remote-client/` |
| UI automation | `ui/packages/camberqa/` |

## Conventions

- Do not edit generated files in `src/gen` directly; regenerate them.
- Do not assert on CSS properties in tests. Prefer behavior, accessibility state,
  or semantic DOM state over exact declarations and inline-style values.
- For ACP UI and state, start in `ui/packages/features/src/acp`.
- For shared chat shell behavior, start in `ui/packages/assistant`.
- For host-specific behavior, use the relevant app under `ui/apps`.
- Keep app README files focused on running, building, packaging, and host quirks.
- Verify UI changes in the running app with camberqa and take before/after
  screenshots; see `../docs/coding-with-agents.md`.

## Common Checks

- `pnpm -F <package> test:unit`
- `pnpm -F <package> check:types`
- `pnpm -F <package> check:lint`
