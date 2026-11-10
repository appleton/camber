import { execFileSync } from "node:child_process";

import type { ReleaseProduct } from "./release-plan.js";

export const RELEASE_LINEAGE_KIND = "camber-release-lineage";
export const RELEASE_LINEAGE_SCHEMA = 1;

const NUMERIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SOURCE_SHA = /^[0-9a-f]{40,64}$/u;
const TAG_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export interface ReleaseTagMetadata {
  kind: typeof RELEASE_LINEAGE_KIND;
  schema: typeof RELEASE_LINEAGE_SCHEMA;
  product: ReleaseProduct;
  tagPrefix: string;
  destination: string;
  version: string;
  sourceSha: string;
  displayName?: string;
}

export interface ReleaseTagRecord {
  tag: string;
  objectType: string;
  annotation: string | null;
  metadata: ReleaseTagMetadata | null;
}

export interface LineageAssociation {
  product: ReleaseProduct;
  tagPrefix: string;
  destination: string;
}

export function validateTagPrefix(tagPrefix: string): string {
  if (!TAG_PREFIX.test(tagPrefix)) {
    throw new Error(
      `Tag prefix ${JSON.stringify(tagPrefix)} must be 1-64 lowercase letters, digits, or hyphens, without a trailing hyphen`,
    );
  }
  return tagPrefix;
}

export function releaseTag(tagPrefix: string, version: string): string {
  validateTagPrefix(tagPrefix);
  if (!NUMERIC_VERSION.test(version)) {
    throw new Error(`Invalid numeric release version: ${version}`);
  }
  return `${tagPrefix}/v${version}`;
}

export function versionFromReleaseTag(tagPrefix: string, tag: string): string | null {
  validateTagPrefix(tagPrefix);
  const prefix = `${tagPrefix}/v`;
  if (!tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  return NUMERIC_VERSION.test(version) ? version : null;
}

function validateMetadata(value: unknown): ReleaseTagMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("Release-lineage metadata must be an object");
  }
  const metadata = value as Record<string, unknown>;
  if (metadata.kind !== RELEASE_LINEAGE_KIND || metadata.schema !== RELEASE_LINEAGE_SCHEMA) {
    throw new Error("Unsupported release-lineage metadata kind or schema");
  }
  if (metadata.product !== "desktop") {
    throw new Error(`Unsupported release product in tag metadata: ${metadata.product}`);
  }
  if (typeof metadata.tagPrefix !== "string") {
    throw new Error("Release tag prefix must be a string");
  }
  validateTagPrefix(metadata.tagPrefix);
  if (
    typeof metadata.destination !== "string" ||
    metadata.destination.length === 0 ||
    metadata.destination.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(metadata.destination)
  ) {
    throw new Error("Release destination must be a non-empty, single-line value");
  }
  if (typeof metadata.version !== "string" || !NUMERIC_VERSION.test(metadata.version)) {
    throw new Error(`Invalid version in tag metadata: ${String(metadata.version)}`);
  }
  if (typeof metadata.sourceSha !== "string" || !SOURCE_SHA.test(metadata.sourceSha)) {
    throw new Error(`Invalid source SHA in tag metadata: ${String(metadata.sourceSha)}`);
  }
  if (
    metadata.displayName !== undefined &&
    (typeof metadata.displayName !== "string" ||
      metadata.displayName.trim() === "" ||
      /[\u0000-\u001f\u007f]/u.test(metadata.displayName))
  ) {
    throw new Error("Release display name must be a non-empty, single-line value when present");
  }
  return {
    kind: RELEASE_LINEAGE_KIND,
    schema: RELEASE_LINEAGE_SCHEMA,
    product: metadata.product,
    tagPrefix: metadata.tagPrefix,
    destination: metadata.destination,
    version: metadata.version,
    sourceSha: metadata.sourceSha,
    ...(typeof metadata.displayName === "string" ? { displayName: metadata.displayName } : {}),
  };
}

export function createReleaseTagMetadata(input: {
  product: ReleaseProduct;
  tagPrefix: string;
  destination: string;
  version: string;
  sourceSha: string;
  displayName?: string;
}): ReleaseTagMetadata {
  return validateMetadata({
    kind: RELEASE_LINEAGE_KIND,
    schema: RELEASE_LINEAGE_SCHEMA,
    ...input,
  });
}

export function serializeReleaseTagMetadata(metadata: ReleaseTagMetadata): string {
  return JSON.stringify(validateMetadata(metadata));
}

export function parseReleaseTagMetadata(annotation: string): ReleaseTagMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(annotation.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  if ((value as { kind?: unknown }).kind !== RELEASE_LINEAGE_KIND) return null;
  return validateMetadata(value);
}

export function assertLineageAssociation(
  metadata: ReleaseTagMetadata,
  expected: LineageAssociation,
): void {
  if (metadata.product !== expected.product) {
    throw new Error(
      `Tag lineage ${expected.tagPrefix} belongs to ${metadata.product}, not ${expected.product}`,
    );
  }
  if (metadata.tagPrefix !== expected.tagPrefix) {
    throw new Error(
      `Tag metadata declares prefix ${metadata.tagPrefix}, expected ${expected.tagPrefix}`,
    );
  }
  if (metadata.destination !== expected.destination) {
    throw new Error(
      `Tag lineage ${expected.tagPrefix} is bound to ${metadata.destination}, not ${expected.destination}`,
    );
  }
}

export function assertVersionTagMetadata(
  metadata: ReleaseTagMetadata,
  expected: LineageAssociation & {
    version: string;
    sourceSha: string;
    displayName?: string;
  },
): void {
  assertLineageAssociation(metadata, expected);
  if (metadata.version !== expected.version) {
    throw new Error(`Tag metadata version ${metadata.version} does not match ${expected.version}`);
  }
  if (metadata.sourceSha !== expected.sourceSha) {
    throw new Error(
      `Tag metadata source ${metadata.sourceSha} does not match ${expected.sourceSha}`,
    );
  }
  if (expected.displayName !== undefined && metadata.displayName !== expected.displayName) {
    throw new Error(
      `Tag metadata display name ${JSON.stringify(metadata.displayName)} does not match ${JSON.stringify(expected.displayName)}`,
    );
  }
}

export function assertDestinationHasSinglePrefix(
  records: Array<{ tag: string; metadata: ReleaseTagMetadata }>,
  expected: LineageAssociation,
): void {
  const conflict = records.find(
    ({ metadata }) =>
      metadata.product === expected.product &&
      metadata.destination === expected.destination &&
      metadata.tagPrefix !== expected.tagPrefix,
  );
  if (conflict) {
    throw new Error(
      `${expected.destination} is already bound to tag prefix ${conflict.metadata.tagPrefix} by ${conflict.tag}`,
    );
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function readReleaseTagRecord(repoRoot: string, tag: string): ReleaseTagRecord {
  const objectType = git(repoRoot, ["cat-file", "-t", `refs/tags/${tag}`]);
  if (objectType !== "tag") {
    return { tag, objectType, annotation: null, metadata: null };
  }
  const annotation = git(repoRoot, [
    "for-each-ref",
    "--format=%(contents:subject)",
    `refs/tags/${tag}`,
  ]);
  return {
    tag,
    objectType,
    annotation,
    metadata: parseReleaseTagMetadata(annotation),
  };
}

export function listReleaseTagMetadata(
  repoRoot: string,
  strictTagPrefix: string,
): Array<{ tag: string; metadata: ReleaseTagMetadata }> {
  const output = execFileSync(
    "git",
    [
      "for-each-ref",
      "--format=%(refname:short)%00%(objecttype)%00%(contents:subject)",
      "refs/tags",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [tag, objectType, annotation] = line.split("\0");
      if (!tag || objectType !== "tag" || annotation === undefined) return [];
      try {
        const metadata = parseReleaseTagMetadata(annotation);
        if (!metadata) return [];
        const expectedTag = releaseTag(metadata.tagPrefix, metadata.version);
        if (tag !== expectedTag) {
          throw new Error(`Tag ${tag} metadata describes ${expectedTag}`);
        }
        const sourceSha = git(repoRoot, ["rev-parse", `${tag}^{commit}`]);
        if (metadata.sourceSha !== sourceSha) {
          throw new Error(
            `Tag ${tag} metadata source ${metadata.sourceSha} does not match ${sourceSha}`,
          );
        }
        return [{ tag, metadata }];
      } catch (error) {
        if (tag.startsWith(`${strictTagPrefix}/v`)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `Ignoring invalid release-lineage annotation on unrelated tag ${tag}: ${message}`,
        );
        return [];
      }
    });
}
