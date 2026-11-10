import { createTextDocument, createVSCodeMock } from "jest-mock-vscode";
import * as vscode from "vscode";
import { Range, Uri } from "vscode";
import { DecorationProvider } from "./DecorationProvider";

vi.mock("vscode", () => createVSCodeMock(vi));

describe("DecorationProvider", () => {
  let provider: DecorationProvider;
  let mockEditor: vscode.TextEditor;
  let mockDecorationType: vscode.TextEditorDecorationType;

  beforeEach(() => {
    provider = new DecorationProvider();

    const doc = createTextDocument(Uri.file("/test/file.ts"), "test content");
    mockEditor = {
      document: doc,
      setDecorations: vi.fn(),
    } as Partial<vscode.TextEditor> as vscode.TextEditor;

    mockDecorationType = {
      dispose: vi.fn(),
    } as Partial<vscode.TextEditorDecorationType> as vscode.TextEditorDecorationType;

    vi.mocked(vscode.window).createTextEditorDecorationType = vi
      .fn()
      .mockReturnValue(mockDecorationType);
    vi.mocked(vscode.window).visibleTextEditors = [mockEditor];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("initializes with empty maps", () => {
      const newProvider = new DecorationProvider();
      expect(newProvider).toBeInstanceOf(DecorationProvider);
    });
  });

  describe("setInserts", () => {
    it("sets new insert locations and applies decorations", async () => {
      const locations = new Map([
        [
          mockEditor.document.uri.fsPath,
          {
            lines: [new Range(0, 0, 0, 10)],
            inner: [new Range(1, 0, 1, 5)],
          },
        ],
      ]);

      await provider.setInserts(locations);

      expect(vscode.window.createTextEditorDecorationType).toHaveBeenCalledTimes(2);
      expect(mockEditor.setDecorations).toHaveBeenCalledTimes(2);
    });

    it("clears existing decorations before setting new ones", async () => {
      const initialLocations = new Map([
        [
          mockEditor.document.uri.fsPath,
          {
            lines: [new Range(0, 0, 0, 5)],
            inner: [],
          },
        ],
      ]);

      await provider.setInserts(initialLocations);
      const firstDecorationType = vi.mocked(vscode.window.createTextEditorDecorationType).mock
        .results[0].value;

      const newLocations = new Map([
        [
          mockEditor.document.uri.fsPath,
          {
            lines: [new Range(2, 0, 2, 10)],
            inner: [],
          },
        ],
      ]);

      await provider.setInserts(newLocations);

      expect(firstDecorationType.dispose).toHaveBeenCalled();
    });
  });

  describe("applyInserts", () => {
    it("creates decorations with correct theme colors", async () => {
      const locations = new Map([
        [
          mockEditor.document.uri.fsPath,
          {
            lines: [new Range(0, 0, 0, 10)],
            inner: [],
          },
        ],
      ]);

      await provider.setInserts(locations);

      expect(vscode.window.createTextEditorDecorationType).toHaveBeenCalledWith({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
        borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
      });
    });

    it("sets hover message with camber branding", async () => {
      const locations = new Map([
        [
          mockEditor.document.uri.fsPath,
          {
            lines: [new Range(0, 0, 0, 10)],
            inner: [],
          },
        ],
      ]);

      await provider.setInserts(locations);

      expect(mockEditor.setDecorations).toHaveBeenCalledWith(
        expect.any(Object),
        expect.arrayContaining([
          expect.objectContaining({
            hoverMessage: expect.objectContaining({
              value: "$(camber-roundel) Edited by camber",
            }),
          }),
        ]),
      );
    });

    it("skips editors without matching locations", async () => {
      const anotherDoc = createTextDocument(Uri.file("/other/file.ts"), "other content");
      const anotherEditor = {
        document: anotherDoc,
        setDecorations: vi.fn(),
      } as Partial<vscode.TextEditor> as vscode.TextEditor;
      vi.mocked(vscode.window).visibleTextEditors = [mockEditor, anotherEditor];

      const locations = new Map([
        [
          mockEditor.document.uri.fsPath,
          {
            lines: [new Range(0, 0, 0, 10)],
            inner: [],
          },
        ],
      ]);

      await provider.setInserts(locations);

      expect(anotherEditor.setDecorations).not.toHaveBeenCalled();
    });

    it("applies both line and inner decorations when present", async () => {
      const locations = new Map([
        [
          mockEditor.document.uri.fsPath,
          {
            lines: [new Range(0, 0, 0, 10)],
            inner: [new Range(1, 2, 1, 8)],
          },
        ],
      ]);

      await provider.setInserts(locations);

      expect(mockEditor.setDecorations).toHaveBeenCalledTimes(2);
      expect(vscode.window.createTextEditorDecorationType).toHaveBeenCalledWith({
        isWholeLine: false,
        backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
        borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
      });
    });
  });

  describe("deleteAllInserts", () => {
    it("deletes all decorations and locations", async () => {
      const locations = new Map([
        ["/test/file1.ts", { lines: [new Range(0, 0, 0, 5)], inner: [] }],
        ["/test/file2.ts", { lines: [new Range(0, 0, 0, 5)], inner: [] }],
      ]);

      await provider.setInserts(locations);
      const decorationTypes = vi
        .mocked(vscode.window.createTextEditorDecorationType)
        .mock.results.map((r) => r.value);

      provider.deleteAllInserts();

      decorationTypes.forEach((dt) => {
        expect(dt.dispose).toHaveBeenCalled();
      });
    });
  });

  describe("deleteInserts", () => {
    it("removes specific path decorations and locations", async () => {
      const locations = new Map([
        [
          mockEditor.document.uri.fsPath,
          {
            lines: [new Range(0, 0, 0, 10)],
            inner: [],
          },
        ],
      ]);

      await provider.setInserts(locations);
      const decorationType = vi.mocked(vscode.window.createTextEditorDecorationType).mock.results[0]
        .value;

      provider.deleteInserts(mockEditor.document.uri.fsPath);

      expect(decorationType.dispose).toHaveBeenCalled();
    });

    it("handles non-existent paths gracefully", () => {
      expect(() => {
        provider.deleteInserts("/non/existent/path.ts");
      }).not.toThrow();
    });
  });

  describe("hideInserts", () => {
    it("disposes decorations but keeps locations", async () => {
      const locations = new Map([
        [
          mockEditor.document.uri.fsPath,
          {
            lines: [new Range(0, 0, 0, 10)],
            inner: [],
          },
        ],
      ]);

      await provider.setInserts(locations);
      const decorationType = vi.mocked(vscode.window.createTextEditorDecorationType).mock.results[0]
        .value;

      provider.hideInserts(mockEditor.document.uri.fsPath);

      expect(decorationType.dispose).toHaveBeenCalled();
    });

    it("handles paths without decorations", () => {
      expect(() => {
        provider.hideInserts("/test/file.ts");
      }).not.toThrow();
    });
  });
});
