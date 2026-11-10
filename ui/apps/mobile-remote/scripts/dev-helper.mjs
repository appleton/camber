#!/usr/bin/env node
// Dev/E2E driver for the mobile remote surface: builds and spawns
// camber-helper, initializes it against a workspace, enables remote access,
// and prints a pairing code. The mobile UI (vite dev server or the built
// bundle served by the helper itself) can then connect.
//
// Usage:
//   node scripts/dev-helper.mjs [workspacePath]
//
// Env:
//   CAMBER_HELPER_BIN              path to a prebuilt helper (skips go build)
//   CAMBER_REMOTE_BIND             loopback | tailscale | all   (default loopback)
//   CAMBER_DEV_HELPER_REMOTE_PORT  port. Defaults to the worktree slot's
//                                    remote port + 1 so a test helper never
//                                    squats the port the worktree's desktop
//                                    instance uses (CAMBER_REMOTE_PORT is
//                                    exported by `camberqa worktree env` and
//                                    points at the desktop's server, so it is
//                                    deliberately NOT used here).
//   CAMBER_REMOTE_STATIC           path to built mobile UI (default ../dist if built)
//   CAMBER_REMOTE_DEV_SERVER       vite dev server URL to proxy UI traffic to

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(appDir, "../../..");
const workspace = path.resolve(process.argv[2] ?? repoRoot);

let helperBin = process.env.CAMBER_HELPER_BIN;
if (!helperBin) {
  helperBin = path.join(os.tmpdir(), "camber-helper-mobile-dev");
  console.log("building camber-helper (go build)…");
  execFileSync("go", ["build", "-o", helperBin, "./cmd/camber-helper"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

const staticDir =
  process.env.CAMBER_REMOTE_STATIC ??
  (existsSync(path.join(appDir, "dist", "index.html")) ? path.join(appDir, "dist") : "");

const helper = spawn(helperBin, ["--stdin"], { stdio: ["pipe", "pipe", "inherit"] });
helper.on("exit", (code) => {
  console.error(`helper exited with code ${code}`);
  process.exit(code ?? 1);
});
process.on("SIGINT", () => {
  helper.kill();
  process.exit(0);
});

// ---- Content-Length framed JSON-RPC over the helper's stdio ----

let nextId = 1;
const pending = new Map();
let buffer = Buffer.alloc(0);

helper.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString();
    const match = /Content-Length: (\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString();
    buffer = buffer.subarray(bodyStart + length);
    handleMessage(JSON.parse(body));
  }
});

function send(msg) {
  const body = JSON.stringify(msg);
  helper.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function handleMessage(msg) {
  if (msg.id != null && !msg.method) {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
    return;
  }
  if (msg.method && msg.id != null) {
    // Helper -> client request (e.g. permission prompt broadcast): decline
    // politely, the phone or desktop should answer these.
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "dev-helper driver does not answer client requests" },
    });
  }
}

// ---- Boot sequence ----

const bind = process.env.CAMBER_REMOTE_BIND ?? "loopback";
const slot = Number(process.env.CAMBER_WORKTREE_SLOT ?? "0") || 0;
const port = Number(process.env.CAMBER_DEV_HELPER_REMOTE_PORT ?? 8737 + slot * 10 + 1);

async function newPairingCode() {
  const pairing = await call("camber/remoteAccess/createPairingCode", {});
  console.log("\n──────────────────────────────────────────");
  console.log(`  Pairing link expires ${pairing.expiresAt}`);
  for (const url of pairing.urls ?? []) {
    console.log(`  Open on your phone: ${url}/#pair=${pairing.code}`);
  }
  console.log("  Confirm pairing from the desktop UI with the code shown on the phone.");
  console.log("──────────────────────────────────────────\n");
}

try {
  await call("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    workspaceFolders: [{ uri: pathToFileURL(workspace).href, name: path.basename(workspace) }],
  });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  const status = await call("camber/remoteAccess/enable", {
    bind,
    port,
    staticDir,
    plainHttp: process.env.CAMBER_REMOTE_PLAIN_HTTP === "1",
  });
  console.log("remote access enabled:", JSON.stringify(status, null, 2));
  if (!staticDir) {
    console.log("(no built UI bundle found — run `pnpm build` here, or use `pnpm dev` + proxy)");
  }
  await newPairingCode();
  console.log("press <enter> for a new pairing code, ctrl-c to quit");

  createInterface({ input: process.stdin }).on("line", () => {
    void newPairingCode().catch((error) => console.error(error.message));
  });
} catch (error) {
  console.error("dev-helper failed:", error);
  helper.kill();
  process.exit(1);
}
