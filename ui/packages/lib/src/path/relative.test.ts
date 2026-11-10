import { relative } from "./relative.js";

describe("unix", () => {
  it("should calculate relative path between directories", () => {
    expect(relative("/Users/poolie/camber", "/Users/poolie/projects")).toBe("../projects");
  });

  it("should calculate relative path from parent to child", () => {
    expect(relative("/Users/poolie", "/Users/poolie/camber/file.ts")).toBe("camber/file.ts");
  });

  it("should calculate relative path from child to parent", () => {
    expect(relative("/Users/poolie/camber/src", "/Users/poolie")).toBe("../..");
  });

  it("should return empty string for same paths", () => {
    expect(relative("/Users/poolie/camber", "/Users/poolie/camber")).toBe("");
  });

  it("should calculate relative path between deeply nested paths", () => {
    expect(relative("/a/b/c/d", "/a/b/e/f")).toBe("../../e/f");
  });

  it("should calculate relative path from root", () => {
    expect(relative("/", "/Users/poolie/file.ts")).toBe("Users/poolie/file.ts");
  });

  it("should calculate relative path to root", () => {
    expect(relative("/Users/poolie", "/")).toBe("../..");
  });

  it("should handle trailing slashes in from", () => {
    expect(relative("/Users/poolie/camber/", "/Users/poolie/projects")).toBe("../projects");
  });

  it("should handle trailing slashes in to", () => {
    expect(relative("/Users/poolie/camber", "/Users/poolie/projects/")).toBe("../projects");
  });

  it("should handle paths with dots", () => {
    expect(relative("/Users/poolie/../poolie/camber", "/Users/poolie/projects")).toBe(
      "../projects",
    );
  });
});

describe("windows", () => {
  it("should calculate relative path between directories", () => {
    expect(relative("C:\\Users\\poolie\\camber", "C:\\Users\\poolie\\projects")).toBe(
      "../projects",
    );
  });

  it("should calculate relative path from parent to child", () => {
    expect(relative("C:\\Users\\poolie", "C:\\Users\\poolie\\camber\\file.ts")).toBe(
      "camber/file.ts",
    );
  });

  it("should calculate relative path from child to parent", () => {
    expect(relative("C:\\Users\\poolie\\camber\\src", "C:\\Users\\poolie")).toBe("../..");
  });

  it("should return empty string for same paths", () => {
    expect(relative("C:\\Users\\poolie\\camber", "C:\\Users\\poolie\\camber")).toBe("");
  });

  it("should return absolute path for different drives", () => {
    expect(relative("C:\\Users\\poolie", "D:\\Projects\\file.ts")).toBe("D:/Projects/file.ts");
  });

  it("should calculate relative path from drive root", () => {
    expect(relative("C:\\", "C:\\Users\\poolie\\file.ts")).toBe("Users/poolie/file.ts");
  });

  it("should calculate relative path to drive root", () => {
    expect(relative("C:\\Users\\poolie", "C:\\")).toBe("../..");
  });
});

describe("relative paths", () => {
  it("should calculate relative path between relative paths", () => {
    expect(relative("src/utils", "src/components")).toBe("../components");
  });

  it("should calculate relative path from relative to relative", () => {
    expect(relative("src", "src/utils/file.ts")).toBe("utils/file.ts");
  });

  it("should return empty string for same relative paths", () => {
    expect(relative("src/utils", "src/utils")).toBe("");
  });

  it("should handle parent directory references", () => {
    expect(relative("../src/utils", "../src/components")).toBe("../components");
  });

  it("should handle current directory references", () => {
    expect(relative("./src/utils", "./src/components")).toBe("../components");
  });
});

describe("edge cases", () => {
  it("should handle both empty paths", () => {
    expect(relative("", "")).toBe("");
  });

  it("should handle empty from path", () => {
    expect(relative("", "src/file.ts")).toBe("src/file.ts");
  });

  it("should handle current directory as from", () => {
    expect(relative(".", "src/file.ts")).toBe("src/file.ts");
  });

  it("should handle current directory as to", () => {
    expect(relative("src/utils", ".")).toBe("../..");
  });

  it("should handle multiple slashes", () => {
    expect(relative("/path///to///from", "/path///to///to")).toBe("../to");
  });
});
