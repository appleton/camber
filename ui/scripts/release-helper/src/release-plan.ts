import semver from "semver";

export type ReleaseProduct = "desktop";
export type ReleaseChannel = "stable" | "nightly";
export type ReleaseBump = "patch" | "minor" | "major";

export interface VersionPlanInput {
  product: ReleaseProduct;
  channel: ReleaseChannel;
  bump: ReleaseBump;
  exactVersion?: string;
  exactVersionIsRecovery?: boolean;
  syncVersions: boolean;
  productVersions: string[];
  allProductVersions: string[];
}

export interface VersionPlan {
  version: string;
  productLocalCandidate: string | null;
  crossProductMaximum: string | null;
  alignmentFloor: string | null;
  exactVersion: boolean;
}

function parseNumericVersion(version: string): semver.SemVer | null {
  const parsed = semver.parse(version);
  return parsed && parsed.prerelease.length === 0 && parsed.build.length === 0 ? parsed : null;
}

export function isNumericReleaseVersion(version: string): boolean {
  return parseNumericVersion(version) !== null;
}

export function versionMatchesChannel(version: string, channel: ReleaseChannel): boolean {
  const parsed = parseNumericVersion(version);
  if (!parsed) return false;
  return channel === "stable" ? parsed.minor % 2 === 0 : parsed.minor % 2 === 1;
}

export function validNumericVersions(versions: string[]): string[] {
  return [...new Set(versions.filter(isNumericReleaseVersion))].sort(semver.rcompare);
}

function nextChannelMinor(version: semver.SemVer, channel: ReleaseChannel): string {
  let minor = version.minor + 1;
  const wantsEven = channel === "stable";
  if ((minor % 2 === 0) !== wantsEven) minor += 1;
  return `${version.major}.${minor}.0`;
}

export function calculateLocalCandidate(
  versions: string[],
  channel: ReleaseChannel,
  bump: ReleaseBump,
): string | null {
  const latest = validNumericVersions(versions)[0];
  if (!latest) return null;

  const parsed = semver.parse(latest);
  if (!parsed) throw new Error(`Unexpected invalid version: ${latest}`);

  if (channel === "nightly") {
    return parsed.minor % 2 === 1
      ? `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
      : nextChannelMinor(parsed, channel);
  }

  if (bump === "major") return `${parsed.major + 1}.0.0`;
  if (bump === "minor") return nextChannelMinor(parsed, channel);
  return parsed.minor % 2 === 0
    ? `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
    : nextChannelMinor(parsed, channel);
}

export function calculateAlignmentFloor(
  versions: string[],
  channel: ReleaseChannel,
): string | null {
  const maximum = validNumericVersions(versions)[0];
  if (!maximum) return null;
  if (versionMatchesChannel(maximum, channel)) return maximum;

  const parsed = semver.parse(maximum);
  if (!parsed) throw new Error(`Unexpected invalid version: ${maximum}`);
  return nextChannelMinor(parsed, channel);
}

export function calculateVersionPlan(input: VersionPlanInput): VersionPlan {
  const productVersions = validNumericVersions(input.productVersions);
  const allProductVersions = validNumericVersions(input.allProductVersions);
  const crossProductMaximum = allProductVersions[0] ?? null;

  if (input.exactVersion) {
    if (!isNumericReleaseVersion(input.exactVersion)) {
      throw new Error(
        `Exact version ${input.exactVersion} must be numeric major.minor.patch without prerelease or build metadata`,
      );
    }
    if (!versionMatchesChannel(input.exactVersion, input.channel)) {
      throw new Error(
        `Exact version ${input.exactVersion} does not belong to the ${input.channel} channel`,
      );
    }
    const alignmentFloor = input.syncVersions
      ? calculateAlignmentFloor(allProductVersions, input.channel)
      : null;
    if (
      alignmentFloor &&
      semver.lt(input.exactVersion, alignmentFloor) &&
      !input.exactVersionIsRecovery
    ) {
      throw new Error(
        `Exact version ${input.exactVersion} is below the synchronized ${input.channel} floor ${alignmentFloor}; disable version synchronization to override it`,
      );
    }
    return {
      version: input.exactVersion,
      productLocalCandidate: null,
      crossProductMaximum,
      alignmentFloor,
      exactVersion: true,
    };
  }

  const productLocalCandidate = calculateLocalCandidate(productVersions, input.channel, input.bump);
  if (!productLocalCandidate) {
    throw new Error(
      `No ${input.product} tags exist; provide an exact --version for the first release`,
    );
  }

  const alignmentFloor = input.syncVersions
    ? calculateAlignmentFloor(allProductVersions, input.channel)
    : null;
  const version =
    alignmentFloor && semver.gt(alignmentFloor, productLocalCandidate)
      ? alignmentFloor
      : productLocalCandidate;

  if (productVersions.includes(version)) {
    throw new Error(`Calculated version ${version} already exists for ${input.product}`);
  }

  return {
    version,
    productLocalCandidate,
    crossProductMaximum,
    alignmentFloor,
    exactVersion: false,
  };
}
