# AGENTS.md

Map, not encyclopedia. Small by design - follow the paths.

This repository contains Camber Assistant: the macOS desktop client and its mobile remote companion,
shared assistant UI packages, ACP support, and `camber-helper`.

Scoped `AGENTS.md` files override this file for their subtree. Read the scoped
file before editing a domain you have not touched before. `CLAUDE.md` files are
symlinks to `AGENTS.md` — edit `AGENTS.md`, never add a separate `CLAUDE.md`.

New to the repo? Set up with [`INSTALL.md`](INSTALL.md#build-from-source)
(tool versions come from [`.tool-versions`](.tool-versions)), then read
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how changes land.

## The protocol

Camber Assistant is a client for agents speaking the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP). Upstream
protocol and schema documentation live there. Camber's `_poolside/*`
extension methods are defined in `pkg/acp/README.md`.

## Repository map

| Area | Where |
| --- | --- |
| Helper entry point | `cmd/camber-helper/readme.md` |
| Helper implementation and JSON-RPC handlers | `pkg/camber-helper/README.md` |
| ACP types and extensions | `pkg/acp/README.md` |
| Helper ACP proxy | `pkg/camber-helper/internal/handler/acpproxy/` |
| `camber` control CLI | `docs/camber-cli.md`, `cmd/camber/`, `pkg/camber-cli/` |
| Helper control dispatcher (CLI actions) | `pkg/camber-helper/internal/handler/control/` |
| UI workspace | `ui/README.md`, `ui/AGENTS.md` |
| Desktop assistant | `ui/apps/desktop-assistant/README.md` |
| Shared assistant webview | `ui/packages/assistant/README.md` |
| Shared ACP UI/state | `ui/packages/features/src/acp/` |
| Mobile remote app | `ui/apps/mobile-remote/README.md` |
| Remote client transport | `ui/packages/remote-client/README.md` |
| Helper remote access server | `pkg/camber-helper/internal/handler/remoteaccess/` |
| Host/webview RPC | `ui/packages/rpc/README.md` |
| Helper API bindings | `ui/packages/helperapi/README.md` |
| UI automation | `ui/packages/camberqa/README.md` |
| Working with coding agents (camberqa, worktrees) | `docs/coding-with-agents.md` |

## Build and test

Use scoped README files for target-specific commands. Prefer focused tests for
the area touched.

Common entry points:

- Helper: `bazelisk test //pkg/camber-helper/...`
- UI workspace: `pnpm test`, `pnpm build`
- Desktop unit tests: `pnpm -F @camber/desktop-assistant test:unit`
- Desktop assistant: `pnpm -F @camber/desktop-assistant check:types`

For UI changes, verify in the running app with camberqa and attach
before/after screenshots as PR evidence — see
[`docs/coding-with-agents.md`](docs/coding-with-agents.md).

## Ways of working

- PRs, issue flow, and where to discuss changes: [`CONTRIBUTING.md`](CONTRIBUTING.md).
- CI lives in `.github/workflows`. Dependency license checks:
  [`docs/license-checks.md`](docs/license-checks.md).
- Run `pnpm fix:format` before pushing UI changes; `gofmt` is enforced for Go.

## TypeScript and Svelte

For code under `ui/`, use `ui/README.md` as the canonical walkthrough of the
workspace, Svelte patterns, and apps.

- This project uses Node.js and pnpm. Check the root `.tool-versions` file for
  versions.
- Always use `pnpm`, never `npm`.
- Prefer scoped installs such as `pnpm install --filter @camber/<app>...`
  (note the trailing `...`) over a top-level install when working on one app or
  package.
- Read the relevant README under `ui/` before working there.
- Check type errors with editor diagnostics if available; otherwise use
  `pnpm check:types`.
- Fix formatting issues with `pnpm fix:format`.
- Run unit tests with `pnpm test:unit` or a focused package command such as
  `pnpm -F @camber/desktop-assistant test:unit`.
- Run unit tests in watch mode with `pnpm test:unit:watch`, or scope the same
  script with `pnpm -F <package>`.
- Run Storybook development servers with a scoped package command such as
  `pnpm -F @camber/assistant storybook`, or with
  `pnpm exec turbo storybook --affected` when using the Turbo task directly.
  Run Storybook tests with `pnpm test:storybook` and watch mode with
  `pnpm test:storybook:watch`.

## Go

- Order files by importance to readers: exported types, tests, and methods
  first; helper methods and unexported types later.
- Suffix methods that must be called when a lock is called Locked, e.g. `startLocked`

### Tests
- In tests, use `testify` `assert`/`require` rather than `t.Error`.
- Use `require` in tests to eliminate possible runtime panics, for example
  `require.Len(t, someSlice, 1)` before accessing a slice index.
- Prefer `assert` for independent post-conditions so one test run reports every
  failure, not just the first one.

## Editing docs

Before adding to this file, ask whether the detail belongs
in a scoped `AGENTS.md`, a package README, or an app README.
