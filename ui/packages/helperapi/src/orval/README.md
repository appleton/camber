# Orval JSON-RPC generator

The custom Orval generator in `jsonrpcGenerator.ts` creates type-safe wrappers
that convert OpenAPI paths to JSON-RPC method names and call the runtime defined
in `clientHelpers.ts`.

Regenerate the bindings from the repository root:

```sh
pnpm -F @camber/helperapi codegen
```
