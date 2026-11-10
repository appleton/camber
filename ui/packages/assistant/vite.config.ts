import base, { mergeConfigs } from "@camber/vite-config";
import { defineConfig } from "vite";

export default defineConfig((env) =>
  mergeConfigs(base(env), {
    optimizeDeps: {
      include: [],
    },
  }),
);
