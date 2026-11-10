<script lang="ts">
  import { run } from "svelte/legacy";

  import parseDiff from "parse-diff";
  import { compact } from "@camber/lib/array";
  import mermaid from "mermaid";
  import Icon from "../icon/Icon.svelte";
  import CodeBlockOptions from "../assistant-ui/CodeBlockOptions/CodeBlockOptions.svelte";
  import CopyToClipboard from "../assistant-ui/CopyToClipboard.svelte";
  import RunCommand from "../assistant-ui/RunCommand.svelte";
  import { highlight, memoizedHighlight } from "../assistant-ui/codeHighlight.js";
  import { codeBlockHtml } from "../assistant-ui/codeClipboard.js";
  import { hashString } from "../assistant-ui/hash.js";
  import { escape } from "html-escaper";
  import { defaultMarkdownHost, type MarkdownHostAdapter } from "./host.js";
  import { sanitizeMermaidSvg } from "./mermaidSvg.js";
  import { isMermaidCode } from "./mermaidCode.js";

  interface Props {
    text: string;
    startLine?: number | undefined;
    // this is either a fence language, e.g. python, or a scope, e.g. scope.python
    lang: string | undefined;
    diff?: parseDiff.File | undefined;
    isCopyable?: boolean;
    hasHeader?: boolean;
    /** Global caching is reserved for immutable code blocks. */
    cacheHighlighting?: boolean;
    host?: MarkdownHostAdapter;
  }

  let {
    text,
    startLine = undefined,
    lang,
    diff = undefined,
    isCopyable = true,
    hasHeader = false,
    cacheHighlighting = true,
    host = defaultMarkdownHost,
  }: Props = $props();

  function find(diff: parseDiff.File | undefined, operationType: "add" | "del", line: number) {
    if (!diff) return;

    return diff.chunks.find((chunk) => {
      return chunk.changes.find((chunk) => {
        return chunk.type === operationType && chunk.ln === line;
      });
    });
  }

  function isAddition(diff: parseDiff.File | undefined, line?: number) {
    if (!line) return false;
    return !!find(diff, "add", line);
  }

  /**
   * Returns an array of contiguous delete changes starting with the given line.
   * - If the given line is undefined then return empty
   * - If the given line does not have a deletion then return empty
   * - If the given line is not at the start of a contiguous block then return empty
   */
  function changes(kind: "add" | "del", diff: parseDiff.File | undefined, line?: number) {
    if (!line) return [];

    const chunk = find(diff, kind, line);
    if (!chunk?.changes) return [];

    const startIndex = chunk.changes.findIndex(
      (change) => change.type === kind && change.ln === line,
    );

    if (startIndex !== 0 && chunk.changes[startIndex - 1].type === kind) return [];

    // Find the index of the last in this block of contiguous deletions
    const endIndex = chunk.changes.findIndex((change, i) => {
      // false if this line is before the start line (means there was another delete block before
      // this one)
      if (i < startIndex) return false;

      const isLastChunk = chunk.changes.length - 1 === i;
      return change.type === kind && (isLastChunk || chunk.changes[i + 1].type !== kind);
    });

    return chunk.changes.slice(startIndex, endIndex + 1) as
      | parseDiff.DeleteChange[]
      | parseDiff.AddChange[];
  }

  let codeLines: { isAdd: boolean; isDel: boolean; line?: number; code: string }[] = $state([]);
  let lastProcessedKey = "";
  let highlightVersion = 0;

  run(() => {
    // Keep only compact fingerprints between updates. Retaining the complete
    // text here used to pin the previous streaming snapshot alongside the
    // current source and highlighted DOM.
    const diffSource = diff ? JSON.stringify(diff) : "";
    const processKey = [
      hashString(text),
      text.length,
      startLine,
      lang,
      cacheHighlighting,
      hashString(diffSource),
      diffSource.length,
    ].join(":");
    if (processKey === lastProcessedKey) return;
    lastProcessedKey = processKey;
    // First, build up an array of lines that represent all regular lines, additions and deletions.
    codeLines = text
      .split("\n")
      .map((codeLine, i) => {
        const lineNumber = startLine ? i + startLine : undefined;
        const deleteLines = changes("del", diff, lineNumber).map((change) => {
          return {
            isAdd: false,
            isDel: true,
            line: change.ln,
            code: change.content.replace(/^-/, ""),
          };
        });

        const addLines = changes("add", diff, lineNumber).map((change) => {
          return {
            isAdd: true,
            isDel: false,
            line: change.ln,
            code: change.content.replace(/^\+/, ""),
          };
        });

        return compact([
          ...deleteLines,
          ...addLines,
          isAddition(diff, lineNumber)
            ? undefined
            : { isAdd: false, isDel: false, line: lineNumber, code: codeLine },
        ]);
      })
      .flat();

    // Paint escaped source immediately, then replace it once this block's lazy
    // grammar has loaded. The version guard prevents an older stream chunk
    // from overwriting a newer one when highlighting resolves out of order.
    const version = ++highlightVersion;
    const source = codeLines.map((line) => line.code).join("\n");
    codeLines = codeLines.map((line) => ({ ...line, code: escape(line.code) }));
    const highlightSource = cacheHighlighting ? memoizedHighlight : highlight;
    void highlightSource(source, lang).then((html) => {
      if (version !== highlightVersion) return;
      const highlightedLines = html.split("\n");
      codeLines = codeLines.map((line, i) => ({ ...line, code: highlightedLines[i] ?? line.code }));
    });
  });

  let hostStateStore = $derived(host.state);
  let hostState = $derived($hostStateStore);
  let capabilities = $derived(hostState.environment.capabilities ?? {});
  let isRunnable = $derived(!!capabilities.runTerminalCommands && lang === "bash");
  // HTML representation for rich-clipboard copy (text/html MIME type).
  // Passed as a getter so the expensive escape work only runs when the user
  // clicks copy, not on every streaming chunk re-render.
  function getCodeHtml() {
    return codeBlockHtml(text, lang);
  }
  // Extract only the specific settings we care about to avoid unnecessary reactivity
  let showMermaidDiagrams = $derived(hostState.userSettings.showMermaidDiagrams);
  let wrapLines = $derived(hostState.userSettings.wrapLines);
  let isMermaid = $derived(isMermaidCode(text, lang) && showMermaidDiagrams);
  let renderedSvg = $state("");
  let mermaidError = $state<string | null>(null);
  let showDiagram = $derived(isMermaid && !!renderedSvg);
  const diagramDescriptionId = $props.id();

  $effect(() => {
    const enabled = isMermaid;
    const source = text;
    const settled = cacheHighlighting;
    renderedSvg = "";
    mermaidError = null;
    if (!enabled || !source) return;

    let cancelled = false;
    async function renderDiagram() {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          securityLevel: "strict",
          // The sanitizer excludes foreignObject, so labels must use SVG text.
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          logLevel: "fatal",
          suppressErrorRendering: true,
        });
        const { svg } = await mermaid.render(`mermaid-${crypto.randomUUID()}`, source);
        if (cancelled) return;
        renderedSvg = sanitizeMermaidSvg(svg);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        const line = message.match(/Parse error on line (\d+):/);
        mermaidError = line ? `Syntax error on line ${line[1]}` : "Invalid diagram syntax";
      }
    }

    // Completed fences render immediately; mutable code waits for a pause.
    const timer = setTimeout(() => void renderDiagram(), settled ? 0 : 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });
</script>

<div
  data-lang={lang || undefined}
  class="highlightedCode relative isolate overflow-hidden rounded-md border border-psx-border bg-psx-editor-background py-[3px] pr-1 pl-1"
  class:wrapped={wrapLines}
  class:rounder={capabilities.customUI}
>
  {#if isRunnable || isCopyable}
    <CodeBlockOptions isUnderHeader={hasHeader} {capabilities}>
      {#if isRunnable}
        <RunCommand command={text} {capabilities} openTerminal={host.openTerminal} />
      {/if}
      {#if isCopyable}
        <CopyToClipboard
          {text}
          html={getCodeHtml}
          forCode
          {capabilities}
          writeToClipboard={host.writeToClipboard}
          onCopyError={host.onCopyError}
          trackClick={host.trackClick}
        />
      {/if}
    </CodeBlockOptions>
  {/if}

  {#if showDiagram}
    <div
      class="mermaid-diagram"
      role="img"
      aria-label="Mermaid diagram"
      aria-describedby={diagramDescriptionId}
    >
      {@html renderedSvg}
    </div>
    <span id={diagramDescriptionId} hidden>{text}</span>
  {:else}
    <div class="codeScroll">
      <table role="presentation">
        <tbody>
          {#each codeLines as codeLine}
            <tr class:deletion={codeLine.isDel} class:addition={codeLine.isAdd}>
              {#if codeLine.line}
                <td class="lineNumber" aria-hidden="true">
                  <code class:opacity-60={codeLine.isDel}>
                    <span class="sr-only">
                      {#if codeLine.isAdd}add{/if}
                      {#if codeLine.isDel}delete{/if}
                    </span>
                    <span aria-hidden="true" class="mr-1 block">
                      {#if codeLine.isAdd}+{/if}
                      {#if codeLine.isDel}-{/if}
                    </span>
                    <span class="block"><span class="sr-only">line </span>{codeLine.line}</span>
                  </code>
                  <span class="lineNumberBackground"></span>
                </td>
              {/if}
              <td
                class="codeContent"
                class:border-none={!codeLine.line}
                class:pr-6={isCopyable && !hasHeader}
              >
                <pre><code>{@html codeLine.code}</code></pre>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if isMermaid && mermaidError}
    <div
      class="mermaid-error border-psx-input-invalid-border bg-psx-input-invalid-background m-1 flex items-center gap-1.5 rounded-md border px-2 py-1.5"
      role="status"
      title={mermaidError}
    >
      <Icon name="alert" class="text-psx-input-invalid-border h-4 w-4 shrink-0" />
      <span class="text-psx-input-invalid-border text-xs">{mermaidError}</span>
    </div>
  {/if}
</div>

<style lang="postcss">
  @reference "#tailwind.css";
  :global(body.web-app) .highlightedCode {
    @apply border-transparent bg-(--color-mono-000) shadow-(--shadow-border) dark:bg-(--color-mono-200);
  }

  .highlightedCode {
    font-size: inherit;
    line-height: var(--psx-text-leading, inherit);

    &.rounder {
      @apply rounded-xl;

      &:has(:global(.lineNumber)) {
        border-top-right-radius: 0;
      }
    }

    :global(.show-on-hover) {
      @apply opacity-0;
    }

    &:hover :global(.show-on-hover) {
      @apply opacity-100;
    }
  }

  .codeScroll {
    overflow-x: auto;
  }

  /* macOS overlay scrollbars only render mid-scroll, so overflowing lines
     were invisible cut-offs. A styled WebKit scrollbar opts out of overlay
     mode and shows whenever the code actually overflows. */
  .codeScroll::-webkit-scrollbar {
    height: 6px;
  }

  .codeScroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .codeScroll::-webkit-scrollbar-thumb {
    background-color: color-mix(in srgb, var(--psx-foreground-primary) 25%, transparent);
    border-radius: 9999px;
    /* Keep the thumb clear of the block's rounded corners. */
    border: 1px solid transparent;
    background-clip: padding-box;
  }

  .codeScroll::-webkit-scrollbar-thumb:hover {
    background-color: color-mix(in srgb, var(--psx-foreground-primary) 45%, transparent);
  }

  table {
    @apply w-full min-w-max;
  }

  .highlightedCode table {
    @apply my-0;
  }

  /* All lines of code */
  tr td {
    @apply relative !min-h-5;
  }

  tr td pre {
    @apply min-h-5 leading-5;
  }

  /* First line of code */
  :not(.wrapped) tr:first-of-type .lineNumber code {
    @apply pt-2;
  }
  :not(.wrapped) tr:first-of-type pre {
    @apply pt-[6px];
  }

  /* Last line of code */
  :not(.wrapped) tr:last-of-type .lineNumber code {
    @apply pb-2;
  }
  :not(.wrapped) tr:last-of-type pre {
    @apply pb-[6px];
  }

  /* Line Number */
  td.lineNumber code {
    @apply !pr-1 !pl-2 !text-psx-editor-line-number-foreground;
  }

  /* Additions + Deletions */
  .addition pre,
  .deletion pre {
    @apply opacity-100;
  }

  .addition {
    @apply bg-psx-diff-insert;
  }

  .deletion {
    @apply bg-psx-diff-delete;
  }

  /* Line Numbers */
  td.lineNumber {
    @apply sticky left-0 z-20 w-[1ch] bg-psx-editor-background align-top whitespace-nowrap select-none;
  }

  .lineNumberBackground {
    @apply absolute inset-0 opacity-60;
  }

  .addition .lineNumberBackground {
    @apply bg-psx-diff-insert opacity-60;
  }

  .deletion .lineNumberBackground {
    @apply bg-psx-diff-delete opacity-60;
  }

  .lineNumberBackground::after {
    content: "";
    @apply absolute inset-y-0 -right-px w-px bg-psx-border;
  }

  .addition .lineNumberBackground::after {
    @apply bg-psx-diff-insert-foreground opacity-20;
  }

  .deletion .lineNumberBackground::after {
    @apply bg-psx-diff-delete-foreground opacity-20;
  }

  .lineNumber code {
    @apply relative z-20 inline-flex w-full justify-between px-1 py-[2px] opacity-60;
  }

  .addition .lineNumber code {
    @apply text-psx-diff-insert-foreground opacity-70;
  }

  .deletion .lineNumber code {
    @apply text-psx-diff-delete-foreground opacity-70;
  }

  .codeContent {
    @apply flex w-full min-w-max pl-2;
  }

  :global(.userMessage) .codeContent {
    @apply -my-0.5 px-1.5;
  }

  .codeContent pre {
    @apply w-full min-w-max wrap-break-word whitespace-pre-wrap;
  }

  /* Styles for wrapped mode */
  .wrapped {
    table {
      @apply w-full min-w-0;
    }

    .codeContent {
      @apply min-w-0;
    }

    .codeContent pre {
      @apply min-w-0;
    }
  }

  /* Mermaid's neutral palette stays readable in both light and dark hosts. */
  .mermaid-diagram {
    @apply m-1 overflow-auto rounded bg-white p-4;
  }

  .mermaid-diagram :global(svg) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }
</style>
