import MagicString from "magic-string";
import { basename } from "node:path";
import { parseAst, type Plugin } from "vite";

const QUERY = "?shared-worker";
const PREFIX = "\0camber:shared-worker:";
const PRELOAD_HELPER = "\0vite/preload-helper.js";

/**
 * Emit DOM-free module workers in the app's Rollup graph. Shared grammar and
 * engine modules then have one output URL, without rewriting generated assets.
 * Development keeps Vite's worker pipeline and HMR behavior.
 */
export function sharedWorkers(): Plugin {
  let building = false;
  const workers = new Set<string>();
  return {
    name: "camber-shared-workers",
    enforce: "pre",
    configResolved(config) {
      building = config.command === "build";
    },
    buildStart() {
      workers.clear();
    },
    async resolveId(id, importer) {
      if (!id.endsWith(QUERY)) return;
      const entry = id.slice(0, -QUERY.length);
      if (!building) return this.resolve(`${entry}?worker`, importer, { skipSelf: true });
      const resolved = await this.resolve(entry, importer, { skipSelf: true });
      if (!resolved || resolved.external) this.error(`Cannot resolve shared worker: ${entry}`);
      return PREFIX + resolved.id;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return;
      const entry = id.slice(PREFIX.length);
      const reference = this.emitFile({
        type: "chunk",
        id: entry,
        name: `worker-${basename(entry).replace(/\.[^.]+$/, "")}`,
      });
      workers.add(reference);
      // Match Vite's lazy constructor: merely importing the UI must still work
      // in hosts without Worker, where callers use their existing fallback.
      return `export default function WorkerConstructor(options) {
        return new Worker(import.meta.ROLLUP_FILE_URL_${reference}, { ...options, type: "module" });
      }`;
    },
    transform(code, id) {
      if (!building || id !== PRELOAD_HELPER) return;
      return workerSafePreload(code, id);
    },
    generateBundle(_, bundle) {
      // Sharing a module with the window must never introduce CSS loading into
      // a worker. Fail the build if a future import crosses that boundary.
      const visited = new Set<string>();
      const visit = (name: string) => {
        if (visited.has(name)) return;
        visited.add(name);
        const chunk = bundle[name];
        if (!chunk || chunk.type !== "chunk") return;
        if (chunk.viteMetadata?.importedCss.size) {
          this.error(`Shared worker imports CSS through ${name}; keep worker entries DOM-free`);
        }
        for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) visit(dependency);
      };
      for (const reference of workers) visit(this.getFileName(reference));
    },
  };
}

/**
 * Vite's window preload helper accompanies shared dynamic imports. In a worker,
 * native import() owns loading and rejection; DOM preloads/error events cannot
 * run. Keep Vite's original window path and compose accurate source maps.
 * This deliberately fails on an incompatible Vite helper instead of shipping a
 * worker that silently loses syntax highlighting after a dependency update.
 */
export function workerSafePreload(code: string, id = PRELOAD_HELPER) {
  const ast = parseAst(code);
  for (const statement of ast.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier" || item.id.name !== "__vitePreload") continue;
      const fn = item.init;
      if (fn?.type !== "FunctionExpression" || fn.params[0]?.type !== "Identifier") break;
      const result = new MagicString(code);
      result.appendLeft(
        (fn.body as typeof fn.body & { start: number }).start + 1,
        `if (typeof document === "undefined") return ${fn.params[0].name}();`,
      );
      return { code: result.toString(), map: result.generateMap({ hires: true, source: id }) };
    }
  }
  throw new Error("Unsupported Vite preload helper; review the shared worker build integration");
}
