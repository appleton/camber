const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
exports.run = async () => {
  const before = require("/tmp/camber-l6-before.cjs");
  const after = require("/tmp/camber-l6-after.cjs");
  const context = {
    extensionMode: vscode.ExtensionMode.Production,
    extensionPath: process.env.CAMBER_L6_EXTENSION,
    extensionUri: vscode.Uri.file(process.env.CAMBER_L6_EXTENSION),
  };
  const system = { context };
  const webview = { asWebviewUri: (uri) => uri };
  if (process.env.CAMBER_L6_CAPTURE) {
    for (const entry of ["assistant", "acp-chat"]) {
      const htmls = [];
      for (const phase of ["before", "after"]) {
        const html = await { before, after }[phase].getWebviewHtml(system, webview, entry);
        fs.writeFileSync(`/tmp/camber-l6-${phase}-${entry}.html`, html);
        htmls.push(html);
      }
      assert.equal(htmls[0], htmls[1]);
    }
    return;
  }
  const rows = [];
  for (const payloadBytes of [0, 512 * 1024]) {
    for (let trial = 0; trial < 5; trial++) {
      for (const phase of trial % 2 ? ["after", "before"] : ["before", "after"]) {
        const start = performance.now();
        const html = await { before, after }[phase].getWebviewHtml(
          system,
          webview,
          trial % 2 ? "acp-chat" : "assistant",
          payloadBytes
            ? [
                {
                  key: "AUDIT_EXTRA",
                  value: "日本語 🧵 <safe>".repeat(Math.floor(payloadBytes / 26)),
                },
              ]
            : [],
        );
        const durationMs = performance.now() - start;
        const state = JSON.parse(
          Buffer.from(
            html.match(/CAMBER_INITIAL_STATE = decode\("([^"]+)"\)/)[1],
            "base64",
          ).toString("utf8"),
        );
        const row = {
          phase,
          trial,
          payloadBytes,
          durationMs,
          htmlBytes: Buffer.byteLength(html),
          digest: crypto.createHash("sha256").update(html).digest("hex"),
          theme: state.colorTheme?.name,
          icons: Object.keys(state.fileIconTheme?.iconDefinitions ?? {}).length,
          keybindings: Object.keys(state.keybindings ?? {}).length,
        };
        rows.push(row);
        fs.writeFileSync(
          "/tmp/camber-l6-native-measurements.json",
          JSON.stringify({ vscode: vscode.version, rows }, null, 2),
        );
      }
      const [a, b] = rows.slice(-2);
      assert.equal(a.digest, b.digest, JSON.stringify([a, b]));
    }
  }
};
