import { InfoMessageType, type AttachedFile } from "@camber/rpc";
import type { ContextRepository } from "../../../../context";

interface FileContextAttachmentRPC {
  getFileContents(path: string): Promise<AttachedFile | undefined>;
  showInfoMessage(message: string, type?: InfoMessageType): void;
}

interface AttachFilePathToContextOptions {
  contextRepo: ContextRepository;
  helperSupported: boolean;
  rpc: FileContextAttachmentRPC;
}

export async function attachFilePathToContext(
  path: string,
  { contextRepo, helperSupported, rpc }: AttachFilePathToContextOptions,
): Promise<void> {
  const existing = contextRepo.attachedFiles.find((file) => file.path === path);
  if (existing) return;

  // When using helper, it will read the latest state of the file when
  // gathering context.
  const file = helperSupported ? { path } : await rpc.getFileContents(path);

  if (!file) {
    rpc.showInfoMessage("Unable to add file", InfoMessageType.error);
    return;
  }

  contextRepo.attachFile(file);
}
