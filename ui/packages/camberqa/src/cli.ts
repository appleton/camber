/**
 * CamberQA CLI — thin wrapper that talks to the persistent server.
 *
 * The server must already be running (started by the user via `pnpm start`).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { manageList, manageLogs, manageRestart, manageStop } from "./manage/client.js";
import { runWrapper } from "./manage/wrapper.js";
import { portsForSlot, targetCamberQAPort } from "./worktree/shared.js";
import {
  detectGitWorktreeInfo,
  findSlotForWorktreeId,
  slotOwnerId,
  type WorktreeEnv,
} from "./worktree/slot.js";

interface ServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  stateFile: string;
}

function getStateFile(): string {
  if (process.env.CAMBERQA_STATE_FILE) return process.env.CAMBERQA_STATE_FILE;
  const port = parseInt(process.env.CAMBERQA_PORT || "0", 10);
  const suffix = port ? `-${port}` : "";
  return `/tmp/camberqa-server${suffix}.json`;
}

function readState(): ServerState | null {
  return readStateFromFile(getStateFile());
}

function readStateFromFile(filePath: string): ServerState | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Omit<ServerState, "stateFile">;
    if (
      typeof data.pid !== "number" ||
      typeof data.port !== "number" ||
      typeof data.token !== "string" ||
      typeof data.startedAt !== "string"
    ) {
      return null;
    }
    return { ...data, stateFile: filePath };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getServerNotRunningMessage(): Promise<string> {
  return "[camberqa] Server is not running. Start the desktop app with 'camberqa desktop up' in another terminal.";
}

async function requireServer(): Promise<ServerState> {
  const state = readState();

  if (state && isProcessAlive(state.pid)) {
    try {
      const resp = await fetch(`http://127.0.0.1:${state.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const health = (await resp.json()) as any;
        if (health.status === "healthy") {
          return state;
        }
      }
    } catch {
      // Health check failed
    }
  }

  console.error(await getServerNotRunningMessage());
  process.exit(1);
}

async function isHealthyState(state: ServerState | null): Promise<boolean> {
  if (!state || !isProcessAlive(state.pid)) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${state.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!resp.ok) return false;
    const health = (await resp.json()) as {
      status?: string;
      targetRunning?: boolean;
    };
    return health.status === "healthy" && (health.targetRunning ?? false);
  } catch {
    return false;
  }
}

async function requestCommand(
  state: ServerState,
  command: string,
  args: string[],
  options?: { serverNotRunningMessage?: string },
): Promise<string> {
  const body = JSON.stringify({ command, args });
  const timeout = 300000;

  try {
    const resp = await fetch(`http://127.0.0.1:${state.port}/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body,
      signal: AbortSignal.timeout(timeout),
    });

    if (resp.status === 401) {
      const newState = state.stateFile ? readStateFromFile(state.stateFile) : readState();
      if (newState && newState.token !== state.token) {
        return requestCommand(newState, command, args, options);
      }
      throw new Error("Authentication failed — try restarting the server");
    }

    const text = await resp.text();
    if (resp.ok) {
      return text;
    }

    if (text.length === 0) {
      throw new Error(`Command failed with status ${resp.status}`);
    }

    let parsedError: { error?: string; hint?: string } | null = null;
    try {
      parsedError = JSON.parse(text) as { error?: string; hint?: string };
    } catch {
      parsedError = null;
    }
    if (parsedError) {
      const message = parsedError.error || text;
      if (parsedError.hint) {
        throw new Error(`${message}\n${parsedError.hint}`);
      }
      throw new Error(message);
    }
    throw new Error(text);
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(`[camberqa] Command timed out after ${timeout / 1000}s`);
    }
    if (
      err.code === "ECONNREFUSED" ||
      err.code === "ECONNRESET" ||
      err.message?.includes("fetch failed")
    ) {
      throw new Error(options?.serverNotRunningMessage || (await getServerNotRunningMessage()));
    }
    throw err;
  }
}

async function sendCommand(state: ServerState, command: string, args: string[]): Promise<void> {
  try {
    const text = await requestCommand(state, command, args);
    process.stdout.write(text);
    if (!text.endsWith("\n")) process.stdout.write("\n");
  } catch (err: any) {
    if (err?.message) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

function stateFileForPort(port: number): string {
  return `/tmp/camberqa-server-${port}.json`;
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function findWorktreeEnvFile(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, ".worktree-env.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readWorktreeEnv(startDir: string): WorktreeEnv | null {
  const envFile = findWorktreeEnvFile(startDir);
  if (!envFile) return null;
  return JSON.parse(fs.readFileSync(envFile, "utf-8")) as WorktreeEnv;
}

function consumeTargetFlag(args: string[]): { target?: "desktop"; args: string[] } {
  let target: "desktop" | undefined;
  const next: string[] = [];
  for (const arg of args) {
    if (arg === "--desktop") {
      target = "desktop";
    } else {
      next.push(arg);
    }
  }
  return { target, args: next };
}

async function applyTargetEnvironment(target?: "desktop"): Promise<void> {
  // CAMBERQA_STATE_FILE is the explicit per-invocation override (it is what
  // `camberqa desktop env` prints). CAMBERQA_PORT alone is NOT an
  // override inside a worktree: shells spawned from a camberqa-launched app
  // inherit it, and it points at the instance that spawned the shell — which
  // may be a different worktree entirely.
  if (!target && process.env.CAMBERQA_STATE_FILE) return;

  const startDir = process.env.CAMBERQA_CALLER_CWD || process.cwd();
  let env = readWorktreeEnv(startDir);

  // A slot can be reclaimed by another worktree after a missed teardown, which
  // leaves this worktree's .worktree-env.json pointing at someone else's
  // services. Never talk to a slot we no longer own.
  if (env) {
    const owner = slotOwnerId(env.slot);
    if (owner !== null && owner !== env.id) {
      console.error(
        `[camberqa] Ignoring stale .worktree-env.json — slot ${env.slot} now belongs to "${owner}".`,
      );
      const envFile = findWorktreeEnvFile(startDir);
      if (envFile) {
        try {
          fs.unlinkSync(envFile);
        } catch {}
      }
      env = null;
    }
  }

  if (!env) {
    const inherited = process.env.CAMBERQA_PORT
      ? ` (ignoring CAMBERQA_PORT=${process.env.CAMBERQA_PORT} — likely inherited from the app that spawned this shell; set CAMBERQA_STATE_FILE to override explicitly)`
      : "";
    const gitInfo = detectGitWorktreeInfo(startDir);
    if (!gitInfo) {
      // The main workspace keeps the default state-file behavior, but a
      // directory that is not a usable checkout (e.g. an orphaned worktree
      // whose git metadata was pruned) must not fall back to an inherited
      // port and silently drive another worktree's instance.
      if (isGitRepo(startDir)) return;
      throw new Error(
        `Cannot determine the worktree for ${startDir} — not a usable git checkout${inherited}.`,
      );
    }
    const slot = findSlotForWorktreeId(gitInfo.id);
    if (slot === null) {
      throw new Error(
        `No running camberqa services for worktree "${gitInfo.id}"${inherited}. Start them with 'camberqa desktop up'.`,
      );
    }
    env = {
      slot,
      id: gitInfo.id,
      ports: portsForSlot(slot),
      profile: "worktree",
      pid: 0,
    };
  }

  const candidates: Array<{ target: "desktop"; port: number }> = [
    { target: "desktop", port: targetCamberQAPort(env.slot, "desktop") },
  ];

  let selected = target ? candidates.find((candidate) => candidate.target === target) : undefined;
  if (!selected) {
    const healthy: Array<{ target: "desktop"; port: number }> = [];
    for (const candidate of candidates) {
      if (await isHealthyState(readStateFromFile(stateFileForPort(candidate.port)))) {
        healthy.push(candidate);
      }
    }
    if (healthy.length > 1) {
      throw new Error(
        `[camberqa] Multiple targets are running for this worktree. Re-run with --desktop.`,
      );
    }
    selected = healthy[0] ?? candidates[0];
  }

  process.env.CAMBERQA_PORT = String(selected.port);
  process.env.CAMBERQA_STATE_FILE = stateFileForPort(selected.port);
  process.env.VITE_DEV_PORT = String(
    selected.target === "desktop" ? env.ports.desktopVite : env.ports.vite,
  );
}

async function main() {
  const parsedTarget = consumeTargetFlag(process.argv.slice(2));
  const args = parsedTarget.args;

  // Auto-detect worktree environment. Skip for lifecycle commands (desktop
  // manage their own env) and for help, since detection can fail loudly when no
  // services are running for the current worktree.
  const isTargetCommand = args[0] === "desktop";
  const isManageCommand = args[0] === "manage";
  const isHelp = args.length === 0 || args[0] === "--help" || args[0] === "-h";
  if (!isTargetCommand && !isManageCommand && !isHelp) {
    await applyTargetEnvironment(parsedTarget.target);
  }

  if (args[0] === "manage") {
    const subArgs = args.slice(1);
    const sub = subArgs[0];

    if (sub === "list") {
      await manageList();
    } else if (sub === "restart") {
      await manageRestart(subArgs[1]);
    } else if (sub === "stop") {
      await manageStop(subArgs[1]);
    } else if (sub === "logs") {
      const tailIdx = subArgs.indexOf("--tail");
      const tail = tailIdx >= 0 ? parseInt(subArgs[tailIdx + 1], 10) : 100;
      await manageLogs(subArgs[1], tail);
    } else if (sub === "run") {
      await runWrapper(subArgs.slice(1));
    } else {
      console.log(`Usage: camberqa manage run [--name <id>] <command...>
       camberqa manage list
       camberqa manage restart <id>
       camberqa manage stop <id|pattern>
       camberqa manage logs <id> [--tail N]`);
    }
    return;
  }

  if (args[0] === "desktop") {
    const { handleTargetCommand } = await import("./worktree/commands.js");
    await handleTargetCommand(args[0], args.slice(1));
    return;
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`🧵 camberqa — Camber Assistant QA tool

Usage: camberqa <command> [args...] [-- <command2> [args...] ...]

Target lifecycle:
  desktop up [--color HEX] [--worktree-name NAME] [--fast]
  desktop down [--all] | status | env

Interaction:
  snapshot [-i] [-c] [-d N] [-D]    discover @e1, @e2... refs
  click @ref | <selector>
  fill @ref "text" | type "text"
  press "Key" | scroll [up|down] [amount]
  hover @ref | wait "<selector>" [timeout]

Visual / read:
  screenshot [-o PATH] [--webview]
  screenshotElement @ref [-o PATH] [-p PADDING]
  text [@ref] | html [@ref] | js "expr"
  webErrors [--all] [--clear] [--limit N]
  component @ref [--components-only] [-d N]

Debug / profile:
  debug go [--port PORT]                  restart helper under Delve (desktop)
  profile go <cpu|heap|goroutine|trace>   capture helper pprof output
               [--seconds N] [-o PATH]
  debug rust                              print LLDB attach commands
  profile rust cpu [--seconds N]          report Rust profiling availability
               [-o PATH] [--format pprof|svg]

Chat:
  sendMessage "text"
  stopGeneration | isStreaming
  getLastResponse | getMessageCount
  waitForMessageCount <N> [timeout]
  assertMessage "text"
  approveAction [once|always|deny] | waitForApproval [timeout] | getApprovalInfo
  openCommandMenu | selectCommand "name"

Conversations:
  newConversation [--project NAME | --worktree NAME]
                                             click the "New conversation" button
                                             (desktop: defaults to projects[0])
  archiveConversation "title-substring"      archive the matching sidebar row
  openHistory | closeHistory                 open or close archived conversations
  deleteConversation "title-substring"       delete from history (auto-opens history)
  restoreConversation "title-substring"      restore an archived conversation
  listConversations | selectConversation "id" | --index N
  getCurrentConversation

Session config:
  getConfigs                                 list each config option with its current value
  setConfig <name> <value>                   open the matching dropdown and click the value
                                             (e.g. setConfig mode plan, setConfig model opus)

Projects (desktop):
  listProjects                               list projects in the sidebar
  listWorktrees [--project NAME]             list worktrees per project (filter optional)
  openProject "name"                         expand the project section
  closeProject "name"                        collapse the project section (if supported)
  removeProject "name"                       remove via kebab menu (no confirmation)
  createWorktree [--project NAME]            click "Add worktree for X"; name is server-assigned
  removeWorktree "name"                      hover row, click "Delete worktree X"
  openWorktree "name"                        click worktree row to switch workspace

Debug / ACP:
  getACPDump [output.json] | loadACPDump "path-or-json"
  restartACPServer "agent-server"
  restartHelper | helperLogs [lines=500]

Meta:
  status | focusCamber | quit

Process management:
  manage run [--name <id>] <command...>
  manage list | manage restart <id> | manage stop <id|pattern>
  manage logs <id> [--tail N]

Target selection:
  --desktop              select the desktop app

Refs:
  After \`snapshot\`, use @e1, @e2... as selectors.`);
    process.exit(0);
  }

  // Split args on "--" into multiple commands
  const commands: { command: string; args: string[] }[] = [];
  let current: string[] = [];
  for (const arg of args) {
    if (arg === "--" && current.length > 0) {
      commands.push({ command: current[0], args: current.slice(1) });
      current = [];
    } else {
      current.push(arg);
    }
  }
  if (current.length > 0) {
    commands.push({ command: current[0], args: current.slice(1) });
  }

  const state = await requireServer();
  for (const cmd of commands) {
    await sendCommand(state, cmd.command, cmd.args);
  }
}

main().catch((err) => {
  console.error(`[camberqa] ${err.message}`);
  process.exit(1);
});
