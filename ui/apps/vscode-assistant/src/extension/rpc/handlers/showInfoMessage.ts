import { forceExhaustivenessCheck } from "@camber/assistant/shared/language";
import { InfoMessageType } from "@camber/rpc";
import * as vscode from "vscode";

export function showInfoMessage(message: string, typ: InfoMessageType = InfoMessageType.info) {
  switch (typ) {
    case InfoMessageType.info:
      vscode.window.showInformationMessage(`camber: ${message}`);
      break;
    case InfoMessageType.error:
      vscode.window.showErrorMessage(`camber: ${message}`);
      break;
    case InfoMessageType.warning:
      vscode.window.showWarningMessage(`camber: ${message}`);
      break;
    default:
      forceExhaustivenessCheck(typ);
  }
}
