// Historical experiment: use a clean checkout of the audited baseline below.
// Build the desktop app's dependencies in that checkout:
// pnpm exec turbo build --filter='@camber/desktop-assistant^...'
// node /path/to/this/script.mjs baseline|logos|splash|combined --root /path/to/baseline
// See performance-audit-2026-09-07.md for complete worktree/setup commands.
// Experiments change Vite's in-memory inputs, never product source files.
// Output is temporary and does not run desktop's post-build deduplication or isolation build.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const baselineCommit = "1a648b18350ada8b6f8a8b7f362dbed70e7c5a07";
const { values, positionals } = parseArgs({
  options: { root: { type: "string" } },
  allowPositionals: true,
});
const root = path.resolve(
  values.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const app = path.join(root, "ui/apps/desktop-assistant");
const variant = positionals[0] ?? "baseline";
if (positionals.length > 1 || !["baseline", "logos", "splash", "combined"].includes(variant)) {
  throw new Error("Expected baseline, logos, splash, or combined");
}
const inputPaths = [
  "ui",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches",
  "turbo.json",
];
const baselineDiff = spawnSync("git", ["diff", "--quiet", baselineCommit, "--", ...inputPaths], {
  cwd: root,
  encoding: "utf8",
});
if (baselineDiff.status !== 0) {
  throw new Error(
    `These historical bundle experiments require UI and build inputs from ${baselineCommit}. ` +
      "Create a separate baseline worktree, install its frozen dependencies, rebuild its shared packages, " +
      "and pass --root /path/to/baseline. See docs/performance-audit-2026-09-07.md. " +
      (baselineDiff.stderr || ""),
  );
}
const localChanges = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", ...inputPaths],
  {
    cwd: root,
    encoding: "utf8",
  },
);
if (localChanges) throw new Error(`The baseline experiment inputs must be clean:\n${localChanges}`);
const checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const output = fs.mkdtempSync(path.join(os.tmpdir(), `camber-audit-${variant}-`));
const dist = path.join(output, "dist");
const require = createRequire(path.join(app, "package.json"));
const { build } = await import(require.resolve("vite"));
const logoNamesPath = path.join(
  root,
  "ui/packages/features/src/acp/components/mcp/connectorLogoNames.ts",
);
const logoSource = fs.readFileSync(
  fs.existsSync(logoNamesPath)
    ? logoNamesPath
    : path.join(root, "ui/packages/features/src/acp/components/mcp/ConnectorServiceIcon.svelte"),
  "utf8",
);
const logoMap = logoSource.match(
  /const (?:iconNames|connectorLogoNames): Record<string, string> = \{([\s\S]*?)\n\s*\};/,
);
if (!logoMap) throw new Error("Connector icon mapping changed; review this experiment");
const logoNames = [...logoMap[1].matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1]);
let narrowedSplash = false;
let narrowedLogos = false;
let chunks = [];

process.chdir(app);
await build({
  configFile: path.join(app, "vite.config.ts"),
  build: { outDir: dist },
  plugins: [
    {
      name: "audit-input-experiments",
      enforce: "pre",
      load(id) {
        if (!["logos", "combined"].includes(variant)) return;
        if (!id.endsWith("/@iconify-json/logos/icons.json")) return;
        const all = JSON.parse(fs.readFileSync(id, "utf8"));
        const icons = Object.fromEntries(
          logoNames.map((name) => {
            if (!all.icons[name]) throw new Error(`Missing standalone logo: ${name}`);
            return [name, all.icons[name]];
          }),
        );
        narrowedLogos = true;
        return JSON.stringify({ ...all, icons, aliases: {} });
      },
      transform(code, id) {
        if (!["splash", "combined"].includes(variant)) return;
        if (id !== path.join(app, "src/DesktopStartupFrame.svelte")) return;
        const original =
          'import { CAMBER_ROUNDEL_ICON_URL, StreamingIndicator } from "@camber/features/acp";';
        if (!code.includes(original))
          throw new Error("Splash import changed; review this experiment");
        narrowedSplash = true;
        // Diagnostic only: a production fix should expose supported narrow package exports.
        return code.replace(
          original,
          [
            `import { CAMBER_ROUNDEL_ICON_URL } from ${JSON.stringify(path.join(root, "ui/packages/features/dist/acp/localAgentIcon.js"))};`,
            `import StreamingIndicator from ${JSON.stringify(path.join(root, "ui/packages/features/dist/acp/components/ui/StreamingIndicator.svelte"))};`,
          ].join("\n"),
        );
      },
    },
    {
      name: "audit-import-graph",
      generateBundle(_options, bundle) {
        chunks = Object.values(bundle)
          .filter((item) => item.type === "chunk")
          .map((chunk) => ({
            file: chunk.fileName,
            isEntry: chunk.isEntry,
            imports: chunk.imports,
            dynamicImports: chunk.dynamicImports,
            hasStartup: Object.keys(chunk.modules).some((id) => id.endsWith("/src/startup.ts")),
            hasAppStart: Object.hasOwn(chunk.modules, path.join(app, "src/main.ts")),
            topModules: Object.entries(chunk.modules)
              .map(([id, module]) => ({
                id: id.replace(`${root}/`, ""),
                renderedLengthBeforeMinification: module.renderedLength,
              }))
              .sort(
                (a, b) => b.renderedLengthBeforeMinification - a.renderedLengthBeforeMinification,
              )
              .slice(0, 20),
          }));
      },
    },
  ],
});

if (["logos", "combined"].includes(variant) && !narrowedLogos)
  throw new Error("Logo override did not run");
if (["splash", "combined"].includes(variant) && !narrowedSplash)
  throw new Error("Splash override did not run");
for (const chunk of chunks) {
  const code = fs.readFileSync(path.join(dist, chunk.file));
  chunk.bytes = code.length;
  chunk.gzipLevel6Bytes = gzipSync(code, { level: 6 }).length;
}
const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
const startup = chunks.find((chunk) => chunk.isEntry && chunk.hasStartup);
if (!startup) throw new Error("No startup entry found");
function closure(entryFiles) {
  const seen = new Set();
  function visit(file) {
    if (seen.has(file) || !byFile.has(file)) return;
    seen.add(file);
    byFile.get(file).imports.forEach(visit);
  }
  entryFiles.forEach(visit);
  const files = [...seen];
  return {
    files,
    bytes: files.reduce((sum, file) => sum + byFile.get(file).bytes, 0),
    gzipLevel6Bytes: files.reduce((sum, file) => sum + byFile.get(file).gzipLevel6Bytes, 0),
  };
}
const appStart = chunks.find((chunk) => chunk.hasAppStart);
if (!appStart) throw new Error("No application start module found");
const report = {
  variant,
  baselineCommit,
  checkoutCommit,
  runtime: process.version,
  note: "Production Vite output; excludes CSS, on-demand chunks, post-build dedupe and native packaging. Gzip level 6 is for comparison, not measured desktop transfer size.",
  logoNames,
  startupStaticClosure: closure([startup.file]),
  includingDirectDynamicStartupImports: closure([startup.file, appStart.file]),
  chunks,
};
fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      output,
      startupStaticClosure: report.startupStaticClosure,
      includingDirectDynamicStartupImports: report.includingDirectDynamicStartupImports,
    },
    null,
    2,
  ),
);
