import { describe, expect, it } from "vitest";

import {
  calculateAlignmentFloor,
  calculateLocalCandidate,
  calculateVersionPlan,
  isNumericReleaseVersion,
  versionMatchesChannel,
} from "./release-plan.js";

describe("release version validation", () => {
  it("accepts numeric versions and rejects prerelease/build metadata", () => {
    expect(isNumericReleaseVersion("1.2.3")).toBe(true);
    expect(isNumericReleaseVersion("1.2.3-nightly.1")).toBe(false);
    expect(isNumericReleaseVersion("1.2.3+build.1")).toBe(false);
    expect(isNumericReleaseVersion("garbage")).toBe(false);
  });

  it("uses the same odd/even channel convention for both products", () => {
    expect(versionMatchesChannel("1.2.3", "stable")).toBe(true);
    expect(versionMatchesChannel("1.3.0", "nightly")).toBe(true);
    expect(versionMatchesChannel("1.3.0", "stable")).toBe(false);
  });
});

describe("calculateLocalCandidate", () => {
  it("increments a patch within the current channel line", () => {
    expect(calculateLocalCandidate(["1.2.3"], "stable", "patch")).toBe("1.2.4");
    expect(calculateLocalCandidate(["1.3.7"], "nightly", "patch")).toBe("1.3.8");
  });

  it("moves from stable to the next preview line", () => {
    expect(calculateLocalCandidate(["1.2.3"], "nightly", "patch")).toBe("1.3.0");
  });

  it("moves from preview to the next stable line", () => {
    expect(calculateLocalCandidate(["1.3.7", "1.2.4"], "stable", "patch")).toBe("1.4.0");
  });

  it("supports explicit stable minor and major bumps", () => {
    expect(calculateLocalCandidate(["1.2.3"], "stable", "minor")).toBe("1.4.0");
    expect(calculateLocalCandidate(["1.5.2"], "stable", "major")).toBe("2.0.0");
  });
});

describe("calculateAlignmentFloor", () => {
  it("reuses a cross-product maximum with matching parity", () => {
    expect(calculateAlignmentFloor(["1.4.3", "1.2.1"], "stable")).toBe("1.4.3");
  });

  it("advances an opposite-parity maximum to the requested line", () => {
    expect(calculateAlignmentFloor(["1.5.4", "1.2.1"], "stable")).toBe("1.6.0");
    expect(calculateAlignmentFloor(["1.4.1", "1.3.2"], "nightly")).toBe("1.5.0");
  });
});

describe("calculateVersionPlan", () => {
  const base = {
    product: "desktop" as const,
    channel: "stable" as const,
    bump: "patch" as const,
    productVersions: ["1.2.1"],
    allProductVersions: ["1.4.3", "1.2.1"],
  };

  it("aligns a manual release by default when requested", () => {
    expect(calculateVersionPlan({ ...base, syncVersions: true })).toMatchObject({
      version: "1.4.3",
      productLocalCandidate: "1.2.2",
      crossProductMaximum: "1.4.3",
      alignmentFloor: "1.4.3",
    });
  });

  it("keeps scheduled and opted-out releases product-local", () => {
    expect(calculateVersionPlan({ ...base, syncVersions: false }).version).toBe("1.2.2");
  });

  it("lets the local candidate win when it is already ahead", () => {
    expect(
      calculateVersionPlan({
        ...base,
        productVersions: ["1.6.2"],
        allProductVersions: ["1.6.2", "1.5.9"],
        syncVersions: true,
      }).version,
    ).toBe("1.6.3");
  });

  it("requires an explicit first version", () => {
    expect(() =>
      calculateVersionPlan({
        ...base,
        productVersions: [],
        allProductVersions: [],
        syncVersions: true,
      }),
    ).toThrow("provide an exact --version");
  });

  it("validates exact versions and applies alignment to new bootstraps", () => {
    expect(
      calculateVersionPlan({ ...base, exactVersion: "1.4.3", syncVersions: true }),
    ).toMatchObject({ version: "1.4.3", exactVersion: true, alignmentFloor: "1.4.3" });
    expect(() =>
      calculateVersionPlan({ ...base, exactVersion: "0.1.0", syncVersions: true }),
    ).toThrow("does not belong");
    expect(() =>
      calculateVersionPlan({ ...base, exactVersion: "0.2.0", syncVersions: true }),
    ).toThrow("below the synchronized stable floor 1.4.3");
  });

  it("allows an intentional exact-version divergence or reserved-tag recovery", () => {
    expect(
      calculateVersionPlan({ ...base, exactVersion: "0.2.0", syncVersions: false }),
    ).toMatchObject({ version: "0.2.0", alignmentFloor: null });
    expect(
      calculateVersionPlan({
        ...base,
        exactVersion: "0.2.0",
        exactVersionIsRecovery: true,
        syncVersions: true,
      }),
    ).toMatchObject({ version: "0.2.0", alignmentFloor: "1.4.3" });
  });
});
