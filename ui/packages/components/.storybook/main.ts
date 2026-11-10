import { defineConfig } from "@camber/storybook-config";

const DEFAULT_BRANCH = "head";

const config = defineConfig({
  refs: (_: unknown, { configType }: { configType?: "DEVELOPMENT" | "PRODUCTION" }) => {
    if (configType === "DEVELOPMENT") {
      return {
        assistant: {
          disable: true,
        },
      };
    }
    const branch =
      (process.env.GITHUB_HEAD_REF === "main" ? DEFAULT_BRANCH : process.env.GITHUB_HEAD_REF) ||
      DEFAULT_BRANCH;

    return {
      assistant: {
        title: "Assistant",
        url: `https://${branch}--${process.env.CHROMATIC_ASSISTANT_APP_ID}.chromatic.com`,
      },
    };
  },
});

export default { ...config };
