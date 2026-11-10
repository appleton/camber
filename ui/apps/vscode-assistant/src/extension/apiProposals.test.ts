import * as commentJSON from "comment-json";
import { createVSCodeMock } from "jest-mock-vscode";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ensureEnabled } from "./apiProposals";

const homedir = "/home/testuser";

vi.mock("os", () => ({
  homedir: () => homedir,
}));

const ApiProposalStatus = {
  unknown: 0,
  enabled: 1,
  disabled: 2,
  pendingRestart: 3,
} as const;

vi.mock("./system", () => ({
  ApiProposalStatus: {
    unknown: 0,
    enabled: 1,
    disabled: 2,
    pendingRestart: 3,
  },
}));

const mockConfigUpdate = vi.fn().mockResolvedValue(undefined);

vi.mock("vscode", () => {
  const mock = createVSCodeMock(vi);
  return {
    ...mock,
    env: {
      remoteName: undefined,
      appName: "Visual Studio Code",
    },
    workspace: {
      ...mock.workspace,
      fs: {
        stat: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
      },
      getConfiguration: vi.fn(() => ({
        get: vi.fn().mockReturnValue("native"),
        inspect: vi.fn().mockReturnValue({ globalValue: "native" }),
        update: mockConfigUpdate,
      })),
    },
  };
});

describe("apiProposals", () => {
  const extensionId = "appleton.camber-assistant";

  let mockSystem: {
    context: { extension: { id: string } };
    setApiProposalStatus: ReturnType<typeof vi.fn>;
  };

  let writtenFiles: Map<string, string>;
  let existingDirs: Set<string>;
  let existingFiles: Map<string, string>;

  beforeEach(() => {
    mockSystem = {
      context: { extension: { id: extensionId } },
      setApiProposalStatus: vi.fn(),
    };

    writtenFiles = new Map();
    existingDirs = new Set();
    existingFiles = new Map();

    // Reset env
    (vscode.env as any).remoteName = undefined;
    (vscode.env as any).appName = "Visual Studio Code";

    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async (uri: vscode.Uri) => {
      const uriPath = uri.fsPath || uri.path;
      if (existingDirs.has(uriPath) || existingFiles.has(uriPath)) {
        return { type: vscode.FileType.Directory } as vscode.FileStat;
      }
      throw new Error("ENOENT");
    });

    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: vscode.Uri) => {
      const uriPath = uri.fsPath || uri.path;
      const content = existingFiles.get(uriPath);
      if (content) {
        return new TextEncoder().encode(content);
      }
      throw new Error("ENOENT");
    });

    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(
      async (uri: vscode.Uri, content: Uint8Array) => {
        const uriPath = uri.fsPath || uri.path;
        writtenFiles.set(uriPath, new TextDecoder().decode(content));
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("ensureEnabled", () => {
    it("sets disabled status in remote environment", async () => {
      (vscode.env as any).remoteName = "ssh-remote";

      await ensureEnabled(mockSystem as any);

      expect(mockSystem.setApiProposalStatus).toHaveBeenCalledWith(ApiProposalStatus.disabled);
      expect(writtenFiles.size).toBe(0);
    });

    it("sets enabled status when already enabled in all config dirs", async () => {
      existingDirs.add(path.join(homedir, ".vscode"));
      existingFiles.set(
        path.join(homedir, ".vscode", "argv.json"),
        JSON.stringify({ "enable-proposed-api": [extensionId] }),
      );

      await ensureEnabled(mockSystem as any);

      expect(mockSystem.setApiProposalStatus).toHaveBeenCalledWith(ApiProposalStatus.enabled);
      expect(writtenFiles.size).toBe(0);
    });

    it("updates argv.json and sets pendingRestart when not enabled", async () => {
      existingDirs.add(path.join(homedir, ".vscode"));
      existingFiles.set(
        path.join(homedir, ".vscode", "argv.json"),
        JSON.stringify({ "enable-proposed-api": [] }),
      );

      await ensureEnabled(mockSystem as any);

      expect(mockSystem.setApiProposalStatus).toHaveBeenCalledWith(
        ApiProposalStatus.pendingRestart,
      );
      expect(writtenFiles.size).toBe(1);

      const writtenContent = writtenFiles.get(path.join(homedir, ".vscode", "argv.json"));
      expect(writtenContent).toBeDefined();
      const parsed = JSON.parse(writtenContent!);
      expect(parsed["enable-proposed-api"]).toContain(extensionId);
    });

    it("creates default .vscode dir config when no config dirs exist", async () => {
      await ensureEnabled(mockSystem as any);

      expect(mockSystem.setApiProposalStatus).toHaveBeenCalledWith(
        ApiProposalStatus.pendingRestart,
      );
      expect(writtenFiles.has(path.join(homedir, ".vscode", "argv.json"))).toBe(true);
    });

    it("updates both .vscode and .vscode-insiders when both exist", async () => {
      existingDirs.add(path.join(homedir, ".vscode"));
      existingDirs.add(path.join(homedir, ".vscode-insiders"));
      existingFiles.set(
        path.join(homedir, ".vscode", "argv.json"),
        JSON.stringify({ "enable-proposed-api": [] }),
      );
      existingFiles.set(
        path.join(homedir, ".vscode-insiders", "argv.json"),
        JSON.stringify({ "enable-proposed-api": [] }),
      );

      await ensureEnabled(mockSystem as any);

      expect(writtenFiles.size).toBe(2);
      expect(writtenFiles.has(path.join(homedir, ".vscode", "argv.json"))).toBe(true);
      expect(writtenFiles.has(path.join(homedir, ".vscode-insiders", "argv.json"))).toBe(true);
    });

    it("only updates .vscode-insiders when only it exists", async () => {
      existingDirs.add(path.join(homedir, ".vscode-insiders"));
      existingFiles.set(
        path.join(homedir, ".vscode-insiders", "argv.json"),
        JSON.stringify({ "enable-proposed-api": [] }),
      );

      await ensureEnabled(mockSystem as any);

      expect(writtenFiles.size).toBe(1);
      expect(writtenFiles.has(path.join(homedir, ".vscode-insiders", "argv.json"))).toBe(true);
    });

    describe("restart behavior", () => {
      it("prompts restart for stable VSCode when .vscode is updated", async () => {
        (vscode.env as any).appName = "Visual Studio Code";
        existingDirs.add(path.join(homedir, ".vscode"));
        existingFiles.set(
          path.join(homedir, ".vscode", "argv.json"),
          JSON.stringify({ "enable-proposed-api": [] }),
        );

        await ensureEnabled(mockSystem as any);

        expect(mockSystem.setApiProposalStatus).toHaveBeenCalledWith(
          ApiProposalStatus.pendingRestart,
        );
        expect(mockConfigUpdate).toHaveBeenCalled();
      });

      it("does not prompt restart for stable VSCode when only .vscode-insiders is updated", async () => {
        (vscode.env as any).appName = "Visual Studio Code";
        existingDirs.add(path.join(homedir, ".vscode-insiders"));
        existingFiles.set(
          path.join(homedir, ".vscode-insiders", "argv.json"),
          JSON.stringify({ "enable-proposed-api": [] }),
        );

        await ensureEnabled(mockSystem as any);

        expect(mockSystem.setApiProposalStatus).toHaveBeenCalledWith(ApiProposalStatus.disabled);
        expect(mockConfigUpdate).not.toHaveBeenCalled();
      });

      it("prompts restart for Insiders when .vscode-insiders is updated", async () => {
        (vscode.env as any).appName = "Visual Studio Code - Insiders";
        existingDirs.add(path.join(homedir, ".vscode-insiders"));
        existingFiles.set(
          path.join(homedir, ".vscode-insiders", "argv.json"),
          JSON.stringify({ "enable-proposed-api": [] }),
        );

        await ensureEnabled(mockSystem as any);

        expect(mockSystem.setApiProposalStatus).toHaveBeenCalledWith(
          ApiProposalStatus.pendingRestart,
        );
        expect(mockConfigUpdate).toHaveBeenCalled();
      });

      it("prompts restart for Insiders when .vscode is updated (backwards compat)", async () => {
        (vscode.env as any).appName = "Visual Studio Code - Insiders";
        existingDirs.add(path.join(homedir, ".vscode"));
        existingFiles.set(
          path.join(homedir, ".vscode", "argv.json"),
          JSON.stringify({ "enable-proposed-api": [] }),
        );

        await ensureEnabled(mockSystem as any);

        expect(mockSystem.setApiProposalStatus).toHaveBeenCalledWith(
          ApiProposalStatus.pendingRestart,
        );
        expect(mockConfigUpdate).toHaveBeenCalled();
      });
    });

    it("preserves existing enable-proposed-api entries", async () => {
      const existingExtension = "other-extension.id";
      existingDirs.add(path.join(homedir, ".vscode"));
      existingFiles.set(
        path.join(homedir, ".vscode", "argv.json"),
        JSON.stringify({ "enable-proposed-api": [existingExtension] }),
      );

      await ensureEnabled(mockSystem as any);

      const writtenContent = writtenFiles.get(path.join(homedir, ".vscode", "argv.json"));
      const parsed = JSON.parse(writtenContent!);
      expect(parsed["enable-proposed-api"]).toContain(existingExtension);
      expect(parsed["enable-proposed-api"]).toContain(extensionId);
    });

    it("skips updating dir where extension is already enabled", async () => {
      existingDirs.add(path.join(homedir, ".vscode"));
      existingDirs.add(path.join(homedir, ".vscode-insiders"));
      existingFiles.set(
        path.join(homedir, ".vscode", "argv.json"),
        JSON.stringify({ "enable-proposed-api": [extensionId] }),
      );
      existingFiles.set(
        path.join(homedir, ".vscode-insiders", "argv.json"),
        JSON.stringify({ "enable-proposed-api": [] }),
      );

      await ensureEnabled(mockSystem as any);

      expect(writtenFiles.size).toBe(1);
      expect(writtenFiles.has(path.join(homedir, ".vscode", "argv.json"))).toBe(false);
      expect(writtenFiles.has(path.join(homedir, ".vscode-insiders", "argv.json"))).toBe(true);
    });

    it("handles malformed argv.json by creating valid config", async () => {
      existingDirs.add(path.join(homedir, ".vscode"));
      existingFiles.set(path.join(homedir, ".vscode", "argv.json"), "{ invalid json content");

      await ensureEnabled(mockSystem as any);

      expect(mockSystem.setApiProposalStatus).toHaveBeenCalledWith(
        ApiProposalStatus.pendingRestart,
      );
      expect(writtenFiles.size).toBe(1);

      const writtenContent = writtenFiles.get(path.join(homedir, ".vscode", "argv.json"));
      expect(writtenContent).toBeDefined();
      const parsed = commentJSON.parse(writtenContent!) as commentJSON.CommentObject;
      expect(parsed["enable-proposed-api"]).toContain(extensionId);
    });
  });
});
