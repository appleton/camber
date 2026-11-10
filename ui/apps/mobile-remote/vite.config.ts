import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import base, { mergeConfigs } from "@camber/vite-config";
import { defineConfig, type Plugin } from "vite";

// Mirror camberqa's portsForSlot (ui/packages/camberqa/src/worktree/shared.ts)
// so each worktree's dev server and helper get distinct ports.
const slot = Number(process.env.CAMBER_WORKTREE_SLOT ?? "0") || 0;
const devPort = 5179 + slot * 10;
const remotePort = Number(process.env.CAMBER_REMOTE_PORT ?? "0") || 8737 + slot * 10;

const appDir = path.dirname(fileURLToPath(import.meta.url));

// Inline the apple-touch-icon as a data URI so iOS never has to fetch it over
// the network when adding to the home screen. iOS refuses to use an
// apple-touch-icon served over a self-signed / privately-signed HTTPS cert
// (falling back to a screenshot); embedding the bytes in the already-loaded
// HTML sidesteps that fetch entirely. The /apple-touch-icon.png file is still
// emitted as a fallback for clients that fetch it normally.
function inlineAppleTouchIcon(): Plugin {
  return {
    name: "inline-apple-touch-icon",
    transformIndexHtml(html) {
      const iconBytes = readFileSync(path.join(appDir, "public/apple-touch-icon.png"));
      const dataUri = `data:image/png;base64,${iconBytes.toString("base64")}`;
      return html.replace(/(<link rel="apple-touch-icon"[^>]*href=")[^"]*(")/, `$1${dataUri}$2`);
    },
  };
}

export default defineConfig((env) =>
  mergeConfigs(base(env), {
    clearScreen: false,
    plugins: [inlineAppleTouchIcon()],
    server: {
      port: devPort,
      strictPort: true,
      proxy: {
        // When the browser talks to Vite directly, proxy the API to the
        // helper so cookies stay same-origin. (The primary dev flow is the
        // inverse: the helper proxies UI traffic here — see
        // remoteaccess/server.go devServerHandler.)
        "/api": {
          target: process.env.CAMBER_REMOTE_API ?? `http://127.0.0.1:${remotePort}`,
          ws: true,
        },
      },
    },
    build: {
      // No sourcemaps: embed-webui.mjs copies dist/ wholesale into the
      // helper's go:embed dir, so .map files would ship inside every released
      // helper binary — and generating them is what pushed the release build
      // past Node's default heap.
      sourcemap: false,
      rollupOptions: {
        input: {
          main: "index.html",
        },
      },
    },
  }),
);
