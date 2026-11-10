import type { Preview } from "@storybook/svelte-vite";
import { merge } from "ts-deepmerge";
import githubDarkDefault from "./themes/github-dark-default.css?raw";
import githubDark from "./themes/github-dark.css?raw";
import githubLightDefault from "./themes/github-light-default.css?raw";
import githubLight from "./themes/github-light.css?raw";
import oneDarkPro from "./themes/one-dark-pro.css?raw";
import vscodeDarkHC from "./themes/vscode-dark-hc.css?raw";
import vscodeDarkModern from "./themes/vscode-dark-modern.css?raw";
import vscodeDarkPlus from "./themes/vscode-dark-plus.css?raw";
import vscodeLightHC from "./themes/vscode-light-hc.css?raw";
import vscodeLightModern from "./themes/vscode-light-modern.css?raw";
import vscodeLightPlus from "./themes/vscode-light-plus.css?raw";

const themes = {
  "github-dark": {
    title: "GitHub Dark",
    right: "vscode",
    styles: githubDark,
    scheme: "dark",
  },
  "github-dark-default": {
    title: "GitHub Dark Default",
    right: "vscode",
    styles: githubDarkDefault,
    scheme: "dark",
  },
  "github-light": {
    title: "GitHub Light",
    right: "vscode",
    styles: githubLight,
    scheme: "light",
  },
  "github-light-default": {
    title: "GitHub Light Default",
    right: "vscode",
    styles: githubLightDefault,
    scheme: "light",
  },
  "one-dark-pro": {
    title: "One Dark Pro",
    styles: oneDarkPro,
    scheme: "dark",
  },
  "vscode-dark-hc": {
    title: "Dark High Contrast",
    right: "vscode",
    styles: vscodeDarkHC,
    scheme: "dark",
  },
  "vscode-dark-modern": {
    title: "Dark Modern",
    right: "vscode",
    styles: vscodeDarkModern,
    scheme: "dark",
  },
  "vscode-dark-plus": {
    title: "Dark+",
    right: "vscode",
    styles: vscodeDarkPlus,
    scheme: "dark",
  },
  "vscode-light-hc": {
    title: "Light High Contrast",
    right: "vscode",
    styles: vscodeLightHC,
    scheme: "light",
  },
  "vscode-light-modern": {
    title: "Light Modern",
    right: "vscode",
    styles: vscodeLightModern,
    scheme: "light",
  },
  "vscode-light-plus": {
    title: "Light+",
    right: "vscode",
    styles: vscodeLightPlus,
    scheme: "light",
  },
} as const;

type Theme = keyof typeof themes;

const base = {
  argTypes: {
    children: { table: { disable: true } },
    child: { table: { disable: true } },
  },
  globalTypes: {
    theme: {
      description: "Theme",
      toolbar: {
        dynamicTitle: true,
        items: Object.entries(themes)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, { scheme, ...rest }]) => ({
            icon: scheme === "dark" ? "moon" : "sun",
            value: key,
            ...rest,
          })),
      },
    },
  },
  initialGlobals: {
    theme: "github-dark" satisfies Theme,
  },
  parameters: {
    backgrounds: { disable: true },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: "todo",
    },
  },
  decorators: [
    (story, context) => {
      const themeKey = context.globals.theme as Theme;
      const { ownerDocument } = context.canvasElement;
      const { documentElement } = ownerDocument;
      const theme = themes[themeKey];
      documentElement.classList.remove("psx-light", "psx-dark");
      documentElement.classList.add(`psx-${theme.scheme}`);
      const load = async () => {
        let style = ownerDocument.querySelector("style[data-theme]");
        if (!style) {
          style = ownerDocument.createElement("style");
          ownerDocument.head.appendChild(style);
        }
        style.setAttribute("data-theme", themeKey);
        style.textContent = theme.styles;
      };
      void load();
      return story();
    },
  ],
} satisfies Preview;

/**
 * Merges a package's `.storybook/preview.ts` over the shared base.
 *
 * Deliberately not called `definePreview`: Storybook decides whether a preview
 * uses CSF Factories by scanning `.storybook/preview.ts` for an import named
 * `definePreview` from any module specifier containing "storybook" — which
 * `@camber/storybook-config` does. It then generates
 * `preview.default.composed`, and because this returns a plain annotations
 * object there is no `composed`, so no renderer annotations load and every
 * story fails with MissingRenderToCanvasError. `@storybook/svelte` does not
 * export `definePreview` at all, so classic CSF is the only option here.
 */
export function definePreviewConfig(preview: Partial<Preview> = {}) {
  return merge(base, preview) as Preview;
}
