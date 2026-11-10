<script lang="ts" module>
  export type Language = {
    id: string;
    extensions?: Set<string>;
    aliases?: Set<string>;
    filenames?: Set<string>;
    filenamePatterns?: Set<string>;
  };

  export type LanguagesProvider = {
    all: Map<Language["id"], Language>;
    get: (name: string) => Language | undefined;
    getByPath: (path: string) => Language[];
    getByExtension: (ext: string) => Language[];
  };

  const [getLanguages, setLanguage] = createContext<LanguagesProvider>();

  export { getLanguages };
</script>

<script lang="ts">
  import { extname } from "@camber/lib/path";
  import { createContext, type Snippet } from "svelte";
  import type { SetFieldType } from "type-fest";

  interface Props {
    languages?: SetFieldType<
      Language,
      "extensions" | "aliases" | "filenames" | "filenamePatterns",
      string[]
    >[];
    children: Snippet;
  }

  let { children, ...rest }: Props = $props();

  const languages = $derived.by(() => {
    const entries = (rest.languages ?? []).map(
      ({ id, aliases, extensions, filenames, filenamePatterns }) => {
        return [
          id,
          {
            id,
            ...(extensions?.length && { extensions: new Set(extensions) }),
            ...(aliases?.length && { aliases: new Set(aliases) }),
            ...(filenames?.length && { filenames: new Set(filenames) }),
            ...(filenamePatterns?.length && { filenamePatterns: new Set(filenamePatterns) }),
          } satisfies Language,
        ] as const;
      },
    );

    return new Map(entries);
  });

  setLanguage({
    get all() {
      return languages;
    },

    get: (name) => {
      const lang = languages.get(name) ?? languages.get(name.toLowerCase());
      if (lang) return lang;
      for (const lang of languages.values()) {
        if (lang.aliases?.has(name)) return lang;
      }
    },

    getByPath: (path) => {
      if (!path) return [];
      const ext = extname(path);
      const result: Language[] = [];
      for (const lang of languages.values()) {
        if (lang.filenames?.has(path) || (ext && lang.extensions?.has(ext))) {
          result.push(lang);
        }
      }

      return result;
    },

    getByExtension: (extension) => {
      if (!extension) return [];
      extension = extension.includes(".") ? `.${extension.split(".").pop()}` : `.${extension}`;
      const result: Language[] = [];
      for (const lang of languages.values()) {
        if (lang.extensions?.has(extension)) {
          result.push(lang);
        }
      }

      return result;
    },
  });
</script>

{@render children()}
