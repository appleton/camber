import { describe, expect, test } from "vitest";
import {
  defaultGoDebugPort,
  parseDebugGoArgs,
  parsePprofURLFromLogs,
  parseProfileGoArgs,
  parseProfileRustArgs,
} from "./diagnostics.js";

describe("parsePprofURLFromLogs", () => {
  test("finds the latest helper pprof address", () => {
    const logs = [
      'camber-helper: level=INFO msg="pprof listening on" addr=127.0.0.1:49601',
      'camber-helper: level=INFO msg="pprof listening on" addr=127.0.0.1:49602',
    ].join("\n");

    expect(parsePprofURLFromLogs(logs)).toBe("http://127.0.0.1:49602");
  });

  test("returns null when no pprof address is present", () => {
    expect(parsePprofURLFromLogs("helper started")).toBeNull();
  });
});

describe("parseDebugGoArgs", () => {
  test("uses a slot-derived default port", () => {
    expect(defaultGoDebugPort(0)).toBe(21375);
    expect(defaultGoDebugPort(3)).toBe(21405);
  });

  test("accepts an explicit port and dlv path", () => {
    expect(parseDebugGoArgs(["--port", "24000", "--dlv", "/bin/dlv"])).toEqual({
      port: 24000,
      dlvBinary: "/bin/dlv",
    });
  });

  test("rejects invalid ports", () => {
    expect(() => parseDebugGoArgs(["--port", "0"])).toThrow(
      "Usage: debug go [--port PORT] [--dlv PATH]",
    );
  });

  test("rejects missing dlv paths", () => {
    expect(() => parseDebugGoArgs(["--dlv"])).toThrow("Usage: debug go [--port PORT] [--dlv PATH]");
  });
});

describe("parseProfileGoArgs", () => {
  test("accepts cpu profile options", () => {
    expect(parseProfileGoArgs(["cpu", "--seconds", "5", "-o", "/tmp/cpu.pb.gz"])).toEqual({
      kind: "cpu",
      seconds: 5,
      output: "/tmp/cpu.pb.gz",
    });
  });

  test("rejects unknown profile kinds", () => {
    expect(() => parseProfileGoArgs(["mutex"])).toThrow(
      "Usage: profile go <cpu|heap|goroutine|trace> [--seconds N] [-o PATH]",
    );
  });
});

describe("parseProfileRustArgs", () => {
  test("accepts cpu profile format options", () => {
    expect(
      parseProfileRustArgs(["cpu", "--seconds", "10", "--format", "svg", "-o", "/tmp/rust.svg"]),
    ).toEqual({
      seconds: 10,
      output: "/tmp/rust.svg",
      format: "svg",
    });
  });

  test("rejects non-cpu profiles", () => {
    expect(() => parseProfileRustArgs(["heap"])).toThrow(
      "Usage: profile rust cpu [--seconds N] [-o PATH] [--format pprof|svg]",
    );
  });
});
