import type { ContentBlock, EmbeddedResourceResource } from "@agentclientprotocol/sdk";
import { basename } from "@camber/lib/path";

export interface PromptContentOptions {
  supportsEmbeddedContext: boolean;
  supportsImages: boolean;
}

export function buildACPPromptContent(
  value: string,
  pastedAttachments: ContentBlock[],
  contextContents: ContentBlock[],
  options: PromptContentOptions,
): ContentBlock[] {
  return [
    { type: "text", text: value },
    ...promptAttachmentBlocks(pastedAttachments, options),
    ...contextContents,
  ];
}

function promptAttachmentBlocks(
  attachments: ContentBlock[],
  options: PromptContentOptions,
): ContentBlock[] {
  return attachments.flatMap((attachment) => {
    if (attachment.type === "image") {
      return options.supportsImages ? [attachment] : [];
    }
    if (attachment.type !== "resource" || options.supportsEmbeddedContext) {
      return [attachment];
    }
    return [resourceToLink(attachment.resource)];
  });
}

function resourceToLink(resource: EmbeddedResourceResource): ContentBlock {
  return resourceLink(basename(resource.uri), resource.uri, resource.uri, resource.mimeType);
}

function resourceLink(
  name: string,
  uri: string,
  title?: string,
  mimeType?: string | null,
): ContentBlock {
  return {
    type: "resource_link",
    name,
    title,
    uri,
    ...(mimeType ? { mimeType } : {}),
  };
}
