import { isAbsolute } from "./isAbsolute.js";

describe("unix", () => {
  it("should recognize absolute path starting with /", () => {
    expect(isAbsolute("/Users/poolie/camber/file.ts")).toBe(true);
  });

  it("should recognize root directory as absolute", () => {
    expect(isAbsolute("/")).toBe(true);
  });

  it("should recognize absolute path with trailing slash", () => {
    expect(isAbsolute("/Users/poolie/camber/")).toBe(true);
  });

  it("should recognize absolute path with dots", () => {
    expect(isAbsolute("/Users/poolie/../camber/file.ts")).toBe(true);
  });

  it("should recognize absolute path to dotfile", () => {
    expect(isAbsolute("/Users/poolie/.gitignore")).toBe(true);
  });
});

describe("windows", () => {
  it("should recognize absolute path with drive letter", () => {
    expect(isAbsolute("C:\\Users\\poolie\\camber\\file.ts")).toBe(true);
  });

  it("should recognize drive root as absolute", () => {
    expect(isAbsolute("C:\\")).toBe(true);
  });

  it("should recognize UNC path as absolute", () => {
    expect(isAbsolute("\\\\server\\share\\folder\\file.ts")).toBe(true);
  });

  it("should recognize absolute path with trailing backslash", () => {
    expect(isAbsolute("C:\\Users\\poolie\\camber\\")).toBe(true);
  });

  it("should recognize different drive letters", () => {
    expect(isAbsolute("D:\\projects\\file.ts")).toBe(true);
  });
});

describe("relative paths", () => {
  it("should recognize multi-level relative path as not absolute", () => {
    expect(isAbsolute("src/utils/file.ts")).toBe(false);
  });

  it("should recognize single filename as not absolute", () => {
    expect(isAbsolute("file.ts")).toBe(false);
  });

  it("should recognize relative path with parent reference as not absolute", () => {
    expect(isAbsolute("../utils/file.ts")).toBe(false);
  });

  it("should recognize relative path with current directory as not absolute", () => {
    expect(isAbsolute("./utils/file.ts")).toBe(false);
  });
});

describe("edge cases", () => {
  it("should recognize current directory as not absolute", () => {
    expect(isAbsolute(".")).toBe(false);
  });

  it("should recognize parent directory reference as not absolute", () => {
    expect(isAbsolute("..")).toBe(false);
  });

  it("should handle empty string as not absolute", () => {
    expect(isAbsolute("")).toBe(false);
  });

  it("should handle path with backslashes on unix as not absolute", () => {
    expect(isAbsolute("folder\\file.ts")).toBe(false);
  });
});
