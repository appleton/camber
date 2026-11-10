import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isProcessAlive as isManagedProcessAlive, readState } from "../manage/state.js";
import { type WorktreePorts } from "./shared.js";

const SLOT_DIR = "/tmp/camber-worktree-slots";
const MAX_SLOTS = 8;

interface SlotLock {
  id: string;
  pid: number;
  claimedAt: string;
}

export interface WorktreeEnv {
  slot: number;
  id: string;
  ports: WorktreePorts;
  profile: string;
  agentMode?: "acp" | "classic";
  pid: number;
}

interface GitWorktreeInfo {
  id: string;
  root: string;
}

function callerCwd(): string {
  return process.env.CAMBERQA_CALLER_CWD || process.cwd();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function slotPath(slot: number): string {
  return path.join(SLOT_DIR, `slot-${slot}.lock`);
}

function readSlotLock(slot: number): SlotLock | null {
  try {
    return JSON.parse(fs.readFileSync(slotPath(slot), "utf-8"));
  } catch {
    return null;
  }
}

function writeSlotLock(slot: number, lock: SlotLock): void {
  // The main workspace (slot 0) never goes through claimSlot/claimOrReuseSlot,
  // so SLOT_DIR may not exist yet — ensure it before writing the lock.
  fs.mkdirSync(SLOT_DIR, { recursive: true });
  fs.writeFileSync(slotPath(slot), JSON.stringify(lock, null, 2));
}

function getManagedSlotLock(slot: number, currentLock: SlotLock | null): SlotLock | null {
  const claimedAt = currentLock?.claimedAt ?? new Date().toISOString();
  const id = currentLock?.id ?? `slot-${slot}`;

  for (const service of ["camberqa", "desktop", "desktop-vite", "vite", "mobile-vite"]) {
    const state = readState(`${service}-s${slot}`);
    if (state && isManagedProcessAlive(state.pid)) {
      return {
        id,
        pid: state.pid,
        claimedAt,
      };
    }
  }

  return null;
}

function claimSlot(worktreeId: string): number {
  fs.mkdirSync(SLOT_DIR, { recursive: true });

  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const lock = readSlotLock(slot);
    const managedLock = getManagedSlotLock(slot, lock);

    if (managedLock) {
      if (!lock || lock.id !== managedLock.id || lock.pid !== managedLock.pid) {
        writeSlotLock(slot, managedLock);
      }
      continue;
    }

    if (!lock || !isProcessAlive(lock.pid)) {
      const newLock: SlotLock = {
        id: worktreeId,
        pid: process.pid,
        claimedAt: new Date().toISOString(),
      };
      writeSlotLock(slot, newLock);
      return slot;
    }
  }

  throw new Error(`All ${MAX_SLOTS} worktree slots are occupied by live processes`);
}

export function claimOrReuseSlot(worktreeId: string): number {
  fs.mkdirSync(SLOT_DIR, { recursive: true });

  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const lock = readSlotLock(slot);
    const managedLock = getManagedSlotLock(slot, lock);
    const effectiveLock = managedLock ?? lock;
    if (effectiveLock?.id === worktreeId) {
      if (managedLock && (!lock || lock.pid !== managedLock.pid)) {
        writeSlotLock(slot, managedLock);
      }
      return slot;
    }
  }

  return claimSlot(worktreeId);
}

export function updateSlotOwner(slot: number, worktreeId: string, pid: number): void {
  const currentLock = readSlotLock(slot);
  writeSlotLock(slot, {
    id: currentLock?.id ?? worktreeId,
    pid,
    claimedAt: currentLock?.claimedAt ?? new Date().toISOString(),
  });
}

export function slotOwnerId(slot: number): string | null {
  return readSlotLock(slot)?.id ?? null;
}

export function releaseSlot(slot: number): void {
  try {
    fs.unlinkSync(slotPath(slot));
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
}

export function findWorktreeEnv(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, ".worktree-env.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function detectWorktree(): { id: string; slot: number } | null {
  const startDir = callerCwd();
  const envFile = findWorktreeEnv(startDir);
  if (envFile) {
    try {
      const env: WorktreeEnv = JSON.parse(fs.readFileSync(envFile, "utf-8"));
      return { id: env.id, slot: env.slot };
    } catch {}
  }

  const gitInfo = detectGitWorktreeInfo(startDir);
  const id = gitInfo?.id;
  if (!id) return null;
  const slot = findSlotForWorktreeId(id);
  return slot === null ? null : { id, slot };
}

export function findSlotForWorktreeId(id: string): number | null {
  try {
    for (let slot = 1; slot <= MAX_SLOTS; slot++) {
      const lock = readSlotLock(slot);
      if (lock && lock.id === id) {
        return slot;
      }
    }
  } catch {}

  return null;
}

export function detectGitWorktreeInfo(startDir = callerCwd()): GitWorktreeInfo | null {
  let root: string;
  let gitDir: string;
  let commonDir: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const dirs = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      {
        cwd: startDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
      .trim()
      .split("\n");
    gitDir = dirs[0] ?? "";
    commonDir = dirs[1] ?? "";
  } catch {
    return null;
  }

  if (!root || !gitDir || !commonDir || path.resolve(gitDir) === path.resolve(commonDir)) {
    return null;
  }

  return {
    id: gitWorktreeId(startDir, root),
    root,
  };
}

export function gitWorktreeId(startDir: string, root: string): string {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: startDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const camberPrefix = "camber/";
    if (branch.startsWith(camberPrefix)) {
      return branch.slice(camberPrefix.length);
    }
  } catch {}

  return path.basename(root);
}

export function listSlots(): Array<{ slot: number; id: string; pid: number; alive: boolean }> {
  const results: Array<{ slot: number; id: string; pid: number; alive: boolean }> = [];

  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const lock = readSlotLock(slot);
    const managedLock = getManagedSlotLock(slot, lock);
    const effectiveLock = managedLock ?? lock;

    if (effectiveLock) {
      results.push({
        slot,
        id: effectiveLock.id,
        pid: effectiveLock.pid,
        alive: managedLock ? true : isProcessAlive(effectiveLock.pid),
      });
    }
  }

  return results;
}

export function findWorktreeRoot(): string | null {
  return detectGitWorktreeInfo(callerCwd())?.root ?? null;
}
