---
name: camber-helper
description: Development workflow for the camber-helper project (pkg/camber-helper). Use when working on, debugging, running, or profiling the camber-helper binary. Triggers on requests like "run the helper", "debug the helper", "start camber-helper", "profile the helper", "pprof the helper", "attach dlv to helper".
---

# camber-helper Development

## Project layout

- Entry point: `cmd/camber-helper/main.go`
- Core packages: `pkg/camber-helper/`
- Server wiring: `pkg/camber-helper/server/server.go`
- Handler (RPC methods, pprof, initialization): `pkg/camber-helper/internal/handler/`

## Running with dlv debugger attached

The helper communicates over stdio (JSON-RPC / LSP base protocol), so dlv must be run in headless mode with logs redirected away from stdout.

```bash
# From the repo root:
CGO_ENABLED=1 CGO_CPPFLAGS="-w" dlv debug \
  --continue \
  --headless \
  --listen=:21370 \
  --api-version=2 \
  --accept-multiclient \
  --build-flags='-tags=fts5' \
  --log-dest=/tmp/camber-helper-dlv.log \
  ./cmd/camber-helper -- --stdin
```

Key flags:
- `--continue` starts the process immediately instead of pausing at entry.
- `--headless` runs dlv without a terminal UI so an IDE or `dlv connect` can attach.
- `--listen=:21370` is the conventional port; any free port works.
- `--build-flags='-tags=fts5'` enables the SQLite FTS5 extension required by helper.
- `CGO_CPPFLAGS="-w"` suppresses tree-sitter compiler warnings that would corrupt the stdio JSON-RPC stream.
- `--log-dest` keeps dlv's own output off stdout (which is the RPC channel).

Attach a debugger client (IDE or CLI):

```bash
dlv connect :21370
```

If dlv is not installed:

```bash
go install github.com/go-delve/delve/cmd/dlv@latest
```

### Running without the debugger

```bash
CGO_ENABLED=1 go run -tags=fts5 ./cmd/camber-helper/... --stdin
```

Or listen on a TCP port instead of stdio (`--stdin=false` is required because `--stdin` defaults to true):

```bash
CGO_ENABLED=1 go run -tags=fts5 ./cmd/camber-helper/... --stdin=false --port 9999
```

## Sending JSON-RPC requests

The helper uses the [LSP base protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.16/specification/#baseProtocol): each message is a JSON-RPC body preceded by a `Content-Length` header, separated from the body by `\r\n\r\n`.

The lifecycle is: `initialize` request → `initialized` notification → further requests → `shutdown` → `exit`.

### Interacting via shell tools

Use TCP mode with the bundled `lsp-send.sh` relay script. The script holds a persistent TCP connection open via `nc`, reads JSON lines from stdin, and automatically adds LSP `Content-Length` framing. Responses are printed to stdout as plain JSON (one line per message). No Python required.

1. Start the helper in TCP mode with `shell` (mode: background).
2. Start the relay script with `shell` (interactive: true, mode: background):
   `bash .camber/skills/camber-helper/scripts/lsp-send.sh 127.0.0.1 <port>`
3. Send the `initialize` request via `shell_send` — just the raw JSON body, terminated by `\n`.
4. Read the response with `shell_tail`.
5. Send the `initialized` notification via `shell_send` (no `id` field).
6. Send any further method calls the same way.

Example — start the helper and relay:

```bash
# Terminal 1 (background): start the helper
CGO_ENABLED=1 go run -tags=fts5 ./cmd/camber-helper/... --stdin=false --port 9999

# Terminal 2 (interactive background): start the relay
bash .camber/skills/camber-helper/scripts/lsp-send.sh 127.0.0.1 9999
```

Send `initialize` via `shell_send` (just the JSON, the relay adds framing):

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"workspaceFolders":[{"uri":"file:///tmp/myproject","name":"myproject"}]}}
```

Then the `initialized` notification:

```
{"jsonrpc":"2.0","method":"initialized","params":{}}
```

Then any method, e.g. `camber/hello`:

```
{"jsonrpc":"2.0","id":2,"method":"camber/hello","params":{}}
```

Registered methods include standard LSP (`textDocument/didOpen`, `textDocument/completion`, etc.) and custom `camber/` namespaced methods. See `handler/handler.go` for the full list.

## pprof profiling

pprof is always started automatically (the `--pprof` flag is obsolete and ignored). On initialization, the handler binds `net/http/pprof` to an ephemeral port in the range **49600-50599** on `127.0.0.1`.

### Finding the pprof port

The port is logged to stderr on startup. Look for:

```
level=INFO msg="pprof listening on" addr=127.0.0.1:<port>
```

If running via an editor extension, check the **camber Helper** output channel.

### Using pprof

Once you know the port (e.g. 49602):

```bash
# Interactive CPU profile (30s default)
go tool pprof http://127.0.0.1:49602/debug/pprof/profile

# Heap profile
go tool pprof http://127.0.0.1:49602/debug/pprof/heap

# Goroutine dump
curl http://127.0.0.1:49602/debug/pprof/goroutine?debug=2

# All available profiles (browser)
open http://127.0.0.1:49602/debug/pprof/

# Snapshot heap to a file for later analysis
curl -o heap.pb.gz http://127.0.0.1:49602/debug/pprof/heap
go tool pprof heap.pb.gz
```
