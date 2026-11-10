import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { LogWriter } from "./log.js";
import {
  deriveId,
  isProcessAlive,
  logPath,
  readState,
  removeState,
  socketPath,
  writeState,
  type ManagedProcessState,
} from "./state.js";

interface WrapperOptions {
  name?: string;
  command: string[];
  cwd?: string;
}

function parseWrapperArgs(args: string[]): WrapperOptions {
  let name: string | undefined;
  let cwd: string | undefined;
  let commandStart = 0;

  // --name and --cwd must come before the command to avoid ambiguity with child args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
      commandStart = i + 1;
    } else if (args[i] === "--cwd" && i + 1 < args.length) {
      cwd = args[++i];
      commandStart = i + 1;
    } else {
      commandStart = i;
      break;
    }
  }

  const command = args.slice(commandStart);

  if (command.length === 0) {
    throw new Error("Usage: camberqa manage [--name <id>] [--cwd <dir>] <command...>");
  }

  return { name, command, cwd: cwd || process.env.CAMBERQA_CALLER_CWD || process.cwd() };
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null) {
      resolve();
      return;
    }

    child.once("exit", () => resolve());
    signalChildTree(child, "SIGTERM");

    // Force kill after 5s
    const timer = setTimeout(() => {
      signalChildTree(child, "SIGKILL");
    }, 5000);
    timer.unref();

    child.once("exit", () => clearTimeout(timer));
  });
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export async function runWrapper(args: string[]): Promise<void> {
  const opts = parseWrapperArgs(args);
  const id = deriveId(opts.command, opts.name);
  const cwd = opts.cwd || process.cwd();

  // Check for existing wrapper with same ID
  const existing = readState(id);
  if (existing && isProcessAlive(existing.pid)) {
    console.error(
      `[camberqa] Process "${id}" is already managed (PID ${existing.pid}, child PID ${existing.childPid}).`,
    );
    console.error(
      `[camberqa] Use 'camberqa manage restart ${id}' or 'camberqa manage stop ${id}'.`,
    );
    process.exit(1);
  }

  // Clean up stale state/socket
  removeState(id);

  const logFile = logPath(id);
  const sockPath = socketPath(id);
  const logger = new LogWriter(logFile);

  let child: ChildProcess;
  let restartCount = 0;
  let isShuttingDown = false;
  let state: ManagedProcessState;

  function spawnChild(): ChildProcess {
    const proc = spawn(opts.command[0], opts.command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: process.env,
      detached: true,
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      logger.write(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      logger.write(chunk);
    });

    proc.on("exit", (code, signal) => {
      if (isShuttingDown) return;
      // Child exited on its own — clean up and exit wrapper
      cleanup();
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      console.error(`\n[camberqa] Process "${id}" exited (${reason})`);
      process.exit(code ?? 1);
    });

    return proc;
  }

  function updateState(): void {
    state = {
      id,
      command: opts.command,
      cwd,
      pid: process.pid,
      childPid: child.pid!,
      socketPath: sockPath,
      logFile,
      startedAt: state?.startedAt || new Date().toISOString(),
      restartCount,
    };
    writeState(state);
  }

  function cleanup(): void {
    logger.close();
    removeState(id);
    try {
      server.close();
    } catch {}
  }

  // Spawn initial child
  child = spawnChild();

  // Create Unix socket server for control commands
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (data) => {
      buf += data.toString();
      const nlIdx = buf.indexOf("\n");
      if (nlIdx < 0) return;

      const line = buf.slice(0, nlIdx);
      buf = buf.slice(nlIdx + 1);

      let msg: { action: string };
      try {
        msg = JSON.parse(line);
      } catch {
        conn.end(JSON.stringify({ error: "invalid JSON" }) + "\n");
        return;
      }

      if (msg.action === "restart") {
        isShuttingDown = true;
        killChild(child).then(() => {
          restartCount++;
          isShuttingDown = false;
          child = spawnChild();
          updateState();
          conn.end(JSON.stringify({ ok: true, childPid: child.pid, restartCount }) + "\n");
        });
      } else if (msg.action === "stop") {
        conn.end(JSON.stringify({ ok: true }) + "\n");
        isShuttingDown = true;
        killChild(child).then(() => {
          cleanup();
          process.exit(0);
        });
      } else if (msg.action === "status") {
        const alive = child.pid ? isProcessAlive(child.pid) : false;
        conn.end(
          JSON.stringify({ id, childPid: child.pid, alive, restartCount, command: opts.command }) +
            "\n",
        );
      } else {
        conn.end(JSON.stringify({ error: `unknown action: ${msg.action}` }) + "\n");
      }
    });
  });

  // Clean up stale socket file
  try {
    fs.unlinkSync(sockPath);
  } catch {}

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(sockPath, () => {
      fs.chmodSync(sockPath, 0o600);
      resolve();
    });
  });

  updateState();

  // Signal handling — forward to child and clean up
  const handleSignal = (sig: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try {
      signalChildTree(child, sig);
    } catch {}
    child.once("exit", () => {
      cleanup();
      process.exit(0);
    });
    // Force exit after timeout
    setTimeout(() => {
      cleanup();
      process.exit(1);
    }, 6000).unref();
  };

  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
}
