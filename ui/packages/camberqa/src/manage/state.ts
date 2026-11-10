import * as fs from "node:fs";
import * as path from "node:path";

export const STATE_DIR = "/tmp/camberqa-managed";

export interface ManagedProcessState {
  id: string;
  command: string[];
  cwd: string;
  pid: number;
  childPid: number;
  socketPath: string;
  logFile: string;
  startedAt: string;
  restartCount: number;
}

export function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function statePath(id: string): string {
  return path.join(STATE_DIR, `${id}.json`);
}

export function socketPath(id: string): string {
  return path.join(STATE_DIR, `${id}.sock`);
}

export function logPath(id: string): string {
  return path.join(STATE_DIR, `${id}.log`);
}

export function writeState(state: ManagedProcessState): void {
  ensureStateDir();
  fs.writeFileSync(statePath(state.id), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function readState(id: string): ManagedProcessState | null {
  try {
    const data = fs.readFileSync(statePath(id), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function removeState(id: string): void {
  try {
    fs.unlinkSync(statePath(id));
  } catch {}
  try {
    fs.unlinkSync(socketPath(id));
  } catch {}
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listStates(): ManagedProcessState[] {
  ensureStateDir();
  const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
  const states: ManagedProcessState[] = [];
  for (const file of files) {
    try {
      const data = fs.readFileSync(path.join(STATE_DIR, file), "utf-8");
      states.push(JSON.parse(data));
    } catch {
      // skip corrupt files
    }
  }
  return states;
}

export function deriveId(command: string[], nameOverride?: string): string {
  const base = nameOverride || path.basename(command[0]);
  const existing = listStates();
  const takenIds = new Set(existing.filter((s) => isProcessAlive(s.pid)).map((s) => s.id));

  if (!takenIds.has(base)) return base;

  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!takenIds.has(candidate)) return candidate;
  }
}
