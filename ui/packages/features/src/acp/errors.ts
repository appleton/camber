import { CodedError, formatError, toError } from "@camber/lib/errors";

export type ErrorResponse = {
  code: number;
  message: string;
  data?: unknown;
};

export class ACPError extends CodedError {
  constructor({ code, message, data }: ErrorResponse) {
    super(message, { code, data, name: "ACPError" });
  }
}

export class ACPTransportNotConfiguredError extends Error {
  constructor() {
    super("ACP transport not configured");
    this.name = "ACPTransportNotConfiguredError";
  }
}

export type ACPRequestError = ACPError | Error;
export type ACPSessionRepositoryError = ACPTransportNotConfiguredError | ACPRequestError;

export function formatACPError(
  error: ACPRequestError,
  { prefix }: { prefix?: string } = {},
): string {
  const detail = extractACPErrorDataMessage(error);
  if (!detail) return formatError(error, { prefix });
  return prefix ? `${prefix}: ${detail}` : detail;
}

// Same as formatACPError, minus any upstream response body the agent passed
// through verbatim. Agents commonly append the raw payload of a failed API
// call, e.g. `... failed to create agent session: API request failed with
// status 500: {"title":"Internal Server Error",...,"errors":[{"message":"...
// duplicate key value violates unique constraint \"agent_session_pkey\"...`.
// None of that helps the reader, and it puts database internals on screen
// (PE-2460), so keep the prose and summarize the payload as its status. Callers
// that show a tooltip should keep using formatACPError for the full text.
export function formatACPErrorSummary(
  error: ACPRequestError,
  { prefix }: { prefix?: string } = {},
): string {
  // Summarize the agent's message alone, then prepend the prefix. Summarizing
  // the prefixed string instead would make the prefix count as prose, so a
  // message that is nothing but a payload would collapse to the bare prefix
  // ("Could not send prompt") with the actual error stripped.
  const summary = summarizeUpstreamPayload(formatACPError(error));
  return prefix ? `${prefix}: ${summary}` : summary;
}

// A passed-through response body is JSON introduced by a colon and running to
// the end of the message. Requiring the colon keeps bracketed prose (e.g.
// "command failed [exit 1]") intact.
const upstreamPayloadPattern = /:\s*[{[][\s\S]*[}\]]\s*$/;
const upstreamStatusPattern = /^(.*?):?\s*(?:\w+ )?request failed with status (\d{3})$/i;

function summarizeUpstreamPayload(message: string): string {
  // Nothing but a payload: leave it be rather than emptying the message. The
  // check runs before the pattern so a colon inside nested JSON cannot be
  // mistaken for the prose/payload boundary.
  if (/^[{[]/.test(message.trim())) return message;
  const payload = upstreamPayloadPattern.exec(message);
  if (!payload) return message;
  const prose = message.slice(0, payload.index).trim();
  if (!prose) return message;
  const status = upstreamStatusPattern.exec(prose);
  if (!status) return prose;
  const [, leading, code] = status;
  const summary = `server error ${code}`;
  return leading ? `${leading} (${summary})` : summary;
}

export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof ACPError) {
    return {
      code: error.code,
      message: error.message,
      data: error.data,
    };
  }

  if (isErrorResponse(error)) {
    return {
      code: error.code,
      message: error.message,
      data: error.data,
    };
  }

  return { code: -32603, message: toError(error).message };
}

// JSON-RPC "method not found" is code -32601 (e.g. an older helper that predates
// a method). Some transports surface it only as a message, so also string-match.
export function isMethodNotFoundError(error: unknown): boolean {
  const { code, message } = toErrorResponse(error);
  return code === -32601 || message.toLowerCase().includes("method not found");
}

// RPC rejections often arrive as a plain { message, code } object rather than an
// Error instance, which would otherwise collapse to the opaque fallback string.
// Shared by the ACP MCP settings and user MCP server repositories.
export function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export function normalizeACPError(error: unknown): ACPRequestError {
  if (error instanceof ACPError) {
    return error;
  }

  if (isErrorResponse(error)) {
    return new ACPError(error);
  }

  if (error instanceof Error) {
    return error;
  }

  return toError(error);
}

function isErrorResponse(error: unknown): error is ErrorResponse {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    typeof error.code === "number" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

function extractACPErrorDataMessage(error: ACPRequestError): string | null {
  const data = "data" in error ? error.data : undefined;
  return extractStructuredErrorMessage(data);
}

function extractStructuredErrorMessage(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || depth >= 3) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractStructuredErrorMessage(item, depth + 1);
      if (message) return message;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["details", "error", "message", "reason", "cause"] as const) {
    const message = extractStructuredErrorMessage(record[key], depth + 1);
    if (message) return message;
  }
  return null;
}
