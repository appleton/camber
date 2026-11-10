import * as net from "node:net";
import { readLastLines } from "./log.js";
import { isProcessAlive, listStates, removeState, type ManagedProcessState } from "./state.js";

function sendSocketCommand(socketPath: string, action: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = "";

    conn.on("connect", () => {
      conn.write(JSON.stringify({ action }) + "\n");
    });

    conn.on("data", (data) => {
      buf += data.toString();
    });

    conn.on("end", () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch {
        reject(new Error(`Invalid response: ${buf}`));
      }
    });

    conn.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
        reject(new Error("Wrapper process is not running"));
      } else {
        reject(err);
      }
    });

    // Timeout
    conn.setTimeout(10000, () => {
      conn.destroy();
      reject(new Error("Socket connection timed out"));
    });
  });
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h${remMins}m`;
}

export async function manageList(): Promise<void> {
  const states = listStates();

  if (states.length === 0) {
    console.log("No managed processes.");
    return;
  }

  // Prune dead wrappers
  const alive = states.filter((s) => {
    if (!isProcessAlive(s.pid)) {
      removeState(s.id);
      return false;
    }
    return true;
  });

  if (alive.length === 0) {
    console.log("No managed processes.");
    return;
  }

  // Print table
  const idW = Math.max(4, ...alive.map((s) => s.id.length));
  const cmdW = Math.max(7, ...alive.map((s) => s.command.join(" ").length));
  const header = [
    "ID".padEnd(idW),
    "COMMAND".padEnd(Math.min(cmdW, 40)),
    "PID".padStart(7),
    "CHILD".padStart(7),
    "STATUS".padEnd(8),
    "UPTIME".padEnd(8),
    "RESTARTS",
  ].join("  ");

  console.log(header);

  for (const s of alive) {
    const childAlive = isProcessAlive(s.childPid);
    const cmd = s.command.join(" ");
    const row = [
      s.id.padEnd(idW),
      (cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd).padEnd(Math.min(cmdW, 40)),
      String(s.pid).padStart(7),
      String(s.childPid).padStart(7),
      (childAlive ? "running" : "dead").padEnd(8),
      formatUptime(s.startedAt).padEnd(8),
      String(s.restartCount),
    ].join("  ");
    console.log(row);
  }
}

export async function manageRestart(id: string): Promise<void> {
  if (!id) {
    console.error("Usage: camberqa manage restart <id>");
    process.exit(1);
  }

  const states = listStates();
  const state = states.find((s) => s.id === id);
  if (!state) {
    console.error(`[camberqa] No managed process with id "${id}".`);
    console.error(`[camberqa] Run 'camberqa manage list' to see available processes.`);
    process.exit(1);
  }

  if (!isProcessAlive(state.pid)) {
    removeState(id);
    console.error(`[camberqa] Wrapper for "${id}" is no longer running (stale state cleaned up).`);
    process.exit(1);
  }

  try {
    const resp = await sendSocketCommand(state.socketPath, "restart");
    if (resp.ok) {
      console.log(
        `[camberqa] Restarted "${id}" (new child PID: ${resp.childPid}, restarts: ${resp.restartCount})`,
      );
    } else {
      console.error(`[camberqa] Restart failed: ${resp.error}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`[camberqa] Failed to restart "${id}": ${err.message}`);
    process.exit(1);
  }
}

export async function manageStop(id: string): Promise<void> {
  return manageStopWithOptions(id);
}

function hasWildcard(id: string): boolean {
  return id.includes("*");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesManagedProcessId(id: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(id);
}

export function resolveManagedStopTargets(
  id: string,
  states: ManagedProcessState[],
): ManagedProcessState[] {
  if (!hasWildcard(id)) {
    const state = states.find((s) => s.id === id);
    return state ? [state] : [];
  }

  return states
    .filter((s) => matchesManagedProcessId(s.id, id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface ManageStopOptions {
  tolerateMissing?: boolean;
  tolerateErrors?: boolean;
}

export async function manageStopWithOptions(
  id: string,
  options: ManageStopOptions = {},
): Promise<void> {
  const tolerateMissing = options.tolerateMissing ?? false;
  const tolerateErrors = options.tolerateErrors ?? false;

  if (!id) {
    console.error("Usage: camberqa manage stop <id>");
    process.exit(1);
  }

  const states = listStates();
  const targets = resolveManagedStopTargets(id, states);
  if (targets.length === 0) {
    if (tolerateMissing) {
      console.log(`[camberqa] "${id}" is already stopped (no managed state).`);
      return;
    }
    const noun = hasWildcard(id) ? "matching id" : "id";
    console.error(`[camberqa] No managed process with ${noun} "${id}".`);
    process.exit(1);
  }

  if (hasWildcard(id)) {
    console.log(
      `[camberqa] Stopping ${targets.length} managed process${
        targets.length === 1 ? "" : "es"
      } matching "${id}": ${targets.map((s) => s.id).join(", ")}`,
    );
  }

  for (const state of targets) {
    await stopManagedProcess(state, { tolerateErrors });
  }
}

async function stopManagedProcess(
  state: ManagedProcessState,
  options: Pick<ManageStopOptions, "tolerateErrors"> = {},
): Promise<void> {
  const tolerateErrors = options.tolerateErrors ?? false;
  const id = state.id;

  if (!isProcessAlive(state.pid)) {
    removeState(id);
    console.log(`[camberqa] "${id}" was already dead (stale state cleaned up).`);
    return;
  }

  try {
    const resp = await sendSocketCommand(state.socketPath, "stop");
    if (resp.ok) {
      console.log(`[camberqa] Stopped "${id}".`);
    } else {
      if (tolerateErrors) {
        console.warn(`[camberqa] Failed to stop "${id}" (wrapper returned error): ${resp.error}`);
        return;
      }
      console.error(`[camberqa] Stop failed: ${resp.error}`);
      process.exit(1);
    }
  } catch (err: any) {
    if (tolerateErrors) {
      if (err?.message === "Wrapper process is not running") {
        removeState(id);
        console.log(`[camberqa] "${id}" wrapper was not running (stale state cleaned up).`);
      } else {
        console.warn(`[camberqa] Failed to stop "${id}" (continuing): ${err.message}`);
      }
      return;
    }
    console.error(`[camberqa] Failed to stop "${id}": ${err.message}`);
    process.exit(1);
  }
}

export async function manageLogs(id: string, tail: number = 100): Promise<void> {
  if (!id) {
    console.error("Usage: camberqa manage logs <id> [--tail N]");
    process.exit(1);
  }

  const states = listStates();
  const state = states.find((s) => s.id === id);
  if (!state) {
    console.error(`[camberqa] No managed process with id "${id}".`);
    process.exit(1);
  }

  const content = readLastLines(state.logFile, tail);
  if (content) {
    process.stdout.write(content);
    if (!content.endsWith("\n")) process.stdout.write("\n");
  } else {
    console.log(`[camberqa] No logs for "${id}" yet.`);
  }
}
