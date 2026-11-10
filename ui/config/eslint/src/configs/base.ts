import { globalIgnores } from "eslint/config";
import globals from "globals";
import ts, { type ConfigArray } from "typescript-eslint";
import typescript from "../plugins/typescript.js";

const config: ConfigArray = ts.config(
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/build/",
    "**/.turbo/",
    "**/.svelte-kit/",
    "**/storybook-static/",
    "**/coverage/",
    "**/gen/",
    "**/src/gen/",
    "**/*.stories.svelte",
    "**/*.test.ts",
    "**/*.test.tsx",
  ]),
  {
    name: "camber/globals",
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  ...typescript,
);

export default config;
