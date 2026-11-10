import { isNonNullable } from "@camber/lib/guard";
import { dirname, extname, isAbsolute, resolve } from "@camber/lib/path";
import type { FileIconTheme } from "@camber/rpc";
import * as JSON5 from "json5";
import { merge } from "lodash";
import * as vscode from "vscode";
import type {
  VSCodeFont,
  VSCodeIconDefinition,
  VSCodeIconTheme,
  VSCodeIconThemeManifest,
  VSCodePackageManifest,
  VSCodeThemeManifest,
} from "./types/packageJson";

async function getTheme(name: string) {
  for (const extension of vscode.extensions.all) {
    const packageJSON = extension.packageJSON as VSCodePackageManifest | undefined;
    const themes = packageJSON?.contributes?.themes;
    if (!themes) continue;

    for (const theme of themes) {
      if (theme.label === name || theme.id === name) {
        if (extname(theme.path).toLowerCase() !== ".json") continue;
        const uri = vscode.Uri.joinPath(extension.extensionUri, theme.path);

        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");

        try {
          return JSON5.parse<VSCodeThemeManifest>(text);
        } catch (e) {
          console.error(`Failed to parse theme file ${theme.path}:`, e);
        }
      }
    }
  }
}

async function getIconTheme(name: string) {
  for (const extension of vscode.extensions.all) {
    const packageJSON = extension.packageJSON as VSCodePackageManifest | undefined;
    const iconThemes = packageJSON?.contributes?.iconThemes;
    if (!iconThemes) continue;

    for (const iconTheme of iconThemes) {
      if (iconTheme.id === name) {
        if (extname(iconTheme.path).toLowerCase() !== ".json") continue;
        const uri = vscode.Uri.joinPath(extension.extensionUri, iconTheme.path);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");

        try {
          const theme = JSON5.parse<VSCodeIconThemeManifest>(text);
          return {
            uri,
            theme,
          } as const;
        } catch (e) {
          console.error(`Failed to parse icon theme file ${iconTheme.path}:`, e);
        }
      }
    }
  }
}

export function getActiveTheme() {
  const name = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
  if (!name) return;
  return getTheme(name);
}

export async function getActiveFileIconTheme(): Promise<
  | {
      uri: vscode.Uri;
      theme: VSCodeIconThemeManifest;
    }
  | undefined
>;
export async function getActiveFileIconTheme(kind: vscode.ColorThemeKind): Promise<
  | {
      uri: vscode.Uri;
      theme: VSCodeIconTheme;
    }
  | undefined
>;
export async function getActiveFileIconTheme(kind?: vscode.ColorThemeKind) {
  const name = vscode.workspace.getConfiguration("workbench").get<string>("iconTheme");
  if (!name) return;
  const theme = await getIconTheme(name);
  if (!theme || !kind) return theme;

  const { highContrast, light, ...defaultTheme } = theme.theme;

  const variantTheme = {
    [vscode.ColorThemeKind.Dark]: defaultTheme,
    [vscode.ColorThemeKind.Light]: light,
    [vscode.ColorThemeKind.HighContrast]: highContrast,
    [vscode.ColorThemeKind.HighContrastLight]: highContrast,
  }[kind];

  return {
    uri: theme.uri,
    theme: variantTheme ? merge({}, defaultTheme, variantTheme) : defaultTheme,
  };
}

export async function getParsedFileIconTheme(): Promise<FileIconTheme | undefined> {
  const { kind } = vscode.window.activeColorTheme;
  const theme = await getActiveFileIconTheme(kind);
  if (!theme) return;

  const { theme: activeTheme } = theme;

  const iconElements = await Promise.all(
    Object.entries(activeTheme.iconDefinitions).map(async ([name, definition]) => {
      const element = await renderIcon(definition, theme.uri, activeTheme);
      if (!element) return;
      return [name, element] as const;
    }),
  );

  const fonts = await Promise.all(
    (activeTheme.fonts || []).map((font) => renderFont(font, theme.uri)),
  );

  return {
    ...activeTheme,
    fonts: Object.fromEntries(fonts.filter(isNonNullable)),
    iconDefinitions: Object.fromEntries(iconElements.filter(isNonNullable)),
  };
}

async function renderFont(font: VSCodeFont, themeUri: vscode.Uri) {
  try {
    const { id, src, weight = "normal", style = "normal" } = font;
    const sources = await Promise.all(
      src.map(async ({ path, format }) => {
        const resolvedFontPath = isAbsolute(path) ? path : resolve(dirname(themeUri.fsPath), path);

        const uri = vscode.Uri.file(resolvedFontPath);
        const data = await vscode.workspace.fs.readFile(uri);
        const base64 = Buffer.from(data).toString("base64");
        const mimeType = {
          woff: "font/woff",
          woff2: "font/woff2",
          ttf: "font/ttf",
          truetype: "font/truetype",
          opentype: "font/opentype",
        }[format];

        if (!mimeType) return;
        return `url(data:${mimeType};base64,${base64}) format('${format}')`;
      }),
    );

    return [
      id,
      `@font-face {
  font-family: '${id}';
  src: ${sources.join(",\n")};
  font-weight: ${weight};
  font-style: ${style};
}`,
    ] as const;
  } catch (error) {
    console.error(`Failed to load font ${font.id}:`, error);
    return;
  }
}

async function renderIcon(
  definition: VSCodeIconDefinition,
  themeUri: vscode.Uri,
  theme: VSCodeIconThemeManifest,
) {
  if ("iconPath" in definition) {
    try {
      const resolvedIconPath = isAbsolute(definition.iconPath)
        ? definition.iconPath
        : resolve(dirname(themeUri.fsPath), definition.iconPath);

      const uri = vscode.Uri.file(resolvedIconPath);

      const data = await vscode.workspace.fs.readFile(uri);
      const ext = extname(uri.fsPath);
      if (ext === ".svg") {
        const content = Buffer.from(data).toString("utf8");
        return content;
      } else {
        const base64 = Buffer.from(data).toString("base64");
        return `<img src="data:image/png;base64,${base64}" width="16" height="16" />`;
      }
    } catch (error) {
      console.error("Failed to load icon:", error);
      return;
    }
  }

  const { fonts } = theme;
  if (!fonts) return;
  const { fontCharacter, fontId = fonts[0]?.id, fontColor = "currentColor" } = definition;
  if (!fontId) return;
  const font = fonts.find((f) => f.id === fontId);
  const fontSize = definition.fontSize || font?.size || "100%";
  const unicodeChar = fontCharacter.replace(/\\u?([0-9A-Fa-f]{2,6})/g, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );

  return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <text
    x="8"
    y="8"
    dominant-baseline="central"
    text-anchor="middle"
    font-family="${fontId}" 
    font-size="${fontSize}" 
    fill="${fontColor}"
  >${unicodeChar}</text>
</svg>`;
}
