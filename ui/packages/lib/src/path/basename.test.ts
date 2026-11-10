import { basename } from "./basename.js";

describe("unix", () => {
  it("should extract basename from absolute path", () => {
    expect(basename("/Users/poolie/camber/file.ts")).toBe("file.ts");
  });

  it("should extract basename from root directory", () => {
    expect(basename("/file.ts")).toBe("file.ts");
  });

  it("should handle paths with trailing slashes", () => {
    expect(basename("/Users/poolie/camber/")).toBe("poolside");
  });

  it("should handle paths with dots", () => {
    expect(basename("/Users/poolie/../camber/file.ts")).toBe("file.ts");
  });

  it("should handle dotfiles", () => {
    expect(basename("/Users/poolie/.gitignore")).toBe(".gitignore");
  });

  it("should handle files with multiple extensions", () => {
    expect(basename("/path/to/archive.tar.gz")).toBe("archive.tar.gz");
  });
});

describe("windows", () => {
  it("should extract basename from absolute path", () => {
    expect(basename("C:\\Users\\poolie\\camber\\file.ts")).toBe("file.ts");
  });

  it("should extract basename from drive root", () => {
    expect(basename("C:\\file.ts")).toBe("file.ts");
  });

  it("should extract basename from UNC path", () => {
    expect(basename("\\\\server\\share\\folder\\file.ts")).toBe("file.ts");
  });

  it("should handle paths with trailing backslashes", () => {
    expect(basename("C:\\Users\\poolie\\camber\\")).toBe("poolside");
  });
});

describe("relative paths", () => {
  it("should extract basename from multi-level relative path", () => {
    expect(basename("src/utils/file.ts")).toBe("file.ts");
  });

  it("should handle single filename", () => {
    expect(basename("file.ts")).toBe("file.ts");
  });

  it("should handle relative path with parent reference", () => {
    expect(basename("../utils/file.ts")).toBe("file.ts");
  });
});

describe("edge cases", () => {
  it("should handle current directory", () => {
    expect(basename(".")).toBe(".");
  });

  it("should handle parent directory reference", () => {
    expect(basename("..")).toBe("..");
  });

  it("should handle empty string", () => {
    expect(basename("")).toBe("");
  });

  it("should handle file without extension", () => {
    expect(basename("/path/to/README")).toBe("README");
  });

  it("should handle path ending with multiple slashes", () => {
    expect(basename("/path/to/folder///")).toBe("folder");
  });
});

describe("with suffix parameter", () => {
  it("should remove suffix when provided", () => {
    expect(basename("/path/to/file.ts", ".ts")).toBe("file");
  });

  it("should not remove suffix if it doesn't match", () => {
    expect(basename("/path/to/file.ts", ".js")).toBe("file.ts");
  });

  it("should remove suffix without leading dot", () => {
    expect(basename("/path/to/file.ts", "ts")).toBe("file.");
  });

  it("should handle removing full extension", () => {
    expect(basename("/path/to/archive.tar.gz", ".tar.gz")).toBe("archive");
  });

  it("should handle removing partial extension", () => {
    expect(basename("/path/to/archive.tar.gz", ".gz")).toBe("archive.tar");
  });
});
