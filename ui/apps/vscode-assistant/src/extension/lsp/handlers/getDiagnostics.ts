import type { GetDiagnosticsOutput, GetDiagnosticsParams } from "@camber/helperapi/schemas";
import { withTimeout } from "@camber/lib/promise";
import * as vscode from "vscode";
import { createConverter } from "vscode-languageclient/lib/common/codeConverter";

// getDiagnostics returns diagnostic information for the given URI.
//
// Diagnostics are published asynchoronously some time after a file edit. If the caller knows that
// an edit has recently happend it can optionally pass a waitMs param and getDiagnostics will wait
// for either new diagnostics to be published for the given URI, or the waitMs timeout (whichever
// is sooner) before reading and retuning diagnostics.
export async function getDiagnostics(params: GetDiagnosticsParams): Promise<GetDiagnosticsOutput> {
  const uri = vscode.Uri.parse(params.uri);

  if (params.waitMs) {
    const disposable = await withTimeout((resolve) => {
      return vscode.languages.onDidChangeDiagnostics((e: vscode.DiagnosticChangeEvent) => {
        if (e.uris.some((u) => u.fsPath === uri.fsPath)) resolve();
      });
    }, params.waitMs);
    disposable.dispose();
  }

  try {
    let diagnostics = vscode.languages.getDiagnostics(uri);
    if (params.severity != null) {
      diagnostics = diagnostics.filter((d) => d.severity <= params.severity);
    }
    const converter = createConverter(undefined);
    return { diagnostics: diagnostics.map(converter.asDiagnostic) };
  } catch (error) {
    console.error("Error getting diagnostics: ", error);
    return { diagnostics: [] };
  }
}
