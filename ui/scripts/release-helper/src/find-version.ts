#!/usr/bin/env tsx

import chalk from "chalk";
import { execFileSync } from "child_process";
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import semver from "semver";
import { fileURLToPath } from "url";
import yaml from "yaml";

import {
  collectUserBody,
  generateChangelog,
  renderChangelogFile,
  type Changelog,
  type ChangelogFileSection,
} from "./changelog.js";
import {
  assertDestinationHasSinglePrefix,
  assertVersionTagMetadata,
  createReleaseTagMetadata,
  listReleaseTagMetadata,
  readReleaseTagRecord,
  releaseTag,
  serializeReleaseTagMetadata,
  validateTagPrefix,
  versionFromReleaseTag,
  type LineageAssociation,
} from "./release-lineage.js";
import {
  calculateCoordinatedVersion,
  calculateVersionPlan,
  validNumericVersions,
  versionMatchesChannel,
  type ReleaseBump,
  type ReleaseChannel,
  type ReleaseProduct,
} from "./release-plan.js";

interface ProjectConfig {
  name: string;
  tag: string;
  dirs: string[];
}

interface ProjectsConfig {
  projects: ProjectConfig[];
}

class VersionFinder {
  private repoRoot: string;
  private projectsConfig: ProjectsConfig;

  constructor() {
    this.repoRoot = this.findRepoRoot();
    const projectsPath = join(process.cwd(), "projects.yml");
    const projectsContent = readFileSync(projectsPath, "utf8");
    this.projectsConfig = yaml.parse(projectsContent);
  }

  private findRepoRoot(): string {
    let currentDir = process.cwd();
    while (currentDir !== "/") {
      if (existsSync(join(currentDir, ".git"))) {
        return currentDir;
      }
      currentDir = dirname(currentDir);
    }
    throw new Error("Could not find git repository root");
  }

  getProjectTags(projectName: string, tagPrefixOverride?: string): string[] {
    const project = this.projectsConfig.projects.find((p) => p.name === projectName);
    if (!project) {
      throw new Error(`Project ${projectName} not found in projects.yml`);
    }

    const tagPrefix = validateTagPrefix(tagPrefixOverride ?? project.tag);
    const output = execFileSync("git", ["tag", "-l", `${tagPrefix}/v*`], {
      cwd: this.repoRoot,
      encoding: "utf8",
    });

    const tags = output.trim().split("\n").filter(Boolean);
    return tags.sort((a, b) => {
      const versionA = a.replace(`${tagPrefix}/v`, "");
      const versionB = b.replace(`${tagPrefix}/v`, "");
      if (!semver.valid(versionA) || !semver.valid(versionB)) {
        return -a.localeCompare(b);
      }
      return -semver.compare(versionA, versionB);
    });
  }

  async getAvailableVersions(projectName: string, tagPrefixOverride?: string): Promise<string[]> {
    const project = this.projectsConfig.projects.find((p) => p.name === projectName);
    if (!project) {
      throw new Error(`Project ${projectName} not found in projects.yml`);
    }

    const tagPrefix = validateTagPrefix(tagPrefixOverride ?? project.tag);
    const prefix = `${tagPrefix}/v`;
    const versions = this.getProjectTags(projectName, tagPrefix)
      .filter((tag) => tag.startsWith(prefix))
      .map((tag) => tag.slice(prefix.length));

    return versions;
  }

  getRepoRoot(): string {
    return this.repoRoot;
  }

  getProject(projectName: string): ProjectConfig {
    const project = this.projectsConfig.projects.find((p) => p.name === projectName);
    if (!project) {
      throw new Error(`Project ${projectName} not found in projects.yml`);
    }
    return project;
  }

  getProjects(): ProjectConfig[] {
    return this.projectsConfig.projects;
  }

  // Latest released version on a given channel (stable | nightly), used both to
  // seed the next nightly base and to find the previous tag for a changelog.
  async findPreviousChannelVersion(
    projectName: string,
    channel: Channel,
    tagPrefixOverride?: string,
  ): Promise<string | null> {
    const versions = await this.getAvailableVersions(projectName, tagPrefixOverride);
    return versions.find((version) => versionMatchesChannel(version, channel)) ?? null;
  }
}

export type Channel = ReleaseChannel;

export const versionFinder = new VersionFinder();

const program = new Command();

program
  .name("find-version")
  .description("Plan and inspect product release versions")
  .version("1.0.0", "-V, --cli-version");

async function printPreviousChannelVersion(
  project: string,
  channel: Channel,
  tagPrefix?: string,
): Promise<void> {
  try {
    const version = await versionFinder.findPreviousChannelVersion(project, channel, tagPrefix);
    if (version) {
      console.log(version);
    } else {
      console.error(chalk.red(`No ${channel} version found for ${project}`));
      process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

async function buildChangelog(
  project: string,
  options: {
    prev?: string;
    channel?: string;
    head: string;
    repository: string;
    slack?: boolean;
    tagPrefix?: string;
  },
): Promise<Changelog> {
  const projectConfig = versionFinder.getProject(project);
  const tagPrefix = validateTagPrefix(options.tagPrefix ?? projectConfig.tag);
  const headSha = execFileSync("git", ["rev-parse", "--verify", `${options.head}^{commit}`], {
    cwd: versionFinder.getRepoRoot(),
    encoding: "utf8",
  }).trim();

  let prevTag: string | null = null;
  if (options.prev) {
    prevTag = options.prev.includes("/")
      ? options.prev
      : releaseTag(tagPrefix, options.prev.replace(/^v/, ""));
  } else if (options.channel) {
    const prevVersion = await versionFinder.findPreviousChannelVersion(
      project,
      options.channel as Channel,
      tagPrefix,
    );
    prevTag = prevVersion ? releaseTag(tagPrefix, prevVersion) : null;
  }

  return generateChangelog({
    repoRoot: versionFinder.getRepoRoot(),
    dirs: projectConfig.dirs,
    prevTag,
    headSha,
    repository: options.repository,
  });
}

/** Default stamped-changelog destinations, relative to the repository root. */
const CHANGELOG_PATHS: Record<string, string> = {
  vscode: "ui/apps/vscode-assistant/CHANGELOG.md",
  desktop: "ui/apps/desktop-assistant/CHANGELOG.md",
};

/** The first version retained in product changelog history. */
const INITIAL_CHANGELOG_VERSION = "1.0.0";

/**
 * Regenerate a product CHANGELOG.md from its release tag lineage: a top
 * section for the version being built, then per-release history sections.
 * Nightly builds itemize every release since 1.0.0 — one Preview-labelled
 * section per nightly, each diffed against its immediate predecessor — so
 * preview users can follow what each build changed. Stable builds keep a
 * stable-only history: the nightlies between two stables roll up into the
 * newer stable's section, answering "what changed since the build most users
 * run".
 */
async function buildChangelogFile(
  project: string,
  options: {
    version: string;
    head: string;
    tagPrefix?: string;
    maxReleases: number;
  },
): Promise<string> {
  const projectConfig = versionFinder.getProject(project);
  const tagPrefix = validateTagPrefix(options.tagPrefix ?? projectConfig.tag);
  const repoRoot = versionFinder.getRepoRoot();
  const dirs = projectConfig.dirs;
  const headSha = git(["rev-parse", "--verify", `${options.head}^{commit}`]);
  const version = options.version;
  if (!versionMatchesChannel(version, "stable") && !versionMatchesChannel(version, "nightly")) {
    throw new Error(`Version ${version} must be numeric major.minor.patch`);
  }
  const preview = versionMatchesChannel(version, "nightly");

  const commitDate = (ref: string): string => git(["log", "-1", "--format=%as", ref]);
  const bodyFor = (prevVersion: string | null, rangeHead: string): string =>
    collectUserBody({
      repoRoot,
      dirs,
      prevTag: prevVersion ? releaseTag(tagPrefix, prevVersion) : null,
      headSha: rangeHead,
    });

  // Newest-first earlier releases; a resumed build's own tag is excluded.
  const earlier = validNumericVersions(
    await versionFinder.getAvailableVersions(project, tagPrefix),
  ).filter(
    (candidate) =>
      semver.gte(candidate, INITIAL_CHANGELOG_VERSION) && semver.lt(candidate, version),
  );
  const stableEarlier = earlier.filter((candidate) => versionMatchesChannel(candidate, "stable"));

  // Nightly changelogs itemize the full lineage; stable changelogs list only
  // stable releases, rolling the nightlies in between into the next stable.
  const history = preview ? earlier : stableEarlier;

  const sections: ChangelogFileSection[] = [
    {
      version,
      preview,
      date: commitDate(headSha),
      body: bodyFor(history[0] ?? earlier[0] ?? null, headSha),
    },
  ];

  for (const [index, historyVersion] of history
    .slice(0, Math.max(0, options.maxReleases - 1))
    .entries()) {
    const tag = releaseTag(tagPrefix, historyVersion);
    const tagSha = resolveTagSha(tag);
    if (!tagSha) {
      throw new Error(`Release tag ${tag} does not resolve to a commit`);
    }
    // Each section diffs against its predecessor in the same history list.
    // The oldest listed release falls back to the newest earlier tag in the
    // lineage (mirroring the planner's channel-bootstrap baseline) so it does
    // not replay the whole monorepo history.
    const prevVersion =
      history[index + 1] ??
      earlier.filter((candidate) => semver.lt(candidate, historyVersion))[0] ??
      null;
    sections.push({
      version: historyVersion,
      preview: versionMatchesChannel(historyVersion, "nightly"),
      date: commitDate(tagSha),
      body: bodyFor(prevVersion, tagSha),
    });
  }

  return renderChangelogFile(sections);
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: versionFinder.getRepoRoot(),
    encoding: "utf8",
  }).trim();
}

function isAncestor(ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: versionFinder.getRepoRoot(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function resolveTagSha(tag: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], {
      cwd: versionFinder.getRepoRoot(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function isOwnedPath(path: string, dirs: string[]): boolean {
  return dirs.some((dir) => path === dir || path.startsWith(`${dir.replace(/\/$/u, "")}/`));
}

interface ReleasePlanOptions {
  version?: string;
  syncVersions: boolean;
  scheduled: boolean;
  skipIfNoChanges: boolean;
  dryRun: boolean;
  mainRef: string;
  destination: string;
  displayName?: string;
  tagPrefix?: string;
  createLineage: boolean;
  allowDivergentRef: boolean;
  ignoreImplicitRecovery?: boolean;
}

interface ProductReleasePlan {
  product: ReleaseProduct;
  channel: ReleaseChannel;
  sourceSha: string;
  scheduled: boolean;
  syncVersions: boolean;
  action: "release" | "resume" | "skip";
  reason: string | null;
  version?: string;
  implicitRecovery?: boolean;
  [key: string]: unknown;
}

interface HelperReleasePlan {
  action: "release" | "resume" | "reuse";
  version: string;
  tag: string;
  tagAnnotation: string;
  sourceSha: string;
  previousTag: string | null;
  published: boolean;
}

function validateManagedLineage(input: {
  product: ReleaseProduct;
  tagPrefix: string;
  defaultTagPrefix: string;
  destination: string;
  projectTags: string[];
  createLineage: boolean;
  scheduled: boolean;
}): boolean {
  const {
    product,
    tagPrefix,
    defaultTagPrefix,
    destination,
    projectTags,
    createLineage,
    scheduled,
  } = input;
  if (!destination || /[\r\n]/u.test(destination)) {
    throw new Error("Managed release lineages require a non-empty, single-line --destination");
  }

  const association: LineageAssociation = { product, tagPrefix, destination };
  assertDestinationHasSinglePrefix(
    listReleaseTagMetadata(versionFinder.getRepoRoot(), tagPrefix),
    association,
  );

  const records = projectTags.flatMap((tag) => {
    const version = versionFromReleaseTag(tagPrefix, tag);
    if (!version) {
      if (tagPrefix !== defaultTagPrefix) {
        throw new Error(
          `Custom lineage ${tagPrefix} contains nonnumeric tag ${tag}; choose a clean prefix`,
        );
      }
      return [];
    }
    const record = readReleaseTagRecord(versionFinder.getRepoRoot(), tag);
    if (record.metadata) {
      const sourceSha = resolveTagSha(tag);
      if (!sourceSha) throw new Error(`Could not resolve ${tag} to a commit`);
      assertVersionTagMetadata(record.metadata, {
        ...association,
        version,
        sourceSha,
      });
    }
    return [{ tag, version, record }];
  });
  const bound = records.filter(({ record }) => record.metadata !== null);

  if (tagPrefix !== defaultTagPrefix && records.some(({ record }) => !record.metadata)) {
    throw new Error(
      `Custom lineage ${tagPrefix} contains a lightweight or unrecognized tag; choose a clean prefix`,
    );
  }
  if (bound.length > 0) {
    const firstBoundVersion = bound.map(({ version }) => version).sort(semver.compare)[0];
    const unboundAfterStart = records.find(
      ({ version, record }) =>
        !record.metadata &&
        firstBoundVersion !== undefined &&
        semver.gte(version, firstBoundVersion),
    );
    if (unboundAfterStart) {
      throw new Error(
        `Tag ${unboundAfterStart.tag} is not annotated with the established ${tagPrefix} lineage`,
      );
    }
    return true;
  }

  // Scheduled runs never bind a lineage; the caller skips them until a manual
  // bootstrap has created the first annotated tag. Lightweight tags do not
  // count as bound.
  if (scheduled) return false;
  if (!createLineage) {
    throw new Error(
      `Tag lineage ${tagPrefix} is not bound; rerun its first release with --create-lineage and an exact --version`,
    );
  }
  return false;
}

function buildReleasePlan(
  product: ReleaseProduct,
  channel: ReleaseChannel,
  ref: string,
  bump: ReleaseBump,
  options: ReleasePlanOptions,
): ProductReleasePlan {
  const sourceSha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  git(["rev-parse", "--verify", `${options.mainRef}^{commit}`]);
  if (!options.allowDivergentRef && !isAncestor(sourceSha, options.mainRef)) {
    throw new Error(`Release source ${sourceSha} is not an ancestor of ${options.mainRef}`);
  }

  const project = versionFinder.getProject(product);
  const defaultTagPrefix = validateTagPrefix(project.tag);
  const tagPrefix = validateTagPrefix(options.tagPrefix ?? defaultTagPrefix);
  const managedLineage = options.tagPrefix !== undefined || options.createLineage;
  const customLineage = tagPrefix !== defaultTagPrefix;
  if (customLineage && options.scheduled) {
    throw new Error("Scheduled releases must use the configured product tag prefix");
  }
  if (options.createLineage && options.scheduled) {
    throw new Error("Scheduled releases cannot create or adopt a tag lineage");
  }

  const projectTags = versionFinder.getProjectTags(product, tagPrefix);
  const lineageBound = managedLineage
    ? validateManagedLineage({
        product,
        tagPrefix,
        defaultTagPrefix,
        destination: options.destination,
        projectTags,
        createLineage: options.createLineage,
        scheduled: options.scheduled,
      })
    : false;
  if (managedLineage && !lineageBound && !options.scheduled && !options.version) {
    throw new Error(`The first ${tagPrefix} release requires an exact --version`);
  }
  if (managedLineage && !lineageBound && options.scheduled) {
    return {
      product,
      channel,
      tagPrefix,
      sourceSha,
      dryRun: options.dryRun,
      scheduled: true,
      syncVersions: false,
      action: "skip",
      reason:
        projectTags.length === 0
          ? `No ${product} tags exist; bootstrap the first release manually with --version`
          : `Tag lineage ${tagPrefix} is not bound; bootstrap it manually with an exact --version`,
    };
  }

  const projectVersions = validNumericVersions(
    projectTags.flatMap((tag) => versionFromReleaseTag(tagPrefix, tag) ?? []),
  );
  const latestTag = projectVersions[0] ? releaseTag(tagPrefix, projectVersions[0]) : null;

  if (projectVersions.length === 0 && !options.version && options.scheduled) {
    return {
      product,
      channel,
      tagPrefix,
      sourceSha,
      dryRun: options.dryRun,
      scheduled: true,
      syncVersions: false,
      action: "skip",
      reason: `No ${product} tags exist; bootstrap the first release manually with --version`,
    };
  }

  const syncVersions = options.scheduled || customLineage ? false : options.syncVersions;
  const allProductVersions = syncVersions
    ? validNumericVersions(
        versionFinder
          .getProjects()
          .flatMap(({ name, tag }) =>
            versionFinder
              .getProjectTags(name, tag)
              .flatMap((projectTag) => versionFromReleaseTag(tag, projectTag) ?? []),
          ),
      )
    : projectVersions;
  const implicitRecoveryVersion =
    options.version || options.scheduled || options.ignoreImplicitRecovery
      ? undefined
      : projectVersions.find((candidate) => {
          if (!versionMatchesChannel(candidate, channel)) return false;
          return resolveTagSha(releaseTag(tagPrefix, candidate)) === sourceSha;
        });
  const exactVersion = options.version ?? implicitRecoveryVersion;
  const exactVersionTagSha = exactVersion
    ? resolveTagSha(releaseTag(tagPrefix, exactVersion))
    : null;
  const versionPlan = calculateVersionPlan({
    product,
    channel,
    bump,
    exactVersion,
    exactVersionIsRecovery: exactVersionTagSha !== null,
    syncVersions,
    productVersions: projectVersions,
    allProductVersions,
  });
  const version = versionPlan.version;
  const tag = releaseTag(tagPrefix, version);
  const existingTagSha = exactVersion === version ? exactVersionTagSha : resolveTagSha(tag);
  if (existingTagSha && existingTagSha !== sourceSha) {
    throw new Error(`Tag ${tag} points to ${existingTagSha}, not planned source ${sourceSha}`);
  }
  if (options.version && !existingTagSha) {
    const latest = projectVersions[0];
    if (latest && semver.gte(latest, version)) {
      throw new Error(
        `Exact version ${version} is not newer than existing ${product} version ${latest} and has no resumable tag`,
      );
    }
  }

  const previousVersion = projectVersions.find(
    (candidate) => versionMatchesChannel(candidate, channel) && semver.lt(candidate, version),
  );
  const previousTag = previousVersion ? releaseTag(tagPrefix, previousVersion) : null;
  if (previousTag && !isAncestor(previousTag, sourceSha)) {
    throw new Error(`Previous ${channel} tag ${previousTag} is not an ancestor of ${sourceSha}`);
  }
  const previousAnyChannelVersion = projectVersions.find((candidate) =>
    semver.lt(candidate, version),
  );
  const changelogVersion = previousVersion ?? previousAnyChannelVersion;
  const changelogTag = changelogVersion ? releaseTag(tagPrefix, changelogVersion) : null;
  if (changelogTag && !isAncestor(changelogTag, sourceSha)) {
    throw new Error(`Changelog baseline tag ${changelogTag} is not an ancestor of ${sourceSha}`);
  }

  const changeBaseTag = options.scheduled && options.skipIfNoChanges ? latestTag : previousTag;
  if (changeBaseTag && !isAncestor(changeBaseTag, sourceSha)) {
    throw new Error(`Change baseline tag ${changeBaseTag} is not an ancestor of ${sourceSha}`);
  }
  const changedFiles = changeBaseTag
    ? git(["diff", "--name-only", `${changeBaseTag}..${sourceSha}`])
        .split("\n")
        .filter(Boolean)
    : [];
  const affectedFiles = changeBaseTag
    ? changedFiles.filter((path) => isOwnedPath(path, project.dirs))
    : project.dirs;
  const affected = changeBaseTag === null || affectedFiles.length > 0;
  const action = existingTagSha
    ? "resume"
    : options.scheduled && options.skipIfNoChanges && !affected
      ? "skip"
      : "release";
  const reason =
    action === "resume"
      ? `Tag ${tag} already reserves the planned source; resume incomplete publication`
      : action === "skip"
        ? `No ${product}-affecting changes since ${changeBaseTag}`
        : null;

  const tagMetadata = managedLineage
    ? createReleaseTagMetadata({
        product,
        tagPrefix,
        destination: options.destination,
        version,
        sourceSha,
        displayName: options.displayName,
      })
    : null;
  if (existingTagSha && tagMetadata) {
    const existingRecord = readReleaseTagRecord(versionFinder.getRepoRoot(), tag);
    if (!existingRecord.metadata) {
      throw new Error(`Existing tag ${tag} is not an annotated managed-lineage tag`);
    }
    assertVersionTagMetadata(existingRecord.metadata, {
      product,
      tagPrefix,
      destination: options.destination,
      version,
      sourceSha,
      displayName: options.displayName,
    });
  }

  return {
    product,
    channel,
    version,
    tag,
    tagPrefix,
    tagAnnotation: tagMetadata ? serializeReleaseTagMetadata(tagMetadata) : null,
    sourceSha,
    previousTag,
    changelogTag,
    latestTag,
    destination: options.destination,
    dryRun: options.dryRun,
    scheduled: options.scheduled,
    syncVersions,
    syncSuppressed: options.syncVersions && customLineage,
    productLocalCandidate: versionPlan.productLocalCandidate,
    crossProductMaximum: versionPlan.crossProductMaximum,
    alignmentFloor: versionPlan.alignmentFloor,
    exactVersion: versionPlan.exactVersion,
    implicitRecovery: implicitRecoveryVersion !== undefined,
    affected,
    affectedFiles,
    action,
    reason,
  };
}

interface CoordinatedReleaseOptions {
  products: ReleaseProduct[];
  bootstrapVersion?: string;
  channel: ReleaseChannel;
  ref: string;
  bump: ReleaseBump;
  mainRef: string;
  syncVersions: boolean;
  scheduled: boolean;
  skipIfNoChanges: boolean;
  vscodeDestination: string;
  vscodeDisplayName?: string;
  desktopDestination: string;
  vsDestination: string;
}

function isPublishedGithubRelease(tag: string): boolean {
  const args = ["release", "view", tag, "--json", "isDraft", "--jq", ".isDraft"];
  if (process.env.GITHUB_REPOSITORY) {
    args.push("--repo", process.env.GITHUB_REPOSITORY);
  }
  try {
    return (
      execFileSync("gh", args, {
        cwd: versionFinder.getRepoRoot(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "false"
    );
  } catch {
    // Missing releases, drafts, and lookup failures are all treated
    // conservatively as incomplete reservations.
    return false;
  }
}

function buildHelperReleasePlan(
  ref: string,
  mainRef: string,
  allowDivergentRef: boolean,
): HelperReleasePlan {
  const sourceSha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  git(["rev-parse", "--verify", `${mainRef}^{commit}`]);
  if (!allowDivergentRef && !isAncestor(sourceSha, mainRef)) {
    throw new Error(`Helper release source ${sourceSha} is not an ancestor of ${mainRef}`);
  }

  const records = git(["tag", "-l", "helper/v*"])
    .split("\n")
    .filter(Boolean)
    .flatMap((tag) => {
      const match = /^helper\/v(.+)$/u.exec(tag);
      const version = match?.[1];
      return version && semver.valid(version) ? [{ tag, version }] : [];
    })
    .sort((a, b) => semver.rcompare(a.version, b.version));
  const matchingSource = records.filter(({ tag }) => resolveTagSha(tag) === sourceSha);
  if (matchingSource.length > 1) {
    throw new Error(
      `Helper source ${sourceSha} already has multiple version tags: ${matchingSource
        .map(({ tag }) => tag)
        .join(", ")}`,
    );
  }

  const existing = matchingSource[0];
  const previousTag = records[0]?.tag ?? null;
  const version = existing?.version ?? semver.inc(records[0]?.version ?? "0.0.0", "patch");
  if (!version) throw new Error("Could not calculate the next helper patch version");
  const tag = existing?.tag ?? `helper/v${version}`;
  const published = existing ? isPublishedGithubRelease(tag) : false;
  const action = existing ? (published ? "reuse" : "resume") : "release";
  const tagAnnotation = JSON.stringify({
    schema: 1,
    kind: "camber-helper-release",
    tag,
    version,
    sourceSha,
  });

  return {
    action,
    version,
    tag,
    tagAnnotation,
    sourceSha,
    previousTag: existing
      ? (records.find(({ version: candidate }) => semver.lt(candidate, version))?.tag ?? null)
      : previousTag,
    published,
  };
}

function buildCoordinatedReleasePlan(options: CoordinatedReleaseOptions): object {
  if (options.products.length === 0) {
    throw new Error("Select at least one product for a coordinated release");
  }

  if (options.bootstrapVersion && options.scheduled) {
    throw new Error("Scheduled releases cannot bootstrap a tag lineage");
  }

  const plans = Object.fromEntries(
    options.products.map((product) => {
      const project = versionFinder.getProject(product);
      const destinations: Record<ReleaseProduct, string> = {
        vscode: options.vscodeDestination,
        desktop: options.desktopDestination,
        vs: options.vsDestination,
      };
      const destination = destinations[product];
      if (!destination) {
        throw new Error(`${product} coordinated releases require a destination`);
      }
      const common: ReleasePlanOptions = {
        version: options.bootstrapVersion,
        syncVersions: options.scheduled ? false : options.syncVersions,
        scheduled: options.scheduled,
        skipIfNoChanges: options.scheduled && options.skipIfNoChanges,
        dryRun: false,
        mainRef: options.mainRef,
        destination,
        displayName: product === "vscode" ? options.vscodeDisplayName : undefined,
        tagPrefix: project.tag,
        createLineage: Boolean(options.bootstrapVersion),
        allowDivergentRef: false,
      };
      const scheduledPlan = buildReleasePlan(
        product,
        options.channel,
        options.ref,
        options.bump,
        common,
      );

      if (!options.scheduled) {
        if (
          scheduledPlan.action === "resume" &&
          scheduledPlan.implicitRecovery === true &&
          typeof scheduledPlan.tag === "string" &&
          isPublishedGithubRelease(scheduledPlan.tag)
        ) {
          return [
            product,
            buildReleasePlan(product, options.channel, options.ref, options.bump, {
              ...common,
              ignoreImplicitRecovery: true,
            }),
          ];
        }
        return [product, scheduledPlan];
      }

      if (scheduledPlan.action !== "skip" || scheduledPlan.version === undefined) {
        return [product, scheduledPlan];
      }

      // A schedule retried after one product reserved its tag sees no new
      // changes for that product. Check the manual implicit-recovery path so
      // the coordinator can recover and reuse an unpublished reservation.
      const recoveryPlan = buildReleasePlan(product, options.channel, options.ref, options.bump, {
        ...common,
        scheduled: false,
        skipIfNoChanges: false,
      });
      return [
        product,
        recoveryPlan.action === "resume" &&
        recoveryPlan.implicitRecovery === true &&
        typeof recoveryPlan.tag === "string" &&
        !isPublishedGithubRelease(recoveryPlan.tag)
          ? recoveryPlan
          : scheduledPlan,
      ];
    }),
  ) as Partial<Record<ReleaseProduct, ProductReleasePlan>>;

  const candidates = options.products.map((product) => {
    const plan = plans[product];
    if (!plan) throw new Error(`Missing coordinated ${product} plan`);
    return {
      product,
      action: plan.action,
      version: plan.version,
      implicitRecovery: plan.implicitRecovery,
    };
  });
  const activeProducts = candidates
    .filter((candidate) => candidate.action !== "skip")
    .map((candidate) => candidate.product);
  const coordinated = options.syncVersions
    ? calculateCoordinatedVersion(candidates)
    : {
        version: null,
        activeProducts,
        recovering: candidates.some(
          (candidate) => candidate.action === "resume" && candidate.implicitRecovery === true,
        ),
      };
  const versions = Object.fromEntries(
    activeProducts.map((product) => {
      const candidate = plans[product]?.version;
      if (!candidate) throw new Error(`Active ${product} plan has no version`);
      return [product, coordinated.version ?? candidate];
    }),
  );
  const sourceShas = [
    ...new Set(options.products.map((product) => plans[product]?.sourceSha).filter(Boolean)),
  ];
  if (sourceShas.length !== 1) {
    throw new Error(`Coordinated product plans disagree on source SHA: ${sourceShas.join(", ")}`);
  }

  return {
    channel: options.channel,
    bootstrapVersion: options.bootstrapVersion ?? null,
    sourceSha: sourceShas[0],
    scheduled: options.scheduled,
    syncVersions: options.syncVersions,
    version: coordinated.version,
    versions,
    activeProducts: coordinated.activeProducts,
    recovering: coordinated.recovering,
    products: plans,
  };
}

program
  .command("prev-stable")
  .description("Find the previous stable-channel version for a project")
  .argument("<project>", "Project name (e.g., vscode, desktop)")
  .option("--tag-prefix <prefix>", "Override the project's release tag prefix")
  .action(async (project: string, options: { tagPrefix?: string }) => {
    await printPreviousChannelVersion(project, "stable", options.tagPrefix);
  });

program
  .command("prev-nightly")
  .description("Find the previous nightly (desktop) / pre-release (vscode) version for a project")
  .argument("<project>", "Project name (e.g., vscode, desktop)")
  .option("--tag-prefix <prefix>", "Override the project's release tag prefix")
  .action(async (project: string, options: { tagPrefix?: string }) => {
    await printPreviousChannelVersion(project, "nightly", options.tagPrefix);
  });

program
  .command("plan")
  .description("Create a validated, machine-readable product release plan")
  .argument("<product>", "Product to release (vscode|desktop|vs)")
  .requiredOption("--channel <channel>", "Release channel (stable|nightly)")
  .option("--ref <ref>", "Commit to release", "HEAD")
  .option("--bump <bump>", "Stable bump (patch|minor|major)", "patch")
  .option("--version <version>", "Exact bootstrap or recovery version")
  .option("--tag-prefix <prefix>", "Managed release tag prefix")
  .option("--create-lineage", "Create or explicitly adopt an unbound tag lineage", false)
  .option("--sync-versions", "Align against the highest version across all products", false)
  .option("--scheduled", "Apply scheduled-release bootstrap and alignment rules", false)
  .option("--skip-if-no-changes", "Skip a schedule with no product-affecting changes", false)
  .option("--dry-run", "Mark the plan as build-only", false)
  .option("--main-ref <ref>", "Public mainline ref used for ancestry validation", "origin/main")
  .option("--destination <identity>", "External destination identity", "")
  .option("--display-name <name>", "Mutable display name recorded for exact-version retries")
  .option(
    "--allow-divergent-ref",
    "Allow a source outside main (explicit operator recovery only)",
    false,
  )
  .action(
    async (
      product: string,
      options: ReleasePlanOptions & { channel: string; ref: string; bump: string },
    ) => {
      try {
        if (product !== "vscode" && product !== "desktop" && product !== "vs") {
          throw new Error(`Unknown release product: ${product}`);
        }
        if (options.channel !== "stable" && options.channel !== "nightly") {
          throw new Error(`Unknown release channel: ${options.channel}`);
        }
        if (options.bump !== "patch" && options.bump !== "minor" && options.bump !== "major") {
          throw new Error(`Unknown release bump: ${options.bump}`);
        }
        const plan = buildReleasePlan(product, options.channel, options.ref, options.bump, options);
        console.log(JSON.stringify(plan));
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    },
  );

program
  .command("plan-products")
  .description("Create one retry-safe version plan for coordinated product releases")
  .option(
    "--bootstrap-version <version>",
    "Create or resume a lineage at an exact migration version",
  )
  .requiredOption("--channel <channel>", "Release channel (stable|nightly)")
  .option("--ref <ref>", "Commit to release", "HEAD")
  .option("--bump <bump>", "Stable bump (patch|minor|major)", "patch")
  .option("--main-ref <ref>", "Public mainline ref used for ancestry validation", "origin/main")
  .option("--vscode", "Include VS Code", false)
  .option("--desktop", "Include Desktop", false)
  .option("--vs", "Include Visual Studio", false)
  .option("--sync-versions", "Give every active product one exact version", false)
  .option("--scheduled", "Apply scheduled-release recovery and bootstrap rules", false)
  .option("--skip-if-no-changes", "Exclude scheduled products with no owning-path changes", false)
  .option("--vscode-destination <identity>", "VS Code Marketplace extension identity", "")
  .option("--vscode-display-name <name>", "VS Code Marketplace display name")
  .option("--desktop-destination <identity>", "CrabNebula application identity", "")
  .option("--vs-destination <identity>", "Visual Studio Marketplace extension identity", "")
  .action(
    async (options: {
      bootstrapVersion?: string;
      channel: string;
      ref: string;
      bump: string;
      mainRef: string;
      vscode: boolean;
      desktop: boolean;
      vs: boolean;
      syncVersions: boolean;
      scheduled: boolean;
      skipIfNoChanges: boolean;
      vscodeDestination: string;
      vscodeDisplayName?: string;
      desktopDestination: string;
      vsDestination: string;
    }) => {
      try {
        if (options.channel !== "stable" && options.channel !== "nightly") {
          throw new Error(`Unknown release channel: ${options.channel}`);
        }
        if (options.bump !== "patch" && options.bump !== "minor" && options.bump !== "major") {
          throw new Error(`Unknown release bump: ${options.bump}`);
        }
        const products: ReleaseProduct[] = [];
        if (options.vscode) products.push("vscode");
        if (options.desktop) products.push("desktop");
        if (options.vs) products.push("vs");
        const plan = buildCoordinatedReleasePlan({
          products,
          bootstrapVersion: options.bootstrapVersion,
          channel: options.channel,
          ref: options.ref,
          bump: options.bump,
          mainRef: options.mainRef,
          syncVersions: options.syncVersions,
          scheduled: options.scheduled,
          skipIfNoChanges: options.skipIfNoChanges,
          vscodeDestination: options.vscodeDestination,
          vscodeDisplayName: options.vscodeDisplayName,
          desktopDestination: options.desktopDestination,
          vsDestination: options.vsDestination,
        });
        console.log(JSON.stringify(plan));
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    },
  );

program
  .command("plan-helper")
  .description("Create an independent patch-version plan for a permanent helper release")
  .option("--ref <ref>", "Commit to release", "HEAD")
  .option("--main-ref <ref>", "Public mainline ref used for ancestry validation", "origin/main")
  .option(
    "--allow-divergent-ref",
    "Allow a source outside main (explicit operator recovery only)",
    false,
  )
  .action((options: { ref: string; mainRef: string; allowDivergentRef: boolean }) => {
    try {
      console.log(
        JSON.stringify(
          buildHelperReleasePlan(options.ref, options.mainRef, options.allowDivergentRef),
        ),
      );
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

program
  .command("changelog")
  .description("Generate release notes from conventional commits, path-scoped to the app")
  .argument("<project>", "Project name (e.g., vscode, desktop)")
  .option("--prev <ref>", "Previous tag or version to diff against (overrides --channel discovery)")
  .option(
    "--channel <channel>",
    "Channel to auto-discover the previous release of (stable|nightly)",
  )
  .option("--tag-prefix <prefix>", "Override the project's release tag prefix")
  .option("--head <sha>", "Head commit to diff to", "HEAD")
  .option(
    "--repository <owner/repo>",
    "GitHub repository for commit/compare links",
    process.env.GITHUB_REPOSITORY || "appleton/camber",
  )
  .option("--slack", "Emit the truncated Slack variant instead of the release markdown", false)
  .action(
    async (
      project: string,
      options: {
        prev?: string;
        channel?: string;
        head: string;
        repository: string;
        slack?: boolean;
        tagPrefix?: string;
      },
    ) => {
      try {
        const changelog = await buildChangelog(project, options);
        console.log(options.slack ? changelog.slack : changelog.release);
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    },
  );

program
  .command("render-changelog")
  .description("Regenerate a product CHANGELOG.md from its release tag history")
  .argument("<project>", "Project name (e.g., vscode, desktop)")
  .requiredOption("--version <version>", "Numeric version being released (top section)")
  .option("--head <sha>", "Head commit for the top section", "HEAD")
  .option("--tag-prefix <prefix>", "Override the project's release tag prefix")
  .option("--max-releases <count>", "Maximum release sections to render", "20")
  .option("--out <path>", "Output path relative to the repo root (- for stdout)")
  .action(
    async (
      project: string,
      options: {
        version: string;
        head: string;
        tagPrefix?: string;
        maxReleases: string;
        out?: string;
      },
    ) => {
      try {
        const maxReleases = Number.parseInt(options.maxReleases, 10);
        if (!Number.isInteger(maxReleases) || maxReleases < 1) {
          throw new Error(`--max-releases must be a positive integer: ${options.maxReleases}`);
        }
        const content = await buildChangelogFile(project, { ...options, maxReleases });
        const outPath = options.out ?? CHANGELOG_PATHS[project];
        if (outPath === "-") {
          console.log(content);
          return;
        }
        if (!outPath) {
          throw new Error(`No default changelog path for ${project}; pass --out`);
        }
        const target = resolve(versionFinder.getRepoRoot(), outPath);
        writeFileSync(target, content);
        console.error(chalk.green(`Wrote ${outPath} for ${project} ${options.version}`));
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    },
  );

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  program.parse();
}
