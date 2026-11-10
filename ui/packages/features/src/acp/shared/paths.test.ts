import type { WorkspaceFolder } from "@camber/rpc";
import { describe, expect, it } from "vitest";
import {
  getReadableFileInfo,
  shortenDirectoryPathsInText,
  shortenHomeDirectoryInText,
} from "./paths";

const workspaces: WorkspaceFolder[] = [
  {
    path: "/Users/andy/project",
    name: "project",
    index: 0,
  },
];

describe("getReadableFileInfo", () => {
  it("shortens paths in the user home directory when they are outside the workspace", () => {
    expect(
      getReadableFileInfo("/Users/andy/.codex/config.toml", workspaces, "/Users/andy"),
    ).toEqual({
      filePath: "~/.codex/config.toml",
      fileName: "~/.codex/config.toml",
      absolutePath: "/Users/andy/.codex/config.toml",
    });
  });

  it("prefers a workspace-relative path for files in the active project", () => {
    expect(
      getReadableFileInfo("/Users/andy/project/src/index.ts", workspaces, "/Users/andy"),
    ).toEqual({
      filePath: "./src/index.ts",
      fileName: "index.ts",
      absolutePath: "/Users/andy/project/src/index.ts",
    });
  });

  it("does not treat a sibling whose name starts with the workspace name as project-relative", () => {
    expect(
      getReadableFileInfo("/Users/andy/project-old/src/index.ts", workspaces, "/Users/andy"),
    ).toEqual({
      filePath: "~/project-old/src/index.ts",
      fileName: "~/project-old/src/index.ts",
      absolutePath: "/Users/andy/project-old/src/index.ts",
    });
  });

  it("leaves paths outside the provided home directory absolute", () => {
    expect(getReadableFileInfo("/opt/shared/config.toml", workspaces, "/Users/andy")).toEqual({
      filePath: "/opt/shared/config.toml",
      fileName: "/opt/shared/config.toml",
      absolutePath: "/opt/shared/config.toml",
    });
  });

  it("does not shorten another user's home directory", () => {
    expect(getReadableFileInfo("/Users/alice/notes.txt", workspaces, "/Users/andy")).toEqual({
      filePath: "/Users/alice/notes.txt",
      fileName: "/Users/alice/notes.txt",
      absolutePath: "/Users/alice/notes.txt",
    });
  });

  it("normalizes file URIs before shortening them", () => {
    expect(
      getReadableFileInfo("file:///Users/andy/.codex/config.toml", workspaces, "/Users/andy"),
    ).toEqual({
      filePath: "~/.codex/config.toml",
      fileName: "~/.codex/config.toml",
      absolutePath: "/Users/andy/.codex/config.toml",
    });
  });
});

describe("shortenHomeDirectoryInText", () => {
  it("shortens exact home paths in UI labels without inferring a username", () => {
    expect(
      shortenHomeDirectoryInText(
        "Read /Users/andy/.codex/config.toml and file:///Users/andy/notes.txt",
        "/Users/andy",
      ),
    ).toBe("Read ~/.codex/config.toml and ~/notes.txt");
  });

  it("does not shorten a longer path segment that merely starts with the home directory", () => {
    expect(shortenHomeDirectoryInText("Read /Users/andy-work/notes.txt", "/Users/andy")).toBe(
      "Read /Users/andy-work/notes.txt",
    );
  });
});

describe("shortenDirectoryPathsInText", () => {
  it("prefers workspace-relative labels before shortening other home paths", () => {
    expect(
      shortenDirectoryPathsInText(
        "Read /Users/andy/project/src/app.ts and /Users/andy/notes.txt",
        workspaces,
        "/Users/andy",
      ),
    ).toBe("Read ./src/app.ts and ~/notes.txt");
  });
});
