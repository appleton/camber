import { FILE_PATH_REGEX, isFilePath, parseFilePathWithLine } from "@camber/components/markdown";
import { describe, expect, it } from "vitest";

describe("isFilePath", () => {
  describe("absolute paths", () => {
    it("should recognize absolute paths starting with /", () => {
      expect(isFilePath("/path/to/file.go")).toBe(true);
      expect(isFilePath("/workspace/project/main.ts")).toBe(true);
      expect(isFilePath("/etc/config")).toBe(true);
    });
  });

  describe("relative paths", () => {
    it("should recognize ./ relative paths", () => {
      expect(isFilePath("./file.go")).toBe(true);
      expect(isFilePath("./path/to/file.ts")).toBe(true);
    });

    it("should recognize ../ relative paths", () => {
      expect(isFilePath("../file.go")).toBe(true);
      expect(isFilePath("../path/to/file.ts")).toBe(true);
    });
  });

  describe("paths with extensions", () => {
    it("should recognize paths with common extensions", () => {
      expect(isFilePath("file.go")).toBe(true);
      expect(isFilePath("file.ts")).toBe(true);
      expect(isFilePath("file.tsx")).toBe(true);
      expect(isFilePath("file.json")).toBe(true);
      expect(isFilePath("models/book.go")).toBe(true);
      expect(isFilePath("(pages)/file.tsx")).toBe(true);
    });
  });

  describe("dotfiles", () => {
    it("should recognize standalone dotfiles", () => {
      expect(isFilePath(".dockerignore")).toBe(true);
      expect(isFilePath(".gitignore")).toBe(true);
      expect(isFilePath(".env")).toBe(true);
      expect(isFilePath(".eslintrc")).toBe(true);
      expect(isFilePath(".prettierrc")).toBe(true);
    });

    it("should recognize dotfiles in relative paths", () => {
      expect(isFilePath("path/to/.dockerignore")).toBe(true);
      expect(isFilePath("project/.gitignore")).toBe(true);
      expect(isFilePath("src/.env")).toBe(true);
    });
  });

  describe("non-file-paths", () => {
    it("should reject empty strings", () => {
      expect(isFilePath("")).toBe(false);
    });

    it("should reject plain words", () => {
      expect(isFilePath("hello")).toBe(false);
      expect(isFilePath("just a sentence")).toBe(false);
    });
  });
});

describe("FILE_PATH_REGEX", () => {
  function extractPaths(text: string): string[] {
    const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
    const matches = [...text.matchAll(regex)];
    return matches.map((m) => m[1]);
  }

  function extractMatches(text: string): { path: string; line?: string; column?: string }[] {
    const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
    return [...text.matchAll(regex)].map((m) => ({
      path: m[1],
      line: m[2],
      column: m[3],
    }));
  }

  describe("traditional file paths in text", () => {
    it("should match absolute paths", () => {
      expect(extractPaths("Edit /path/to/file.go to fix the bug")).toEqual(["/path/to/file.go"]);
    });

    it("should match relative paths with ./ prefix", () => {
      expect(extractPaths("See ./src/main.ts for details")).toEqual(["./src/main.ts"]);
    });

    it("should match relative paths with ../ prefix", () => {
      expect(extractPaths("Check ../config.json")).toEqual(["../config.json"]);
    });

    it("should match bare relative paths", () => {
      expect(extractPaths("Look at models/book.go")).toEqual(["models/book.go"]);
    });

    it("should match multiple paths in text", () => {
      expect(extractPaths("Edit file.go and utils.ts")).toEqual(["file.go", "utils.ts"]);
    });

    it("should match paths at start of text", () => {
      expect(extractPaths("file.go contains the main logic")).toEqual(["file.go"]);
    });

    it("should match paths at end of text", () => {
      expect(extractPaths("Check the file at /path/to/config.yml")).toEqual([
        "/path/to/config.yml",
      ]);
    });
  });

  describe("dotfiles in paths (regression: .dockerignore bug)", () => {
    it("should match absolute paths with dotfiles", () => {
      expect(extractPaths("Edit /workspace/project/.dockerignore")).toEqual([
        "/workspace/project/.dockerignore",
      ]);
    });

    it("should match relative paths with dotfiles", () => {
      expect(extractPaths("See ./path/to/.gitignore for details")).toEqual([
        "./path/to/.gitignore",
      ]);
    });

    it("should match bare relative paths with dotfiles", () => {
      expect(extractPaths("Check project/.dockerignore")).toEqual(["project/.dockerignore"]);
    });

    it("should match ../ paths with dotfiles", () => {
      expect(extractPaths("Edit ../.dockerignore")).toEqual(["../.dockerignore"]);
    });

    it("should match ./ paths with dotfiles", () => {
      expect(extractPaths("Edit ./.dockerignore")).toEqual(["./.dockerignore"]);
    });

    it("should match various dotfile types in paths", () => {
      expect(extractPaths("See project/.gitignore and src/.eslintrc")).toEqual([
        "project/.gitignore",
        "src/.eslintrc",
      ]);
    });

    it("should match dotfiles with dots in name like .eslintrc.json", () => {
      expect(extractPaths("Edit project/.eslintrc.json")).toEqual(["project/.eslintrc.json"]);
    });
  });

  describe("file paths with line numbers", () => {
    it("should match path with line number", () => {
      expect(extractMatches("See src/main.ts:42 for details")).toEqual([
        { path: "src/main.ts", line: "42", column: undefined },
      ]);
    });

    it("should match path with line and column", () => {
      expect(extractMatches("See src/main.ts:42:5 for details")).toEqual([
        { path: "src/main.ts", line: "42", column: "5" },
      ]);
    });

    it("should match absolute path with line number", () => {
      expect(extractMatches("Edit /path/to/file.go:17 to fix")).toEqual([
        { path: "/path/to/file.go", line: "17", column: undefined },
      ]);
    });

    it("should match path with line number followed by punctuation", () => {
      expect(extractMatches("Check file.ts:10, that's the issue.")).toEqual([
        { path: "file.ts", line: "10", column: undefined },
      ]);
    });

    it("should still match path without line number", () => {
      expect(extractMatches("See src/main.ts for details")).toEqual([
        { path: "src/main.ts", line: undefined, column: undefined },
      ]);
    });
  });

  describe("quoted paths", () => {
    it("should match double-quoted relative paths", () => {
      expect(extractPaths('Update "ui/packages/foo/bar.ts" next')).toEqual([
        "ui/packages/foo/bar.ts",
      ]);
    });

    it("should match single-quoted paths", () => {
      expect(extractPaths("Check 'src/main.ts' now")).toEqual(["src/main.ts"]);
    });

    it("should match curly-quoted paths", () => {
      expect(extractPaths("Check “src/main.ts” and ‘lib/util.go’")).toEqual([
        "src/main.ts",
        "lib/util.go",
      ]);
    });

    it("should match quoted paths with line numbers", () => {
      expect(extractMatches('See "src/main.ts:42:5" for details')).toEqual([
        { path: "src/main.ts", line: "42", column: "5" },
      ]);
    });

    it("should match a quoted path at the start of text", () => {
      expect(extractPaths('"src/main.ts" is the entry point')).toEqual(["src/main.ts"]);
    });

    it("should match quoted paths followed by punctuation", () => {
      expect(extractPaths('Open "src/main.ts".')).toEqual(["src/main.ts"]);
    });

    it("should match multiple quoted paths", () => {
      expect(extractPaths('Compare "a/b.ts" with "c/d.ts"')).toEqual(["a/b.ts", "c/d.ts"]);
    });
  });

  describe("should not match", () => {
    it("should not match plain sentences with periods", () => {
      // "file. The" should not be matched as a path
      expect(extractPaths("This is a file. The answer is yes.")).toEqual([]);
    });

    it("should not match standalone dotfiles in text (too ambiguous)", () => {
      // Standalone dotfiles without path context are ambiguous in plain text
      expect(extractPaths("Create a .dockerignore file")).toEqual([]);
    });
  });
});

describe("parseFilePathWithLine", () => {
  it("should parse path without line", () => {
    expect(parseFilePathWithLine("src/main.ts")).toEqual({ path: "src/main.ts" });
  });

  it("should parse path with line", () => {
    expect(parseFilePathWithLine("src/main.ts:42")).toEqual({
      path: "src/main.ts",
      line: 42,
    });
  });

  it("should parse path with line and column", () => {
    expect(parseFilePathWithLine("src/main.ts:42:5")).toEqual({
      path: "src/main.ts",
      line: 42,
      column: 5,
    });
  });

  it("should parse absolute path with line", () => {
    expect(parseFilePathWithLine("/workspace/file.go:17")).toEqual({
      path: "/workspace/file.go",
      line: 17,
    });
  });
});
