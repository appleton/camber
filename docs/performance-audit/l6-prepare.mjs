/** Prepare matched Node bundles for the native VS Code runner; --clean removes temporary source. */
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const base = "ui/apps/vscode-assistant/src/extension/";
const source = (path) =>
  execFileSync("git", ["show", `21107ca3a:${base}${path}`], { encoding: "utf8" });
const files = {
  [base + "__audit_l6_before_state.ts"]: source("state.ts"),
  [base + "views/__audit_l6_before_html.ts"]: source("views/getWebviewHtml.ts").replace(
    '"../state"',
    '"../__audit_l6_before_state"',
  ),
  [base + "__audit_l6_before.ts"]:
    'export { getWebviewHtml } from "./views/__audit_l6_before_html";\nexport { getInitialAppState } from "./__audit_l6_before_state";\n',
  [base + "__audit_l6_after.ts"]:
    'export { getWebviewHtml } from "./views/getWebviewHtml";\nexport { getInitialAppState } from "./state";\n',
};
if (process.argv.includes("--clean")) {
  for (const path of Object.keys(files)) if (existsSync(path)) unlinkSync(path);
} else {
  for (const path of Object.keys(files))
    if (existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
  for (const [path, content] of Object.entries(files)) writeFileSync(path, content);
  for (const phase of ["before", "after"])
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/.pnpm/esbuild@0.25.9/node_modules/esbuild/bin/esbuild"),
        `${base}__audit_l6_${phase}.ts`,
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--external:vscode",
        `--outfile=/tmp/camber-l6-${phase}.cjs`,
      ],
      { stdio: "inherit" },
    );
}
