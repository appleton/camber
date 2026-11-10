import { defineConfig } from "@camber/storybook-config";

const config = defineConfig({
  stories: ["./**/*.stories.ts"],
});

export default {
  ...config,
  stories: ["./**/*.stories.ts"],
};
