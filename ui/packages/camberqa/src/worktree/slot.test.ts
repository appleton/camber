import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { detectGitWorktreeInfo, findWorktreeRoot } from "./slot.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("detectGitWorktreeInfo", () => {
  test("detects a linked git worktree and derives the id from camber branch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "camberqa-worktree-"));
    const repo = path.join(dir, "repo");
    const worktree = path.join(dir, "worktree");

    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "camberqa@example.com"]);
    git(repo, ["config", "user.name", "CamberQA Test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repo, "README.md"), "test\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["worktree", "add", "-b", "camber/flashing-foil", worktree]);

    expect(detectGitWorktreeInfo(worktree)).toEqual({
      id: "flashing-foil",
      root: fs.realpathSync(worktree),
    });
    expect(detectGitWorktreeInfo(repo)).toBeNull();
  });

  test("finds git worktree root from CAMBERQA_CALLER_CWD", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "camberqa-caller-worktree-"));
    const repo = path.join(dir, "repo");
    const worktree = path.join(dir, "worktree");

    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "camberqa@example.com"]);
    git(repo, ["config", "user.name", "CamberQA Test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repo, "README.md"), "test\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["worktree", "add", "-b", "camber/hearty-hitch", worktree]);

    const previousCallerCwd = process.env.CAMBERQA_CALLER_CWD;
    process.env.CAMBERQA_CALLER_CWD = worktree;
    try {
      expect(findWorktreeRoot()).toBe(fs.realpathSync(worktree));
      expect(detectGitWorktreeInfo()).toEqual({
        id: "hearty-hitch",
        root: fs.realpathSync(worktree),
      });
    } finally {
      if (previousCallerCwd === undefined) {
        delete process.env.CAMBERQA_CALLER_CWD;
      } else {
        process.env.CAMBERQA_CALLER_CWD = previousCallerCwd;
      }
    }
  });
});
