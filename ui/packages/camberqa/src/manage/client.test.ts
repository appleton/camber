import { describe, expect, test } from "vitest";
import { matchesManagedProcessId, resolveManagedStopTargets } from "./client.js";
import type { ManagedProcessState } from "./state.js";

function state(id: string): ManagedProcessState {
  return {
    id,
    command: ["echo", id],
    cwd: "/tmp",
    pid: 1,
    childPid: 2,
    socketPath: `/tmp/${id}.sock`,
    logFile: `/tmp/${id}.log`,
    startedAt: new Date(0).toISOString(),
    restartCount: 0,
  };
}

describe("matchesManagedProcessId", () => {
  test("matches exact ids without wildcards", () => {
    expect(matchesManagedProcessId("desktop-s3", "desktop-s3")).toBe(true);
    expect(matchesManagedProcessId("desktop-s4", "desktop-s3")).toBe(false);
  });

  test("matches prefix and suffix wildcards", () => {
    expect(matchesManagedProcessId("desktop-s3", "desktop*")).toBe(true);
    expect(matchesManagedProcessId("desktop-vite-s3", "*-s3")).toBe(true);
    expect(matchesManagedProcessId("camberqa-s3", "*-s3")).toBe(true);
    expect(matchesManagedProcessId("desktop-s4", "*-s3")).toBe(false);
  });

  test("treats non-wildcard regex characters literally", () => {
    expect(matchesManagedProcessId("desktop-s3", "desktop-s.")).toBe(false);
    expect(matchesManagedProcessId("desktop-s.", "desktop-s.")).toBe(true);
  });
});

describe("resolveManagedStopTargets", () => {
  const states = [
    state("camberqa-s3"),
    state("desktop-s4"),
    state("desktop-vite-s3"),
    state("desktop-s3"),
  ];

  test("resolves an exact id", () => {
    expect(resolveManagedStopTargets("desktop-s3", states).map((s) => s.id)).toEqual([
      "desktop-s3",
    ]);
  });

  test("resolves wildcard matches in deterministic order", () => {
    expect(resolveManagedStopTargets("*-s3", states).map((s) => s.id)).toEqual([
      "camberqa-s3",
      "desktop-s3",
      "desktop-vite-s3",
    ]);
  });

  test("returns no targets when a pattern does not match", () => {
    expect(resolveManagedStopTargets("missing*", states)).toEqual([]);
  });
});
