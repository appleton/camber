import { imageFilePathFromUri } from "@camber/components/assistant-ui";
import { describe, expect, it } from "vitest";

describe("image preview utilities", () => {
  it("converts Unix file image URIs to paths", () => {
    expect(imageFilePathFromUri("file:///tmp/cat.png")).toBe("/tmp/cat.png");
  });

  it("converts Windows drive file image URIs without a leading slash", () => {
    expect(imageFilePathFromUri("file:///C:/Users/test/cat.png")).toBe("C:/Users/test/cat.png");
  });

  it("converts Windows UNC file image URIs to UNC paths", () => {
    expect(imageFilePathFromUri("file://server/share/cat.png")).toBe("//server/share/cat.png");
  });

  it("does not return non-image file paths", () => {
    expect(imageFilePathFromUri("file:///tmp/readme.md")).toBeUndefined();
  });
});
