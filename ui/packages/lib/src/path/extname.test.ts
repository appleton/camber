import { extname } from "./extname.js";

describe("unix", () => {
  it("should extract extension from absolute path", () => {
    expect(extname("/Users/poolie/camber/file.ts")).toBe(".ts");
  });

  it("should extract extension from root directory", () => {
    expect(extname("/file.ts")).toBe(".ts");
  });

  it("should handle paths with trailing slashes", () => {
    expect(extname("/Users/poolie/camber/")).toBe("");
  });

  it("should extract last extension from multiple extensions", () => {
    expect(extname("/path/to/archive.tar.gz")).toBe(".gz");
  });

  it("should handle dotfiles with extension", () => {
    expect(extname("/Users/poolie/.config.json")).toBe(".json");
  });
});

describe("windows", () => {
  it("should extract extension from absolute path", () => {
    expect(extname("C:\\Users\\poolie\\camber\\file.ts")).toBe(".ts");
  });

  it("should extract extension from drive root", () => {
    expect(extname("C:\\file.ts")).toBe(".ts");
  });

  it("should extract extension from UNC path", () => {
    expect(extname("\\\\server\\share\\folder\\file.ts")).toBe(".ts");
  });

  it("should handle paths with trailing backslashes", () => {
    expect(extname("C:\\Users\\poolie\\camber\\")).toBe("");
  });
});

describe("relative paths", () => {
  it("should extract extension from multi-level relative path", () => {
    expect(extname("src/utils/file.ts")).toBe(".ts");
  });

  it("should extract extension from single filename", () => {
    expect(extname("file.ts")).toBe(".ts");
  });

  it("should extract extension from relative path with parent reference", () => {
    expect(extname("../utils/file.ts")).toBe(".ts");
  });
});

describe("edge cases", () => {
  it("should return empty string for current directory", () => {
    expect(extname(".")).toBe("");
  });

  it("should return empty string for parent directory reference", () => {
    expect(extname("..")).toBe("");
  });

  it("should return empty string for empty string", () => {
    expect(extname("")).toBe("");
  });

  it("should return empty string for file without extension", () => {
    expect(extname("/path/to/README")).toBe("");
  });

  it("should handle path ending with multiple slashes", () => {
    expect(extname("/path/to/folder///")).toBe("");
  });

  it("should handle multiple dots in filename", () => {
    expect(extname("/path/to/my.file.name.ts")).toBe(".ts");
  });

  it("should handle filename ending with dot", () => {
    expect(extname("/path/to/file.")).toBe(".");
  });

  it("should handle dots in directory names", () => {
    expect(extname("/path.with.dots/to/file.ts")).toBe(".ts");
  });
});
