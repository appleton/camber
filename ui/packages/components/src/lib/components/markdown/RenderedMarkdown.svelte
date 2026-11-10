<script lang="ts">
  import "katex/dist/katex.min.css";
  import "./Markdown.css";
  import { Marked } from "marked";
  import { escape } from "html-escaper";
  import HighlightedCode from "./HighlightedCode.svelte";
  import { tick, onDestroy, mount, unmount, getAllContexts } from "svelte";
  import { markedKatex } from "./markedKatex.js";
  import {
    uniqueWordsStore,
    addUniqueWord,
    normalizeWord,
    shouldColorize,
  } from "./CodeBadgeStore.js";
  import { get } from "svelte/store";
  import { encodeMarkdownHtmlEntries, sanitizeMarkdownHtml } from "./markdownUtils.js";
  import ChipNode from "../prompt/editor/chip/ChipNode.svelte";
  import FileChip from "./FileChip.svelte";
  import Visualization from "./Visualization.svelte";
  import { visualizationExtension, type VisualizationReference } from "./visualization.js";
  import { fileCitationExtension } from "./fileCitation.js";
  import {
    decodeFilePathTarget,
    isFilePath,
    FILE_PATH_REGEX,
    parseFilePathWithLine,
    stripMatchingQuotes,
  } from "./filePaths.js";
  import {
    CHIP_HOST_SELECTOR,
    buildSlashTokenRegex,
    collectEligibleTextNodes,
    createFileExistsCache,
    getMinimalDisplayPath,
    parseFilePathMatches,
    tildeStrikethroughTokenizer,
    type FilePathMatch,
  } from "./markdownRendererUtils.js";
  import { defaultMarkdownHost, type MarkdownHostAdapter } from "./host.js";
  import { reconcileMarkdownDom } from "./reconcileMarkdownDom.js";
  import { getCachedMarkdownHtml, setCachedMarkdownHtml } from "./markdownHtmlCache.js";

  interface Props {
    source: string;
    encodeHtmlEntities?: boolean;
    allowVisualizations?: boolean;
    visualizationBasePath?: string;
    copyableCode?: boolean;
    /** Cache highlighted code only when this Markdown source is immutable. */
    cacheCodeHighlighting?: boolean;
    /** Preserve compatible DOM while this source is the mutable stream tail. */
    streaming?: boolean;
    host?: MarkdownHostAdapter;
  }

  let {
    source,
    encodeHtmlEntities = false,
    allowVisualizations = false,
    visualizationBasePath,
    copyableCode = true,
    cacheCodeHighlighting = true,
    streaming = false,
    host = defaultMarkdownHost,
  }: Props = $props();

  const context = getAllContexts();
  let node = $state<HTMLDivElement>();

  let knownCommands = $derived(new Set(host.getSlashCommands?.().commands ?? []));
  let knownSkills = $derived(new Set(host.getSlashCommands?.().skills ?? []));

  const mountedComponents: Map<Element, ReturnType<typeof mount>> = new Map();
  const fileExistsCache = createFileExistsCache(host.checkFileExists);
  const workspaces = $derived(get(host.state).workspaces);

  function createFileLinkElement(
    fullPath: string,
    absolutePath: string,
    allPaths: string[],
    line?: number,
    column?: number,
    label?: string,
  ): HTMLSpanElement {
    const hostElement = document.createElement("span");
    hostElement.className = "inline-block align-baseline";
    hostElement.dataset["filePath"] = absolutePath;
    if (line !== undefined) hostElement.dataset["fileLine"] = String(line);
    if (column !== undefined) hostElement.dataset["fileColumn"] = String(column);

    const minimalPath = getMinimalDisplayPath(fullPath, allPaths, absolutePath, workspaces);
    const lineSuffix =
      line !== undefined ? (column !== undefined ? `:${line}:${column}` : `:${line}`) : "";
    const displayPath = label?.trim() || `${minimalPath}${lineSuffix}`;

    mountedComponents.set(
      hostElement,
      mount(FileChip, {
        target: hostElement,
        props: { absolutePath, displayPath, line, column, host },
        context,
      }),
    );
    return hostElement;
  }

  function createChipElement(name: string, type: "skill" | "command"): HTMLSpanElement {
    const hostElement = document.createElement("span");
    hostElement.className = "inline-block align-baseline";
    hostElement.dataset[type] = name;

    const label = name.startsWith("$") ? name.slice(1) : name;
    mountedComponents.set(
      hostElement,
      mount(ChipNode, {
        target: hostElement,
        props: {
          label,
          icon: type === "skill" ? "skills" : (host.getSlashCommandIcon?.(name) ?? "command"),
          ariaLabel: `${type} ${label}`,
        },
        context,
      }),
    );
    return hostElement;
  }

  const isFilePathLinkingSupported = $derived.by(() => {
    const state = get(host.state);
    return ["vscode", "vs", "desktop"].includes(state.environment.assistantHost ?? "");
  });

  type CodeHit =
    | { kind: "file"; element: Element; path: string; line?: number; column?: number }
    | { kind: "other"; element: Element; word: string };

  type LinkHit = {
    element: HTMLAnchorElement;
    path: string;
    line?: number;
    column?: number;
    label: string;
  };

  type TextHit = {
    textNode: Text;
    text: string;
    matches: FilePathMatch[];
  };

  const PROCESSED_CLASS = "camber-colorized";

  // Detect file-path references in the rendered markdown and replace them with
  // FileChip components. Handles two DOM shapes:
  //   - <code>foo/bar.ts</code>: replace the whole element
  //   - "...see foo/bar.ts at line 1...": split the text node around each match
  async function applyFilePathProcessing(root: Element, signal: AbortSignal) {
    let allCandidates: string[] = [];

    const linkHits: LinkHit[] = [];
    if (isFilePathLinkingSupported) {
      const links = root.querySelectorAll<HTMLAnchorElement>("a[data-file-link-target]");
      for (const element of links) {
        const encodedTarget = element.dataset["fileLinkTarget"];
        if (!encodedTarget) continue;

        const target = decodeFilePathTarget(encodedTarget);
        const { path, line, column } = element.hasAttribute("data-file-link-literal")
          ? { path: target, line: undefined, column: undefined }
          : parseFilePathWithLine(decodeFilePathTarget(target));
        allCandidates.push(path);
        linkHits.push({ element, path, line, column, label: element.textContent ?? "" });
      }
    }

    // Code elements whose entire textContent is a file path.
    const elements = root.querySelectorAll(
      `code:not(.highlightedCode code):not(.${PROCESSED_CLASS})`,
    );
    const codeHits = [...elements].map((element): CodeHit => {
      const word = element.textContent ?? "";
      const unquoted = stripMatchingQuotes(word);
      if (isFilePathLinkingSupported && unquoted && isFilePath(unquoted)) {
        const { path, line, column } = parseFilePathWithLine(unquoted);
        allCandidates.push(path);
        return { kind: "file", element, path, line, column };
      }
      return { kind: "other", element, word };
    });

    // File paths embedded inside plain text nodes.
    const textHits: TextHit[] = [];
    if (isFilePathLinkingSupported) {
      for (const textNode of collectEligibleTextNodes(root)) {
        const text = textNode.textContent ?? "";
        const matches = parseFilePathMatches(text, FILE_PATH_REGEX);
        if (matches.length === 0) continue;
        allCandidates = allCandidates.concat(matches.map((match) => match.path));
        textHits.push({ textNode, text, matches });
      }
    }

    // Markdown links whose target is a file path.
    for (const hit of linkHits) {
      const absolutePath = await fileExistsCache.resolve(hit.path, workspaces);
      if (signal.aborted) return;
      if (!absolutePath) continue;

      const fileLink = createFileLinkElement(
        hit.path,
        absolutePath,
        allCandidates,
        hit.line,
        hit.column,
        hit.label,
      );
      hit.element.parentNode?.replaceChild(fileLink, hit.element);
    }

    // Code-hit apply: swap whole <code> for FileChip if resolved, else colorize.
    for (const hit of codeHits) {
      if (hit.kind === "file") {
        const absolutePath = await fileExistsCache.resolve(hit.path, workspaces);
        if (signal.aborted) return;
        if (absolutePath) {
          const fileLink = createFileLinkElement(
            hit.path,
            absolutePath,
            allCandidates,
            hit.line,
            hit.column,
          );
          hit.element.parentNode?.replaceChild(fileLink, hit.element);
          continue;
        }
      }
      const word = hit.kind === "other" ? hit.word : (hit.element.textContent ?? "");
      hit.element.classList.add(PROCESSED_CLASS);
      if (shouldColorize(word) && word) {
        addUniqueWord(word);
        const colorClass = get(uniqueWordsStore).get(normalizeWord(word)) ?? "";
        if (colorClass) hit.element.classList.add(...colorClass.split(" "));
      }
    }

    // Text-hit apply: split each text node into a fragment of [text, chip, text, ...].
    for (const hit of textHits) {
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of hit.matches) {
        if (match.pathStartIndex > cursor) {
          fragment.appendChild(
            document.createTextNode(hit.text.slice(cursor, match.pathStartIndex)),
          );
        }
        const absolutePath = await fileExistsCache.resolve(match.path, workspaces);
        if (signal.aborted) return;
        if (absolutePath) {
          fragment.appendChild(
            createFileLinkElement(
              match.path,
              absolutePath,
              allCandidates,
              match.line,
              match.column,
            ),
          );
        } else {
          fragment.appendChild(
            document.createTextNode(
              hit.text.slice(match.pathStartIndex, match.pathStartIndex + match.matchedTextLength),
            ),
          );
        }
        cursor = match.pathStartIndex + match.matchedTextLength;
      }
      if (cursor < hit.text.length) {
        fragment.appendChild(document.createTextNode(hit.text.slice(cursor)));
      }
      hit.textNode.parentNode?.replaceChild(fragment, hit.textNode);
    }
  }

  const visualizationReferences = new Map<string, VisualizationReference>();
  const visualizationsEnabled = $derived(allowVisualizations && !encodeHtmlEntities);
  const md = $derived.by(() => {
    const parser = new Marked();
    parser.use(markedKatex({ useExtraRules: false, throwOnError: false }));
    parser.use(tildeStrikethroughTokenizer);
    if (!encodeHtmlEntities) parser.use(fileCitationExtension);
    if (visualizationsEnabled) {
      parser.use(
        visualizationExtension((reference) => {
          const id = crypto.randomUUID();
          visualizationReferences.set(id, reference);
          return id;
        }),
      );
    }
    return parser;
  });

  const renderer = $derived.by(() => {
    const r = new md.Renderer();
    r.code = ({ text, lang }) => {
      return `<div data-code="${encodeURIComponent(text)}" data-lang="${lang || ""}"></div>`;
    };

    r.link = function (token) {
      const href = token.href ?? "";
      const title = token.title ? ` title="${escape(token.title)}"` : "";
      // Reuse tokens lexed in link context. Re-lexing the label can discover
      // nested file citations or recursively rediscover bare URL autolinks.
      const text = this.parser.parseInline(token.tokens);

      if (isFilePathLinkingSupported && isFilePath(href)) {
        return `<a data-file-link-target="${encodeURIComponent(href)}"${title}>${text}</a>`;
      }

      return `<a href="${escape(href)}"${title}>${text}</a>`;
    };

    r.table = (token) => {
      const alignments = token.align || [];

      const header = `<tr>${token.header
        .map((cell, i) => {
          const align = alignments[i];
          const style = align ? ` style="text-align:${align}"` : "";
          return `<th${style}>${md.parseInline(cell.text)}</th>`;
        })
        .join("")}</tr>`;

      const rows = token.rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, i) => {
                const align = alignments[i];
                const style = align ? ` style="text-align:${align}"` : "";
                return `<td${style}>${md.parseInline(cell.text)}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("");

      return `<div class="table-container">
        <table>
          <thead>${header}</thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    };

    return r;
  });

  $effect(() => {
    md.setOptions({ renderer });
  });

  function mountCodeComponent(element: Element) {
    const text = decodeURIComponent(element.getAttribute("data-code") || "");
    const lang = element.getAttribute("data-lang") || "auto";

    if (mountedComponents.has(element)) return;

    element.innerHTML = "";
    mountedComponents.set(
      element,
      mount(HighlightedCode, {
        target: element,
        props: {
          text,
          lang,
          isCopyable: copyableCode,
          hasHeader: false,
          cacheHighlighting: cacheCodeHighlighting,
          host,
        },
      }),
    );
  }

  function highlightBareSlashTokens(
    root: Element,
    known: ReadonlySet<string>,
    type: "skill" | "command",
  ) {
    if (known.size === 0) return;

    const textNodes = collectEligibleTextNodes(root);
    const re = buildSlashTokenRegex(known);

    for (const textNode of textNodes) {
      const text = textNode.textContent ?? "";
      if (!text.includes("/") && !text.includes("$")) continue;

      const matches = [...text.matchAll(re)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        name: match[1].startsWith("/") ? match[1].slice(1) : match[1],
      }));
      if (matches.length === 0) continue;

      const parent = textNode.parentNode;
      if (!parent) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const { start, end, name } of matches) {
        if (start > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
        }
        fragment.appendChild(createChipElement(name, type));
        cursor = end;
      }
      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }
      parent.replaceChild(fragment, textNode);
    }
  }

  let updateContentAbortController: AbortController | null = null;
  let lastRenderedSource: string | undefined;
  let lastRenderedEncodeHtmlEntities: boolean | undefined;
  let lastRenderedVisualizationsEnabled: boolean | undefined;
  let lastRenderedVisualizationBasePath: string | undefined;
  let lastRenderedCopyableCode: boolean | undefined;
  let lastRenderedCacheCodeHighlighting: boolean | undefined;
  let lastRenderedStreaming: boolean | undefined;
  let lastRenderedKnownCommands: ReadonlySet<string> | undefined;
  let lastRenderedKnownSkills: ReadonlySet<string> | undefined;

  class AbortedError extends Error {}

  function clearMountedComponents() {
    mountedComponents.forEach((instance) => unmount(instance));
    mountedComponents.clear();
  }

  function clearMountedComponentsWithin(root: Node) {
    for (const [element, instance] of mountedComponents) {
      if (root === element || root.contains(element)) {
        void unmount(instance);
        mountedComponents.delete(element);
      }
    }
  }

  async function updateContent(
    currentKnownCommands: ReadonlySet<string>,
    currentKnownSkills: ReadonlySet<string>,
  ) {
    if (!node) return;
    if (
      source === lastRenderedSource &&
      encodeHtmlEntities === lastRenderedEncodeHtmlEntities &&
      visualizationsEnabled === lastRenderedVisualizationsEnabled &&
      visualizationBasePath === lastRenderedVisualizationBasePath &&
      copyableCode === lastRenderedCopyableCode &&
      cacheCodeHighlighting === lastRenderedCacheCodeHighlighting &&
      streaming === lastRenderedStreaming &&
      currentKnownCommands === lastRenderedKnownCommands &&
      currentKnownSkills === lastRenderedKnownSkills
    ) {
      return;
    }
    lastRenderedSource = source;
    lastRenderedEncodeHtmlEntities = encodeHtmlEntities;
    lastRenderedVisualizationsEnabled = visualizationsEnabled;
    lastRenderedVisualizationBasePath = visualizationBasePath;
    lastRenderedCopyableCode = copyableCode;
    lastRenderedCacheCodeHighlighting = cacheCodeHighlighting;
    lastRenderedStreaming = streaming;
    lastRenderedKnownCommands = currentKnownCommands;
    lastRenderedKnownSkills = currentKnownSkills;

    updateContentAbortController?.abort();
    updateContentAbortController = new AbortController();
    const signal = updateContentAbortController.signal;

    function throwIfAborted(signal: AbortSignal) {
      if (signal.aborted) throw new AbortedError();
    }

    try {
      const processedContent = encodeHtmlEntities ? encodeMarkdownHtmlEntries(source) : source;
      const cacheVariant = `${encodeHtmlEntities ? "encoded" : "raw"}:${isFilePathLinkingSupported ? "files" : "links"}:${visualizationsEnabled ? "visualizations" : "literal"}`;
      // References receive fresh, unguessable IDs for each parse. Raw HTML data
      // attributes cannot authorize file reads, and IDs must never be cached.
      visualizationReferences.clear();
      const cacheHtml =
        !streaming &&
        cacheCodeHighlighting &&
        !(visualizationsEnabled && processedContent.includes("visualize"));
      let html = cacheHtml ? getCachedMarkdownHtml(cacheVariant, processedContent) : undefined;

      if (html === undefined) {
        // Marked is synchronous with this renderer configuration. Keep that
        // fast path synchronous so settled blocks insert before the browser can
        // paint. Still support an async Marked extension without changing this
        // component's API.
        const parsedMarkdown = md.parse(processedContent);
        const markdown = typeof parsedMarkdown === "string" ? parsedMarkdown : await parsedMarkdown;
        html = sanitizeMarkdownHtml(markdown);
        if (cacheHtml) {
          setCachedMarkdownHtml(cacheVariant, processedContent, html);
        }
      }
      throwIfAborted(signal);

      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = html;

      if (streaming && mountedComponents.size === 0) {
        reconcileMarkdownDom(node, tempDiv, { beforeRemove: clearMountedComponentsWithin });
      } else {
        clearMountedComponents();
        node.replaceChildren(...tempDiv.childNodes);
      }

      await tick();
      throwIfAborted(signal);

      node.querySelectorAll("[data-code]").forEach((element) => {
        mountCodeComponent(element);
      });

      await tick();
      throwIfAborted(signal);

      // File and slash chips asynchronously mutate the DOM. Keep a live tail
      // structurally reconcilable; its immutable render performs this pass.
      if (streaming) return;

      if (visualizationsEnabled) {
        node.querySelectorAll<HTMLElement>("[data-visualization]").forEach((element) => {
          const reference = visualizationReferences.get(element.dataset.visualization ?? "");
          if (!reference) return;
          element.replaceChildren();
          mountedComponents.set(
            element,
            mount(Visualization, {
              target: element,
              props: { reference, host, basePath: visualizationBasePath },
              context,
            }),
          );
        });
      }

      await applyFilePathProcessing(node, signal);
      throwIfAborted(signal);

      highlightBareSlashTokens(node, currentKnownCommands, "command");
      highlightBareSlashTokens(node, currentKnownSkills, "skill");
    } catch (error) {
      if (error instanceof AbortedError) return;
      console.error("Error updating markdown content:", error);
    }
  }

  // Chips render their label inside inline-level flex/inline-block boxes. The
  // browser's clipboard serializer — which is NOT the same code path as
  // Selection.toString() — treats those boxes as block boundaries and injects a
  // line break before and after a chip when copying a selection that spans it
  // ("Changed [menu.ts] whatever" pastes with the chip on its own
  // line). Build the plain text ourselves, with each chip contributing only its
  // label, and write it to the clipboard directly so copied prose stays intact.
  function handleCopy(event: ClipboardEvent) {
    if (!node || !event.clipboardData) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    if (!node.contains(range.commonAncestorContainer)) return;

    const fragment = range.cloneContents();
    const chips = fragment.querySelectorAll(CHIP_HOST_SELECTOR);
    if (chips.length === 0) return; // No chips in the selection: let the browser copy normally.

    for (const chip of chips) {
      chip.replaceWith(document.createTextNode(chip.textContent ?? ""));
    }

    // Serialize with the browser's own algorithm inside the markdown CSS context
    // so block-level newlines (paragraphs, list items, code) are preserved while
    // the now-plain chip text stays inline. A detached scratch node would lose
    // that context, so mount it off-screen within `node`.
    const scratch = document.createElement("div");
    scratch.style.cssText = "position:fixed;left:-9999px;top:0;";
    scratch.appendChild(fragment);
    node.appendChild(scratch);

    const savedRange = range.cloneRange();
    const scratchRange = document.createRange();
    scratchRange.selectNodeContents(scratch);
    selection.removeAllRanges();
    selection.addRange(scratchRange);
    const text = selection.toString();
    const html = scratch.innerHTML;
    selection.removeAllRanges();
    selection.addRange(savedRange);

    node.removeChild(scratch);

    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/html", html);
    event.preventDefault();
  }

  onDestroy(() => {
    updateContentAbortController?.abort();
    clearMountedComponents();
    fileExistsCache.clear();
  });

  $effect(() => {
    const currentKnownCommands = knownCommands;
    const currentKnownSkills = knownSkills;
    if (source !== undefined) {
      updateContent(currentKnownCommands, currentKnownSkills);
    }
  });
</script>

<div bind:this={node} class="markdown" oncopy={handleCopy}>
  <!-- Parsed Markdown content is rendered here. -->
</div>
