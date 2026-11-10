import { describe, expect, it } from "vitest";
import {
  ACPError,
  ACPTransportNotConfiguredError,
  formatACPError,
  formatACPErrorSummary,
  normalizeACPError,
  toErrorResponse,
} from "./errors";

describe("formatACPError", () => {
  it.each([
    { data: { details: "Install the required CLI" }, expected: "Install the required CLI" },
    { data: { error: "Authentication failed" }, expected: "Authentication failed" },
    { data: { message: "Model unavailable" }, expected: "Model unavailable" },
    { data: { error: { message: "Nested failure" } }, expected: "Nested failure" },
    { data: "Plain error data", expected: "Plain error data" },
  ])("surfaces structured ACP error data", ({ data, expected }) => {
    const error = new ACPError({ code: -32603, message: "Internal error", data });

    expect(formatACPError(error, { prefix: "Could not send prompt" })).toBe(
      `Could not send prompt: ${expected}`,
    );
  });

  it("falls back to the error message when structured data has no message", () => {
    const error = new ACPError({
      code: -32603,
      message: "Internal error",
      data: { retryAfterSeconds: 5 },
    });

    expect(formatACPError(error, { prefix: "Could not send prompt" })).toBe(
      "Could not send prompt: Internal error",
    );
  });
});

describe("formatACPErrorSummary", () => {
  it("summarizes an upstream response body the agent passed through", () => {
    const error = new ACPError({
      code: -32603,
      message: "Internal error",
      data: {
        error:
          'starting conversation: failed to create agent session: API request failed with status 500: {"title":"Internal Server Error","status":500,"errors":[{"message":"inserting new agent session: ERROR: duplicate key value violates unique constraint \\"agent_session_pkey\\" (SQLSTATE 23505)"}]}',
      },
    });

    expect(formatACPErrorSummary(error, { prefix: "Could not send prompt" })).toBe(
      "Could not send prompt: starting conversation: failed to create agent session (server error 500)",
    );
    // The full text stays available for tooltips and bug reports.
    expect(formatACPError(error)).toContain("agent_session_pkey");
  });

  it("keeps the prose when the payload has no status to summarize", () => {
    const error = new ACPError({
      code: -32603,
      message: "Internal error",
      data: { error: 'loading session state: {"code":"corrupt"}' },
    });

    expect(formatACPErrorSummary(error)).toBe("loading session state");
  });

  it("leaves messages without an upstream payload untouched", () => {
    const error = new ACPError({
      code: -32603,
      message: "Internal error",
      data: { error: 'cwd "/gone" is not a directory' },
    });

    expect(formatACPErrorSummary(error, { prefix: "Could not send prompt" })).toBe(
      'Could not send prompt: cwd "/gone" is not a directory',
    );
  });

  it("keeps a message that is nothing but a payload rather than emptying it", () => {
    const error = new ACPError({
      code: -32603,
      message: "Internal error",
      data: { error: '{"detail":"unexpected error occurred"}' },
    });

    expect(formatACPErrorSummary(error)).toBe('{"detail":"unexpected error occurred"}');
  });

  // The summary runs on the agent's message alone; summarizing after the
  // prefix was prepended would count the prefix as prose and collapse this to
  // a bare "Could not send prompt" with the actual error stripped.
  it("keeps a payload-only message when a prefix is passed", () => {
    const error = new ACPError({
      code: -32603,
      message: "Internal error",
      data: { error: '{"detail":"unexpected error occurred"}' },
    });

    expect(formatACPErrorSummary(error, { prefix: "Could not send prompt" })).toBe(
      'Could not send prompt: {"detail":"unexpected error occurred"}',
    );
  });

  it("keeps bracketed prose that is not a trailing payload", () => {
    const error = new ACPError({
      code: -32603,
      message: "Internal error",
      data: { error: "agent command failed [exit status 1]" },
    });

    expect(formatACPErrorSummary(error)).toBe("agent command failed [exit status 1]");
  });
});

describe("normalizeACPError", () => {
  it("preserves ACP SDK error responses as ACPError", () => {
    const error = normalizeACPError({ code: -32603, message: "boom", data: { traceId: "123" } });

    expect(error).toBeInstanceOf(ACPError);
    expect(error).toMatchObject({
      name: "ACPError",
      message: "boom",
      code: -32603,
      data: { traceId: "123" },
    });
  });

  it("preserves ordinary Error instances", () => {
    const error = new ACPTransportNotConfiguredError();
    expect(normalizeACPError(error)).toBe(error);
  });

  it("normalizes ACP SDK RequestError instances with code and data", () => {
    const requestError = Object.assign(new Error("could not open a new TTY"), {
      name: "RequestError",
      code: -32000,
      data: { message: "Run `pool login` in a terminal to authenticate to Camber." },
    });

    const error = normalizeACPError(requestError);

    expect(error).toBeInstanceOf(ACPError);
    expect(error).toMatchObject({
      name: "ACPError",
      message: "could not open a new TTY",
      code: -32000,
      data: { message: "Run `pool login` in a terminal to authenticate to Camber." },
    });
  });
});

describe("toErrorResponse", () => {
  it("serializes ACPError instances back to JSON-RPC error responses", () => {
    expect(
      toErrorResponse(new ACPError({ code: -32603, message: "boom", data: "details" })),
    ).toEqual({
      code: -32603,
      message: "boom",
      data: "details",
    });
  });
});
