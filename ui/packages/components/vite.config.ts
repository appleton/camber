import base, { mergeConfigs } from "@camber/vite-config";
import { defineConfig } from "vite";
import { visualizationCommands } from "./tests/visualizationCommands.js";

export default defineConfig((env) =>
  mergeConfigs(base(env), {
    test: { browser: { commands: visualizationCommands } },
    // Storybook discovers these after transforming Svelte stories. Prebundle
    // them so a cold test run cannot reload the browser halfway through setup.
    optimizeDeps: {
      include: [
        "@storybook/svelte-vite",
        "storybook/test",
        "storybook/theming",
        "marked",
        "html-escaper",
        "parse-diff",
        "mermaid",
        "katex",
        "dompurify",
        "html-entities",
        "bits-ui",
        "@melt-ui/svelte",
        "svelte-copy",
        "shiki",
        "shiki/wasm",
        "@camber/tailwind-config > tailwind-variants",
      ],
    },
  }),
);
