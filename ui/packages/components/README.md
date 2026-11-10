@camber/components contains reusable UI, not coupled to business logic or state. UI state is fine, e.g. whether a component has been clicked, or the value of fields currently shown in a form. UI components that are coupled to application logic belong within their relevant @camber/features package.

## Highlighting bundles

Chat highlighting uses Shiki core, the app's CSS-variable theme, and lazy grammar loaders. The small `highlightLanguages.ts` registry contains every installed language name and alias without importing the tokenizer into UI name lookup. Regenerate it with `node scripts/highlight-languages.mjs` after updating Shiki; the highlighting tests compare it with the complete installed registry. Both WASM and the CSP-compatible JavaScript engine remain available.

Chat and Pierre workers use `?shared-worker`, provided by `@camber/vite-config`. Production emits them in the same Rollup graph as the window, sharing grammar/engine URLs without rewriting generated assets. Development uses Vite's standard module-worker path; restart the Vite server after changing the shared configuration. Keep these worker entries DOM-free: the build rejects CSS in their import closure. The build integration also guards Vite's preload helper for worker contexts and fails on an incompatible helper shape, so rerun its Node tests and production-worker browser checks when updating Vite.

The pinned `@pierre/diffs` patch uses narrow Shiki imports and the same core constructor as Pierre's own worker. Its existing language/theme resolvers still supply grammars, registered app themes, and optional upstream themes. Modified dependency modules retain accurate final JS source maps by omitting their stale upstream map links. See the [B3 evidence](../../../docs/performance-audit/implementation.md#b3--shared-worker-assets-and-narrow-highlighter-imports) for all-host grammar, engine, fallback and UI checks.

## Adding a component

1. Add a directory inside `src/lib/components`, e.g. `src/lib/components/cool-component`.
2. Add this directory to `exports` in `package.json`. The `index.ts` should contain all public exports to ensure a consciously designed public API for your feature.
3. Add a storybook (with `play` tests for interactions)
4. Ensure your component has enough document to be used by others

## Markdown diagrams

`MarkdownBlock` renders fenced `mermaid` diagrams inline when the host enables
`showMermaidDiagrams`. The standalone component and desktop app enable this by
default; IDE hosts retain their existing setting. Untagged code blocks starting
with a Mermaid `flowchart` or `graph` direction also render as diagrams. Use a
`text` fence to display the syntax literally.

The copy control copies the original diagram source. Invalid diagrams keep their
source visible with an error, and open streaming fences remain code until closed.

## Codex file citations

Codex `:codex-file-citation{path="..." purpose="source"}` references render as
inline file chips using the filename as their label and the full path on hover.
They use the existing host file-opening behavior; desktop PDF links open in the
system viewer. Missing files retain a readable filename and path tooltip. User
messages, code examples, and malformed references remain literal.

## Codex visualizations

`MarkdownBlock` requires explicit `allowVisualizations` opt-in to recognize
standalone Codex `visualize` content references. Only assistant reply text opts
in; user messages, tool output, GitHub bodies, and file previews stay literal.
Only parser-created references can load files; raw HTML attributes cannot.

The desktop host provides `readVisualizationFile` to load local `.html` or `.htm`
files; assistant replies pass their conversation working directory via
`visualizationBasePath` to resolve relative paths independently in each chat pane.
Standalone callers fall back to the host workspace. URL, UNC, and device paths are
rejected before reading. IDE hosts show a file link until their native bridges
and bounded reads have been verified. Missing files show an error and retry.

Previews use two opaque iframes with `sandbox="allow-scripts"`, without same-origin
access. The trusted outer frame's CSP blocks navigation of the untrusted inner
frame, so generated scripts cannot navigate away and discard their policy.
Only source-checked, bounded height messages are relayed. CSP blocks fetch/XHR,
network frame navigation, and forms, while allowing static resources from the visualization
CDN allowlist. Fragments have a 1 MB limit (desktop file reads also have a native
5 MiB limit). Common visualization styles and theme variables are provided;
Codex-specific APIs such as `window.openai` and `Tweak` are not implemented.

Run the real-browser navigation regression with
`pnpm -F @camber/components test:storybook src/lib/components/markdown/Visualization.stories.svelte`.
It exercises script, meta-refresh, anchor, and mailto navigation in Playwright,
with synthetic destination requests intercepted before they can reach the network.
