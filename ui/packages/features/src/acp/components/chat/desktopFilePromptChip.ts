export const DESKTOP_FILE_PROMPT_CHIP_EVENT = "camber:desktop-file-prompt-chip";

export interface DesktopFilePromptChipEventDetail {
  path: string;
}

export function requestDesktopFilePromptChip(path: string): boolean {
  return !window.dispatchEvent(
    new CustomEvent<DesktopFilePromptChipEventDetail>(DESKTOP_FILE_PROMPT_CHIP_EVENT, {
      cancelable: true,
      detail: { path },
    }),
  );
}

export const DESKTOP_IMAGE_ATTACHMENT_EVENT = "camber:desktop-image-attachment";

export interface DesktopImageAttachmentEventDetail {
  name: string;
  data: string;
  mimeType: string;
}

export function requestDesktopImageAttachment(detail: DesktopImageAttachmentEventDetail): boolean {
  return !window.dispatchEvent(
    new CustomEvent<DesktopImageAttachmentEventDetail>(DESKTOP_IMAGE_ATTACHMENT_EVENT, {
      cancelable: true,
      detail,
    }),
  );
}
