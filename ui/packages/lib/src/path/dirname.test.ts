import { dirname } from "./dirname.js";

describe("unix", () => {
  it("should handle absolute paths", () => {
    expect(dirname("/Users/poolie/camber/file.ts")).toBe("/Users/poolie/camber");
  });

  it("should handle root directory", () => {
    expect(dirname("/file.ts")).toBe("/");
  });

  it("should handle paths with trailing slashes", () => {
    expect(dirname("/Users/poolie/camber/")).toBe("/Users/poolie");
  });

  it("should handle paths with dots", () => {
    expect(dirname("/Users/poolie/../camber/file.ts")).toBe("/Users/poolie/../camber");
  });
});

describe("win", () => {
  it("should handle absolute paths", () => {
    expect(dirname("C:\\Users\\poolie\\camber\\file.ts")).toBe("C:/Users/poolie/camber");
  });

  it("should handle drive root", () => {
    expect(dirname("C:\\file.ts")).toBe("C:/");
  });

  it("should handle UNC paths", () => {
    expect(dirname("\\\\server\\share\\folder\\file.ts")).toBe("//server/share/folder");
  });
});

describe("relative", () => {
  it("should handle multi-level relative paths", () => {
    expect(dirname("src/utils/file.ts")).toBe("src/utils");
  });

  it("should handle single-level relative paths", () => {
    expect(dirname("file.ts")).toBe(".");
  });
});

describe("edge", () => {
  it("should handle current directory", () => {
    expect(dirname(".")).toBe(".");
  });

  it("should handle parent directory reference", () => {
    expect(dirname("..")).toBe(".");
  });

  it("should handle empty string", () => {
    expect(dirname("")).toBe(".");
  });
});
