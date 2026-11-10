import base, { mergeConfigs } from "@camber/vite-config";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig((env) =>
  mergeConfigs(base(env), {
    build: {
      lib: {
        entry: { index: "src/index.ts" },
        formats: ["es"],
        cssFileName: "globals",
      },
    },
    plugins: [dts({ tsconfigPath: "./tsconfig.build.json" })],
  }),
);
