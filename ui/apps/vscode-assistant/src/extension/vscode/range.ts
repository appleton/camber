// API ranges are 1 indexed
import { Range } from "vscode";

export interface LineRangeOneIndexed {
  startLine: number;
  endLine: number;
  oneIndexed: true;
}

/**
 * The camber API starts line number at 1, vscode at 0
 */
export function vscodeRangeToAPIRange(selection: Range): LineRangeOneIndexed {
  return {
    startLine: vscodeLineToAPILine(selection.start.line),
    endLine: vscodeLineToAPILine(selection.end.line),
    oneIndexed: true,
  };
}

export function vscodeLineToAPILine(line: number): number {
  return line + 1;
}
