import base, { mergeConfigs } from "@camber/vite-config";
import { execa } from "execa";
import console from "node:console";
import path from "node:path";
import { build } from "tsdown";
import type { ConfigEnv, PluginOption, ResolvedConfig, UserConfig } from "vite";
import { defineConfig } from "vite";

export function packageJsonDeclaration(): PluginOption {
  async function generateDeclaration() {
    await execa`pnpm codegen:types`;
  }

  return {
    name: "package-json-declaration",
    buildStart: generateDeclaration,
    configureServer(server) {
      const packageJsonPath = path.resolve("./package.json");
      server.watcher.add(packageJsonPath);
      server.watcher.on("change", async (filePath) => {
        if (path.resolve(filePath) === packageJsonPath) {
          await generateDeclaration();
        }
      });
    },
  };
}

function vscode(): PluginOption {
  const handleConfig = (config: UserConfig, { command }: ConfigEnv): UserConfig => {
    const { assetsDir = "webview" } = config.build ?? {};

    return {
      base: "./",
      build: {
        assetsDir,
        manifest: true,
        sourcemap: command === "build" ? "hidden" : false,
        copyPublicDir: false,
        minify: command === "build",
        rollupOptions: {
          output: {
            chunkFileNames: `${assetsDir}/[name].js`,
            entryFileNames: `${assetsDir}/[name].js`,
            assetFileNames: `${assetsDir}/[name].[ext]`,
          },
        },
      },
    };
  };

  let config: ResolvedConfig;

  return [
    {
      name: "@camber:vscode",
      apply: "serve",
      config: handleConfig,
      configResolved(_config) {
        config = _config;
      },
      configureServer(server) {
        if (!server.httpServer) return;

        const { assetsDir } = config.build ?? {};

        server.httpServer.once("listening", async () => {
          console.info("extension build start");
          let buildCount = 0;

          await build({
            watch: true,
            ignoreWatch: ["dist", `src/${assetsDir}`, "node_modules"],
            minify: false,
            onSuccess() {
              if (buildCount++ > 1) {
                console.info("extension rebuild success");
              } else {
                console.info("extension build success");
              }
            },
          });
        });
      },
    },
    {
      name: "@camber:vscode",
      apply: "build",
      enforce: "post",
      config: handleConfig,
      async closeBundle() {
        console.info("extension build start");
        await build({
          onSuccess() {
            console.info("extension build success");
          },
        });
      },
    },
    {
      /**
       * The `vscode` package which provides the extension API is dynamically built by the extension
       * host. The following allows vitest to mock this package even though it does not exist in the
       * test context.
       */
      name: "@camber:vscode",
      resolveId(id) {
        if (id === "vscode") {
          return "virtual:vscode";
        }
      },
    },
  ];
}

export default defineConfig((env) =>
  mergeConfigs(base(env), {
    plugins: [vscode(), packageJsonDeclaration()],
    optimizeDeps: {
      include: ["vscode-diff/dist/vs/editor/common/core/range"],
    },
    build: {
      rollupOptions: {
        input: ["./src/webview/assistant.main.ts", "./src/webview/acp-chat.main.ts"],
      },
    },
    server: {
      port: parseInt(process.env.VITE_DEV_PORT || "5173", 10),
      strictPort: true,
      cors: true,
      headers: {
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "*",
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "*",
      },
    },
  }),
);
