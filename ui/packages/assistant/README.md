# `@camber/assistant`

## About

This is the shared Svelte assistant shell used by the desktop app and IDE
extensions.

## Building and running from source

1. Node and pnpm versions are specified in `.tool-versions`. Make sure you have the correct versions
   installed.
2. Ensure that you're in the repository root.
3. Run `pnpm install`.
4. In a new shell, run `code .`.
5. When VS Code loads, press **F5** with the **Launch Extension** configuration
   selected to open a development window with the extension loaded.

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
pnpm run test
```
