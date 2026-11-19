import { ACP_AUTH_REQUIRED_ERROR_CODE } from "../../authMethods";
import { ACPError, type ACPRequestError } from "../../errors";

export function isAuthRequiredError(err: ACPRequestError): boolean {
  if (!(err instanceof ACPError)) {
    return containsAuthRequiredMessage(err.message);
  }
  if (err.code === ACP_AUTH_REQUIRED_ERROR_CODE) return true;
  return containsAuthRequiredMessage(err.message) || containsAuthRequiredMessage(err.data);
}

export function isStaleSessionError(err: ACPRequestError): boolean {
  if (!(err instanceof ACPError)) return false;
  if (err.code === -32002 && err.message.toLowerCase().includes("resource not found")) {
    return true;
  }
  // Agents answer calls on a session they no longer hold (closed via
  // session/close by this or another surface, or lost to an agent restart)
  // with a plain internal error, e.g. claude-agent-acp's "Session not found".
  // Treat it as stale so the restore-and-retry path reopens transparently.
  if (err.code !== -32603) return false;
  const detail = `${err.message} ${stringifyData(err.data)}`.toLowerCase();
  return detail.includes("session not found");
}

// An agent can refuse to prompt a session it just restored, in a way no
// reload can fix. `pool acp` keeps the record binding an ACP session to its
// backend session on disk; when that record is lost the agent replays no
// transcript and every prompt re-runs its "starting conversation" path, which
// collides with the backend session the first turn already created
// (PE-2460 / AGR-356). Retrying only repeats the collision, so callers rebind
// the conversation to a fresh session instead.
export function isUnresumableSessionError(err: ACPRequestError): boolean {
  if (!(err instanceof ACPError)) return false;
  if (err.code !== -32603) return false;
  const detail = `${err.message} ${stringifyData(err.data)}`.toLowerCase();
  if (detail.includes("agent_session_pkey")) return true;
  return detail.includes("duplicate key") && detail.includes("agent session");
}

// The helper refuses to resume or reload a conversation whose turn is still
// running (acpproxy SESSION_ACTIVE / CONVERSATION_BUSY) without interrupting
// the agent. Nothing is wrong with the session; the caller retries when idle.
export function isSessionActiveError(err: ACPRequestError): boolean {
  const detail = `${err.message} ${err instanceof ACPError ? stringifyData(err.data) : ""}`;
  return (
    detail.includes("SESSION_ACTIVE") ||
    detail.includes("CONVERSATION_BUSY") ||
    detail.toLowerCase().includes("still running and cannot be reloaded")
  );
}

function stringifyData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data) ?? "";
  } catch {
    return "";
  }
}

function containsAuthRequiredMessage(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /\b401\b/.test(value) ||
      /\bunauthori[sz]ed\b/i.test(value) ||
      /\bauth[_ -]?required\b/i.test(value) ||
      /authentication[_ -]?failed/i.test(value) ||
      /\bfailed to authenticate\b/i.test(value) ||
      /\bcould not authenticate\b/i.test(value) ||
      /\binvalid authentication credentials\b/i.test(value)
    );
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some(containsAuthRequiredMessage);
  }
  return Object.values(value as Record<string, unknown>).some(containsAuthRequiredMessage);
}
