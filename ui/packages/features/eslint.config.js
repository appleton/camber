import { defineConfig } from "@camber/eslint-config";
import acpRules from "./eslint-acp-rules.js";

export default defineConfig(
  {
    files: ["**/*.{ts,js,svelte}"],
    plugins: {
      acp: acpRules,
    },
    rules: {
      "acp/no-raw-helper-jsonrpc": "error",
      "acp/no-repository-construction-in-components": "error",
      "acp/no-repository-prop-drilling": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../*/**", "src/*/**"],
              message:
                "Cross-feature imports must go through the feature public API (import from the feature root). Do not deep-import files from another feature.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/acp/**/*.{ts,svelte}"],
    rules: {
      "acp/no-environment-branching-in-repositories": "error",
      "no-restricted-imports": "off",
    },
  },
);
