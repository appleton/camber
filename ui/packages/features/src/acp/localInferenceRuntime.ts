import type { LocalInferenceState } from "@camber/helperapi/schemas";
import type { SessionEvent } from "./types";

// Derivations for the ambient local-runtime indicator: which model is
// resident in the sidecar's memory, how much memory it holds, when it was
// last prompted, and when the sidecar will free it on its own.

export interface LocalRuntimeResidency {
  modelId: string;
  /** Display name from the catalog, falling back to the id's last segment. */
  modelName: string;
  memoryBytes: number;
  lastActivityUnixMs: number;
  /** Sidecar idle-unload interval; 0 when auto unload is disabled. */
  idleUnloadSeconds: number;
}

/** Whether the helper is observing a sidecar that it does not manage. */
export function isExternalLocalInferenceRuntime(state: LocalInferenceState | null): boolean {
  return state?.runtime.status === "external";
}

/**
 * Whether the live turn has produced any agent output — a message, thought,
 * or tool call after the latest user message. Once it has, the model is
 * generating regardless of what runtime residency reports, so the indicator
 * must say "Working...", not "Loading model...": residency arrives via
 * didChange pushes and a missed or mismatched push would otherwise pin the
 * loading label for the whole turn.
 */
export function turnHasAgentOutput(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const kind = events[i].eventKind;
    if (kind === "user_message") return false;
    if (kind === "agent_message" || kind === "agent_thought" || kind === "tool_call") return true;
  }
  return false;
}

/** The model currently resident in the sidecar, or null when nothing is. */
export function localRuntimeResidency(
  state: LocalInferenceState | null,
): LocalRuntimeResidency | null {
  const runtime = state?.runtime;
  if (!runtime || runtime.status !== "running" || !runtime.loadedModelId) return null;
  const model = state.catalog.find(
    (candidate) =>
      candidate.id === runtime.loadedModelId || candidate.repoId === runtime.loadedModelId,
  );
  return {
    modelId: runtime.loadedModelId,
    modelName: model?.name ?? runtime.loadedModelId.split("/").at(-1) ?? runtime.loadedModelId,
    memoryBytes: runtime.loadedMemoryBytes ?? 0,
    lastActivityUnixMs: runtime.lastActivityUnixMs ?? 0,
    idleUnloadSeconds: runtime.idleUnloadSeconds ?? 0,
  };
}

/** "20.1 GB" style figure for the pill and popover; null when unknown. */
export function formatMemoryBytes(bytes: number): string | null {
  if (bytes <= 0) return null;
  const gib = bytes / 1024 ** 3;
  if (gib >= 10) return `${Math.round(gib)} GB`;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** "just now" / "4 min ago" / "2 h ago" for the last prompt line. */
export function formatLastPrompt(lastActivityUnixMs: number, nowMs: number): string | null {
  if (lastActivityUnixMs <= 0) return null;
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - lastActivityUnixMs) / 1000));
  if (elapsedSeconds < 60) return "just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ago`;
}

/**
 * "frees automatically in ~11 min" countdown; null when auto unload is
 * disabled or the deadline has already passed (the sidecar's sweep will
 * collect it momentarily).
 */
export function formatAutoUnload(residency: LocalRuntimeResidency, nowMs: number): string | null {
  if (residency.idleUnloadSeconds <= 0 || residency.lastActivityUnixMs <= 0) return null;
  const deadlineMs = residency.lastActivityUnixMs + residency.idleUnloadSeconds * 1000;
  const remainingSeconds = Math.floor((deadlineMs - nowMs) / 1000);
  if (remainingSeconds <= 0) return null;
  if (remainingSeconds < 60) return "frees automatically in under a minute";
  const minutes = Math.round(remainingSeconds / 60);
  return `frees automatically in ~${minutes} min`;
}
