import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface HelperPlan {
  action: "release" | "resume" | "reuse";
  version: string;
  tag: string;
  tagAnnotation: string;
  sourceSha: string;
  previousTag: string | null;
  published: boolean;
}

const script = resolve(dirname(fileURLToPath(import.meta.url)), "find-version.ts");
const tsx = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/tsx");

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function plan(repo: string): HelperPlan {
  const result = spawnSync(tsx, [script, "plan-helper", "--ref", "HEAD", "--main-ref", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      PATH: `${resolve(repo, "bin")}:${process.env.PATH ?? ""}`,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `helper release planner exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

describe("helper release planning", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), "helper-release-"));
    mkdirSync(resolve(repo, "bin"));
    writeFileSync(
      resolve(repo, "bin/gh"),
      `#!/bin/sh
test "\${HELPER_RELEASE_PUBLISHED:-}" = "true" && printf 'false\\n'
`,
    );
    chmodSync(resolve(repo, "bin/gh"), 0o755);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Release Test");
    git(repo, "config", "user.email", "release-test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(
      resolve(repo, "projects.yml"),
      "projects:\n  - name: desktop\n    tag: desktop\n    dirs: [app]\n  - name: desktop\n    tag: desktop\n    dirs: [desktop]\n",
    );
    writeFileSync(resolve(repo, "file.txt"), "first");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "first");
    git(repo, "tag", "helper/v0.0.9");
    writeFileSync(resolve(repo, "file.txt"), "second");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "second");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("increments the independent helper patch lineage", () => {
    expect(plan(repo)).toMatchObject({
      action: "release",
      version: "0.0.10",
      tag: "helper/v0.0.10",
      previousTag: "helper/v0.0.9",
      published: false,
    });
  });

  it("resumes an unpublished tag for the same source", () => {
    const initial = plan(repo);
    git(repo, "tag", "--annotate", initial.tag, "--message", initial.tagAnnotation);

    expect(plan(repo)).toMatchObject({
      action: "resume",
      version: "0.0.10",
      tag: "helper/v0.0.10",
      published: false,
    });
  });

  it("reuses a published release for the same source", () => {
    const initial = plan(repo);
    git(repo, "tag", "--annotate", initial.tag, "--message", initial.tagAnnotation);

    process.env.HELPER_RELEASE_PUBLISHED = "true";
    try {
      expect(plan(repo)).toMatchObject({
        action: "reuse",
        version: "0.0.10",
        tag: "helper/v0.0.10",
        published: true,
      });
    } finally {
      delete process.env.HELPER_RELEASE_PUBLISHED;
    }
  });
});
