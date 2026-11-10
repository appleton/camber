# Camber Assistant for Visual Studio Code

Camber Assistant for Visual Studio Code is an ACP client for coding agents in
your editor.

## Get started

Once Camber Assistant is installed, run **Camber: Show Sidebar** from the
Command Palette. If the Camber icon appears in the Activity Bar, you can open
it from there too.

For setting up agents, adding connectors, and starting your first conversation,
see [Getting started with Camber Assistant](https://github.com/appleton/camber/blob/main/docs/getting-started.md).

## Feedback

Report bugs and suggest features in [GitHub Discussions](https://github.com/appleton/camber/discussions).

## Release build diagnostics

`pnpm -F camber-assistant build` minifies the webview and extension host.
`dev` keeps watched output readable. Run `check:release-build` after building
to verify bundle budgets and that every runtime resource survives packaging.
Hidden source maps stay outside the VSIX; the release workflow retains them
with `release-provenance.json` in a separate artifact for 90 days. Download the
artifact for the matching release when resolving a minified stack trace.
