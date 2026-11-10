import type { AttachedUrl } from "@camber/rpc";
import { describe, expect, it } from "vitest";
import { ContextRepositoryWriter } from "./ContextRepository.svelte";

describe("ContextRepositoryWriter", () => {
  describe("asPromptContentBlocks", () => {
    it("returns an empty array when no files or urls are attached", () => {
      const repo = new ContextRepositoryWriter();
      expect(repo.asPromptContentBlocks(true)).toEqual([]);
    });

    it("emits active files, attached files, and recent files as embedded resources", () => {
      const repo = new ContextRepositoryWriter();
      repo.setRecentFile({
        path: "/workspace/src/recent.ts",
        content: "const recent = true;",
      });
      repo.setActiveFiles([
        {
          path: "/workspace/src/app.ts",
          content: "const active = true;",
          selection: [2, 4],
          visibleRange: { start: 1, end: 8 },
          cursorLine: 3,
        },
      ]);
      repo.attachFile({
        path: "/workspace/src/other.ts",
        content: "const attached = true;",
      });

      expect(repo.asPromptContentBlocks(true)).toEqual([
        {
          type: "resource",
          resource: {
            uri: "/workspace/src/app.ts",
            mimeType: "text/plain",
            text: "const active = true;",
            _meta: {
              recent: false,
              active: true,
              selection: { startLine: 2, endLine: 4 },
              visibleRange: { startLine: 1, endLine: 8 },
              cursorLine: 3,
            },
          },
        },
        {
          type: "resource",
          resource: {
            uri: "/workspace/src/other.ts",
            mimeType: "text/plain",
            text: "const attached = true;",
            _meta: {
              recent: false,
              active: false,
            },
          },
        },
        {
          type: "resource",
          resource: {
            uri: "/workspace/src/recent.ts",
            mimeType: "text/plain",
            text: "const recent = true;",
            _meta: {
              recent: true,
              active: false,
            },
          },
        },
      ]);
    });

    it("deduplicates files by path, keeping active before attached before recent", () => {
      const repo = new ContextRepositoryWriter();
      repo.setRecentFile({
        path: "/workspace/src/app.ts",
        content: "const recent = true;",
      });
      repo.attachFile({
        path: "/workspace/src/app.ts",
        content: "const attached = true;",
      });
      repo.setActiveFiles([
        {
          path: "/workspace/src/app.ts",
          content: "const active = true;",
        },
      ]);

      expect(repo.asPromptContentBlocks(true)).toEqual([
        {
          type: "resource",
          resource: {
            uri: "/workspace/src/app.ts",
            mimeType: "text/plain",
            text: "const active = true;",
            _meta: {
              recent: true,
              active: true,
            },
          },
        },
      ]);
    });

    it("emits resource_link for files without content, even when embedded context is supported", () => {
      const repo = new ContextRepositoryWriter();
      repo.attachFile({
        path: "/workspace/src/content.ts",
        content: "const attached = true;",
      });
      repo.attachFile({ path: "/workspace/README.md" });

      expect(repo.asPromptContentBlocks(true)).toEqual([
        {
          type: "resource",
          resource: {
            uri: "/workspace/src/content.ts",
            mimeType: "text/plain",
            text: "const attached = true;",
            _meta: {
              recent: false,
              active: false,
            },
          },
        },
        {
          type: "resource_link",
          name: "README.md",
          title: "/workspace/README.md",
          uri: "/workspace/README.md",
          _meta: {
            recent: false,
            active: false,
          },
        },
      ]);
    });

    it("emits resource_link for all files when embedded context is unsupported", () => {
      const repo = new ContextRepositoryWriter();
      repo.setRecentFile({
        path: "/workspace/src/app.ts",
        content: "const recent = true;",
      });
      repo.attachFile({
        path: "/workspace/src/other.ts",
        content: "const attached = true;",
      });

      expect(repo.asPromptContentBlocks(false)).toEqual([
        {
          type: "resource_link",
          name: "other.ts",
          title: "/workspace/src/other.ts",
          uri: "/workspace/src/other.ts",
          _meta: {
            recent: false,
            active: false,
          },
        },
        {
          type: "resource_link",
          name: "app.ts",
          title: "/workspace/src/app.ts",
          uri: "/workspace/src/app.ts",
          _meta: {
            recent: true,
            active: false,
          },
        },
      ]);
    });

    it("appends attached urls after files as resource_links", () => {
      const repo = new ContextRepositoryWriter();
      repo.attachFile({
        path: "/workspace/src/app.ts",
        content: "const attached = true;",
      });
      const url: AttachedUrl = {
        url: "https://example.com/docs/path",
        content: "page",
      };
      repo.attachUrl({ status: "attached", ...url });

      expect(repo.asPromptContentBlocks(true)).toEqual([
        {
          type: "resource",
          resource: {
            uri: "/workspace/src/app.ts",
            mimeType: "text/plain",
            text: "const attached = true;",
            _meta: {
              recent: false,
              active: false,
            },
          },
        },
        {
          type: "resource_link",
          name: "example.com/docs/path",
          title: "example.com/docs/path",
          uri: "https://example.com/docs/path",
        },
      ]);
    });
  });

  describe("setActiveFiles", () => {
    it("deduplicates active files by path", () => {
      const repo = new ContextRepositoryWriter();

      repo.setActiveFiles([
        { path: "/workspace/src/app.ts", content: "first" },
        { path: "/workspace/src/app.ts", content: "second" },
        { path: "/workspace/src/other.ts", content: "other" },
      ]);

      expect(repo.activeFiles.map((file) => file.content)).toEqual(["first", "other"]);
    });
  });

  describe("setRecentFile", () => {
    it("updates recentFile without changing prompt attachments", () => {
      const repo = new ContextRepositoryWriter();
      repo.attachFile({ path: "/workspace/prompt.ts", content: "prompt" });

      repo.setRecentFile({ path: "/workspace/recent.ts", content: "recent" });

      expect(repo.recentFile?.path).toBe("/workspace/recent.ts");
      expect(repo.attachedFiles.map((f) => f.path)).toEqual(["/workspace/prompt.ts"]);
    });

    it("keeps recentFile when given undefined or a file without a path", () => {
      const repo = new ContextRepositoryWriter();
      repo.setRecentFile({ path: "/workspace/recent.ts", content: "recent" });

      repo.setRecentFile(undefined);
      repo.setRecentFile({ content: "no path" });

      expect(repo.recentFile?.path).toBe("/workspace/recent.ts");
    });

    it("clears recentFile explicitly", () => {
      const repo = new ContextRepositoryWriter();
      repo.setRecentFile({ path: "/workspace/recent.ts", content: "recent" });

      repo.clearRecentFile();

      expect(repo.recentFile).toBeUndefined();
    });
  });

  describe("removeFile", () => {
    it("removes prompt-attached files without clearing recentFile", () => {
      const repo = new ContextRepositoryWriter();
      repo.setRecentFile({ path: "/workspace/a.ts", content: "a" });
      repo.attachFile({ path: "/workspace/a.ts", content: "attached a" });
      repo.attachFile({ path: "/workspace/b.ts", content: "b" });

      repo.removeFile("/workspace/a.ts");

      expect(repo.recentFile?.path).toBe("/workspace/a.ts");
      expect(repo.attachedFiles.map((f) => f.path)).toEqual(["/workspace/b.ts"]);
    });
  });

  describe("attachUrl", () => {
    it("dedupes urls by url string", () => {
      const repo = new ContextRepositoryWriter();
      repo.attachUrl({
        status: "attached",
        url: "https://example.com/a",
        content: "x",
      });
      repo.attachUrl({
        status: "attached",
        url: "https://example.com/a",
        content: "y",
      });
      expect(repo.attachedUrls).toHaveLength(1);
    });
  });

  describe("reset", () => {
    it("clears attached files and urls", () => {
      const repo = new ContextRepositoryWriter();
      repo.attachFile({ path: "/workspace/a.ts", content: "a" });
      repo.attachUrl({
        status: "attached",
        url: "https://example.com/a",
        content: "x",
      });

      repo.reset();

      expect(repo.attachedFiles).toEqual([]);
      expect(repo.attachedUrls).toEqual([]);
    });
  });
});
