# `@camber/assistant`

## About

This is the shared Svelte assistant shell used by the desktop app and its
mobile remote companion.

## Building and running from source

Follow the repository [build-from-source instructions](../../../INSTALL.md#build-from-source),
then run the desktop app from the repository root:

```sh
pnpm -F @camber/desktop-assistant dev
```

See the [desktop README](../../apps/desktop-assistant/README.md) for native build
requirements and runtime configuration.

## Tests

We have two types of test, unit and integration.

### Unit

Unit tests exercise the contents of the `src` directory which is a Svelte app responsible for
rendering the main panel UI.

- Unit tests use [Vitest](https://vitest.dev) and [Testing Library](https://testing-library.com/docs/svelte-testing-library/intro/).
- Unit test files follow the pattern `/src/**/*.test.ts`, new test files should be placed in the
  same directory as the source file. They should be named like `<SRC_NAME>.test.ts` e.g. a test for `index.ts`
  is named `index.test.ts`.

```sh
pnpm -F @camber/assistant test:unit
```
