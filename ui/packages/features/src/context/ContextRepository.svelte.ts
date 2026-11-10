import type { ContentBlock } from "@agentclientprotocol/sdk";
import { basename } from "@camber/lib/path";
import type { AttachedFile, AttachedUrl } from "@camber/rpc";
import { chain, concat } from "lodash";

interface AttachedUrlState extends AttachedUrl {
  status: "attached";
  display: string;
}

interface LoadingUrlState {
  status: "loading";
  url: string;
  display: string;
}

export type UrlState = AttachedUrlState | LoadingUrlState;

type CreateUrl = ({ status: "attached" } & AttachedUrl) | { status: "loading"; url: string };

const urlPattern = /(https?:\/\/(?!\s)(?:www\.)?)([^\/\s]*)?(\/[^\n]*)?$/;

export type ContextRepository = NoSetters<ContextRepositoryWriter>;

export class ContextRepositoryWriter {
  recentFile = $state<AttachedFile | undefined>(undefined);
  activeFiles = $state<AttachedFile[]>([]);
  attachedFiles = $state<AttachedFile[]>([]);
  attachedUrls = $state<UrlState[]>([]);

  readonly symbolsFiles = $derived<AttachedFile[]>(
    this.activeFiles.filter((file) => file.path && file.codeSymbolsAvailable === true),
  );

  readonly hasSymbolsMenu = $derived<boolean>(this.symbolsFiles.length > 0);

  publicAPI(): ContextRepository {
    return this as ContextRepository;
  }

  setRecentFile(file: AttachedFile | undefined): void {
    if (file?.path) {
      this.recentFile = file;
    }
  }

  clearRecentFile(): void {
    this.recentFile = undefined;
  }

  setActiveFiles(files: AttachedFile[] | undefined): void {
    this.activeFiles = chain(files ?? [])
      .filter((file) => Boolean(file.path))
      .uniqBy((file) => file.path)
      .value();
  }

  attachFile(file: AttachedFile): void {
    if (file.path && this.attachedFiles.some((existing) => existing.path === file.path)) {
      this.attachedFiles = this.attachedFiles.map((existing) =>
        existing.path === file.path ? file : existing,
      );
      return;
    }
    this.attachedFiles = [...this.attachedFiles, file];
  }

  removeFile(path: string): void {
    this.attachedFiles = this.attachedFiles.filter((file) => file.path !== path);
  }

  attachUrl(url: CreateUrl): void {
    if (this.attachedUrls.some((existing) => existing.url === url.url)) return;
    const matches = url.url.match(urlPattern);
    const display = matches ? matches[2] + (matches[3] ?? "") : "";
    this.attachedUrls = [...this.attachedUrls, { display, ...url } as UrlState];
  }

  removeUrl(url: string): void {
    this.attachedUrls = this.attachedUrls.filter((entry) => entry.url !== url);
  }

  reset(): void {
    this.attachedFiles = [];
    this.attachedUrls = [];
  }

  asPromptContentBlocks(supportsEmbeddedContext: boolean): ContentBlock[] {
    const fileContents = chain([...this.activeFiles, ...this.attachedFiles, this.recentFile])
      .filter((file): file is AttachedFile => file != null && file.path !== null)
      .uniqBy((file) => file.path)
      .map((file): ContentBlock => {
        const isRecent = this.recentFile?.path === file.path;
        const isActive = this.activeFiles.some((activeFile) => activeFile.path === file.path);
        const name = basename(file.path ?? "");
        const meta = fileMetadata(file, { recent: isRecent, active: isActive });

        if (file.content !== undefined && supportsEmbeddedContext) {
          return {
            type: "resource",
            resource: {
              uri: file.path ?? name,
              mimeType: "text/plain",
              text: file.content,
              ...(meta ? { _meta: meta } : {}),
            },
          };
        }

        return {
          type: "resource_link",
          name,
          title: file.path ?? name,
          uri: file.path ?? "",
          ...(meta ? { _meta: meta } : {}),
        };
      })
      .value();

    const urlContents = chain(this.attachedUrls)
      .uniqBy((url) => url.url)
      .map((url): ContentBlock => {
        return {
          type: "resource_link",
          name: url.display,
          title: url.display,
          uri: url.url,
        };
      })
      .value();

    return concat(fileContents, urlContents);
  }
}

function fileMetadata(
  file: AttachedFile,
  flags: { recent?: boolean; active?: boolean },
): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...flags };

  if (file.selection) {
    meta.selection = {
      startLine: file.selection[0],
      endLine: file.selection[1],
    };
  }
  if (file.visibleRange) {
    meta.visibleRange = {
      startLine: file.visibleRange.start,
      endLine: file.visibleRange.end,
    };
  }
  if (file.selectedCode) {
    meta.selectedCode = file.selectedCode;
  }
  if (file.cursorLine !== undefined) {
    meta.cursorLine = file.cursorLine;
  }
  if (file.codeSymbolsAvailable !== undefined) {
    meta.codeSymbolsAvailable = file.codeSymbolsAvailable;
  }

  return meta;
}

type NoSetters<T> = { readonly [K in keyof T]: T[K] };
