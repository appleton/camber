import { defineConfig } from "@camber/eslint-config";
import acpRules from "./eslint-acp-rules.js";

export default defineConfig(
  {
    files: ["src/**/*.{ts,svelte}"],
    plugins: {
      acp: acpRules,
    },
    rules: {
      "acp/no-raw-helper-jsonrpc": "error",
      "acp/no-repository-construction-in-components": "error",
      "acp/no-repository-prop-drilling": "error",
    },
  },
  {
    files: ["src/lib/acp/**/*.{ts,svelte}"],
    rules: {
      "acp/no-environment-branching-in-repositories": "error",
    },
  },
);
