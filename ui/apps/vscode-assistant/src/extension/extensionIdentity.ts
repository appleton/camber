import * as vscode from "vscode";

// Default/legacy production id, used only as the pre-activation seed and in
// tests. The authoritative id at runtime comes from `context.extension.id`
// (see main.ts) and can differ when we publish under a new marketplace name.
export const CAMBER_EXTENSION_ID = "appleton.camber-assistant";
export const CAMBER_NAME = "camber";
export const CAMBER_DEV_NAME = "camber-dev";
export type CamberName = typeof CAMBER_NAME | typeof CAMBER_DEV_NAME;
export let CAMBER: CamberName = CAMBER_NAME;

export interface ExtensionIdentity {
  extensionId: string;
  camberName: CamberName;
  isDev: boolean;
  assistantTitle: string;
  viewTitle: string;
  devPortEnvName: "VITE_DEV_PORT" | "CAMBER_DEV_VITE_DEV_PORT";
  helperOutputChannelName: string;
  telemetryOutputChannelName: CamberName;
}

function titleForCamberName(camberName: ExtensionIdentity["camberName"]): string {
  return camberName === CAMBER_DEV_NAME ? "Camber Dev" : "Camber";
}

function buildIdentity(extensionId: string): ExtensionIdentity {
  // Detect the dev variant by suffix so any published marketplace name works
  // (a rename to `appleton.<new-name>` keeps a `<new-name>-dev` dev build).
  const isDev = extensionId.endsWith("-dev");
  const camberName = isDev ? CAMBER_DEV_NAME : CAMBER_NAME;
  const title = titleForCamberName(camberName);

  return {
    // Pass through the real runtime id (from `context.extension.id`) so
    // marketplace / settings deep-links resolve under whatever name we ship as.
    extensionId,
    camberName,
    isDev,
    assistantTitle: isDev ? title : "Camber Assistant",
    viewTitle: title,
    devPortEnvName: isDev ? "CAMBER_DEV_VITE_DEV_PORT" : "VITE_DEV_PORT",
    helperOutputChannelName: isDev ? "camber Helper-dev" : "camber Helper",
    telemetryOutputChannelName: camberName,
  };
}

let currentIdentity = buildIdentity(CAMBER_EXTENSION_ID);

export function configureExtensionIdentity(extensionId: string): ExtensionIdentity {
  currentIdentity = buildIdentity(extensionId);
  CAMBER = currentIdentity.camberName;
  return currentIdentity;
}

export function getExtensionIdentity(): ExtensionIdentity {
  return currentIdentity;
}

export function camberConfigurationKey(key: string): string {
  if (key.startsWith("camber.")) {
    return `${CAMBER}.${key.slice("camber.".length)}`;
  }
  return key;
}

export function camberConfigurationSection(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CAMBER);
}
