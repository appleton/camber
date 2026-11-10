import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Plan {
  action: string;
  reason: string | null;
  version: string;
  tag: string;
  previousTag: string | null;
  changelogTag: string | null;
  latestTag: string | null;
  tagAnnotation: string;
  syncVersions: boolean;
  syncSuppressed: boolean;
  implicitRecovery: boolean;
  alignmentFloor: string | null;
  sourceSha: string;
  affected: boolean;
  affectedFiles: string[];
}

const script = resolve(dirname(fileURLToPath(import.meta.url)), "find-version.ts");
const tsx = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/tsx");
const destination = "appleton.assistant-release-test";
const displayName = "Camber Assistant Release Test";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function plan(repo: string, ...args: string[]): Plan {
  const result = spawnSync(
    tsx,
    [
      script,
      "plan",
      "desktop",
      "--ref",
      "HEAD",
      "--main-ref",
      "HEAD",
      "--destination",
      destination,
      "--display-name",
      displayName,
      ...args,
    ],
    { cwd: repo, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `release planner exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function renderChangelog(repo: string, ...args: string[]): string {
  const result = spawnSync(
    tsx,
    [script, "render-changelog", "desktop", "--head", "HEAD", "--out", "-", ...args],
    { cwd: repo, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `changelog renderer exited ${result.status}`);
  }
  return result.stdout;
}

function commit(repo: string, contents: string): string {
  writeFileSync(resolve(repo, "app/file.txt"), contents);
  git(repo, "add", ".");
  git(repo, "commit", "-m", contents);
  return git(repo, "rev-parse", "HEAD");
}

describe("managed release lineages", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), "release-lineage-"));
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Release Test");
    git(repo, "config", "user.email", "release-test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    mkdirSync(resolve(repo, "app"));
    writeFileSync(
      resolve(repo, "projects.yml"),
      "projects:\n  - name: desktop\n    tag: desktop\n    dirs:\n      - app\n",
    );
    commit(repo, "first");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("starts changelog history at 1.0.0", { timeout: 20_000 }, () => {
    git(repo, "tag", "desktop/v0.14.1");
    commit(repo, "Add the initial release");
    git(repo, "tag", "desktop/v1.0.0");
    commit(repo, "Add a post-1.0 improvement");

    const changelog = renderChangelog(repo, "--version", "1.1.0");

    expect(changelog).toContain("## 1.1.0 (Preview)");
    expect(changelog).toContain("- Add a post-1.0 improvement");
    expect(changelog).toContain("## 1.0.0");
    expect(changelog).toContain("_Initial release._");
    expect(changelog).not.toContain("0.14.1");
    expect(changelog).not.toContain("Add the initial release");
  });

  it("itemizes each earlier release in a nightly changelog", { timeout: 20_000 }, () => {
    commit(repo, "Add the initial release");
    git(repo, "tag", "desktop/v1.0.0");
    commit(repo, "Add the first nightly change");
    git(repo, "tag", "desktop/v1.1.0");
    commit(repo, "Add the second nightly change");
    git(repo, "tag", "desktop/v1.1.1");
    commit(repo, "Add the third nightly change");

    const changelog = renderChangelog(repo, "--version", "1.1.2");

    const sections = changelog.split(/^## /mu).slice(1);
    expect(sections.map((section) => section.split(" — ")[0])).toEqual([
      "1.1.2 (Preview)",
      "1.1.1 (Preview)",
      "1.1.0 (Preview)",
      "1.0.0",
    ]);
    expect(sections[0]).toContain("- Add the third nightly change");
    expect(sections[0]).not.toContain("second nightly");
    expect(sections[1]).toContain("- Add the second nightly change");
    expect(sections[1]).not.toContain("first nightly");
    expect(sections[2]).toContain("- Add the first nightly change");
    expect(sections[3]).toContain("_Initial release._");
  });

  it("rolls nightly releases up into a stable changelog", { timeout: 20_000 }, () => {
    commit(repo, "Add the initial release");
    git(repo, "tag", "desktop/v1.0.0");
    commit(repo, "Add the first nightly change");
    git(repo, "tag", "desktop/v1.1.0");
    commit(repo, "Add the second nightly change");
    git(repo, "tag", "desktop/v1.1.1");

    const changelog = renderChangelog(repo, "--version", "1.2.0");

    const sections = changelog.split(/^## /mu).slice(1);
    expect(sections.map((section) => section.split(" — ")[0])).toEqual(["1.2.0", "1.0.0"]);
    expect(sections[0]).toContain("- Add the first nightly change");
    expect(sections[0]).toContain("- Add the second nightly change");
    expect(sections[1]).toContain("_Initial release._");
  });

  it("bootstraps, resumes, and bumps only inside a custom prefix", { timeout: 20_000 }, () => {
    git(repo, "tag", "retired-desktop/v9.8.0");
    const bootstrap = plan(
      repo,
      "--channel",
      "nightly",
      "--version",
      "0.1.0",
      "--tag-prefix",
      "desktop-shadow",
      "--create-lineage",
      "--sync-versions",
    );
    expect(bootstrap).toMatchObject({
      action: "release",
      version: "0.1.0",
      tag: "desktop-shadow/v0.1.0",
      previousTag: null,
      changelogTag: null,
      latestTag: null,
      syncVersions: false,
      syncSuppressed: true,
    });

    git(repo, "tag", "--annotate", bootstrap.tag, "--message", bootstrap.tagAnnotation);
    expect(
      plan(repo, "--channel", "nightly", "--tag-prefix", "desktop-shadow", "--create-lineage"),
    ).toMatchObject({
      action: "resume",
      version: "0.1.0",
      implicitRecovery: true,
    });

    commit(repo, "second");
    expect(plan(repo, "--channel", "nightly", "--tag-prefix", "desktop-shadow")).toMatchObject({
      action: "release",
      version: "0.1.1",
      tag: "desktop-shadow/v0.1.1",
      previousTag: "desktop-shadow/v0.1.0",
      latestTag: "desktop-shadow/v0.1.0",
    });
    expect(plan(repo, "--channel", "stable", "--tag-prefix", "desktop-shadow")).toMatchObject({
      version: "0.2.0",
      tag: "desktop-shadow/v0.2.0",
      previousTag: null,
      changelogTag: "desktop-shadow/v0.1.0",
    });
  });

  it("requires explicit creation for the first release", { timeout: 20_000 }, () => {
    expect(() =>
      plan(repo, "--channel", "nightly", "--version", "0.1.0", "--tag-prefix", "desktop-shadow"),
    ).toThrow("--create-lineage");
    expect(() =>
      plan(repo, "--channel", "nightly", "--tag-prefix", "desktop-shadow", "--create-lineage"),
    ).toThrow("requires an exact --version");
  });

  it("excludes the retired Desktop tag namespace from version sync", { timeout: 20_000 }, () => {
    git(repo, "tag", "retired-desktop/v9.8.0");
    git(repo, "tag", "desktop/v0.7.0");

    expect(
      plan(
        repo,
        "--channel",
        "nightly",
        "--version",
        "0.7.1",
        "--tag-prefix",
        "desktop",
        "--create-lineage",
        "--sync-versions",
      ),
    ).toMatchObject({
      version: "0.7.1",
      alignmentFloor: "0.7.0",
      tag: "desktop/v0.7.1",
    });
  });

  it("rejects lightweight tags and destination changes", { timeout: 20_000 }, () => {
    git(repo, "tag", "desktop-shadow/v0.1.0");
    expect(() => plan(repo, "--channel", "nightly", "--tag-prefix", "desktop-shadow")).toThrow(
      "lightweight or unrecognized",
    );

    git(repo, "tag", "--delete", "desktop-shadow/v0.1.0");
    const bootstrap = plan(
      repo,
      "--channel",
      "nightly",
      "--version",
      "0.1.0",
      "--tag-prefix",
      "desktop-shadow",
      "--create-lineage",
    );
    git(repo, "tag", "--annotate", bootstrap.tag, "--message", bootstrap.tagAnnotation);

    expect(() =>
      plan(
        repo,
        "--channel",
        "nightly",
        "--version",
        "0.1.0",
        "--tag-prefix",
        "desktop-other",
        "--create-lineage",
      ),
    ).toThrow("already bound");
    expect(() =>
      plan(
        repo,
        "--channel",
        "nightly",
        "--tag-prefix",
        "desktop-shadow",
        "--destination",
        "appleton.some-other-extension",
      ),
    ).toThrow("is bound to");
  });

  it("rejects custom prefixes for schedules", { timeout: 20_000 }, () => {
    expect(() =>
      plan(repo, "--channel", "nightly", "--tag-prefix", "desktop-shadow", "--scheduled"),
    ).toThrow("Scheduled releases must use");
  });

  it("ignores malformed metadata outside the active lineage", { timeout: 20_000 }, () => {
    const unrelated = JSON.stringify({
      kind: "camber-release-lineage",
      schema: 2,
      product: "desktop",
      tagPrefix: "desktop-shadow",
      destination: "camber/desktop-shadow",
      version: "0.1.0",
      sourceSha: git(repo, "rev-parse", "HEAD"),
    });
    git(repo, "tag", "--annotate", "unrelated-preview/v0.1.0", "--message", unrelated);

    expect(
      plan(
        repo,
        "--channel",
        "nightly",
        "--version",
        "0.1.0",
        "--tag-prefix",
        "desktop-shadow",
        "--create-lineage",
      ),
    ).toMatchObject({ action: "release", tag: "desktop-shadow/v0.1.0" });
  });

  it("rejects malformed metadata inside the active lineage", { timeout: 20_000 }, () => {
    const malformed = JSON.stringify({
      kind: "camber-release-lineage",
      schema: 2,
      product: "desktop",
      tagPrefix: "desktop-shadow",
      destination,
      version: "0.1.0",
      sourceSha: git(repo, "rev-parse", "HEAD"),
    });
    git(repo, "tag", "--annotate", "desktop-shadow/v0.1.0", "--message", malformed);

    expect(() => plan(repo, "--channel", "nightly", "--tag-prefix", "desktop-shadow")).toThrow(
      "Unsupported release-lineage metadata",
    );
  });

  it("skips scheduled runs until the default lineage is bootstrapped", { timeout: 20_000 }, () => {
    expect(
      plan(repo, "--channel", "nightly", "--tag-prefix", "desktop", "--scheduled"),
    ).toMatchObject({
      action: "skip",
      reason: "No desktop tags exist; bootstrap the first release manually with --version",
    });

    // An unbound lightweight tag cannot bootstrap scheduled publication.
    git(repo, "tag", "desktop/v4.7.0");
    expect(
      plan(repo, "--channel", "nightly", "--tag-prefix", "desktop", "--scheduled"),
    ).toMatchObject({
      action: "skip",
      reason: "Tag lineage desktop is not bound; bootstrap it manually with an exact --version",
    });
  });

  it(
    "uses the newest cross-channel release as the scheduled change baseline",
    { timeout: 20_000 },
    () => {
      const nightly = plan(
        repo,
        "--channel",
        "nightly",
        "--version",
        "0.1.0",
        "--tag-prefix",
        "desktop",
        "--create-lineage",
      );
      git(repo, "tag", "--annotate", nightly.tag, "--message", nightly.tagAnnotation);

      commit(repo, "stable change");
      const stable = plan(repo, "--channel", "stable", "--tag-prefix", "desktop");
      expect(stable).toMatchObject({ version: "0.2.0", tag: "desktop/v0.2.0" });
      git(repo, "tag", "--annotate", stable.tag, "--message", stable.tagAnnotation);

      expect(
        plan(
          repo,
          "--channel",
          "nightly",
          "--tag-prefix",
          "desktop",
          "--scheduled",
          "--skip-if-no-changes",
        ),
      ).toMatchObject({
        action: "skip",
        reason: "No desktop-affecting changes since desktop/v0.2.0",
        previousTag: "desktop/v0.1.0",
        changelogTag: "desktop/v0.1.0",
        latestTag: "desktop/v0.2.0",
        affected: false,
        affectedFiles: [],
      });

      commit(repo, "nightly change");
      expect(
        plan(
          repo,
          "--channel",
          "nightly",
          "--tag-prefix",
          "desktop",
          "--scheduled",
          "--skip-if-no-changes",
        ),
      ).toMatchObject({
        action: "release",
        affected: true,
        affectedFiles: ["app/file.txt"],
      });
    },
  );

  it("accepts main history and rejects an unmerged descendant", { timeout: 20_000 }, () => {
    const firstSha = git(repo, "rev-parse", "HEAD");
    commit(repo, "second");
    expect(
      plan(
        repo,
        "--channel",
        "nightly",
        "--version",
        "0.1.0",
        "--tag-prefix",
        "desktop-shadow",
        "--create-lineage",
        "--ref",
        firstSha,
        "--main-ref",
        "main",
      ),
    ).toMatchObject({ sourceSha: firstSha });

    git(repo, "switch", "--create", "feature");
    commit(repo, "feature");
    expect(() =>
      plan(
        repo,
        "--channel",
        "nightly",
        "--version",
        "0.1.0",
        "--tag-prefix",
        "desktop-shadow",
        "--create-lineage",
        "--main-ref",
        "main",
      ),
    ).toThrow("is not an ancestor");
  });

  it("ignores suffixed tags when binding the default lineage", { timeout: 20_000 }, () => {
    git(repo, "tag", "desktop/v4.2.1-internal");
    expect(
      plan(
        repo,
        "--channel",
        "nightly",
        "--version",
        "0.1.0",
        "--tag-prefix",
        "desktop",
        "--create-lineage",
      ),
    ).toMatchObject({
      action: "release",
      version: "0.1.0",
      tag: "desktop/v0.1.0",
      previousTag: null,
    });
  });

  it("rejects an arbitrary detached one-commit tag based on main", { timeout: 20_000 }, () => {
    git(repo, "switch", "--create", "unrelated-release");
    commit(repo, "unrelated side-branch change");
    git(repo, "tag", "desktop/v4.7.0");

    git(repo, "switch", "main");
    commit(repo, "later main change");

    expect(() =>
      plan(
        repo,
        "--channel",
        "nightly",
        "--version",
        "4.7.1",
        "--tag-prefix",
        "desktop",
        "--create-lineage",
      ),
    ).toThrow("is not an ancestor");
  });

  it("rejects a detached tag not based on main history", { timeout: 20_000 }, () => {
    const tree = git(repo, "rev-parse", "HEAD^{tree}");
    const unrelatedParent = git(repo, "commit-tree", tree, "-m", "unrelated root");
    const unrelatedTagCommit = git(
      repo,
      "commit-tree",
      tree,
      "-p",
      unrelatedParent,
      "-m",
      "detached version stamp",
    );
    git(repo, "tag", "desktop/v4.7.0", unrelatedTagCommit);

    expect(() =>
      plan(
        repo,
        "--channel",
        "nightly",
        "--version",
        "4.7.1",
        "--tag-prefix",
        "desktop",
        "--create-lineage",
      ),
    ).toThrow("is not an ancestor");
  });
});
