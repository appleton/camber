import { escape } from "html-escaper";
import { createCssVariablesTheme, createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages } from "shiki/langs";
import type { BundledLanguage } from "shiki/types";
import { canUseShikiWasmEngine } from "../../utils/shikiEngine.js";
import { resolveHighlightLanguage } from "./resolveHighlightLanguage.js";
export { resolveHighlightLanguage } from "./resolveHighlightLanguage.js";

/**
 * The shiki pipeline shared by the main thread and the highlight worker —
 * everything here must stay free of DOM APIs so it runs in both contexts.
 * The worker facade lives in `codeHighlight.ts`; both sides produce
 * byte-identical HTML through {@link highlightToHtml}.
 */

export interface HighlightWorkerRequest {
  id: number;
  code: string;
  language: string | undefined;
}

export interface HighlightWorkerResponse {
  id: number;
  html?: string;
  error?: string;
}

const CAMBER_THEME = createCssVariablesTheme({
  name: "camber-code",
  variablePrefix: "--psx-shiki-",
  variableDefaults: {
    foreground: "var(--psx-foreground-primary)",
    background: "transparent",
    "token-comment": "var(--color-prettylights-syntax-comment)",
    "token-constant": "var(--color-prettylights-syntax-constant)",
    "token-string": "var(--color-prettylights-syntax-string)",
    "token-string-expression": "var(--color-prettylights-syntax-string)",
    "token-keyword": "var(--color-prettylights-syntax-keyword)",
    "token-parameter": "var(--color-prettylights-syntax-variable)",
    "token-function": "var(--color-prettylights-syntax-entity)",
    "token-punctuation": "var(--psx-foreground-primary)",
    "token-link": "var(--color-prettylights-syntax-constant-other-reference-link)",
    "token-inserted": "var(--color-prettylights-syntax-markup-inserted-text)",
    "token-deleted": "var(--color-prettylights-syntax-markup-deleted-text)",
    "token-changed": "var(--color-prettylights-syntax-markup-changed-text)",
  },
});

let highlighterPromise: ReturnType<typeof createHighlighterCore> | undefined;
const loadingLanguages = new Map<BundledLanguage, Promise<void>>();

function getHighlighter() {
  // The wasm engine is 5-15x faster and, unlike the JS regex engine, has no
  // pathological grammars that can stall for seconds on a large streamed
  // code block. The wasm binary is a lazy chunk loaded on first highlight;
  // environments whose CSP forbids wasm keep the JS engine.
  return (highlighterPromise ??= createHighlighterCore({
    themes: [CAMBER_THEME],
    langs: [],
    engine: canUseShikiWasmEngine()
      ? createOnigurumaEngine(import("shiki/wasm"))
      : createJavaScriptRegexEngine(),
  }));
}

async function loadLanguage(language: BundledLanguage) {
  let pending = loadingLanguages.get(language);
  if (!pending) {
    pending = getHighlighter().then(async (highlighter) => {
      if (!highlighter.getLoadedLanguages().includes(language)) {
        await highlighter.loadLanguage(await bundledLanguages[language]());
      }
    });
    loadingLanguages.set(language, pending);
  }
  await pending;
}

/** Highlight a complete static block, loading only its grammar on first use. */
export async function highlightToHtml(code: string, language: string | undefined): Promise<string> {
  const lang = resolveHighlightLanguage(language);
  if (!lang) return escape(code);

  try {
    await loadLanguage(lang);
    const highlighter = await getHighlighter();
    const result = highlighter.codeToTokens(code, { lang, theme: "camber-code" });
    return result.tokens
      .map((line) =>
        line
          .map((token) => {
            const styles = [`color:${token.color}`];
            if (token.fontStyle && token.fontStyle & 1) styles.push("font-style:italic");
            if (token.fontStyle && token.fontStyle & 2) styles.push("font-weight:bold");
            if (token.fontStyle && token.fontStyle & 4) styles.push("text-decoration:underline");
            return `<span style="${escape(styles.join(";"))}">${escape(token.content)}</span>`;
          })
          .join(""),
      )
      .join("\n");
  } catch {
    return escape(code);
  }
}
