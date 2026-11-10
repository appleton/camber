import type { StorybookConfig } from "@storybook/svelte-vite";
import { merge } from "ts-deepmerge";

const base = {
  stories: ["../src/*.stories.svelte", "../src/lib/**/*.stories.svelte"],
  addons: [
    "@storybook/addon-svelte-csf",
    "@storybook/addon-a11y",
    "@storybook/addon-vitest",
    "@chromatic-com/storybook",
  ],
  framework: {
    name: "@storybook/svelte-vite",
    options: {},
  },
  staticDirs: ["../node_modules/@camber/tailwind-config/public"],
  previewHead: (head) => `${head}
<link
  rel="preload"
  href="/jetbrains-mono-regular.woff2"
  as="font"
  type="font/woff2"
  crossorigin
/>

<style>
  @font-face {
    font-family: "Jetbrains Mono";
    font-style: normal;
    font-display: swap;
    font-weight: 400;
    src: url("/jetbrains-mono-regular.woff2");
  }
  
  :root {
    --vscode-editor-font-family: JetBrains Mono;
    --vscode-editor-font-weight: normal;
    --vscode-editor-font-size: 14px;
    --vscode-editor-font-feature-settings: "liga" on, "calt" on;
  }
</style>`,
} satisfies StorybookConfig;

export function defineConfig(config: Partial<StorybookConfig> = {}) {
  return merge(base, config) as StorybookConfig;
}
