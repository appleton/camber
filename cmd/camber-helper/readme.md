# `camber-helper` — the binary

This directory holds the `main` for the helper daemon. The interesting code,
JSON-RPC handlers, ACP proxy, and developer docs live one floor up at
[`pkg/camber-helper/`](../../pkg/camber-helper/README.md).

The desktop app launches the helper as a long-lived subprocess for each
workspace, communicating over stdio with JSON-RPC framed by the LSP base
protocol. Methods are namespaced `camber/…` so they can't collide with
LSP itself.

```sh
# Build the binary
bazelisk build //cmd/camber-helper

# See available CLI subcommands
camber-helper --help
```

Assistant client code lives under [`../../ui/apps/`](../../ui/apps/).
