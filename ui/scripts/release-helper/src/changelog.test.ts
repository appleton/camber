import { describe, expect, it } from "vitest";

import {
  filterUserFacing,
  groupCommits,
  parseGitLog,
  renderChangelogFile,
  renderUserBody,
  SLACK_CHANGELOG_COMMIT_LIMIT,
} from "./changelog.js";

const US = "\x1f";
const RS = "\x1e";
const REPO = "appleton/camber";
const HEAD = "abcdef0123456789abcdef0123456789abcdef01";

function record(sha: string, author: string, subject: string, files: string[] = ["src/a.ts"]) {
  return `${RS}${sha}${US}${author}${US}${subject}\n\n${files.join("\n")}\n`;
}

function log(...records: string[]): string {
  return records.join("");
}

describe("parseGitLog", () => {
  it("returns an empty array for empty input", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("   \n  ")).toEqual([]);
  });

  it("parses records with changed files and classifies conventional commits", () => {
    const raw = log(
      record("1".repeat(40), "Ada", "feat(ui): add channel switcher", ["ui/a.ts", "ui/b.svelte"]),
      record("2".repeat(40), "Bob", "fix: correct nightly ordering"),
      record("3".repeat(40), "", "chore: bump deps"),
      record("4".repeat(40), "Cy", "random subject without type"),
    );

    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(4);

    expect(commits[0]).toMatchObject({
      shortSha: "1".repeat(12),
      authorName: "Ada",
      type: "feat",
      scope: "ui",
      breaking: false,
      description: "add channel switcher",
      files: ["ui/a.ts", "ui/b.svelte"],
    });
    expect(commits[1]).toMatchObject({
      type: "fix",
      scope: null,
      description: "correct nightly ordering",
    });
    expect(commits[2]).toMatchObject({ type: "chore", authorName: "Unknown author" });
    expect(commits[3]).toMatchObject({ type: null, description: "random subject without type" });
  });

  it("flags breaking changes via !", () => {
    const commits = parseGitLog(record("a".repeat(40), "Ada", "feat!: drop legacy api"));
    expect(commits[0].breaking).toBe(true);
  });

  it("strips pull-request numbers and ticket keys from descriptions", () => {
    const raw = log(
      record("1".repeat(40), "Ada", "Discover local models outside the app (PE-2474) (#568)"),
      record("2".repeat(40), "Bob", "PE-2463: Show standalone chats in mobile sidebar (#567)"),
      record("3".repeat(40), "Cy", "fix(prompt): don't disable send (PE-2456) (#514)"),
      record("4".repeat(40), "Dee", "Fix cropped bubble (PE-2449) and unbreak Storybook (#499)"),
    );

    expect(parseGitLog(raw).map((commit) => commit.description)).toEqual([
      "Discover local models outside the app",
      "Show standalone chats in mobile sidebar",
      "don't disable send",
      "Fix cropped bubble and unbreak Storybook",
    ]);
  });

  it("strips bracketed, repeated, and trailing ticket keys", () => {
    const raw = log(
      record("1".repeat(40), "Ada", "[PE-2400] Improve desktop assistant settings (#332)"),
      record("2".repeat(40), "Bob", "DOC-131 PE-2356 improve assistant repo docs (#340)"),
      record("3".repeat(40), "Cy", "Remove stale infra and training references PE-2255 (#163)"),
      record("4".repeat(40), "Dee", "PE-2294 Advertise ACP host context (#185)"),
    );

    expect(parseGitLog(raw).map((commit) => commit.description)).toEqual([
      "Improve desktop assistant settings",
      "improve assistant repo docs",
      "Remove stale infra and training references",
      "Advertise ACP host context",
    ]);
  });

  it("keeps prose parentheses and standards tokens", () => {
    const raw = log(
      record("1".repeat(40), "Ada", "Handle invalid input (UTF-8 fallback) (#123)"),
      record("2".repeat(40), "Bob", "Surface agents' collaboration mode (build/plan) (#561)"),
      record("3".repeat(40), "Cy", "Set locale for spawned terminals to UTF-8 (#124)"),
      record("4".repeat(40), "Dee", "UTF-8: decode terminal output (#125)"),
      record("5".repeat(40), "Ev", "Create drafts on click (PE-2329 follow-up) (#242)"),
    );

    const commits = parseGitLog(raw);
    expect(commits.map((commit) => commit.description)).toEqual([
      "Handle invalid input (UTF-8 fallback)",
      "Surface agents' collaboration mode (build/plan)",
      "Set locale for spawned terminals to UTF-8",
      "UTF-8: decode terminal output",
      "Create drafts on click (PE-2329 follow-up)",
    ]);
    expect(commits[0].subject).toBe("Handle invalid input (UTF-8 fallback) (#123)");
  });
});

describe("filterUserFacing", () => {
  it("drops excluded conventional types", () => {
    const commits = parseGitLog(
      log(
        record("1".repeat(40), "Ada", "chore: tidy up"),
        record("2".repeat(40), "Ada", "ci: speed up builds"),
        record("3".repeat(40), "Ada", "docs: clarify setup"),
        record("4".repeat(40), "Ada", "refactor: extract helper"),
        record("5".repeat(40), "Ada", "feat: add switcher"),
        record("6".repeat(40), "Ada", "Improve prompt editor"),
      ),
    );
    expect(filterUserFacing(commits).map((commit) => commit.description)).toEqual([
      "add switcher",
      "Improve prompt editor",
    ]);
  });

  it("drops commits whose owned changes are only docs or lockfiles", () => {
    const commits = parseGitLog(
      log(
        record("1".repeat(40), "Ada", "Tweak vscode readme (#547)", [
          "ui/apps/vscode-assistant/readme.md",
          "docs/getting-started.md",
        ]),
        record("2".repeat(40), "Ada", "Bump deps (#548)", ["pnpm-lock.yaml", "MODULE.bazel.lock"]),
        record("3".repeat(40), "Ada", "Add licenses to About (#539)", [
          "THIRD-PARTY-DEPENDENCIES.md",
          "ui/apps/desktop-assistant/src-tauri/src/lib.rs",
        ]),
      ),
    );
    expect(filterUserFacing(commits).map((commit) => commit.subject)).toEqual([
      "Add licenses to About (#539)",
    ]);
  });

  it("keeps commits with no recorded files", () => {
    const commits = parseGitLog(`${RS}${"1".repeat(40)}${US}Ada${US}Fix a thing\n`);
    expect(commits[0].files).toEqual([]);
    expect(filterUserFacing(commits)).toHaveLength(1);
  });
});

describe("renderUserBody", () => {
  it("groups improvements before fixes using types and leading verbs", () => {
    const body = renderUserBody(
      parseGitLog(
        log(
          record("1".repeat(40), "Ada", "Fix diff viewer cache collisions (#550)"),
          record("2".repeat(40), "Bob", "Add third-party licenses to About (#539)"),
          record("3".repeat(40), "Cy", "fix: nightly ordering"),
          record("4".repeat(40), "Di", "perf: faster boot"),
          record("5".repeat(40), "Ev", "feat!: breaking thing"),
        ),
      ),
    );

    const idxImprovements = body.indexOf("### Improvements");
    const idxFixes = body.indexOf("### Fixes");
    expect(idxImprovements).toBeGreaterThanOrEqual(0);
    expect(idxImprovements).toBeLessThan(idxFixes);

    expect(body).toContain("- Add third-party licenses to About");
    expect(body).toContain("- faster boot");
    expect(body).toContain("- breaking thing **(breaking)**");
    expect(body).toContain("- Fix diff viewer cache collisions");
    expect(body).toContain("- nightly ordering");
    expect(body).not.toContain("(#");

    const fixesSection = body.slice(idxFixes);
    expect(fixesSection).toContain("Fix diff viewer cache collisions");
    expect(fixesSection).not.toContain("licenses to About");
  });

  it("reports when nothing user-facing remains", () => {
    const body = renderUserBody(parseGitLog(record("1".repeat(40), "Ada", "chore: tidy up")));
    expect(body).toBe("_No user-facing changes in this release._");
  });
});

describe("groupCommits", () => {
  const commits = parseGitLog(
    log(
      record("1".repeat(40), "Ada", "Add switcher (#101)"),
      record("2".repeat(40), "Bob", "fix: nightly ordering (#102)"),
      record("3".repeat(40), "Di", "chore: tidy up (#103)"),
    ),
  );

  it("renders user-facing markdown without hashes, authors, links, or tickets", () => {
    const { release } = groupCommits(commits, {
      repository: REPO,
      prevTag: "desktop/v0.3.21",
      headSha: HEAD,
    });

    expect(release).toContain("## Changes since 0.3.21");
    expect(release).toContain("- Add switcher");
    expect(release).toContain("- nightly ordering");
    expect(release).not.toContain("(#");
    expect(release).not.toContain("tidy up");
    expect(release).not.toContain("https://");
    expect(release).not.toContain("Ada");
    expect(release).not.toContain("111111111111");
  });

  it("handles the first release (no previous tag)", () => {
    const { release, slack } = groupCommits(commits, {
      repository: REPO,
      prevTag: null,
      headSha: HEAD,
    });
    expect(release).toBe("_Initial release._\n");
    expect(slack).toBe("• Initial release");
  });

  it("reports when there are no commits", () => {
    const { release, slack } = groupCommits([], {
      repository: REPO,
      prevTag: "vscode-assistant/v4.2.0",
      headSha: HEAD,
    });
    expect(release).toContain("## Changes since 4.2.0");
    expect(release).toContain("_No user-facing changes");
    expect(slack).toContain("Full diff");
  });

  it("truncates the Slack variant and appends a diff link", () => {
    const many = parseGitLog(
      log(
        ...Array.from({ length: 10 }, (_, i) =>
          record(String(i).repeat(40).slice(0, 40), "Ada", `feat: commit ${i}`),
        ),
      ),
    );
    const { slack } = groupCommits(many, {
      repository: REPO,
      prevTag: "desktop/v0.3.21",
      headSha: HEAD,
    });
    const bulletCount = slack.split("\n").filter((line) => line.startsWith("•")).length;
    expect(bulletCount).toBe(SLACK_CHANGELOG_COMMIT_LIMIT);
    expect(slack).toContain(`${10 - SLACK_CHANGELOG_COMMIT_LIMIT} more · `);
    expect(slack).not.toContain("commit 0");
    expect(slack).toContain("commit 9");
    expect(slack).toContain("Full diff");
  });

  it("links pull requests, shows authors, and escapes mrkdwn in Slack", () => {
    const tricky = parseGitLog(
      record("6".repeat(40), "Ada & Bob", "fix: guard <Suspense> & <slot> fallbacks (#471)"),
    );
    const { slack } = groupCommits(tricky, {
      repository: REPO,
      prevTag: "desktop/v0.3.21",
      headSha: HEAD,
    });

    expect(slack).toContain("• fix: guard &lt;Suspense&gt; &amp; &lt;slot&gt; fallbacks");
    expect(slack).toContain(`(<https://github.com/${REPO}/pull/471|#471>)`);
    expect(slack).toContain("— Ada &amp; Bob");
    expect(slack).not.toContain("/commit/");
    // Trusted pull-request and diff links keep raw <url|label> syntax.
    expect(slack).toContain(`<https://github.com/${REPO}/compare/desktop/v0.3.21...${HEAD}|`);
  });
});

describe("renderChangelogFile", () => {
  it("assembles versioned sections newest first with a Preview label", () => {
    const content = renderChangelogFile([
      {
        version: "1.3.2",
        preview: true,
        date: "2026-07-30",
        body: "### Improvements\n\n- Add switcher (#101)",
      },
      {
        version: "1.2.0",
        preview: false,
        date: "2026-07-01",
        body: "### Fixes\n\n- Fix crash (#90)",
      },
      { version: "1.0.0", preview: false, date: "2026-06-01", body: "_Initial release._" },
    ]);

    expect(content.startsWith("# Changelog\n")).toBe(true);
    const idxPreview = content.indexOf("## 1.3.2 (Preview) — 2026-07-30");
    const idxStable = content.indexOf("## 1.2.0 — 2026-07-01");
    const idxInitial = content.indexOf("## 1.0.0 — 2026-06-01");
    expect(idxPreview).toBeGreaterThan(0);
    expect(idxPreview).toBeLessThan(idxStable);
    expect(idxStable).toBeLessThan(idxInitial);
    expect(content).toContain("- Add switcher (#101)");
    expect(content).toContain("_Initial release._");
    expect(content.endsWith("\n")).toBe(true);
  });
});
