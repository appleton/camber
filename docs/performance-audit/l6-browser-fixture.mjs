/** Serve captured native HTML and built webviews through the existing mobile dev server. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const destination = "ui/apps/mobile-remote/public/__audit_l6";
if (process.argv.includes("--clean")) {
  rmSync(destination, { recursive: true, force: true });
} else {
  if (existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
  mkdirSync(destination, { recursive: true });
  for (const name of ["webview", "resources"])
    cpSync(`ui/apps/vscode-assistant/dist/${name}`, `${destination}/${name}`, {
      recursive: true,
      filter: (path) => !path.endsWith(".map"),
    });
  const host = readFileSync("docs/performance-audit/b4-host-fixture.js", "utf8");
  writeFileSync(`${destination}/fixture.js`, host.slice(host.indexOf("window.__b4 =")));
  for (const phase of ["before", "after"])
    for (const entry of ["assistant", "acp-chat"]) {
      const html = readFileSync(`/tmp/camber-l6-${phase}-${entry}.html`, "utf8")
        .replace(/<base href="[^"]+">/, '<base href="/__audit_l6/">')
        .replace(
          '<script type="module"',
          '<script src="fixture.js"></script>\n<script type="module"',
        );
      writeFileSync(`${destination}/${phase}-${entry}.html`, html);
    }
}
