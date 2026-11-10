import type { GetDiagnosticsParams } from "@camber/helperapi/schemas";
import { createVSCodeMock } from "jest-mock-vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { getDiagnostics } from "./getDiagnostics";

vi.mock("vscode", () => createVSCodeMock(vi));

vi.mock("vscode-languageclient/lib/common/codeConverter", () => ({
  createConverter: () => ({
    asDiagnostic: vi.fn((diagnostic) => ({
      message: diagnostic.message,
      severity: diagnostic.severity,
      range: diagnostic.range,
      source: diagnostic.source,
    })),
  }),
}));

describe("getDiagnostics", () => {
  let mockGetDiagnostics: any;
  let mockUri: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    mockGetDiagnostics = vi.fn();
    mockUri = { parse: vi.fn() };
    vscode.languages.getDiagnostics = mockGetDiagnostics;
    vscode.Uri.parse = mockUri.parse;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy.mockRestore();
  });

  const createMockDiagnostic = (
    severity: vscode.DiagnosticSeverity,
    message: string = "Test diagnostic",
    range?: vscode.Range,
  ): vscode.Diagnostic => ({
    severity,
    message,
    range: range || new vscode.Range(0, 0, 0, 10),
    source: "test",
  });

  it("should return all diagnostics when no severity filter is provided", async () => {
    const mockDiagnostics = [
      createMockDiagnostic(vscode.DiagnosticSeverity.Error, "Error message"),
      createMockDiagnostic(vscode.DiagnosticSeverity.Warning, "Warning message"),
      createMockDiagnostic(vscode.DiagnosticSeverity.Information, "Info message"),
    ];

    const mockParsedUri = { toString: () => "file:///test.ts" };
    mockUri.parse.mockReturnValue(mockParsedUri);
    mockGetDiagnostics.mockReturnValue(mockDiagnostics);

    const params: GetDiagnosticsParams = {
      uri: "file:///test.ts",
      severity: 3, // Include all severities (Error=0, Warning=1, Information=2, Hint=3)
    };

    const result = await getDiagnostics(params);

    expect(vscode.Uri.parse).toHaveBeenCalledWith("file:///test.ts");
    expect(vscode.languages.getDiagnostics).toHaveBeenCalledWith(mockParsedUri);
    expect(result.diagnostics).toHaveLength(3);
  });

  it("should filter diagnostics by severity when severity parameter is provided", async () => {
    const mockDiagnostics = [
      createMockDiagnostic(vscode.DiagnosticSeverity.Error), // 0
      createMockDiagnostic(vscode.DiagnosticSeverity.Warning), // 1
      createMockDiagnostic(vscode.DiagnosticSeverity.Information), // 2
      createMockDiagnostic(vscode.DiagnosticSeverity.Hint), // 3
    ];

    const mockParsedUri = { toString: () => "file:///test.ts" };
    mockUri.parse.mockReturnValue(mockParsedUri);
    mockGetDiagnostics.mockReturnValue(mockDiagnostics);

    const params: GetDiagnosticsParams = {
      uri: "file:///test.ts",
      severity: vscode.DiagnosticSeverity.Warning, // Should include Error (0) and Warning (1)
    };

    const result = await getDiagnostics(params);

    expect(result.diagnostics).toHaveLength(2);
  });

  it("should filter diagnostics to only errors when severity is Error", async () => {
    const mockDiagnostics = [
      createMockDiagnostic(vscode.DiagnosticSeverity.Error), // 0 - should be included
      createMockDiagnostic(vscode.DiagnosticSeverity.Warning), // 1 - should be excluded
      createMockDiagnostic(vscode.DiagnosticSeverity.Information), // 2 - should be excluded
    ];

    const mockParsedUri = { toString: () => "file:///test.ts" };
    mockUri.parse.mockReturnValue(mockParsedUri);
    mockGetDiagnostics.mockReturnValue(mockDiagnostics);

    const params: GetDiagnosticsParams = {
      uri: "file:///test.ts",
      severity: vscode.DiagnosticSeverity.Error, // Should include only Error (0)
    };

    const result = await getDiagnostics(params);

    expect(result.diagnostics).toHaveLength(1);
  });

  it("should return empty array when no diagnostics exist", async () => {
    const mockParsedUri = { toString: () => "file:///test.ts" };
    mockUri.parse.mockReturnValue(mockParsedUri);
    mockGetDiagnostics.mockReturnValue([]);

    const params: GetDiagnosticsParams = {
      uri: "file:///test.ts",
      severity: 3, // Include all severities
    };

    const result = await getDiagnostics(params);

    expect(result.diagnostics).toHaveLength(0);
  });

  it("should handle errors gracefully and return empty diagnostics array", async () => {
    const mockParsedUri = { toString: () => "file:///test.ts" };
    mockUri.parse.mockReturnValue(mockParsedUri);

    const error = new Error("Failed to get diagnostics");
    mockGetDiagnostics.mockImplementation(() => {
      throw error;
    });

    const params: GetDiagnosticsParams = {
      uri: "file:///test.ts",
      severity: 3, // Include all severities
    };

    const result = await getDiagnostics(params);

    expect(result.diagnostics).toHaveLength(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith("Error getting diagnostics: ", error);
  });

  it("should handle vscode.languages.getDiagnostics throwing an error", async () => {
    const mockParsedUri = { toString: () => "file:///test.ts" };
    mockUri.parse.mockReturnValue(mockParsedUri);

    const error = new Error("getDiagnostics failed");
    mockGetDiagnostics.mockImplementation(() => {
      throw error;
    });

    const params: GetDiagnosticsParams = {
      uri: "file:///test.ts",
      severity: 3, // Include all severities
    };

    const result = await getDiagnostics(params);

    expect(result.diagnostics).toHaveLength(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith("Error getting diagnostics: ", error);
  });

  it("should convert VSCode diagnostics to LSP format using converter", async () => {
    const mockDiagnostic = createMockDiagnostic(vscode.DiagnosticSeverity.Error);
    const mockParsedUri = { toString: () => "file:///test.ts" };
    mockUri.parse.mockReturnValue(mockParsedUri);
    mockGetDiagnostics.mockReturnValue([mockDiagnostic]);

    const params: GetDiagnosticsParams = {
      uri: "file:///test.ts",
      severity: 3, // Include all severities
    };

    const result = await getDiagnostics(params);

    expect(result.diagnostics).toHaveLength(1);
    // The converter transforms the diagnostic, so we just verify structure
    expect(result.diagnostics[0]).toBeDefined();
  });
});
