import { type ACPAgentServerConfig } from "@camber/rpc";

// Full SemVer: version core with optional dot-separated prerelease and build
// metadata, both of which may contain hyphens (1.2.3-beta-1+build.2).
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;

const PATH_SEGMENT_VERSION = new RegExp(`/v?(${SEMVER})/`);
const BASENAME_VERSION = new RegExp(`(?:^|[-_])v?(${SEMVER})$`);
const PATH_REFERENCE_VERSION = new RegExp(`(?:^|[/-])v?(${SEMVER})(?:/|$)`);
// Superset of the archive types the helper can install
// (acpproxy/registry_binary.go: zip, tar.gz, tgz, tar.bz2, tbz2).
const ARCHIVE_EXTENSION = /\.(?:tar\.(?:gz|xz|bz2)|tgz|tbz2|zip|gz|xz|dmg|exe)$/i;

// Platform words that archive file names append after the version. Registry
// platform keys spell architectures differently than the file names they
// point at (darwin-aarch64 key vs pool-darwin-arm64.tar.gz), so the suffix is
// stripped token-wise rather than by matching the literal key.
const PLATFORM_TOKENS = new Set([
  "darwin",
  "macos",
  "osx",
  "apple",
  "linux",
  "windows",
  "win32",
  "win",
  "pc",
  "msvc",
  "gnu",
  "musl",
  "unknown",
  "universal",
  "arm64",
  "aarch64",
  "amd64",
  "x86_64",
  "x64",
  "x86",
  "i686",
]);

// Unknown/dev/prerelease versions are deliberately not ordered: they can use
// a different release track from the registry. Build metadata does not order releases.
export function isOlderStableVersion(left: string | null, right: string | null): boolean {
  const stable = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/;
  const a = left?.match(stable)?.slice(1).map(Number);
  const b = right?.match(stable)?.slice(1).map(Number);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function stripPlatformSuffix(name: string): string {
  const tokens = name.split("-");
  while (tokens.length > 0 && PLATFORM_TOKENS.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  return tokens.join("-");
}

export function versionFromConfig(config: ACPAgentServerConfig | undefined): string | null {
  if (!config) return null;
  const binaryDistributions = Object.entries(config.binary ?? {}) as Array<
    [string, { archive?: string }]
  >;
  const binaryVersion = binaryDistributions
    .map(([platform, distribution]) =>
      distribution.archive ? versionFromArchiveReference(distribution.archive, platform) : null,
    )
    .find((version): version is string => version != null);
  if (binaryVersion) return binaryVersion;

  return (
    ((config.args ?? []) as string[])
      .map(versionFromPackageReference)
      .find((version): version is string => version != null) ?? null
  );
}

export function versionFromArchiveReference(archive: string, platform: string): string | null {
  // Query strings and fragments (signed download URLs) are not part of the
  // archive path and could carry version-like sequences of their own.
  const archivePath = archive.split(/[?#]/, 1)[0];

  // Registry archives usually keep the version in its own path segment
  // (…/v1.0.5/pool-darwin-arm64.tar.gz), where the trailing slash makes the
  // full SemVer grammar unambiguous.
  const segmentVersion = archivePath.match(PATH_SEGMENT_VERSION);
  if (segmentVersion?.[1]) return segmentVersion[1];

  // Otherwise the version is embedded in the file name, where a hyphenated
  // prerelease is indistinguishable from the platform suffix
  // (…-v1.2.3-darwin-arm64.tar.gz); strip the extension, the literal platform
  // key, and any remaining platform tokens so the trailing SemVer can be
  // matched in full.
  const basename = archivePath.split("/").pop() ?? archivePath;
  const strippedName = stripPlatformSuffix(
    basename.replace(ARCHIVE_EXTENSION, "").replace(platform, ""),
  ).replace(/[-._]+$/, "");
  return strippedName.match(BASENAME_VERSION)?.[1] ?? null;
}

export function versionFromPackageReference(value: string): string | null {
  const pathVersion = value.match(PATH_REFERENCE_VERSION);
  if (pathVersion?.[1]) return pathVersion[1];

  const pypiVersion = value.match(/^[^=\s]+==(.+)$/);
  if (pypiVersion?.[1]) return pypiVersion[1];

  if (value.startsWith("@")) {
    const scopedVersion = value.match(/^@[^/]+\/[^@]+@(.+)$/);
    return scopedVersion?.[1] ?? null;
  }

  const packageVersion = value.match(/^[^@/]+@(.+)$/);
  return packageVersion?.[1] ?? null;
}
