import { createMockTabGroups, createTextDocument, createVSCodeMock } from "jest-mock-vscode";
import * as os from "os";
import * as path from "path";
import { vi } from "vitest";
import * as vscode from "vscode";
import { Uri } from "vscode";
import { getWorkspaces, sendActiveFileContext } from "./context";
import type { System } from "./system";

let mockWorkspaceFolders: vscode.WorkspaceFolder[] | undefined = undefined;
let mockDefaultWorkingDirectory: string | undefined = undefined;
let getDefaultCwd: typeof import("./context").getDefaultCwd;

const { mockMkdirSync } = vi.hoisted(() => ({ mockMkdirSync: vi.fn() }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, mkdirSync: mockMkdirSync };
});

vi.mock("vscode", () => {
  const mock = createVSCodeMock(vi);
  return {
    ...mock,
    workspace: {
      ...mock.workspace,
      get workspaceFolders() {
        return mockWorkspaceFolders;
      },
      getConfiguration: () => ({
        get: (key: string) =>
          key === "defaultWorkingDirectory" ? mockDefaultWorkingDirectory : undefined,
      }),
    },
  };
});

vi.mock("./system", () => ({}));

vi.mock("./tabs", () => ({
  isDiffTab: (tab: vscode.Tab) => tab.input instanceof MockTabInputTextDiff,
  isTextTab: (tab: vscode.Tab) => tab.input instanceof MockTabInputText,
  isOpenInTab: (document: vscode.TextDocument) =>
    vscode.window.tabGroups.all.some((tabGroup) =>
      tabGroup.tabs.some(
        (tab) =>
          tab.input instanceof MockTabInputText && tab.input.uri.fsPath === document.uri.fsPath,
      ),
    ),
}));

vi.mock("./vscode/range", () => ({
  vscodeLineToAPILine: (line: number) => line + 1,
  vscodeRangeToAPIRange: (range: vscode.Range) => ({
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
  }),
}));

vi.mock("./vscode/uri", () => ({
  documentToContextPath: (doc: vscode.TextDocument) => ({
    absolute: doc.uri.fsPath,
  }),
}));

class MockTabInputText {
  constructor(public uri: vscode.Uri) {}
}

class MockTabInputWebview {
  constructor(public viewType: string) {}
}

class MockTabInputTextDiff {
  constructor(
    public original: vscode.Uri,
    public modified: vscode.Uri,
  ) {}
}

function createMockSystem() {
  return {
    assistant: {
      rpc: {
        setContext: vi.fn(),
      },
    },
    acpChatPanels: {
      setContext: vi.fn(),
    },
  } as unknown as System;
}

function setWorkspaceFolders(folders: vscode.WorkspaceFolder[] | undefined) {
  mockWorkspaceFolders = folders;
}

// The no-project working directory getDefaultCwd falls back to. Deriving it from the
// same platform check the implementation makes would only prove the test agrees with
// the implementation, so the platform is pinned per case below and each branch names
// the directory it expects.
const scratchDir = path.join(os.homedir(), ".poolside", "scratch");
const windowsLocalAppData = path.join("C:", "Users", "dev", "AppData", "Local");

const hostPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("context", () => {
  const rootUri = Uri.file("/test/workspace");

  beforeEach(async () => {
    vi.resetModules();
    ({ getDefaultCwd } = await import("./context"));
    vi.clearAllMocks();
    // clearAllMocks leaves implementations in place, so a test that makes the
    // scratch dir unwritable would otherwise leak into every test after it.
    mockMkdirSync.mockReset();
    // CI runs the unit tests on Linux only, so the Windows branch would never execute
    // unless a case asks for it. Pin the platform so each one picks its own branch.
    setPlatform("linux");
    mockWorkspaceFolders = undefined;
    mockDefaultWorkingDirectory = undefined;
    // @ts-ignore
    vscode.TabInputText = MockTabInputText;
    // @ts-ignore
    vscode.TabInputWebview = MockTabInputWebview;
    // @ts-ignore
    vscode.TabInputTextDiff = MockTabInputTextDiff;
  });

  afterEach(() => {
    setPlatform(hostPlatform);
    vi.unstubAllEnvs();
  });

  describe("getWorkspaces", () => {
    it("returns empty array when no workspace folders", () => {
      setWorkspaceFolders(undefined);
      expect(getWorkspaces()).toEqual([]);
    });

    it("maps workspace folders to path, name, and index", () => {
      setWorkspaceFolders([
        { uri: Uri.file("/workspace/one"), name: "one", index: 0 },
        { uri: Uri.file("/workspace/two"), name: "two", index: 1 },
      ] as vscode.WorkspaceFolder[]);

      expect(getWorkspaces()).toEqual([
        { path: "/workspace/one", name: "one", index: 0 },
        { path: "/workspace/two", name: "two", index: 1 },
      ]);
    });
  });

  describe("getDefaultCwd", () => {
    it("uses a dedicated scratch directory when no setting is configured", () => {
      mockDefaultWorkingDirectory = undefined;

      const cwd = getDefaultCwd();

      expect(cwd).toBe(scratchDir);
      expect(cwd).not.toBe(os.homedir());
      expect(mockMkdirSync).toHaveBeenCalledWith(scratchDir, { recursive: true });
    });

    it("uses the scratch directory when the setting is empty", () => {
      mockDefaultWorkingDirectory = "   ";

      expect(getDefaultCwd()).toBe(scratchDir);
    });

    it("uses the local app data scratch directory on Windows", () => {
      setPlatform("win32");
      vi.stubEnv("LOCALAPPDATA", windowsLocalAppData);
      mockDefaultWorkingDirectory = undefined;

      const cwd = getDefaultCwd();

      expect(cwd).toBe(path.join(windowsLocalAppData, "camber", "scratch"));
      expect(mockMkdirSync).toHaveBeenCalledWith(cwd, { recursive: true });
    });

    it("falls back to the home scratch directory when Windows has no LOCALAPPDATA", () => {
      setPlatform("win32");
      vi.stubEnv("LOCALAPPDATA", "");
      mockDefaultWorkingDirectory = undefined;

      expect(getDefaultCwd()).toBe(scratchDir);
    });

    it("returns the configured directory when set", () => {
      mockDefaultWorkingDirectory = "/custom/scratch";

      expect(getDefaultCwd()).toBe("/custom/scratch");
    });

    // The setting overrides the fallback, so it is not ours to create - and not ours to
    // replace with the temp directory either. Only the scratch fallback below is.
    it("leaves a configured directory alone when it does not exist", () => {
      mockDefaultWorkingDirectory = "/custom/scratch";
      mockMkdirSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      expect(getDefaultCwd()).toBe("/custom/scratch");
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    // Rooting the agent at the profile is what we are getting away from, so an
    // unwritable scratch dir must not silently fall back to the home directory.
    it("stays out of the home directory when the scratch dir cannot be created", () => {
      mockDefaultWorkingDirectory = undefined;
      mockMkdirSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      const cwd = getDefaultCwd();

      expect(cwd).toBe(os.tmpdir());
      expect(cwd).not.toBe(os.homedir());
    });

    // A synchronous mkdir on every cursor move is what resolving it once avoids.
    it("creates the scratch directory once, not on every context refresh", () => {
      mockDefaultWorkingDirectory = undefined;

      expect(getDefaultCwd()).toBe(scratchDir);
      expect(getDefaultCwd()).toBe(scratchDir);
      expect(getDefaultCwd()).toBe(scratchDir);

      expect(mockMkdirSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendActiveFileContext", () => {
    it("does not send context when active tab is a diff tab", async () => {
      const system = createMockSystem();

      const group = {
        isActive: true,
        viewColumn: 1,
        activeTab: {
          label: "diff",
          input: new MockTabInputTextDiff(
            Uri.file("/test/original.ts"),
            Uri.file("/test/modified.ts"),
          ),
          isActive: true,
          isDirty: false,
          isPinned: false,
          isPreview: false,
        } as vscode.Tab,
        tabs: [] as vscode.Tab[],
      };
      group.tabs = [group.activeTab];

      vi.mocked(vscode.window).tabGroups = createMockTabGroups(vi, [group]);

      await sendActiveFileContext(system);

      expect(system.assistant.rpc.setContext).not.toHaveBeenCalled();
      expect(system.acpChatPanels.setContext).not.toHaveBeenCalled();
    });

    it("sends context with no active files when active tab is a webview tab", async () => {
      const system = createMockSystem();

      const group = {
        isActive: true,
        viewColumn: 1,
        activeTab: {
          label: "webview",
          input: new MockTabInputWebview("someWebview"),
          isActive: true,
          isDirty: false,
          isPinned: false,
          isPreview: false,
        } as vscode.Tab,
        tabs: [] as vscode.Tab[],
      };
      group.tabs = [group.activeTab];

      vi.mocked(vscode.window).tabGroups = createMockTabGroups(vi, [group]);

      await sendActiveFileContext(system);

      expect(system.assistant.rpc.setContext).toHaveBeenCalledWith({
        workspaces: [],
        homeDirectory: os.homedir(),
        defaultCwd: scratchDir,
        activeFiles: [],
      });
      expect(system.acpChatPanels.setContext).toHaveBeenCalledWith({
        workspaces: [],
        homeDirectory: os.homedir(),
        defaultCwd: scratchDir,
        activeFiles: [],
      });
    });

    it("sends context with only workspaces when no active text editor", async () => {
      const system = createMockSystem();

      setWorkspaceFolders([
        { uri: Uri.file("/workspace"), name: "workspace", index: 0 },
      ] as vscode.WorkspaceFolder[]);

      const group = {
        isActive: true,
        viewColumn: 1,
        activeTab: undefined,
        tabs: [] as vscode.Tab[],
      };

      vi.mocked(vscode.window).tabGroups = createMockTabGroups(vi, [group]);
      vi.mocked(vscode.window).visibleTextEditors = [];

      await sendActiveFileContext(system);

      expect(system.assistant.rpc.setContext).toHaveBeenCalledWith({
        workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
        homeDirectory: os.homedir(),
        defaultCwd: scratchDir,
        activeFiles: [],
      });
      expect(system.acpChatPanels.setContext).toHaveBeenCalledWith({
        workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
        homeDirectory: os.homedir(),
        defaultCwd: scratchDir,
        activeFiles: [],
      });
    });

    it("sends context with active file details when text editor is active", async () => {
      const system = createMockSystem();

      setWorkspaceFolders([
        { uri: Uri.file("/workspace"), name: "workspace", index: 0 },
      ] as vscode.WorkspaceFolder[]);

      const doc = createTextDocument(
        Uri.joinPath(rootUri, "test.ts"),
        "const x = 1;\nconst y = 2;",
      );

      const group = {
        isActive: true,
        viewColumn: 1,
        activeTab: {
          label: "test.ts",
          input: new MockTabInputText(doc.uri),
          isActive: true,
          isDirty: false,
          isPinned: false,
          isPreview: false,
        } as vscode.Tab,
        tabs: [] as vscode.Tab[],
      };
      group.tabs = [group.activeTab];

      vi.mocked(vscode.window).tabGroups = createMockTabGroups(vi, [group]);

      const mockSelection = new vscode.Selection(0, 0, 1, 0);
      const mockVisibleRange = new vscode.Range(0, 0, 10, 0);

      vi.mocked(vscode.window).visibleTextEditors = [
        {
          document: doc,
          selection: mockSelection,
          visibleRanges: [mockVisibleRange],
        } as unknown as vscode.TextEditor,
      ];

      vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);

      await sendActiveFileContext(system);

      expect(system.assistant.rpc.setContext).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
          homeDirectory: os.homedir(),
          defaultCwd: scratchDir,
          recentFile: expect.objectContaining({
            content: "const x = 1;\nconst y = 2;",
            selectedCode: "const x = 1;\n",
            selection: [1, 2],
          }),
          activeFiles: [
            expect.objectContaining({
              content: "const x = 1;\nconst y = 2;",
              selectedCode: "const x = 1;\n",
              selection: [1, 2],
            }),
          ],
        }),
      );
      expect(system.acpChatPanels.setContext).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
          homeDirectory: os.homedir(),
          defaultCwd: scratchDir,
          recentFile: expect.objectContaining({
            content: "const x = 1;\nconst y = 2;",
            selectedCode: "const x = 1;\n",
            selection: [1, 2],
          }),
          activeFiles: [
            expect.objectContaining({
              content: "const x = 1;\nconst y = 2;",
              selectedCode: "const x = 1;\n",
              selection: [1, 2],
            }),
          ],
        }),
      );
    });
  });
});
