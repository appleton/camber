import base, { mergeConfigs } from "@camber/vite-config";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig((env) =>
  mergeConfigs(
    base(env),
    defineConfig({
      plugins: [],

      resolve: {
        alias: [
          {
            find: "#tailwind.css",
            replacement: "",
            customResolver: (_, importer) => {
              if (!importer) return;

              if (importer.includes("@camber/assistant")) {
                return path.resolve(import.meta.dirname, "./src/assistant.css");
              }

              return;
            },
          },
        ],
      },

      build: {
        rollupOptions: {
          input: ["./assistant.html", "./acp-chat.html"],
          output: {
            entryFileNames: "assets/[name].js",
            chunkFileNames: "assets/[name].js",
            assetFileNames: "assets/[name].[ext]",
          },
        },
        sourcemap: false,
      },

      server: {
        port: 5176,
        strictPort: true,
      },
    }),
  ),
);
