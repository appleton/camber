#!/usr/bin/env node
// Builds the mobile-remote bundle and copies it into the helper's embed
// directory (pkg/camber-helper/internal/handler/remoteaccess/webui/dist) so
// `//go:embed` bakes the UI into the helper binary. Run this before building
// the helper whenever the mobile UI changes. Helper release builds run this
// via the embed_mobile_webui input of reusable-bazel-build.yml; the webui
// BUILD.bazel globs dist/, so no Bazel file needs regenerating afterwards.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, constants as zlibConstants } from "node:zlib";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(appDir, "../../..");
const distDir = path.join(appDir, "dist");
const embedDir = path.join(repoRoot, "pkg/camber-helper/internal/handler/remoteaccess/webui/dist");

console.log("building @camber/mobile-remote (turbo build)…");
execFileSync("pnpm", ["exec", "turbo", "build", "--filter", "@camber/mobile-remote..."], {
  cwd: path.join(repoRoot, "ui"),
  stdio: "inherit",
});

console.log(`copying ${distDir} -> ${embedDir}`);
// Clear previous bundle but keep the committed placeholders.
for (const entry of readdirSync(embedDir)) {
  if (entry === ".gitkeep" || entry === ".gitignore") continue;
  rmSync(path.join(embedDir, entry), { recursive: true, force: true });
}
mkdirSync(embedDir, { recursive: true });
cpSync(distDir, embedDir, { recursive: true });

// Embed compressible assets gzip-only: uncompressed they were ~36MB of the
// helper binary. The helper serves `<name>.gz` transparently for `<name>`
// (remoteaccess spaFileHandler). Already-compressed formats stay raw.
const COMPRESSIBLE = new Set([
  ".js",
  ".css",
  ".html",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
]);
let rawBytes = 0;
let gzBytes = 0;
compressTree(embedDir);
console.log(
  `gzipped compressible assets: ${(rawBytes / 1e6).toFixed(1)}MB -> ${(gzBytes / 1e6).toFixed(1)}MB`,
);

function compressTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      compressTree(p);
      continue;
    }
    if (!COMPRESSIBLE.has(path.extname(entry.name))) continue;
    const data = readFileSync(p);
    const compressed = gzipSync(data, { level: zlibConstants.Z_BEST_COMPRESSION });
    rawBytes += data.length;
    gzBytes += compressed.length;
    writeFileSync(`${p}.gz`, compressed);
    rmSync(p);
  }
}

console.log("embedded. Rebuild the helper to bake it in:");
console.log("  go build ./cmd/camber-helper");
console.log("  # or, for the desktop app:");
console.log(
  "  CAMBER_DESKTOP_LOCAL_HELPER=1 pnpm --dir ui/apps/desktop-assistant download:binaries",
);
