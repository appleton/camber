import { describe, expect, test } from "vitest";
import { outputLogChannelName } from "./vscode.js";

describe("outputLogChannelName", () => {
  test("extracts output channel names from VS Code log files", () => {
    expect(outputLogChannelName("2-camber Helper.log")).toBe("camber Helper");
  });

  test("ignores non-log files", () => {
    expect(outputLogChannelName("camber Helper.txt")).toBeNull();
  });
});
