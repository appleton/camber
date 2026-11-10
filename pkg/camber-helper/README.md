# Camber Helper

Camber Helper is a daemon process started by the desktop app
to provide common functionality to Camber Assistant clients. This directory
holds packages either implementing or relating to Helper. Helper client
implementors should use this README, `methods/`, and the generated helper API
bindings in `../../ui/packages/helperapi`.

Communication between the desktop app and camber-helper happens over
[JSON-RPC](https://www.jsonrpc.org) and implements the [base
protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#base-protocol)
defined by LSP. While some LSP features may be implemented, the methods supported by
camber-helper are a superset of the LSP base protocol. We namespace our
methods with `camber/` to avoid collisions.

e.g.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "camber/exampleMethod",
  "params": {
    "uri": "file:///Users/poolie/scratch"
  }
}
```

Some important details about LSP:

- As per spec, LSP clients and servers have a 1:1 correspondence, and the client manages the server's lifecycle (see the [LSP lifecycle spec](https://github.com/microsoft/language-server-protocol/blob/7755eb18f1d57141e60ae7fe4a68beb860f18bf6/_specifications/lsp/3.17/specification.md#L414)). This is [apparently unlikely to change](https://github.com/microsoft/language-server-protocol/issues/1160#issuecomment-737998922).
- Therefore, we currently assume a server has a singleton relationship with a client. If this changes, look at the stateful fields of the server to determine what needs to be updated.
- `Call(ctx)` doesn't check for context cancellation: it will always be sent. Don't rely on context cancellation for JSON-RPC; use the abort mechanism.

## Startup readiness diagnostics

`initialize` responds after configuration, navigation schema migration and agent
configuration migration/seeding. Runtime-install repair already runs in the
background. Do not defer migrations past this boundary or serve partially
initialized stores.

Debug logs report `helper startup phase` with a phase, duration and success flag.
Go execution traces also include `helper.initialize.*`, `acpnav.open` and
`acpnav.migrations` regions. `BenchmarkInitializeReady` covers fresh and existing
stores, including 10,000 conversations; `BenchmarkOpenUpgrade` checks migration
from a populated older schema. The benchmarks use temporary configuration and
databases and do not launch agents. Their in-process timings exclude process
launch, host transport and the client's subsequent navigation reads.

## Release

Desktop releases consume an immutable `helper/vM.m.p` runtime published in
this fork. Publish and verify the helper assets before packaging the desktop
app; see [Releasing Camber](../../RELEASING.md) for the build and release steps.

Fresh local binary installs resolve the highest published `helper/v*` version;
set `CAMBER_HELPER_VERSION=helper/vM.m.p` to reproduce an exact one. Cached
desktop binary installs remain offline-safe and can be explicitly refreshed.
Local binary downloads use `appleton/camber`, including when working in a
fork. Set `CAMBER_HELPER_REPOSITORY=owner/repo` to resolve and download a
runtime from another repository. Desktop development can opt into a local
helper build with `CAMBER_DESKTOP_LOCAL_HELPER=1`.

## Adding methods

For LSP types, use the gopls types we have vendored. For JSONRPC methods not in LSP,
add types to the methods/ package. Use huma godoc comments, as then the `camber-helper openapi`
command will allow clients to auto-generate types for their language (although Helper is not an HTTP
API, huma was a convenient library which we already use).

Then:

1. Register the methods in `internal/handler/handler.go`.
2. Find an existing sub-handler, such as `internal/handler/git/` for Git
   methods, or create a new one for a new subsystem. See below for registration.
3. Define the methods in a file named for the snake case of the method name, or method-name prefix if you have many (small) related methods.
4. You can either unit-test in the package or define an integration test in `internal/test/`.

The generated TypeScript bindings live in the `@camber/helperapi` package.
Regenerate them with `pnpm -F @camber/helperapi codegen` (or `codegen:up` to
also start the helper's OpenAPI server). See the
[helperapi README](../../ui/packages/helperapi/README.md).

### RPC standards

1. Use `camber/` as the namespace for any non-standard JSON-RPC method: do not use the LSP namespaces, as this is confusing and may create conflicts with future methods.
2. Try to match LSP naming style, e.g. using LSP suffixes for events (`...DidChange`) and keeping consistent prefixes between related methods.
3. Use `camelCase` for JSON keys where possible. We have some cases where we've reused deeply nested API types that use `snake_case`, and it was low ROI to duplicate them.
4. Use `huma` tags to declaratively validate the input.
5. Remember that we have multiple extensions, so be considerate about communicating breaking changes early and widely.

### Sub-handlers

To avoid all methods living in a single package, we define sub-handlers. These
reside in `internal/handler/$yourpkg`, e.g. `internal/handler/foo`. By convention put your constructors in `internal/handler/$yourpkg/handler.go`. Then construct your handler and register methods in the main `handler` package.

New sets of handlers should go in a sub-package like this rather than the main
`handler` package; keep `handler.go` itself to core JSON-RPC and server state.

If your handler cannot be constructed before `initialize` - for example
requiring workspace folders - you can allocate an address for it in `internal/handler/handler.go` in `newHandlerBaseState`, and assign into the value in `initialize`:

```go
package handler

// handler.go
type CamberHandler struct {
  *foo.FooHandler
}

func newHandlerBaseState(httpClient httpClientDo) *CamberHandler {
  // ...
  h := &CamberHandler{
    // ...
    // initialize pointer we can use for registration of method addresses,
    // and we'll assign into this address when constructing Handler
    FooHandler: new(foo.Handler),
  }
}

func New(/* ... */) {
  //...
  registerExtensionMethod(handler, JSONRPCOperation{
    Method:      "camber/fooDidChange",
  }, handler.FooHandler.DidChange)
}


// initialize.go
func (h *CamberHandler) setInitializeState(params *protocol.InitializeParams) error {
  // ...

  // assign the server value to our pre-allocated address, pointed
  // to by the various method handlers
  *h.FooHandler = *foo.NewHandler()
}
```

## Standards and Conventions

These are internal standards and conventions for the helper codebase.

### Error-handling

We handle runtime errors as follows:

1. use `pkgerrors.Wrap / Errorf / WithStack` to wrap errors from non-helper code, or error constants, with stack traces
1. don't use `fmt.Errorf` etc for defining non-constant errors, use `pkgerrors.Errorf` which includes the stack
1. don't add messages in (1) unless you're adding information that cannot be got from the stack trace
1. don't log errors you return. Rely on our logging of errors higher up the stack
1. conversely, if you handle an error and it adds important information, do log it

This example indicates how to handle errors:

```go
func someMethod(...) error {
  if err := thirdparty.Something(); err != nil {
    // if you have something useful to add beyond stack + original err, use Wrap:
    // return pkgerrors.Wrap("useful info", err)
    return pkgerrors.WithStack(err)
  }

  if err := helpercode.Something(); err != nil {
    // since we rely on all helper code following the "wrap third-party err" rule, we can confidently return err unchanged
    // when calling other helper code
    return err
  }

  if badThing() {
    // when we return constant errors, we should add a runtime stacktrace to aid debugging
    return pkgerrors.WithStack(ErrTheThing)
  }
}
```

Never use `==` or `err.(SomeType)` to compare or cast errors, [use](https://go.dev/blog/go1.13-errors) `errors.Is` and `errors.As`.

Use `panic` only for API misuse stemming from programming decisions, not runtime input or behavior. i.e. in the same way as the
go stdlib: `context.WithTimeout(nil, time.Second)` will panic, but we do not panic for validation errors or a failure to read a file.

Ensure you _do not_ use `pkgerrors.New` and friends for defining constant errors, use the standard `errors` library.
Name errors `ErrBadThing`. Return such errors

```go
// good example. When _returning_ this err constant, use pkgerrors.WithStack to capture the runtime stack
var ErrGoodExample = errors.New("the bad thing")

// don't do this - adds a useless/confusing stack trace at process init
var ErrBadExample = pkgerrors.New("the bad thing")
```

Together this will ensure that:

1. all errors have informative stack traces
2. we don't have to write boilerplate error messages at each level of the stack
3. we aim to have a single log for each error, rather than noisy re-logging of the same error throughout the stack

### Paths

A filepath is a path as per `filepath`'s POSIX normalized
FP, i.e. `foo/bar` never `C:\foo\bar` (aka "filepath.ToSlash"). Name variables
with POSIX-normalized paths `fooFP` or `fooFilepath`. OS
paths should be `fooOS` or `fooFSPath`.

In LSP, file identifiers are URIs. Generally we adopt this,
as it makes it possible to support non-local editing in the future.
If your code does not support non-`file:` URIs, return an error.

### File locations

LSPs specify locations in files in UTF-16. Go strings are UTF-8. Generally, pass around
file location as _byte_ positions for complete clarity. When we modify files,
we can then be certain we're applying them in the right place, independent of
encoding (which may be neither of UTF-8 or UTF-16).

### Handler

JSON-RPC handlers dispatched through `internal/handler/` receive a non-nil
request context in `(*glsp.Context).Context`.

## Debugging and building locally

Use `CAMBER_DESKTOP_LOCAL_HELPER=1` when starting desktop development to build
the helper from the current checkout. See the [desktop README](../../ui/apps/desktop-assistant/README.md)
for launch commands and [diagnostics](../../docs/diagnostics.md) for log locations.

Native builds require the Xcode Command Line Tools and `CGO_ENABLED=1`.

## Profiling

For debugging memory and CPU issues, pprof profiles are exposed on a `127.0.0.1`
port. Check the Camber Helper output for the exact port — because multiple
helpers can run at once, it varies.

## DB forward-version compatibility

Helper-owned SQLite DBs (e.g. the acpnav conversation store) run their
migrations through `internal/dbmigrate`, which wraps `golang-migrate` with a
"forward-version tolerance" policy: when a DB records a migration version
ahead of what this binary embeds (i.e. the user downgraded), the helper
logs and proceeds instead of hard-failing at startup.

Forward-version tolerance assumes that an older binary can still use a schema
created by a newer binary. The repository does not currently enforce that
compatibility automatically, so review downgrade compatibility before adding
a migration. For a breaking schema change, bump the DB filename instead —
users get a fresh DB on upgrade and the old file stays on disk for manual
downgrade.
