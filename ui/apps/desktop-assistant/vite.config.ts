import base, { mergeConfigs } from "@camber/vite-config";
import { defineConfig } from "vite";
import { startupBudget } from "./scripts/startup-budget";

export default defineConfig((env) =>
  mergeConfigs(base(env), {
    clearScreen: false,
    plugins: [startupBudget()],
    server: {
      port: Number(process.env.VITE_DEV_PORT ?? 5177),
      strictPort: true,
    },
    build: {
      // Sourcemaps stay dev-only: tauri build packages dist/ verbatim, so a
      // production `true` shipped ~90MB of .map files inside the app bundle,
      // growing the download and Gatekeeper's first-launch verification work.
      sourcemap: env.command === "serve" || process.env.CAMBER_BUILD_SOURCEMAPS === "1",
      rollupOptions: {
        input: {
          main: "index.html",
          thirdPartyLicenses: "third-party-licenses.html",
          changelog: "changelog.html",
        },
        output: {
          entryFileNames: "assets/[name].[hash].js",
          chunkFileNames: "assets/[name].[hash].js",
          assetFileNames: "assets/[name].[hash].[ext]",
        },
      },
    },
  }),
);
