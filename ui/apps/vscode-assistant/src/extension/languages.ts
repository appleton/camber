import { getOrSet } from "@camber/lib/map";
import type { Language } from "@camber/rpc";
import type { SetFieldType } from "type-fest";
import * as vscode from "vscode";
import type { VSCodeLanguageContribution, VSCodePackageManifest } from "./types/packageJson";

type LanguageData = SetFieldType<
  VSCodeLanguageContribution,
  "aliases" | "extensions" | "filenames" | "filenamePatterns",
  Set<string>
>;

export function getLanguages() {
  const result = new Map<VSCodeLanguageContribution["id"], LanguageData>();

  for (const ext of vscode.extensions.all) {
    const pkg = ext.packageJSON as VSCodePackageManifest | undefined;
    const languages = pkg?.contributes?.languages || [];

    for (const lang of languages) {
      if (
        !lang.aliases?.length &&
        !lang.extensions?.length &&
        !lang.filenames?.length &&
        !lang.filenamePatterns?.length
      ) {
        continue;
      }

      const value = getOrSet(
        result,
        lang.id,
        (id) =>
          ({
            id,
            extensions: new Set(),
            aliases: new Set(),
            filenames: new Set(),
            filenamePatterns: new Set(),
          }) satisfies LanguageData,
      );

      lang.extensions?.forEach((ext) => value.extensions.add(ext));
      lang.aliases?.forEach((alias) => value.aliases.add(alias));
      lang.filenames?.forEach((filename) => value.filenames.add(filename));
      lang.filenamePatterns?.forEach((pattern) => value.filenamePatterns.add(pattern));
    }
  }

  return result;
}

export function serializeLanguage({
  id,
  extensions,
  aliases,
  filenames,
  filenamePatterns,
}: LanguageData): Language {
  return {
    id,
    ...(extensions?.size && { extensions: Array.from(extensions) }),
    ...(aliases?.size && { aliases: Array.from(aliases) }),
    ...(filenames?.size && { filenames: Array.from(filenames) }),
    ...(filenamePatterns?.size && { filenamePatterns: Array.from(filenamePatterns) }),
  };
}
export function serializeLanguages(languages: ReturnType<typeof getLanguages>) {
  return Array.from(languages.values()).map(serializeLanguage);
}
