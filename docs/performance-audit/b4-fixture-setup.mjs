// Run from the repository root after preserving the before build in
// output/performance/b4-before-dist and building the after revision.
// Uses an existing mobile development server; does not start a service.
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();
const app = join(root, "ui/apps/vscode-assistant");
for (const phase of ["before", "after"]) {
  const source =
    phase === "before" ? resolve("output/performance/b4-before-dist") : join(app, "dist");
  const extension = `/tmp/camber-b4-${phase}-extension`;
  mkdirSync(extension, { recursive: true });
  cpSync(source, join(extension, "dist"), { recursive: true });
  copyFileSync(join(app, "package.json"), join(extension, "package.json"));
  const profile = `/tmp/camber-b4-${phase}-profile/User`;
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, "settings.json"),
    JSON.stringify({
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "workbench.startupEditor": "none",
      "security.workspace.trust.enabled": false,
    }),
  );
  const fixture = resolve(`ui/apps/mobile-remote/public/__audit_b4_${phase}`);
  cpSync(source, fixture, { recursive: true });
  copyFileSync(resolve("docs/performance-audit/b4-host-fixture.js"), join(fixture, "fixture.js"));
  const manifest = JSON.parse(readFileSync(join(source, ".vite/manifest.json"), "utf8"));
  for (const entry of ["assistant", "acp-chat"]) {
    const seen = new Set();
    const chunks = [];
    function visit(key) {
      if (seen.has(key)) return;
      seen.add(key);
      const chunk = manifest[key];
      for (const dependency of chunk.imports ?? []) visit(dependency);
      chunks.push(chunk);
    }
    visit(`src/webview/${entry}.main.ts`);
    const styles = [...new Set(chunks.flatMap((chunk) => chunk.css ?? []))];
    const head =
      styles.map((css) => `<link rel="stylesheet" href="${css}">`).join("") +
      chunks
        .slice(0, -1)
        .map((chunk) => `<link rel="modulepreload" href="${chunk.file}">`)
        .join("");
    writeFileSync(
      join(fixture, `${entry}.html`),
      `<!doctype html><html><head><meta charset="utf-8"><base href="/__audit_b4_${phase}/">${head}<style>body{--editor-font-size:14px;--editor-line-height:21px;min-height:100vh;}</style></head><body><div id="app"></div><script src="fixture.js"></script><script type="module" src="${chunks.at(-1).file}"></script></body></html>`,
    );
  }
}
console.log(
  "Prepared isolated activation profiles and compiled webview fixtures. Remove public/__audit_b4_{before,after} after QA.",
);
