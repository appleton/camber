import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { sharedWorkers, workerSafePreload } from "../dist/sharedWorkers.js";

test("worker imports retain native resolution/rejection while window preloads are unchanged", async () => {
  const source = `export const __vitePreload = function preload(load, deps) {
    document.calls.push(deps); return load();
  }`;
  const transformed = workerSafePreload(source);
  const evaluate = (globals = {}) =>
    runInNewContext(`${transformed.code.replace("export const", "const")}; __vitePreload`, globals);
  assert.equal(await evaluate()(() => Promise.resolve(42), ["unused.js"]), 42);
  const failure = new Error("grammar unavailable");
  await assert.rejects(
    evaluate()(() => Promise.reject(failure), ["unused.js"]),
    (e) => e === failure,
  );
  const document = { calls: [] };
  assert.equal(await evaluate({ document })(() => Promise.resolve(43), ["grammar.js"]), 43);
  assert.deepEqual(document.calls, [["grammar.js"]]);
  assert.ok(transformed.map.mappings.length > 0);
  assert.throws(
    () => workerSafePreload("export const changedHelper = () => {};"),
    /Unsupported Vite/,
  );
});

for (const [base, pattern] of [
  ["/", "assets/[name]-[hash].js"],
  ["./", "webview/[name].js"],
]) {
  test(`one grammar for two workers and window, with source maps (${base})`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "camber-shared-workers-")));
    try {
      const files = {
        "index.html": '<script type="module" src="/main.js"></script>',
        "main.js": `import A from './a.js?shared-worker'; import B from './b.js?shared-worker';
          window.workers = [new A({ name: 'a' }), new B()];
          window.load = () => import('./grammar.js');`,
        "a.js": `self.onmessage = async () => self.postMessage(await import('./grammar.js'));`,
        "b.js": `self.onmessage = async () => self.postMessage(await import('./grammar.js'));`,
        "grammar.js": `import { text } from './dependency.js'; export const tokens = { text };`,
        "dependency.js": `export const text = 'shared grammar';`,
      };
      for (const [name, content] of Object.entries(files))
        await writeFile(join(root, name), content);
      const result = await build({
        configFile: false,
        root,
        base,
        logLevel: "silent",
        plugins: [sharedWorkers()],
        build: {
          write: false,
          sourcemap: "hidden",
          rollupOptions: {
            output: {
              entryFileNames: pattern,
              chunkFileNames: pattern,
            },
          },
        },
      });
      assert.ok("output" in result);
      const chunks = result.output.filter((item) => item.type === "chunk");
      const grammar = chunks.filter((chunk) =>
        Object.keys(chunk.modules).includes(join(root, "grammar.js")),
      );
      assert.equal(grammar.length, 1);
      const workers = chunks.filter(
        (chunk) =>
          chunk.facadeModuleId === join(root, "a.js") ||
          chunk.facadeModuleId === join(root, "b.js"),
      );
      assert.equal(workers.length, 2);
      for (const worker of workers) {
        assert.ok(worker.dynamicImports.includes(grammar[0].fileName));
        assert.ok(worker.map?.sources.some((source) => /[ab]\.js$/.test(source)));
        assert.ok(worker.map?.mappings);
      }
      const main = chunks.find((chunk) => chunk.facadeModuleId === join(root, "index.html"));
      assert.ok(main);
      for (const worker of workers) assert.ok(!main.imports.includes(worker.fileName));
      assert.ok(chunks.some((chunk) => /typeof document/.test(chunk.code)));

      await writeFile(
        join(root, "dependency.js"),
        `import './bad.css'; export const text = 'bad';`,
      );
      await writeFile(join(root, "bad.css"), "body {color:red}");
      await assert.rejects(
        build({
          configFile: false,
          root,
          logLevel: "silent",
          plugins: [sharedWorkers()],
          build: { write: false },
        }),
        /Shared worker imports CSS/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("importing a production constructor does not require Worker support", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "camber-worker-fallback-")));
  try {
    await writeFile(join(root, "main.js"), "export { default } from './task.js?shared-worker';");
    await writeFile(join(root, "task.js"), "self.onmessage = () => self.postMessage('ok');");
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [sharedWorkers()],
      build: {
        write: false,
        rollupOptions: { input: join(root, "main.js"), preserveEntrySignatures: "strict" },
      },
    });
    assert.ok("output" in result);
    const entry = result.output.find(
      (item) => item.type === "chunk" && item.facadeModuleId === join(root, "main.js"),
    );
    assert.ok(entry && entry.type === "chunk");
    assert.equal(Reflect.get(globalThis, "Worker"), undefined);
    const emittedEntry = join(root, "emitted-entry.mjs");
    await writeFile(emittedEntry, entry.code);
    const module = await import(pathToFileURL(emittedEntry).href);
    assert.equal(typeof module.default, "function");
    assert.throws(() => new module.default(), /Worker is not defined/);
    const calls: { url: string; options: Record<string, string> }[] = [];
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class {
        constructor(url: string, options: Record<string, string>) {
          calls.push({ url, options });
        }
      },
    });
    try {
      new module.default({ name: "highlight", credentials: "omit" });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /worker-task-.*\.js$/);
      assert.deepEqual(calls[0].options, {
        name: "highlight",
        credentials: "omit",
        type: "module",
      });
    } finally {
      Reflect.deleteProperty(globalThis, "Worker");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
