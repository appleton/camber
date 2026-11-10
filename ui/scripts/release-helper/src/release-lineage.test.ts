import { describe, expect, it } from "vitest";

import {
  assertDestinationHasSinglePrefix,
  assertLineageAssociation,
  assertVersionTagMetadata,
  createReleaseTagMetadata,
  parseReleaseTagMetadata,
  releaseTag,
  serializeReleaseTagMetadata,
  validateTagPrefix,
  versionFromReleaseTag,
} from "./release-lineage.js";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const metadata = createReleaseTagMetadata({
  product: "desktop",
  tagPrefix: "desktop-shadow-202607",
  destination: "appleton.assistant-release-test-202607",
  displayName: "Camber Assistant Release Test 202607",
  version: "0.1.0",
  sourceSha,
});
const desktopMetadata = createReleaseTagMetadata({
  product: "desktop",
  tagPrefix: "desktop",
  destination: "camber/desktop-assistant",
  version: "1.0.0",
  sourceSha,
});

describe("release tag names", () => {
  it("creates and parses canonical version tags", () => {
    expect(releaseTag("desktop-shadow-202607", "0.1.2")).toBe("desktop-shadow-202607/v0.1.2");
    expect(versionFromReleaseTag("desktop-shadow-202607", "desktop-shadow-202607/v0.1.2")).toBe(
      "0.1.2",
    );
    expect(versionFromReleaseTag("desktop", "desktop-shadow/v0.1.2")).toBeNull();
  });

  it("rejects unsafe or ambiguous prefixes", () => {
    for (const prefix of ["VSCODE", "desktop/smoke", "desktop..smoke", "desktop-", ""]) {
      expect(() => validateTagPrefix(prefix)).toThrow("Tag prefix");
    }
  });
});

describe("release tag metadata", () => {
  it("round-trips canonical annotation JSON", () => {
    expect(parseReleaseTagMetadata(serializeReleaseTagMetadata(metadata))).toEqual(metadata);
  });

  it("ignores unrelated annotations and rejects malformed lineage metadata", () => {
    expect(parseReleaseTagMetadata("ordinary annotated tag")).toBeNull();
    expect(parseReleaseTagMetadata('{"kind":"something-else"}')).toBeNull();
    expect(() => parseReleaseTagMetadata(JSON.stringify({ ...metadata, schema: 2 }))).toThrow(
      "Unsupported release-lineage metadata",
    );
  });

  it("binds a prefix to one product and destination", () => {
    expect(() =>
      assertLineageAssociation(metadata, {
        product: "desktop",
        tagPrefix: "desktop-shadow-202607",
        destination: "appleton.another-extension",
      }),
    ).toThrow("is bound to");
  });

  it("binds the Desktop lineage to one CrabNebula application", () => {
    expect(parseReleaseTagMetadata(serializeReleaseTagMetadata(desktopMetadata))).toEqual(
      desktopMetadata,
    );
    expect(() =>
      assertLineageAssociation(desktopMetadata, {
        product: "desktop",
        tagPrefix: "desktop",
        destination: "camber/another-desktop-app",
      }),
    ).toThrow("is bound to");
  });

  it("binds a version tag to its source and display name", () => {
    expect(() =>
      assertVersionTagMetadata(metadata, {
        product: "desktop",
        tagPrefix: "desktop-shadow-202607",
        destination: metadata.destination,
        version: "0.1.0",
        sourceSha,
        displayName: metadata.displayName,
      }),
    ).not.toThrow();
    expect(() =>
      assertVersionTagMetadata(metadata, {
        product: "desktop",
        tagPrefix: "desktop-shadow-202607",
        destination: metadata.destination,
        version: "0.1.1",
        sourceSha,
      }),
    ).toThrow("does not match");
  });

  it("prevents one destination from using two prefixes", () => {
    expect(() =>
      assertDestinationHasSinglePrefix(
        [{ tag: "desktop-old/v0.1.0", metadata: { ...metadata, tagPrefix: "desktop-old" } }],
        {
          product: "desktop",
          tagPrefix: "desktop-new",
          destination: metadata.destination,
        },
      ),
    ).toThrow("already bound");
  });
});
