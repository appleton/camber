import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Script, SourceTextModule } from "node:vm";
import { gzipSync } from "node:zlib";
const roots = {
  before: resolve("output/performance/b4-before-dist"),
  after: resolve("ui/apps/vscode-assistant/dist"),
};
if (process.argv[2]) {
  const root = roots[process.argv[2]];
  const ext = readFileSync(join(root, "extension/main.cjs"), "utf8");
  const ui = readFileSync(join(root, "webview/assistant.js"), "utf8");
  const begin = performance.now();
  new Script(ext);
  const hostParseMs = performance.now() - begin;
  const start = performance.now();
  new SourceTextModule(ui);
  const sharedWebviewParseMs = performance.now() - start;
  console.log(JSON.stringify({ hostParseMs, sharedWebviewParseMs }));
} else {
  const result = {};
  const trace = await import(
    resolve(
      "node_modules/.pnpm/@jridgewell+trace-mapping@0.3.30/node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs",
    )
  );
  for (const [phase, root] of Object.entries(roots)) {
    const files = [];
    function walk(dir) {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, ent.name);
        ent.isDirectory() ? walk(file) : files.push(file);
      }
    }
    walk(root);
    const runtime = files.filter((x) => !x.endsWith(".map"));
    const manifest = JSON.parse(readFileSync(join(root, ".vite/manifest.json")));
    let manifestReferences = 0;
    for (const chunk of Object.values(manifest)) {
      for (const path of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
        if (!statSync(join(root, path)).isFile()) throw Error(path);
        manifestReferences++;
      }
      for (const key of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])])
        if (!manifest[key]) throw Error(key);
    }
    result[phase] = {
      runtimeFiles: runtime.length,
      runtimeBytes: runtime.reduce((n, x) => n + statSync(x).size, 0),
      manifestReferences,
      files: Object.fromEntries(
        ["webview/assistant.js", "extension/main.cjs"].map((x) => {
          const bytes = readFileSync(join(root, x));
          return [x, { bytes: bytes.length, gzipBytes: gzipSync(bytes).length }];
        }),
      ),
      parseTrials: [],
    };
  }
  for (let i = 0; i < 5; i++)
    for (const phase of i % 2 ? ["after", "before"] : ["before", "after"]) {
      const child = spawnSync(
        process.execPath,
        ["--experimental-vm-modules", process.argv[1], phase],
        { encoding: "utf8" },
      );
      if (child.status !== 0) throw Error(child.stderr);
      result[phase].parseTrials.push(JSON.parse(child.stdout));
    }
  result.maps = [];
  for (const [file, suffix, needle] of [
    ["extension/main.cjs", "src/extension/main.ts", "export async function activate"],
    ["webview/acp-chat.main.js", "src/webview/acp-chat.main.ts", "init().then"],
  ]) {
    const map = JSON.parse(readFileSync(join(roots.after, file + ".map")));
    const sourceIndex = map.sources.findIndex((x) => x.endsWith(suffix));
    if (sourceIndex < 0) throw Error(suffix);
    const source = map.sources[sourceIndex];
    const line =
      map.sourcesContent[sourceIndex].split("\n").findIndex((x) => x.includes(needle)) + 1;
    const traced = new trace.TraceMap(map);
    const generated = trace.generatedPositionFor(traced, {
      source,
      line,
      column: 0,
      bias: trace.LEAST_UPPER_BOUND,
    });
    if (!generated.line) throw Error("missing mapping " + source);
    const original = trace.originalPositionFor(traced, generated);
    if (!original.source.endsWith(suffix) || original.line !== line)
      throw Error(JSON.stringify(original));
    result.maps.push({ file, source, line, generated, original });
  }
  writeFileSync("/tmp/camber-b4-measurements.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
