import type { FileIconTheme } from "@camber/rpc";
import vscodeIconsUrl from "@iconify-json/vscode-icons/icons.json?url";
import iconThemeData from "vscode-icons-js/data/generated/icons.json";
import languageData from "vscode-icons-js/data/static/languages-vscode.json";

type IconifyIcon = {
  body: string;
  width?: number;
  height?: number;
};

type IconifyCollection = {
  icons: Record<string, IconifyIcon>;
};

type VSCodeIconDefinition = {
  iconPath: string;
};

type VSCodeIconThemeData = {
  iconDefinitions: Record<string, VSCodeIconDefinition>;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  languageIds: Record<string, string>;
};

type VSCodeLanguageData = Record<string, { extensions?: string[] }>;

const vscodeIconTheme = iconThemeData as unknown as VSCodeIconThemeData;
const vscodeLanguageData = languageData as unknown as VSCodeLanguageData;
const macOSFolderIconName = "_folder_macos";
let vscodeIconsPromise: Promise<IconifyCollection> | undefined;

export const VSCODE_FILE_ICON_THEME: FileIconTheme = {
  file: "_file",
  folder: macOSFolderIconName,
  fileExtensions: {
    ...languageExtensionIcons(),
    ...vscodeIconTheme.fileExtensions,
    // The VS Code language list bundled by vscode-icons-js omits Svelte.
    svelte: vscodeIconTheme.languageIds.svelte,
  },
  fileNames: vscodeIconTheme.fileNames,
  // Keep folders visually consistent instead of using the theme's named variants.
  folderNames: {},
  languageIds: vscodeIconTheme.languageIds,
};

export async function getVSCodeFileIconDefinition(iconDefinitionName: string) {
  if (iconDefinitionName === macOSFolderIconName) return macOSFolderIcon;

  const definition = vscodeIconTheme.iconDefinitions[iconDefinitionName];
  if (!definition) return;

  const icons = await loadVSCodeIcons();
  const icon = icons.icons[iconName(definition.iconPath)];
  if (!icon) return;

  return renderIconifyIcon(icon);
}

async function loadVSCodeIcons(): Promise<IconifyCollection> {
  vscodeIconsPromise ??= fetch(vscodeIconsUrl).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Unable to load VS Code file icons: ${response.status}`);
    }

    return (await response.json()) as IconifyCollection;
  });
  return vscodeIconsPromise;
}

function languageExtensionIcons(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vscodeLanguageData).flatMap(([languageId, language]) => {
      const icon = vscodeIconTheme.languageIds[languageId];
      if (!icon) return [];

      return (language.extensions ?? []).map((extension) => [extension.replace(/^\./, ""), icon]);
    }),
  );
}

function iconName(path: string): string {
  return (
    path
      .split("/")
      .pop()
      ?.replace(/\.svg$/, "")
      .replaceAll("_", "-") ?? ""
  );
}

function renderIconifyIcon(icon: IconifyIcon): string {
  const width = icon.width ?? 32;
  const height = icon.height ?? 32;
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${normalizeIconColor(icon.body)}</svg>`;
}

function normalizeIconColor(body: string): string {
  return body.replaceAll("#755838", "#6aa6b8");
}

const macOSFolderIcon = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="macos-folder-back" x1="16" y1="5" x2="16" y2="27" gradientUnits="userSpaceOnUse">
      <stop stop-color="#b9edff"/>
      <stop offset="1" stop-color="#65c5f1"/>
    </linearGradient>
    <linearGradient id="macos-folder-front" x1="16" y1="10" x2="16" y2="28" gradientUnits="userSpaceOnUse">
      <stop stop-color="#65cef6"/>
      <stop offset="1" stop-color="#43b5e9"/>
    </linearGradient>
  </defs>
  <path fill="url(#macos-folder-back)" d="M2 8.25A3.25 3.25 0 0 1 5.25 5h6.69c1.08 0 2.09.54 2.69 1.44l1.04 1.55a3.25 3.25 0 0 0 2.7 1.45h8.38A3.25 3.25 0 0 1 30 12.69v11.56a3.25 3.25 0 0 1-3.25 3.25H5.25A3.25 3.25 0 0 1 2 24.25z"/>
  <path fill="url(#macos-folder-front)" d="M2 13.25A3.25 3.25 0 0 1 5.25 10h21.5A3.25 3.25 0 0 1 30 13.25v11.5A3.25 3.25 0 0 1 26.75 28H5.25A3.25 3.25 0 0 1 2 24.75z"/>
  <path fill="none" stroke="#fff" stroke-opacity=".2" stroke-linecap="round" d="M4.5 11.25h23"/>
</svg>`;
