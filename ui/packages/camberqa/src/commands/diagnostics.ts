import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CamberQATarget } from "../targets/types.js";

const PROFILE_DIR = "/tmp/camberqa-profiles";

export type ProfileGoKind = "cpu" | "heap" | "goroutine" | "trace";
export type RustProfileFormat = "pprof" | "svg";

interface DesktopBridgeTarget extends CamberQATarget {
  readonly kind: "desktop";
  runBridgeCommand(command: string, args: string[]): Promise<string>;
}

interface DesktopRuntimeInfo {
  rustPid: number;
  rustExecutable: string;
  helperPid: number | null;
  helperLogPath: string | null;
  helperPprofUrl: string | null;
  rustProfilingEnabled: boolean;
}

interface DesktopRuntimeInfoTarget extends CamberQATarget {
  readonly kind: "desktop";
  getDesktopRuntimeInfo(): Promise<DesktopRuntimeInfo>;
}

export function parsePprofURLFromLogs(logs: string): string | null {
  const matches = [...logs.matchAll(/pprof listening on.*?\baddr=(?:"([^"]+)"|([^\s]+))/g)];
  const lastMatch = matches[matches.length - 1];
  const raw = lastMatch?.[1] ?? lastMatch?.[2];
  if (!raw) return null;

  const port = raw.match(/:(\d+)$/)?.[1];
  if (!port) return null;
  return `http://127.0.0.1:${port}`;
}

export function defaultGoDebugPort(slot: number): number {
  return 21375 + slot * 10;
}

export function parseDebugGoArgs(args: string[]): { port: number; dlvBinary: string } {
  const slot = Number.parseInt(process.env.CAMBER_WORKTREE_SLOT || "0", 10) || 0;
  let port = defaultGoDebugPort(slot);
  let dlvBinary = process.env.CAMBERQA_DLV_BINARY || "dlv";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        port = Number.parseInt(args[++i], 10);
        break;
      case "--dlv":
        dlvBinary = args[++i];
        break;
      default:
        throw new Error("Usage: debug go [--port PORT] [--dlv PATH]");
    }
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !dlvBinary) {
    throw new Error("Usage: debug go [--port PORT] [--dlv PATH]");
  }

  return { port, dlvBinary };
}

export function parseProfileGoArgs(args: string[]): {
  kind: ProfileGoKind;
  seconds: number;
  output: string;
} {
  const kind = args[0] as ProfileGoKind | undefined;
  if (!kind || !["cpu", "heap", "goroutine", "trace"].includes(kind)) {
    throw new Error("Usage: profile go <cpu|heap|goroutine|trace> [--seconds N] [-o PATH]");
  }

  let seconds = 30;
  let output = "";
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--seconds":
        seconds = Number.parseInt(args[++i], 10);
        break;
      case "-o":
      case "--output":
        output = args[++i];
        break;
      default:
        throw new Error("Usage: profile go <cpu|heap|goroutine|trace> [--seconds N] [-o PATH]");
    }
  }

  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("Usage: profile go <cpu|heap|goroutine|trace> [--seconds N] [-o PATH]");
  }

  return { kind, seconds, output: output || defaultProfilePath("go", kind, goProfileExt(kind)) };
}

export function parseProfileRustArgs(args: string[]): {
  seconds: number;
  output: string;
  format: RustProfileFormat;
} {
  if (args[0] !== "cpu") {
    throw new Error("Usage: profile rust cpu [--seconds N] [-o PATH] [--format pprof|svg]");
  }

  let seconds = 30;
  let output = "";
  let format: RustProfileFormat = "pprof";
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--seconds":
        seconds = Number.parseInt(args[++i], 10);
        break;
      case "-o":
      case "--output":
        output = args[++i];
        break;
      case "--format": {
        const nextFormat = args[++i];
        if (nextFormat !== "pprof" && nextFormat !== "svg") {
          throw new Error("Usage: profile rust cpu [--seconds N] [-o PATH] [--format pprof|svg]");
        }
        format = nextFormat;
        break;
      }
      default:
        throw new Error("Usage: profile rust cpu [--seconds N] [-o PATH] [--format pprof|svg]");
    }
  }

  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("Usage: profile rust cpu [--seconds N] [-o PATH] [--format pprof|svg]");
  }

  return {
    seconds,
    output: output || defaultProfilePath("rust", "cpu", format === "svg" ? "svg" : "pb"),
    format,
  };
}

export async function handleDiagnosticsCommand(
  command: string,
  args: string[],
  target: CamberQATarget,
): Promise<string> {
  switch (command) {
    case "debug":
      return handleDebug(args, target);
    case "profile":
      return handleProfile(args, target);
    default:
      throw new Error(`Unknown diagnostics command: ${command}`);
  }
}

async function handleDebug(args: string[], target: CamberQATarget): Promise<string> {
  const language = args[0];
  if (language === "go") {
    return handleDebugGo(args.slice(1), target);
  }
  if (language === "rust") {
    return handleDebugRust(args.slice(1), target);
  }
  throw new Error("Usage: debug <go|rust> ...");
}

async function handleProfile(args: string[], target: CamberQATarget): Promise<string> {
  const language = args[0];
  if (language === "go") {
    return handleProfileGo(args.slice(1), target);
  }
  if (language === "rust") {
    return handleProfileRust(args.slice(1), target);
  }
  throw new Error("Usage: profile <go|rust> ...");
}

async function handleDebugGo(args: string[], target: CamberQATarget): Promise<string> {
  if (!isDesktopBridgeTarget(target)) {
    throw new Error("debug go currently requires a desktop target. Re-run with --desktop.");
  }

  const { port, dlvBinary } = parseDebugGoArgs(args);
  ensureExecutableAvailable(
    dlvBinary,
    `Delve binary not found: ${dlvBinary}. Install Delve or pass --dlv PATH.`,
  );
  await target.runBridgeCommand("camberqaDebugGo", [String(port), dlvBinary]);
  return [
    `camber-helper restarted under Delve on 127.0.0.1:${port}.`,
    "",
    "Attach:",
    `  dlv connect 127.0.0.1:${port}`,
  ].join("\n");
}

async function handleDebugRust(args: string[], target: CamberQATarget): Promise<string> {
  if (args.length > 0) throw new Error("Usage: debug rust");
  const info = await desktopRuntimeInfo(target);
  return [
    `Rust shell PID: ${info.rustPid}`,
    `Executable: ${info.rustExecutable}`,
    "",
    "Attach:",
    `  rust-lldb --pid ${info.rustPid}`,
    `  lldb -p ${info.rustPid}`,
  ].join("\n");
}

async function handleProfileGo(args: string[], target: CamberQATarget): Promise<string> {
  const { kind, seconds, output } = parseProfileGoArgs(args);
  const logFile = target.findLatestHelperLog();
  if (!logFile) {
    throw new Error("No helper log file found; helper pprof address is unavailable.");
  }

  const logs = fs.readFileSync(logFile, "utf-8");
  const baseURL = parsePprofURLFromLogs(logs);
  if (!baseURL) {
    throw new Error(`No pprof address found in helper log: ${logFile}`);
  }

  const profileURL = goProfileURL(baseURL, kind, seconds);
  await writeFetchedProfile(profileURL, output, seconds);

  const lines = [`Go ${kind} profile written to ${output}`, `Source: ${profileURL}`];
  if (kind === "cpu" || kind === "heap") {
    lines.push("", "Analyze:", `  go tool pprof ${output}`);
  }
  return lines.join("\n");
}

async function handleProfileRust(args: string[], target: CamberQATarget): Promise<string> {
  const { seconds, output, format } = parseProfileRustArgs(args);
  const info = await desktopRuntimeInfo(target);
  if (!info.rustProfilingEnabled) {
    throw new Error("Rust profiling is currently unavailable for this desktop target.");
  }

  const bridgeTarget = requireDesktopBridgeTarget(target);
  const result = await bridgeTarget.runBridgeCommand("camberqaProfileRustCpu", [
    String(seconds),
    output,
    format,
  ]);
  const lines = [result];
  if (format === "pprof") {
    lines.push("", "Analyze:", `  go tool pprof ${output}`);
  }
  return lines.join("\n");
}

async function desktopRuntimeInfo(target: CamberQATarget): Promise<DesktopRuntimeInfo> {
  if (isDesktopRuntimeInfoTarget(target)) {
    return await target.getDesktopRuntimeInfo();
  }
  const bridgeTarget = requireDesktopBridgeTarget(target);
  return JSON.parse(await bridgeTarget.runBridgeCommand("camberqaRuntimeInfo", []));
}

function requireDesktopBridgeTarget(target: CamberQATarget): DesktopBridgeTarget {
  if (!isDesktopBridgeTarget(target)) {
    throw new Error("Rust diagnostics require a desktop target. Re-run with --desktop.");
  }
  return target;
}

function isDesktopBridgeTarget(target: CamberQATarget): target is DesktopBridgeTarget {
  return target.kind === "desktop" && "runBridgeCommand" in target;
}

function isDesktopRuntimeInfoTarget(target: CamberQATarget): target is DesktopRuntimeInfoTarget {
  return target.kind === "desktop" && "getDesktopRuntimeInfo" in target;
}

function defaultProfilePath(language: "go" | "rust", kind: string, ext: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(PROFILE_DIR, `${language}-${kind}-${timestamp}.${ext}`);
}

function ensureExecutableAvailable(binary: string, message: string): void {
  if (binary.includes(path.sep)) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      return;
    } catch {
      throw new Error(message);
    }
  }

  const result = spawnSync("which", [binary], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(message);
  }
}

function goProfileExt(kind: ProfileGoKind): string {
  switch (kind) {
    case "goroutine":
      return "txt";
    case "trace":
      return "trace";
    default:
      return "pb.gz";
  }
}

function goProfileURL(baseURL: string, kind: ProfileGoKind, seconds: number): string {
  switch (kind) {
    case "cpu":
      return `${baseURL}/debug/pprof/profile?seconds=${seconds}`;
    case "trace":
      return `${baseURL}/debug/pprof/trace?seconds=${seconds}`;
    case "goroutine":
      return `${baseURL}/debug/pprof/goroutine?debug=2`;
    case "heap":
      return `${baseURL}/debug/pprof/heap`;
  }
}

async function writeFetchedProfile(url: string, output: string, seconds: number): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const response = await fetch(url, {
    signal: AbortSignal.timeout((seconds + 30) * 1000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch profile: ${response.status} ${response.statusText}`);
  }
  fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
}
