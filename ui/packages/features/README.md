@camber/features contains shared application features, e.g. auth. Features can comprise state-management, UI, and anything else required. In contrast, @camber/components contains only UI logic and state.

Each feature should be self-contained. If there are cross-feature dependencies, express them via the public API, rather than mutual imports.

## Adding a feature

1. Add a directory inside `src/`, e.g. `src/new-feature`.
2. Add this directory to `exports` in `package.json`. The `index.ts` should contain all public exports to ensure a consciously designed public API for your feature.

## Connector logos

`ConnectorServiceIcon` ships only the logo names in `connectorLogoNames.ts`.
After changing that map or updating `@iconify-json/logos`, run
`pnpm -F @camber/features codegen:connector-logos`. The build checks that the
subset exactly matches upstream; do not import the full catalogue into UI code.
