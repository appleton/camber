import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface Project {
  name: string;
  dirs: string[];
}

const config = YAML.parse(readFileSync(resolve("projects.yml"), "utf8")) as {
  projects: Project[];
};
const trackedFiles = execFileSync("git", ["ls-files"], {
  cwd: resolve("../../.."),
  encoding: "utf8",
})
  .trim()
  .split("\n");

const appDirs: Record<string, string> = {
  desktop: "ui/apps/desktop-assistant",
};
const products = Object.keys(appDirs);

function dirsFor(name: string): string[] {
  const project = config.projects.find((candidate) => candidate.name === name);
  if (!project) throw new Error(`Missing ${name} project`);
  return project.dirs;
}

describe("release project ownership", () => {
  it("contains only products managed by the coordinated release flow", () => {
    expect(config.projects.map((project) => project.name)).toEqual(["desktop"]);
  });

  it.each(products)("covers the %s runtime dependency graph", (product) => {
    expect(dirsFor(product)).toEqual(
      expect.arrayContaining([
        appDirs[product],
        "cmd/camber-helper",
        "pkg",
        "ui/apps/mobile-remote",
        "ui/packages/assistant",
        "ui/packages/components",
        "ui/packages/diff",
        "ui/packages/dnd",
        "ui/packages/features",
        "ui/packages/helperapi",
        "ui/packages/lib",
        "ui/packages/rpc",
        "ui/packages/remote-client",
        "ui/packages/splits",
        "ui/config/svelte",
        "ui/config/tailwind",
        "ui/config/tsconfig",
        "ui/config/vite",
        "bazel",
        "patches",
        "third_party",
        ".bazelignore",
        ".bazelrc",
        ".bazelversion",
        "BUILD.bazel",
        "MODULE.bazel",
        "MODULE.bazel.lock",
        "go.mod",
        "go.sum",
        "nogo_config.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "turbo.json",
        ".tool-versions",
      ]),
    );
  });

  it("assigns the Desktop-only MLX sidecar only to Desktop", () => {
    expect(dirsFor("desktop")).toContain("cmd/camber-mlx-sidecar");
  });

  it.each(products)("does not treat %s release automation as product code", (product) => {
    expect(dirsFor(product).some((dir) => dir.startsWith(".github/"))).toBe(false);
  });

  it.each(products)("contains only tracked %s ownership paths", (product) => {
    for (const path of dirsFor(product)) {
      expect(
        trackedFiles.some((file) => file === path || file.startsWith(`${path}/`)),
        `${path} is not tracked`,
      ).toBe(true);
    }
  });
});
