import type {
  SearchSymbolDefinitionsOutput,
  SearchSymbolDefinitionsParams,
} from "@camber/helperapi/schemas";
import * as vscode from "vscode";

export async function searchSymbolDefinitions(
  params: SearchSymbolDefinitionsParams,
): Promise<SearchSymbolDefinitionsOutput> {
  try {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      params.symbol,
    );

    return {
      defs: symbols
        .map((symbol) => ({
          symbol,
          type: getSymbolTypeString(symbol.kind),
        }))
        .filter(({ type }) => {
          if (!type) return false;
          if (params.type && params.type !== "all") {
            return type === params.type;
          }
          return true;
        })
        .map(({ symbol, type }) => ({
          name: symbol.name,
          type: type!,
          path: symbol.location.uri.fsPath,
          startLine: symbol.location.range.start.line,
          endLine: symbol.location.range.end.line,
          startCol: symbol.location.range.start.character,
          endCol: symbol.location.range.end.character,
          startOffset: 0,
          endOffset: 0,
          signature: symbol.name,
          body: "",
          comment: "",
          receiver: "",
          async: false,
          isTest: false,
        })),
    };
  } catch (error) {
    console.error("Error searching symbol definitions:", error);
    return { defs: [] };
  }
}

function getSymbolTypeString(kind: vscode.SymbolKind): string | null {
  switch (kind) {
    case vscode.SymbolKind.Function:
      return "function";
    case vscode.SymbolKind.Method:
      return "method";
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Interface:
    case vscode.SymbolKind.Enum:
    case vscode.SymbolKind.Struct:
      return "type";
    case vscode.SymbolKind.Module:
    case vscode.SymbolKind.Namespace:
      return "import";
    case vscode.SymbolKind.Package:
      return "package";
    default:
      return null;
  }
}
