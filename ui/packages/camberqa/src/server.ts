/**
 * CamberQA server — persistent VS Code + Playwright daemon.
 *
 * Started by the user via `pnpm start`. Launches its own Vite dev server,
 * then launches VS Code with the Camber extension. Exposes commands over HTTP.
 *
 * MUST run under Node.js (not Bun) — Playwright's Electron IPC requires it.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { CAMBER_COMMANDS, handleCamberCommand } from "./commands/camber.js";
import { handleDiagnosticsCommand } from "./commands/diagnostics.js";
import { handleGenericCommand } from "./commands/generic.js";
import { handlePanelCommand } from "./commands/panels.js";
import { handleReadCommand } from "./commands/read.js";
import { DesktopTarget } from "./targets/desktop.js";
import type { CamberQATarget, WindowBounds } from "./targets/types.js";
import { VscodeTarget } from "./targets/vscode.js";
import { CAMBER_DEV_PORT, stripQuotes } from "./utils.js";

const AUTH_TOKEN = crypto.randomUUID();
const CAMBERQA_PORT = parseInt(process.env.CAMBERQA_PORT || "0", 10);
const INSTANCE_SUFFIX = CAMBERQA_PORT ? `-${CAMBERQA_PORT}` : "";
const STATE_FILE = process.env.CAMBERQA_STATE_FILE || `/tmp/camberqa-server${INSTANCE_SUFFIX}.json`;
const IDLE_TIMEOUT_MS = parseInt(process.env.CAMBERQA_IDLE_TIMEOUT || "0", 10);

function validateAuth(req: http.IncomingMessage): boolean {
  const header = req.headers["authorization"];
  return header === `Bearer ${AUTH_TOKEN}`;
}

function writeBridgeCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

let lastActivity = Date.now();
function resetIdleTimer() {
  lastActivity = Date.now();
}

const idleCheckInterval =
  IDLE_TIMEOUT_MS > 0
    ? setInterval(() => {
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
          console.log(`[camberqa] Idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down`);
          shutdown();
        }
      }, 60_000)
    : null;

const GENERIC_COMMANDS = new Set([
  "click",
  "fill",
  "type",
  "press",
  "scroll",
  "wait",
  "snapshot",
  "screenshot",
  "hover",
  "screenshotElement",
]);

const READ_COMMANDS = new Set(["text", "html", "js", "component", "webErrors"]);
const PANEL_COMMANDS = new Set(["listPanels", "selectPanel", "getCurrentPanel"]);
const INTERNAL_COMMANDS = new Set(["windowInfo", "setWindowBounds"]);
const DIAGNOSTIC_COMMANDS = new Set(["debug", "profile"]);
const DESKTOP_BRIDGE_COMMANDS = new Set([
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "scroll",
  "wait",
  "hover",
  "text",
  "html",
  "js",
  "webErrors",
  "screenshot",
  "screenshotElement",
  "component",
  "sendMessage",
  "openCommandMenu",
  "assertMessage",
  "waitForMessageCount",
  "getLastResponse",
  "newConversation",
  "archiveConversation",
  "isStreaming",
  "stopGeneration",
  "getMessageCount",
  "helperLogs",
  "restartHelper",
  "restartACPServer",
  "getACPDump",
  "loadACPDump",
  "getConfigs",
  "setConfig",
  "openHistory",
  "closeHistory",
  "deleteConversation",
  "restoreConversation",
  "listConversations",
  "selectConversation",
  "getCurrentConversation",
  "listProjects",
  "listWorktrees",
  "openProject",
  "closeProject",
  "removeProject",
  "createWorktree",
  "removeWorktree",
  "openWorktree",
  "camberqaDebugGo",
  "camberqaProfileRustCpu",
]);

let target: CamberQATarget = new VscodeTarget();
let isShuttingDown = false;

function isDesktopBridgeTarget(candidate: CamberQATarget): candidate is CamberQATarget & {
  runBridgeCommand(command: string, args: string[]): Promise<string>;
  nextBridgeCommand(): Promise<{ id: string; command: string; args: string[] } | null>;
  completeBridgeCommand(id: string, result: { ok: boolean; body?: string; error?: string }): void;
} {
  return (
    candidate.kind === "desktop" &&
    "runBridgeCommand" in candidate &&
    "nextBridgeCommand" in candidate &&
    "completeBridgeCommand" in candidate
  );
}

function isDesktopRuntimeInfoTarget(candidate: CamberQATarget): candidate is CamberQATarget & {
  getDesktopRuntimeInfo(): Promise<unknown>;
} {
  return candidate.kind === "desktop" && "getDesktopRuntimeInfo" in candidate;
}

function wrapError(err: any): string {
  const msg = err.message || String(err);
  if (msg.startsWith("Usage:")) {
    return msg;
  }
  if (err.name === "TimeoutError" || msg.includes("Timeout") || msg.includes("timeout")) {
    if (
      msg.includes("locator.click") ||
      msg.includes("locator.fill") ||
      msg.includes("locator.hover")
    ) {
      return `Element not found or not interactable within timeout. Run 'snapshot' for fresh refs.`;
    }
    return `Operation timed out: ${msg.split("\n")[0]}`;
  }
  if (msg.includes("resolved to") && msg.includes("elements")) {
    return `Selector matched multiple elements. Use @refs from 'snapshot'.`;
  }
  return msg;
}

function readACPDumpInput(args: string[]): string {
  const input = stripQuotes(args);
  const trimmed = input.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return input;
  }
  return fs.readFileSync(input, "utf-8");
}

async function handleCommand(
  body: any,
): Promise<{ status: number; contentType: string; body: string }> {
  const { command, args = [] } = body;

  if (!command) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: 'Missing "command" field' }),
    };
  }

  try {
    if (command === "camberqaRuntimeInfo" && isDesktopRuntimeInfoTarget(target)) {
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(await target.getDesktopRuntimeInfo()),
      };
    }

    if (isDesktopBridgeTarget(target)) {
      if (DESKTOP_BRIDGE_COMMANDS.has(command)) {
        const bridgeArgs =
          command === "loadACPDump" && args.length > 0 ? [readACPDumpInput(args)] : args;
        const result = await target.runBridgeCommand(command, bridgeArgs);
        if (command === "getACPDump" && args.length > 0) {
          const output = stripQuotes(args);
          fs.writeFileSync(output, result, "utf-8");
          return {
            status: 200,
            contentType: "text/plain",
            body: `ACP dump written to ${output}`,
          };
        }
        return { status: 200, contentType: "text/plain", body: result };
      }
    }

    // Guard: ensure webview is visible before dispatching commands that need it.
    if (
      command !== "status" &&
      command !== "focusCamber" &&
      command !== "quit" &&
      command !== "screenshot" &&
      command !== "webErrors" &&
      !INTERNAL_COMMANDS.has(command) &&
      !DIAGNOSTIC_COMMANDS.has(command)
    ) {
      if (!(await target.ensureReady())) {
        await target.focusWebview();
        if (!(await target.ensureReady())) {
          return {
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({
              error:
                "VS Code not ready. The webview may still be loading — try again in a few seconds.",
            }),
          };
        }
      }
    }

    let result: string;

    if (command === "status") {
      const alive = await target.checkAlive();
      let devStatus: string;
      try {
        const resp = await fetch(`http://localhost:${CAMBER_DEV_PORT}/`, {
          signal: AbortSignal.timeout(1000),
        });
        devStatus = resp.ok || resp.status === 404 ? "running" : "not running";
      } catch {
        devStatus = "not running";
      }
      const webviewReady = alive && (await target.ensureReady());
      const webviewStatus = alive ? (webviewReady ? "open" : "not open") : "not available";
      const lines = [
        `${target.kind === "desktop" ? "Desktop" : "VS Code"}: ${alive ? "running" : "not running"}`,
        `Webview: ${webviewStatus}`,
        `Dev server: ${devStatus} (port ${CAMBER_DEV_PORT})`,
      ];

      // Add actionable guidance when something is wrong
      const fixes: string[] = [];
      if (devStatus === "not running") {
        fixes.push(
          "Dev server is not running. Start it in a separate terminal:\n  pnpm turbo dev -F camber-assistant",
        );
      }
      if (!alive) {
        fixes.push(
          `${target.kind === "desktop" ? "Desktop" : "VS Code"} is not running. Restart camberqa in a separate terminal:\n  camberqa ${target.kind} up`,
        );
      } else if (!webviewReady) {
        fixes.push("Webview is not open. Try running: focusCamber");
      }
      if (fixes.length > 0) {
        lines.push("", "To fix:");
        fixes.forEach((fix, i) => lines.push(`${i + 1}. ${fix}`));
      }

      result = lines.join("\n");
    } else if (command === "focusCamber") {
      await target.focusWebview();
      result = "Camber sidebar opened.";
    } else if (command === "quit") {
      result = "Shutting down...";
      setTimeout(() => shutdown(), 100);
    } else if (command === "windowInfo") {
      result = JSON.stringify(await target.getWindowInfo(), null, 2);
    } else if (command === "setWindowBounds") {
      const usage = "Usage: setWindowBounds <x> <y> <width> <height>";
      if (args.length !== 4) {
        throw new Error(usage);
      }
      const [x, y, width, height] = args.map((arg: string) => Number.parseInt(arg, 10));
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        throw new Error(usage);
      }
      const bounds: WindowBounds = { x, y, width, height };
      await target.setWindowBounds(bounds);
      result = `Window bounds updated to ${x},${y},${width},${height}`;
    } else if (DIAGNOSTIC_COMMANDS.has(command)) {
      result = await handleDiagnosticsCommand(command, args, target);
    } else if (PANEL_COMMANDS.has(command)) {
      result = await handlePanelCommand(command, args, target);
    } else if (GENERIC_COMMANDS.has(command)) {
      result = await handleGenericCommand(command, args, target);
    } else if (READ_COMMANDS.has(command)) {
      result = await handleReadCommand(command, args, target);
    } else if (CAMBER_COMMANDS.has(command)) {
      result = await handleCamberCommand(command, args, target);
    } else {
      const all = [
        "status",
        "focusCamber",
        "quit",
        ...INTERNAL_COMMANDS,
        ...DIAGNOSTIC_COMMANDS,
        ...GENERIC_COMMANDS,
        ...READ_COMMANDS,
        ...PANEL_COMMANDS,
        ...CAMBER_COMMANDS,
      ];
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: `Unknown command: ${command}`,
          hint: `Available: ${[...all].sort().join(", ")}`,
        }),
      };
    }

    return { status: 200, contentType: "text/plain", body: result };
  } catch (err: any) {
    return {
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: wrapError(err) }),
    };
  }
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("[camberqa] Shutting down...");
  if (idleCheckInterval) clearInterval(idleCheckInterval);

  await target.close();

  try {
    fs.unlinkSync(STATE_FILE);
  } catch {}

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function findPort(): Promise<number> {
  const tryPort = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const srv = http.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolve(true));
      });
    });

  if (CAMBERQA_PORT) {
    if (await tryPort(CAMBERQA_PORT)) return CAMBERQA_PORT;
    throw new Error(`[camberqa] Port ${CAMBERQA_PORT} is in use`);
  }

  const start = parseInt(process.env.CAMBERQA_PORT_START || "9500", 10);
  for (let port = start; port < start + 10; port++) {
    if (await tryPort(port)) return port;
  }
  throw new Error(`[camberqa] No available port in range ${start}-${start + 9}`);
}

async function launchTarget() {
  const args = process.argv.slice(2);
  let targetKind: "vscode" | "desktop" = "vscode";
  const opts: {
    project?: string;
    dev?: boolean;
    useProfile?: boolean;
    colorTheme?: string;
    worktreeSlot?: number;
    worktreeId?: string;
    agentMode?: "acp" | "classic";
    extensionDir?: string;
    desktopDevPort?: number;
    desktopColor?: string;
  } = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--project":
        opts.project = args[++i];
        break;
      case "--target": {
        const nextTarget = args[++i];
        if (nextTarget !== "vscode" && nextTarget !== "desktop") {
          throw new Error(`Invalid --target value: ${nextTarget}`);
        }
        targetKind = nextTarget;
        break;
      }
      case "--dev":
        opts.dev = true;
        break;
      case "--use-profile":
        opts.useProfile = true;
        break;
      case "--light":
        opts.colorTheme = "Quiet Light";
        break;
      case "--dark":
        opts.colorTheme = "Visual Studio Dark";
        break;
      case "--auth-clear":
        // Legacy flag. Worktree setup clears the temp profile before first launch.
        break;
      case "--extension-dir":
        opts.extensionDir = args[++i];
        break;
      case "--agent-mode": {
        const agentMode = args[++i];
        if (agentMode !== "acp" && agentMode !== "classic") {
          throw new Error(`Invalid --agent-mode value: ${agentMode}`);
        }
        opts.agentMode = agentMode;
        break;
      }
      case "--desktop-dev-port":
        opts.desktopDevPort = Number.parseInt(args[++i], 10);
        break;
      case "--desktop-color":
        opts.desktopColor = args[++i];
        break;
    }
  }

  if (process.env.CAMBER_WORKTREE_SLOT) {
    opts.worktreeSlot = parseInt(process.env.CAMBER_WORKTREE_SLOT, 10);
    opts.worktreeId = process.env.CAMBER_WORKTREE_ID;
  }

  target = targetKind === "desktop" ? new DesktopTarget() : new VscodeTarget();

  if (target.kind === "desktop") {
    await target.launch({
      devPort: opts.desktopDevPort,
      worktreeSlot: opts.worktreeSlot,
      worktreeId: opts.worktreeId,
      color: opts.desktopColor,
      bridgeUrl: `http://127.0.0.1:${CAMBERQA_PORT || process.env.CAMBERQA_PORT || "9500"}/desktop-bridge`,
      bridgeToken: AUTH_TOKEN,
    });
  } else {
    await target.launch(opts);
  }
}

async function start() {
  const port = await findPort();
  const startTime = Date.now();

  const server = http.createServer(async (req, res) => {
    resetIdleTimer();
    const url = new URL(req.url!, `http://127.0.0.1:${port}`);

    if (url.pathname.startsWith("/desktop-bridge/")) {
      writeBridgeCors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (url.pathname === "/health") {
      const alive = await target.checkAlive();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          uptime: Math.floor((Date.now() - startTime) / 1000),
          target: target.kind,
          vscodeRunning: alive,
          targetRunning: alive,
        }),
      );
      return;
    }

    if (url.pathname === "/desktop-bridge/next" && req.method === "GET") {
      if (!validateAuth(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      if (!isDesktopBridgeTarget(target)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const item = await target.nextBridgeCommand();
      if (!item) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(item));
      return;
    }

    if (url.pathname === "/desktop-bridge/result" && req.method === "POST") {
      if (!validateAuth(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      if (!isDesktopBridgeTarget(target)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody) as {
        id: string;
        ok: boolean;
        body?: string;
        error?: string;
      };
      target.completeBridgeCommand(body.id, body);
      res.writeHead(204);
      res.end();
      return;
    }

    if (!validateAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (url.pathname === "/command" && req.method === "POST") {
      try {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody);
        const result = await handleCommand(body);
        res.writeHead(result.status, { "Content-Type": result.contentType });
        res.end(result.body);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const state = {
        pid: process.pid,
        port,
        token: AUTH_TOKEN,
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });

      console.log(`[camberqa] Server running on http://127.0.0.1:${port} (PID: ${process.pid})`);
      console.log(`[camberqa] State file: ${STATE_FILE}`);
      if (IDLE_TIMEOUT_MS > 0) {
        console.log(`[camberqa] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
      } else {
        console.log(`[camberqa] Idle timeout: disabled`);
      }
      resolve();
    });
  });
}

start()
  .then(async () => {
    console.log("[camberqa] Launching target...");
    await launchTarget();
    console.log("[camberqa] Target launched and webview ready.");
  })
  .catch((err) => {
    console.error(`[camberqa] Failed to start: ${err.message}`);
    process.exit(1);
  });
