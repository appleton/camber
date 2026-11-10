import {
  reorderLayoutOffsets,
  resolveMoveTarget,
  type ReorderDragMoveDetail,
  type ReorderDropTarget,
  type ReorderItemRect,
} from "@camber/dnd";

export interface ReorderMotionPreview<T> {
  item: T;
  clientX: number;
  clientY: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  width: number;
  height: number;
}

const DEFAULT_REORDER_MOTION_DURATION_MS = 120;
const REORDER_DROP_SETTLE_BUFFER_MS = 20;
const REORDER_TARGET_PREPARE_BUFFER_MS = 40;

/**
 * Shared visual state for vertical reorder lists.
 *
 * The outer reorder items retain their original geometry for stable hit
 * testing. Consumers move an inner ReorderMotionItem with contentStyle(),
 * which closes the source slot and opens the dragged item's full-height slot at
 * the projected destination. The floating preview stays presentation-specific.
 */
export class ReorderMotion<T> {
  dragIndex = $state<number | null>(null);
  dropTarget = $state<ReorderDropTarget | null>(null);
  preview = $state.raw<ReorderMotionPreview<T> | null>(null);

  private itemRects = $state.raw<ReorderItemRect[]>([]);
  private dragGeneration = 0;
  private settlingDrop = false;
  private targetReady = true;
  private pendingDropTarget: ReorderDropTarget | null = null;
  private targetPreparationFrame = 0;
  private targetApplicationFrame = 0;

  constructor(
    private readonly items: () => readonly T[],
    private readonly key: (item: T) => string,
    private readonly previewHeight: number,
    private readonly transitionDurationMs = DEFAULT_REORDER_MOTION_DURATION_MS,
    private readonly prepareBeforeFirstTarget = false,
  ) {}

  get active(): boolean {
    return this.dragIndex !== null;
  }

  isSource(item: T): boolean {
    const dragged = this.draggedItem();
    return dragged !== undefined && this.key(dragged) === this.key(item);
  }

  contentStyle(item: T): string | undefined {
    const offset = this.contentOffset(item);
    return offset === 0 ? undefined : `transform: translate3d(0, ${offset}px, 0);`;
  }

  private contentOffset(item: T): number {
    if (this.dragIndex === null || !this.dropTarget || this.itemRects.length === 0) {
      return 0;
    }
    const to = resolveMoveTarget(this.dragIndex, this.dropTarget.index, this.dropTarget.edge);
    if (to === null) return 0;

    const index = this.items().findIndex((candidate) => this.key(candidate) === this.key(item));
    if (index < 0) return 0;
    return reorderLayoutOffsets(this.itemRects, this.dragIndex, to)[index] ?? 0;
  }

  previewStyle(): string | undefined {
    const current = this.preview;
    if (!current) return undefined;
    return `width: ${current.width}px; height: ${current.height}px; transform: translate3d(${current.clientX - current.pointerOffsetX}px, ${current.clientY - current.pointerOffsetY}px, 0);`;
  }

  handleDragStart(index: number): void {
    this.dragGeneration += 1;
    this.settlingDrop = false;
    this.cancelTargetPreparation();
    this.dragIndex = index;
    this.dropTarget = null;
    this.pendingDropTarget = null;
    this.itemRects = [];
    this.preview = null;
    this.targetReady = !this.prepareBeforeFirstTarget;
    if (this.prepareBeforeFirstTarget) {
      const generation = this.dragGeneration;
      this.targetPreparationFrame = requestAnimationFrame(() => {
        this.targetPreparationFrame = 0;
        this.targetApplicationFrame = requestAnimationFrame(() => {
          this.targetApplicationFrame = 0;
          if (generation !== this.dragGeneration) return;
          this.targetReady = true;
          if (this.pendingDropTarget) this.dropTarget = this.pendingDropTarget;
        });
      });
    }
  }

  handleDragMove(detail: ReorderDragMoveDetail): void {
    const item = this.items()[detail.from];
    if (!item) return;
    this.dragIndex = detail.from;
    if (this.itemRects.length !== detail.itemRects.length) {
      this.itemRects = detail.itemRects;
    }
    this.preview = {
      item,
      clientX: detail.clientX,
      clientY: detail.clientY,
      pointerOffsetX: clamp(detail.pointerOffsetX, 12, detail.itemRect.width - 12),
      pointerOffsetY: clamp(detail.pointerOffsetY, 8, this.previewHeight - 6),
      width: detail.itemRect.width,
      height: this.previewHeight,
    };
  }

  handleTargetChange(target: ReorderDropTarget | null): void {
    if (target) {
      this.pendingDropTarget = target;
      if (this.targetReady) this.dropTarget = target;
      return;
    }
    const generation = this.dragGeneration;
    queueMicrotask(() => {
      if (generation === this.dragGeneration && !this.settlingDrop) {
        this.pendingDropTarget = null;
        this.dropTarget = null;
      }
    });
  }

  handleDragEnd(): void {
    const generation = this.dragGeneration;
    queueMicrotask(() => {
      if (generation === this.dragGeneration && !this.settlingDrop) {
        this.reset();
      }
    });
  }

  /**
   * Keep the projected gap alive long enough to paint its complete transition
   * before the consumer commits the reordered DOM. This matters when the last
   * pointermove and pointerup land in the same browser task: clearing
   * immediately would batch away the animation entirely.
   */
  async settleDrop(): Promise<boolean> {
    const generation = this.dragGeneration;
    this.settlingDrop = true;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        this.transitionDurationMs +
          REORDER_DROP_SETTLE_BUFFER_MS +
          (this.prepareBeforeFirstTarget ? REORDER_TARGET_PREPARE_BUFFER_MS : 0),
      ),
    );
    if (generation !== this.dragGeneration) return false;
    this.reset();
    return true;
  }

  private reset(): void {
    this.cancelTargetPreparation();
    this.dragIndex = null;
    this.dropTarget = null;
    this.pendingDropTarget = null;
    this.itemRects = [];
    this.preview = null;
    this.settlingDrop = false;
    this.targetReady = true;
  }

  private cancelTargetPreparation(): void {
    if (this.targetPreparationFrame) cancelAnimationFrame(this.targetPreparationFrame);
    if (this.targetApplicationFrame) cancelAnimationFrame(this.targetApplicationFrame);
    this.targetPreparationFrame = 0;
    this.targetApplicationFrame = 0;
  }

  private draggedItem(): T | undefined {
    return this.dragIndex === null ? undefined : this.items()[this.dragIndex];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
