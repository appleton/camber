<script lang="ts">
  import type { ContentBlock } from "@agentclientprotocol/sdk";
  import { getChips, getPrompt, type ChipNodeAttrs } from "@camber/components/prompt";
  import { generateId } from "@camber/lib/string";
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import {
    DESKTOP_IMAGE_ATTACHMENT_EVENT,
    type DesktopImageAttachmentEventDetail,
  } from "./desktopFilePromptChip";

  type PastedAttachment =
    | {
        id: string;
        name: string;
        fingerprint: string;
        kind: "image";
        data: string;
        mimeType: string;
      }
    | {
        id: string;
        name: string;
        fingerprint: string;
        kind: "text";
        text: string;
        mimeType: string;
      }
    | {
        id: string;
        name: string;
        fingerprint: string;
        kind: "blob";
        blob: string;
        mimeType: string;
      };

  let pastedAttachments = $state<PastedAttachment[]>([]);

  const { editor } = getPrompt();
  const chips = getChips();

  // When true, this instance is the active prompt target for programmatic image
  // attachments (e.g. drag-dropped images). Mirrors the enabled/cancelable-event
  // mechanism used by DesktopFilePromptChipInserter for active-prompt targeting.
  let { enabled = true }: { enabled?: boolean } = $props();

  export function contentBlocks(): ContentBlock[] {
    return pastedAttachments.map((attachment) => {
      if (attachment.kind === "image") {
        return {
          type: "image",
          data: attachment.data,
          mimeType: attachment.mimeType,
        };
      }

      const resource = {
        uri: `clipboard://${attachment.id}/${attachment.name}`,
        mimeType: attachment.mimeType,
        ...(attachment.kind === "text" ? { text: attachment.text } : { blob: attachment.blob }),
      };

      return {
        type: "resource",
        resource,
      };
    });
  }

  export function clear(): void {
    pastedAttachments = [];
  }

  onMount(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (!isPromptPasteTarget()) return;
      void attachClipboardFiles(event);
    };

    const handleImageAttachment = (event: Event) => {
      if (!enabled) return;
      if (!(event instanceof CustomEvent)) return;
      if (event.defaultPrevented) return;
      const detail = event.detail as DesktopImageAttachmentEventDetail;
      const attachment = imageAttachmentFromDetail(detail);
      const seen = new Set(pastedAttachments.map((a) => a.fingerprint));
      if (seen.has(attachment.fingerprint)) {
        event.preventDefault();
        return;
      }
      pastedAttachments.push(attachment);
      insertAttachmentChip(attachment);
      event.preventDefault();
    };

    window.addEventListener("paste", handlePaste, { capture: true });
    window.addEventListener(DESKTOP_IMAGE_ATTACHMENT_EVENT, handleImageAttachment);
    return () => {
      window.removeEventListener("paste", handlePaste, { capture: true });
      window.removeEventListener(DESKTOP_IMAGE_ATTACHMENT_EVENT, handleImageAttachment);
    };
  });

  async function attachClipboardFiles(event: ClipboardEvent): Promise<void> {
    const files = clipboardFiles(event);
    if (files.length === 0) return;

    event.preventDefault();

    const seen = new Set(pastedAttachments.map((attachment) => attachment.fingerprint));

    for (const file of files) {
      const attachment = await fileAttachment(file);
      if (seen.has(attachment.fingerprint)) continue;

      seen.add(attachment.fingerprint);
      pastedAttachments.push(attachment);
      insertAttachmentChip(attachment);
    }
  }

  function clipboardFiles(event: ClipboardEvent): File[] {
    const filesByKey = new Map<string, File>();

    for (const file of event.clipboardData?.files ?? []) {
      filesByKey.set(fileKey(file), file);
    }

    for (const item of event.clipboardData?.items ?? []) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      filesByKey.set(fileKey(file), file);
    }

    return [...filesByKey.values()];
  }

  async function fileAttachment(file: File): Promise<PastedAttachment> {
    const name = file.name || fallbackFileName(file);
    const mimeType = file.type || "application/octet-stream";
    const base = {
      id: generateId<string>(),
      name,
      mimeType,
    };

    if (mimeType.startsWith("image/")) {
      const data = await fileBase64(file);
      return {
        ...base,
        fingerprint: attachmentFingerprint(mimeType, data),
        kind: "image",
        data,
      };
    }

    if (isTextFile(file)) {
      const text = await file.text();
      return {
        ...base,
        fingerprint: attachmentFingerprint(mimeType, text),
        kind: "text",
        text,
      };
    }

    const blob = await fileBase64(file);
    return {
      ...base,
      fingerprint: attachmentFingerprint(mimeType, blob),
      kind: "blob",
      blob,
    };
  }

  function insertAttachmentChip(attachment: PastedAttachment): void {
    const ed = get(editor);
    if (!ed) return;

    const id = generateId<Parameters<typeof chips.register>[0]>();
    const label = attachment.name;
    const content = {
      label,
      value: attachment.id,
      clipboard: label,
      icon: "file",
      fileIconPath: attachment.name,
      tooltip: label,
    } satisfies Parameters<typeof chips.register>[1]["content"];

    chips.register(id, {
      content,
      onRemove: () => removeAttachment(attachment.id),
    });

    ed.executeCommand((state, dispatch) => {
      const node = state.schema.nodes.chip.create({ id, ...content } satisfies ChipNodeAttrs);
      const { from, to } = state.selection;
      dispatch?.(state.tr.replaceRangeWith(from, to, node).insertText(" "));
      return true;
    });
  }

  function removeAttachment(id: string): void {
    pastedAttachments = pastedAttachments.filter((attachment) => attachment.id !== id);
  }

  function isPromptPasteTarget(): boolean {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return Boolean(activeElement.closest("[data-editor]"));
  }

  function isTextFile(file: File): boolean {
    return (
      file.type.startsWith("text/") ||
      file.type === "application/json" ||
      file.type === "application/xml" ||
      file.type.endsWith("+json") ||
      file.type.endsWith("+xml")
    );
  }

  async function fileBase64(file: File): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    return dataUrl.split(",", 2)[1] ?? "";
  }

  function fileKey(file: File): string {
    return [file.name, file.type, file.size, file.lastModified].join("\0");
  }

  function fallbackFileName(file: File): string {
    if (file.type.startsWith("image/")) return "Pasted image";
    return "Pasted file";
  }

  function attachmentFingerprint(mimeType: string, content: string): string {
    return `${mimeType}\0${content}`;
  }

  function imageAttachmentFromDetail(
    detail: DesktopImageAttachmentEventDetail,
  ): PastedAttachment & { kind: "image" } {
    return {
      id: generateId<string>(),
      name: detail.name,
      mimeType: detail.mimeType,
      fingerprint: attachmentFingerprint(detail.mimeType, detail.data),
      kind: "image",
      data: detail.data,
    };
  }
</script>
