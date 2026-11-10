# `@camber/helperapi`

Generated TypeScript bindings for the `camber-helper` JSON-RPC API.

The helper is not an HTTP API, but it exposes OpenAPI-shaped method and schema
metadata so clients can generate typed bindings.

## Regenerate

From the repository root:

```sh
pnpm -F @camber/helperapi codegen
```

Generated files live under `src/gen`. Do not edit generated files directly.

## Related

- Helper implementation: `../../../pkg/camber-helper/README.md`
- RPC contracts: `../rpc/README.md`
