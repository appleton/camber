import vscode from "vscode";
import { camberConfigurationKey, camberConfigurationSection } from "../extensionIdentity";
import type { CamberConfigurationProperties, CamberConfigurationProperty } from "../types/manifest";

function getConfigurationSections(key: CamberConfigurationProperty | string) {
  const resolvedKey = camberConfigurationKey(key);
  const lastDotIndex = resolvedKey.lastIndexOf(".");
  if (lastDotIndex === -1) return undefined;
  return [resolvedKey.substring(0, lastDotIndex), resolvedKey.substring(lastDotIndex + 1)] as const;
}

export function getConfiguration<K extends CamberConfigurationProperty>(
  key: K,
): CamberConfigurationProperties[K] | undefined;
export function getConfiguration<K extends CamberConfigurationProperty>(
  key: K,
  defaultValue: CamberConfigurationProperties[K],
): CamberConfigurationProperties[K];
export function getConfiguration<K extends CamberConfigurationProperty>(
  key: K,
  defaultValue?: CamberConfigurationProperties[K],
) {
  const sections = getConfigurationSections(key);
  if (!sections) return defaultValue;
  const [base, section] = sections;
  return vscode.workspace
    .getConfiguration(base)
    .get(section, defaultValue) as CamberConfigurationProperties[K];
}

export function affectsConfiguration(
  event: vscode.ConfigurationChangeEvent,
  key: CamberConfigurationProperty | string,
  scope?: vscode.ConfigurationScope,
) {
  return event.affectsConfiguration(camberConfigurationKey(key), scope);
}

export function getCamberConfigurationSection(): vscode.WorkspaceConfiguration {
  return camberConfigurationSection();
}
