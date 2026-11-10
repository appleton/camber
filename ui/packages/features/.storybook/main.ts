import { defineConfig } from "@camber/storybook-config";

// Extend the shared config to also scan stories in src/auth
const config = defineConfig({
  stories: ["../src/**/*.stories.svelte"],
});

export default { ...config };
