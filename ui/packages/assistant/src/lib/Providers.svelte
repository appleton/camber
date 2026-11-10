<!--
 @component
 Provides global functionality to specialised components. Can reference global providers,
 e.g., using `LanguageProvider` to map environment languages to file icons.
 
 @example
 ```svelte
 <GlobalProviders>
   <Providers>
     <App />
   </Providers>
 </GlobalProviders>
 ```
 -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { IconProvider, type IconContext } from "@camber/components/icon";
  import { basename, extname } from "@camber/lib/path";
  import { getLanguages, getThemeContext, type FileIconTheme } from "@camber/components/providers";
  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  const languages = getLanguages();
  const theme = getThemeContext();

  function getIconByLanguage({ languageIds }: FileIconTheme, language: string) {
    if (!language || !languageIds) return;

    const languageData = languages.get(language);
    if (!languageData) return;
    return languageIds[languageData.id];
  }

  function getIconByExtension({ fileExtensions, languageIds, file }: FileIconTheme, base: string) {
    const firstDotIndex = base.indexOf(".");
    if (firstDotIndex === -1) return;

    // Try compound extensions first (e.g., "stories.svelte", then "svelte")
    if (fileExtensions) {
      const fullExtension = base.slice(firstDotIndex + 1);
      const parts = fullExtension.split(".");

      for (let i = 0; i < parts.length; i++) {
        const ext = parts.slice(i).join(".");
        const iconName = fileExtensions[ext];
        if (iconName) return iconName;
      }
    }

    // Fallback: try language detection from filename
    if (!languageIds) return;
    for (const lang of languages.getByPath(base)) {
      const id = languageIds[lang.id];
      if (id) return id;
    }

    return file;
  }

  function getIconByPath(theme: FileIconTheme, path: string) {
    const { fileNames, folderNames, folder } = theme;
    const base = basename(path);
    let iconName = fileNames?.[base] ?? fileNames?.[base.toLowerCase()];
    if (iconName) return iconName;

    const isFolder = !extname(path); // heuristic: no extension means folder
    if (!isFolder) return getIconByExtension(theme, base);
    return folderNames?.[base] ?? folder;
  }

  /**
   * Retrieves the file icon for a given file path and optional language.
   *
   * This function determines the appropriate icon following a priority order
   * for icon resolution:
   * 1. Language ID match
   * 2. Folder name match (for directories)
   * 3. Exact file name match
   * 4. File extension match (tries progressively shorter extension combinations)
   * 5. Language detection from file name
   * 6. Default file/folder icon
   *
   * @returns A promise that resolves to:
   *   - An SVG string for vector icons
   *   - An HTML img element string with base64-encoded data for raster icons
   *   - `undefined` if no icon could be determined or loaded
   */
  const getFileIcon: IconContext["getFileIcon"] = async (path, language) => {
    if (!theme.fileIconTheme) return;
    let iconName = language ? getIconByLanguage(theme.fileIconTheme, language) : undefined;
    iconName ||= getIconByPath(theme.fileIconTheme, path);
    if (!iconName) return;
    return await theme.getFileIconDefinition(iconName);
  };

  $effect(() => {
    if (!theme.fileIconTheme?.fonts) return;

    const id = "icon-theme-fonts";
    let style = document.getElementById(id);

    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    }

    style.textContent = Object.values(theme.fileIconTheme.fonts).join("\n");

    return () => {
      style?.remove();
    };
  });
</script>

<IconProvider {getFileIcon}>
  {@render children()}
</IconProvider>
