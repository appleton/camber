import type { CodeSymbol, CodeSymbolKind, CodeSymbolResponse } from "@camber/rpc";
import * as vscode from "vscode";

// These are the symbols kinds that we include.
const symbolClassifiation = new Map<vscode.SymbolKind, CodeSymbolKind>([
  [vscode.SymbolKind.Class, "type"],
  [vscode.SymbolKind.Constant, "value"],
  [vscode.SymbolKind.Enum, "type"],
  [vscode.SymbolKind.EnumMember, "value"],
  [vscode.SymbolKind.Field, "value"],
  [vscode.SymbolKind.Function, "code"],
  [vscode.SymbolKind.Interface, "type"],
  [vscode.SymbolKind.Method, "code"],
  [vscode.SymbolKind.Property, "value"],
  [vscode.SymbolKind.Struct, "type"],
  [vscode.SymbolKind.Variable, "value"],
]);

// These symbols kinds are only included if they are in lexical scope relative to the
// current cursor.
const symbolsOnlyInScope = new Set<vscode.SymbolKind>([vscode.SymbolKind.Variable]);

const noSymbols = { symbols: [] };

export async function getCodeSymbols(path?: string): Promise<CodeSymbolResponse> {
  let uri: vscode.Uri;
  let currentLine = 0;

  if (path) {
    uri = vscode.Uri.file(path);
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return noSymbols;
    const document = editor.document;
    uri = document.uri;
    currentLine = editor.selection.start.line;
  }

  const rootDocumentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    uri,
  );

  if (!rootDocumentSymbols) return noSymbols;
  return { symbols: collectSymbols(rootDocumentSymbols, currentLine) };
}

function collectSymbols(
  documentSymbols: vscode.DocumentSymbol[],
  currentLine: number,
  inScope = true,
  into: CodeSymbol[] = [],
  seen = new Set<string>(),
) {
  for (const symbol of documentSymbols) {
    // Include this symbol if it's a kind we recognize and, if necessary, in scope.
    const kind = symbolClassifiation.get(symbol.kind);
    if (kind && (inScope || !symbolsOnlyInScope.has(symbol.kind)) && !seen.has(symbol.name)) {
      into.push({
        name: symbol.name,
        kind,
      });
      seen.add(symbol.name);
    }

    // Visit child symbols; consider them to be in lexical scope if the current cursor
    // position is within the range of this parent symbol.
    const childrenInScope =
      currentLine >= symbol.range.start.line && currentLine <= symbol.range.end.line;
    collectSymbols(symbol.children, currentLine, childrenInScope, into, seen);
  }
  return into;
}
