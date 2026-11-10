// cSpell:ignore helperapi
import type { SearchSymbolDefinitionsParams } from "@camber/helperapi/schemas";
import { createVSCodeMock } from "jest-mock-vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { searchSymbolDefinitions } from "./searchSymbolDefinitions";

vi.mock("vscode", () => createVSCodeMock(vi));

describe("searchSymbolDefinitions", () => {
  let mockExecuteCommand: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    mockExecuteCommand = vi.fn();
    vscode.commands.executeCommand = mockExecuteCommand;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy.mockRestore();
  });

  const createMockSymbol = (
    name: string,
    kind: number,
    path: string,
    startLine: number = 0,
    endLine: number = 0,
    startChar: number = 0,
    endChar: number = 0,
  ): vscode.SymbolInformation => ({
    name,
    kind,
    location: {
      uri: { fsPath: path } as vscode.Uri,
      range: {
        start: { line: startLine, character: startChar } as vscode.Position,
        end: { line: endLine, character: endChar } as vscode.Position,
      } as vscode.Range,
    } as vscode.Location,
    containerName: "",
    tags: [],
  });

  describe("searchSymbolDefinitions()", () => {
    it("should return function symbols when searching for functions", async () => {
      const mockSymbols = [
        createMockSymbol(
          "testFunction",
          vscode.SymbolKind.Function,
          "/test/file.ts",
          10,
          20,
          0,
          12,
        ),
        createMockSymbol(
          "helperFunction",
          vscode.SymbolKind.Function,
          "/test/helper.ts",
          5,
          15,
          0,
          14,
        ),
      ];

      mockExecuteCommand.mockResolvedValue(mockSymbols);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "testFunction",
        type: "function",
      };

      const result = await searchSymbolDefinitions(params);

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        "vscode.executeWorkspaceSymbolProvider",
        "testFunction",
      );
      expect(result.defs).toHaveLength(2);
      expect(result.defs[0]).toEqual({
        name: "testFunction",
        type: "function",
        path: "/test/file.ts",
        startLine: 10,
        endLine: 20,
        startCol: 0,
        endCol: 12,
        startOffset: 0,
        endOffset: 0,
        signature: "testFunction",
        body: "",
        comment: "",
        receiver: "",
        async: false,
        isTest: false,
      });
    });

    it("should return method symbols when searching for methods", async () => {
      const mockSymbols = [
        createMockSymbol("testMethod", vscode.SymbolKind.Method, "/test/class.ts", 25, 35, 4, 14),
      ];

      mockExecuteCommand.mockResolvedValue(mockSymbols);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "testMethod",
        type: "method",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(1);
      expect(result.defs[0].type).toBe("method");
      expect(result.defs[0].name).toBe("testMethod");
    });

    it("should return type symbols for classes, interfaces, enums, and structs", async () => {
      const mockSymbols = [
        createMockSymbol("TestClass", vscode.SymbolKind.Class, "/test/class.ts"),
        createMockSymbol("TestInterface", vscode.SymbolKind.Interface, "/test/interface.ts"),
        createMockSymbol("TestEnum", vscode.SymbolKind.Enum, "/test/enum.ts"),
        createMockSymbol("TestStruct", vscode.SymbolKind.Struct, "/test/struct.ts"),
      ];

      mockExecuteCommand.mockResolvedValue(mockSymbols);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "Test",
        type: "type",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(4);
      result.defs.forEach((def) => {
        expect(def.type).toBe("type");
      });
    });

    it("should return import symbols for modules and namespaces", async () => {
      const mockSymbols = [
        createMockSymbol("testModule", vscode.SymbolKind.Module, "/test/module.ts"),
        createMockSymbol("testNamespace", vscode.SymbolKind.Namespace, "/test/namespace.ts"),
      ];

      mockExecuteCommand.mockResolvedValue(mockSymbols);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "test",
        type: "import",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(2);
      result.defs.forEach((def) => {
        expect(def.type).toBe("import");
      });
    });

    it("should return package symbols", async () => {
      const mockSymbols = [
        createMockSymbol("testPackage", vscode.SymbolKind.Package, "/test/package.ts"),
      ];

      mockExecuteCommand.mockResolvedValue(mockSymbols);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "testPackage",
        type: "package",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(1);
      expect(result.defs[0].type).toBe("package");
    });

    it("should return all symbols when type is 'all'", async () => {
      const mockSymbols = [
        createMockSymbol("testFunction", vscode.SymbolKind.Function, "/test/file.ts"),
        createMockSymbol("TestClass", vscode.SymbolKind.Class, "/test/class.ts"),
        createMockSymbol("testModule", vscode.SymbolKind.Module, "/test/module.ts"),
        createMockSymbol("unknownSymbol", vscode.SymbolKind.Variable, "/test/var.ts"), // Should be filtered out
      ];

      mockExecuteCommand.mockResolvedValue(mockSymbols);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "test",
        type: "all",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(3); // Variable should be filtered out
      expect(result.defs.map((def) => def.name)).toEqual([
        "testFunction",
        "TestClass",
        "testModule",
      ]);
    });

    it("should return all symbols when type is not specified", async () => {
      const mockSymbols = [
        createMockSymbol("testFunction", vscode.SymbolKind.Function, "/test/file.ts"),
        createMockSymbol("TestClass", vscode.SymbolKind.Class, "/test/class.ts"),
      ];

      mockExecuteCommand.mockResolvedValue(mockSymbols);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "test",
        type: "",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(2);
    });

    it("should filter out symbols with unsupported types", async () => {
      const mockSymbols = [
        createMockSymbol("testFunction", vscode.SymbolKind.Function, "/test/file.ts"),
        createMockSymbol("testVariable", vscode.SymbolKind.Variable, "/test/var.ts"),
        createMockSymbol("testProperty", vscode.SymbolKind.Property, "/test/prop.ts"),
        createMockSymbol("TestClass", vscode.SymbolKind.Class, "/test/class.ts"),
      ];

      mockExecuteCommand.mockResolvedValue(mockSymbols);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "test",
        type: "all",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(2); // Only function and class should be included
      expect(result.defs.map((def) => def.name)).toEqual(["testFunction", "TestClass"]);
    });

    it("should return empty array when no symbols match the type filter", async () => {
      const mockSymbols = [
        createMockSymbol("testVariable", vscode.SymbolKind.Variable, "/test/var.ts"),
      ];

      mockExecuteCommand.mockResolvedValue(mockSymbols);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "test",
        type: "function",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(0);
    });

    it("should return empty array when no symbols are found", async () => {
      mockExecuteCommand.mockResolvedValue([]);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "nonexistent",
        type: "function",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(0);
    });

    it("should handle VSCode command execution errors gracefully", async () => {
      const error = new Error("VSCode command failed");
      mockExecuteCommand.mockRejectedValue(error);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "test",
        type: "function",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith("Error searching symbol definitions:", error);
    });

    it("should handle null or undefined symbols response", async () => {
      mockExecuteCommand.mockResolvedValue(null);

      const params: SearchSymbolDefinitionsParams = {
        symbol: "test",
        type: "function",
      };

      const result = await searchSymbolDefinitions(params);

      expect(result.defs).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe("getSymbolTypeString()", () => {
    it("should map symbol kinds correctly", async () => {
      const testCases = [
        { kind: vscode.SymbolKind.Function, expectedType: "function" },
        { kind: vscode.SymbolKind.Method, expectedType: "method" },
        { kind: vscode.SymbolKind.Class, expectedType: "type" },
        { kind: vscode.SymbolKind.Interface, expectedType: "type" },
        { kind: vscode.SymbolKind.Enum, expectedType: "type" },
        { kind: vscode.SymbolKind.Struct, expectedType: "type" },
        { kind: vscode.SymbolKind.Module, expectedType: "import" },
        { kind: vscode.SymbolKind.Namespace, expectedType: "import" },
        { kind: vscode.SymbolKind.Package, expectedType: "package" },
      ];

      for (const { kind, expectedType } of testCases) {
        const mockSymbols = [createMockSymbol("testSymbol", kind, "/test/file.ts")];
        mockExecuteCommand.mockResolvedValue(mockSymbols);

        const params: SearchSymbolDefinitionsParams = {
          symbol: "test",
          type: "all",
        };

        const result = await searchSymbolDefinitions(params);

        expect(result.defs).toHaveLength(1);
        expect(result.defs[0].type).toBe(expectedType);
      }
    });
  });
});
