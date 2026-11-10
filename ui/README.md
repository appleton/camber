# UI workspace

A pnpm, Svelte, and TypeScript monorepo containing apps, shared packages, and a
shared chat shell.

## The apps

| App           | Package                         | What it is                             |
| ------------- | ------------------------------- | -------------------------------------- |
| Desktop       | `@camber/desktop-assistant` | Tauri v2 standalone client             |
| Mobile remote | `@camber/mobile-remote`     | Remote-control PWA for the desktop app |

## The shared packages

| Package                  | What it owns                                            |
| ------------------------ | ------------------------------------------------------- |
| `@camber/assistant`  | The chat shell every host renders                       |
| `@camber/features`   | Cross-cutting features, including ACP UI/state and auth |
| `@camber/components` | Pure UI components, no state                            |
| `@camber/helperapi`  | Generated bindings for the local helper                 |
| `@camber/rpc`        | Host ↔ webview RPC contracts                           |
| `@camber/camberqa`  | Playwright-driven UI automation                         |

## Setup

Tool versions live in the root [`.tool-versions`](../.tool-versions).
From the repo root:

```sh
pnpm install
```

## Day-to-day

```sh
pnpm build
pnpm test
pnpm check:types
pnpm check:lint
```

While iterating, scope commands to one package:

```sh
pnpm -F @camber/desktop-assistant test:unit
pnpm -F @camber/assistant test:unit
pnpm -F @camber/desktop-assistant dev
pnpm -F @camber/camberqa start
```

## Generated code

Anything under a `src/gen/` directory is generated. Do not hand-edit these
files; rerun the generator:

- Helper API bindings: `pnpm -F @camber/helperapi codegen`

## Going deeper

- Desktop app: [`apps/desktop-assistant/README.md`](apps/desktop-assistant/README.md)
- Shared assistant shell: [`packages/assistant/README.md`](packages/assistant/README.md)
- RPC contracts: [`packages/rpc/README.md`](packages/rpc/README.md)
- Coding agents: [`AGENTS.md`](AGENTS.md)
