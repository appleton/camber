import { ScrollManager as SharedScrollManager } from "@camber/components/assistant-ui";
import { AT_BOTTOM_THRESHOLD_PX } from "./threadVirtualization";

/**
 * Transcript-specific configuration for the shared pinned-scroll behavior.
 * Its detach threshold is kept in sync with transcript virtualization, and it
 * preserves the viewport when a disclosure is explicitly opened.
 */
export class ScrollManager extends SharedScrollManager {
  constructor(el: HTMLDivElement, onAttachedChange?: (attached: boolean) => void) {
    super(el, {
      onAttachedChange,
      detachThreshold: AT_BOTTOM_THRESHOLD_PX,
      trackDisclosureExpansions: true,
    });
  }
}
