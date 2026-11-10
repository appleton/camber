import {
  createCSSVariablesTheme,
  formatCSSVariablePrefix,
  registerCustomTheme,
} from "@pierre/diffs";

export type PierreTheme = "light" | "dark";

/**
 * The one place the app's editor background enters pierre's world. Every diff
 * surface sets this as `--diffs-background`, the top of pierre's own chain
 * (`--diffs-background` → `--diffs-light-bg`/`--diffs-dark-bg` → `--diffs-bg`),
 * so the card fill, the separator bars, the sticky-header backdrop and the
 * shiki theme all read one derived value instead of re-deriving from
 * `--psx-editor-background` in six places.
 *
 * Alpha is stripped (`/ 1`). Pierre mixes this into the accent to make the
 * added/removed line fills — `color-mix(in lab, <this> 85%, <accent>)` — so a
 * translucent editor background (the desktop vibrancy surfaces mix one) drags
 * those fills down to a few percent alpha and the diff renders with coloured
 * gutter numbers over uncoloured lines. Relative color syntax keeps the origin
 * alpha unless it is stated, hence the explicit `/ 1`.
 */
export const DIFF_SURFACE_BACKGROUND =
  "rgb(from var(--psx-editor-background, light-dark(#ffffff, #1b1f23)) r g b / 1)";

/** Detects the color scheme published by the app's webview hosts. */
export function detectPierreTheme(): PierreTheme {
  const root = document.documentElement;
  const body = document.body;
  if (root.classList.contains("vscode-light") || body?.classList.contains("vscode-light")) {
    return "light";
  }
  if (
    root.classList.contains("vscode-dark") ||
    root.classList.contains("dark") ||
    body?.classList.contains("vscode-dark") ||
    body?.classList.contains("dark")
  ) {
    return "dark";
  }

  const colorScheme = getComputedStyle(root).colorScheme;
  if (colorScheme.includes("dark")) return "dark";
  if (colorScheme.includes("light")) return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Registers Shiki CSS-variable themes backed by the app's existing syntax and
 * editor color tokens. Pierre can then render code and diffs with one palette.
 */
function registerAppTheme(type: PierreTheme): string {
  const name = `camber-code-${type}`;
  const dark = type === "dark";
  const syntax = (token: string, fallback: string) =>
    `var(--color-prettylights-syntax-${token}, ${fallback})`;
  const foreground = `var(--psx-foreground-primary, ${dark ? "#c9d1d9" : "#24292f"})`;
  const theme = createCSSVariablesTheme({
    name,
    variablePrefix: formatCSSVariablePrefix("global"),
    fontStyle: true,
    variableDefaults: {
      foreground,
      // Defers to the surface's DIFF_SURFACE_BACKGROUND rather than naming the
      // app token again; if that ever fails to resolve, pierre's own
      // `--diffs-bg` fallback (#fff/#000) is the opaque last resort.
      background: "var(--diffs-background)",
      "token-comment": syntax("comment", dark ? "#8b949e" : "#57606a"),
      "token-constant": syntax("constant", dark ? "#79c0ff" : "#0550ae"),
      "token-string": syntax("string", dark ? "#a5d6ff" : "#0a3069"),
      "token-string-expression": syntax("string", dark ? "#a5d6ff" : "#0a3069"),
      "token-keyword": syntax("keyword", dark ? "#ff7b72" : "#cf222e"),
      "token-parameter": syntax("variable", dark ? "#ffa657" : "#953800"),
      "token-function": syntax("entity", dark ? "#d2a8ff" : "#6639ba"),
      "token-punctuation": foreground,
      "token-link": syntax("constant-other-reference-link", dark ? "#a5d6ff" : "#0a3069"),
      "token-inserted": syntax("markup-inserted-text", dark ? "#aff5b4" : "#116329"),
      "token-deleted": syntax("markup-deleted-text", dark ? "#ffdcd7" : "#82071e"),
      "token-changed": syntax("markup-changed-text", dark ? "#ffdfb6" : "#953800"),
    },
  });

  // Pierre's diff accents come from CSS overrides; leave only editor colors
  // here so Shiki does not normalize CSS variables into placeholder values.
  theme.colors = {
    "editor.foreground": theme.colors?.["editor.foreground"] ?? "",
    "editor.background": theme.colors?.["editor.background"] ?? "",
  };
  theme.type = type;
  registerCustomTheme(name, () => Promise.resolve(theme));
  return name;
}

export const PIERRE_APP_THEMES = {
  light: registerAppTheme("light"),
  dark: registerAppTheme("dark"),
} as const;
