import { describe, expect, test } from "vitest";
import { isPathInside, parseWorktreeUpOptions, servicePatternsForTargets } from "./commands.js";

describe("servicePatternsForTargets", () => {
  const matches = (targets: Array<"vscode" | "desktop">, id: string) =>
    servicePatternsForTargets(targets).some((pattern) => pattern.test(id));

  test("vscode covers vite and camberqa services only", () => {
    expect(matches(["vscode"], "vite-s2")).toBe(true);
    expect(matches(["vscode"], "camberqa-s2")).toBe(true);
    expect(matches(["vscode"], "desktop-vite-s2")).toBe(false);
    expect(matches(["vscode"], "desktop-s2")).toBe(false);
  });

  test("desktop covers desktop services only", () => {
    expect(matches(["desktop"], "desktop-vite-s2")).toBe(true);
    expect(matches(["desktop"], "desktop-s2")).toBe(true);
    expect(matches(["desktop"], "vite-s2")).toBe(false);
    expect(matches(["desktop"], "camberqa-s2")).toBe(false);
  });

  test("both targets cover every slot service but not unrelated processes", () => {
    expect(matches(["vscode", "desktop"], "desktop-s10")).toBe(true);
    expect(matches(["vscode", "desktop"], "vite-s10")).toBe(true);
    expect(matches(["vscode", "desktop"], "sb-features")).toBe(false);
    expect(matches(["vscode", "desktop"], "vite-s2-extra")).toBe(false);
  });
});

describe("isPathInside", () => {
  test("matches the root itself and nested paths", () => {
    expect(isPathInside("/work/tree", "/work/tree")).toBe(true);
    expect(isPathInside("/work/tree/ui/apps", "/work/tree")).toBe(true);
  });

  test("rejects siblings and parents", () => {
    expect(isPathInside("/work/tree-other", "/work/tree")).toBe(false);
    expect(isPathInside("/work", "/work/tree")).toBe(false);
    expect(isPathInside("/elsewhere", "/work/tree")).toBe(false);
  });
});

describe("parseWorktreeUpOptions", () => {
  test("accepts fast worktree startup", () => {
    expect(parseWorktreeUpOptions(["--fast"])).toEqual({
      fast: true,
      agentMode: undefined,
      color: undefined,
      worktreeName: undefined,
    });
  });

  test("accepts acp mode", () => {
    expect(parseWorktreeUpOptions(["--acp"])).toEqual({
      fast: false,
      agentMode: "acp",
      color: undefined,
      worktreeName: undefined,
    });
  });

  test("accepts lsp mode", () => {
    expect(parseWorktreeUpOptions(["--lsp"])).toEqual({
      fast: false,
      agentMode: "classic",
      color: undefined,
      worktreeName: undefined,
    });
  });

  test("rejects acp and lsp together", () => {
    expect(() => parseWorktreeUpOptions(["--acp", "--lsp"])).toThrow(
      "Use either --acp or --lsp, not both.",
    );
  });

  test("accepts desktop display overrides", () => {
    expect(parseWorktreeUpOptions(["--color", "#8ecae6", "--worktree-name", "demo"])).toEqual({
      fast: false,
      agentMode: undefined,
      color: "#8ecae6",
      worktreeName: "demo",
    });
  });
});
