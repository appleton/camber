import { INFO_MESSAGE_EVENT, InfoMessageType } from "@camber/rpc";

export type SidebarToast = {
  id: string;
  message: string;
  type: InfoMessageType;
  progress?:
    | { kind: "countdown"; durationMs: number }
    | { kind: "indeterminate" }
    | { kind: "error" };
  action?: {
    label: string;
    onClick: () => void;
  };
  persistent?: boolean;
  /**
   * Whether ⌘Z runs the action (the progress toasts' undo semantics). Plain
   * announcement actions set false so the shortcut never triggers them.
   */
  undoable?: boolean;
};

const TOAST_TIMEOUT_MS = 5000;
const MAX_TOASTS = 4;

function isNativeUndoShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "z" &&
    event.metaKey !== event.ctrlKey &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
    ),
  );
}

// Shared by every SidebarToasts mount. The desktop sidebar renders one mount
// per slider view (chat list and settings) because a mount inside one view is
// translated off-screen and clipped while the other view is active; sharing
// the state keeps a toast alive across the view slide instead of each mount
// accumulating its own copy from a duplicate window listener.
class SidebarToastsState {
  // Oldest first. Every active toast is visible; hovering the group suspends
  // every timeout, and pointer leave re-arms them all from scratch.
  toasts = $state<SidebarToast[]>([]);

  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private attachedMounts = 0;
  private timersSuspended = false;
  private undoKeydownAttached = false;

  // Refcounted so the window listener registers once no matter how many
  // mounts render the group. Returns the matching detach for onMount.
  attach(): () => void {
    if (this.attachedMounts === 0) {
      window.addEventListener(INFO_MESSAGE_EVENT, this.handleInfoMessage);
    }
    this.attachedMounts += 1;
    return () => {
      this.attachedMounts -= 1;
      if (this.attachedMounts === 0) {
        window.removeEventListener(INFO_MESSAGE_EVENT, this.handleInfoMessage);
        // Keep action toasts alive if the sidebar is temporarily unmounted
        // (for example, while the IDE sidebar is collapsed). Their owner
        // dismisses them when the undo window ends.
        if (this.timersSuspended) this.resumeTimers();
      }
    };
  }

  suspendTimers() {
    this.timersSuspended = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  resumeTimers() {
    this.timersSuspended = false;
    // Timers were suspended for the hover; every surviving toast gets a fresh
    // (shortened) timeout from the moment the pointer leaves.
    for (const toast of this.toasts) {
      if (!toast.persistent) this.armTimer(toast.id, TOAST_TIMEOUT_MS / 2);
    }
  }

  addProgressToast(
    id: string,
    message: string,
    progress: NonNullable<SidebarToast["progress"]>,
    action?: NonNullable<SidebarToast["action"]>,
  ): void {
    this.removeToast(id);
    this.dropOverflowingToasts();
    this.toasts = [
      ...this.toasts,
      {
        id,
        message,
        type: InfoMessageType.info,
        progress,
        action,
        persistent: true,
      },
    ];
    this.syncUndoKeydownListener();
  }

  updateProgressToast(
    id: string,
    message: string,
    progress: NonNullable<SidebarToast["progress"]>,
  ): void {
    if (!this.toasts.some((toast) => toast.id === id)) {
      this.addProgressToast(id, message, progress);
      return;
    }
    this.toasts = this.toasts.map((toast) =>
      toast.id === id
        ? {
            ...toast,
            message,
            type: InfoMessageType.info,
            progress,
            action: undefined,
            persistent: true,
          }
        : toast,
    );
    this.syncUndoKeydownListener();
  }

  /**
   * Plain informational toast with an action (e.g. the post-update
   * "Updated to X" → Changelog), shown as a trailing button. The toast times
   * out like an info toast and is not a ⌘Z undo target.
   */
  addActionToast(
    message: string,
    action: NonNullable<SidebarToast["action"]>,
    options?: { timeoutMs?: number },
  ): void {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    this.dropOverflowingToasts();
    this.toasts = [
      ...this.toasts,
      { id, message, type: InfoMessageType.info, action, undoable: false },
    ];
    if (!this.timersSuspended) this.armTimer(id, options?.timeoutMs ?? TOAST_TIMEOUT_MS);
    this.syncUndoKeydownListener();
  }

  showProgressError(id: string, message: string): void {
    const errorToast: SidebarToast = {
      id,
      message,
      type: InfoMessageType.error,
      progress: { kind: "error" },
      persistent: false,
    };
    if (this.toasts.some((toast) => toast.id === id)) {
      this.toasts = this.toasts.map((toast) => (toast.id === id ? errorToast : toast));
    } else {
      this.dropOverflowingToasts();
      this.toasts = [...this.toasts, errorToast];
    }
    if (!this.timersSuspended) this.armTimer(id);
    this.syncUndoKeydownListener();
  }

  runAction(id: string): void {
    const toast = this.toasts.find((candidate) => candidate.id === id);
    if (!toast?.action) return;
    try {
      toast.action.onClick();
    } finally {
      this.removeToast(id);
    }
  }

  dismiss(id: string): void {
    this.removeToast(id);
  }

  private handleInfoMessage = (event: Event) => {
    const detail = (event as CustomEvent<{ message?: string; type?: InfoMessageType }>).detail;
    if (!detail?.message) return;
    this.addToast(detail.message, detail.type ?? InfoMessageType.info);
  };

  private handleUndoKeydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      !isNativeUndoShortcut(event) ||
      isEditableTarget(event.target)
    ) {
      return;
    }
    const toast = [...this.toasts]
      .reverse()
      .find((candidate) => candidate.action && candidate.undoable !== false);
    if (!toast) return;
    event.preventDefault();
    event.stopPropagation();
    this.runAction(toast.id);
  };

  private addToast(message: string, type: InfoMessageType) {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    this.dropOverflowingToasts();
    this.toasts = [...this.toasts, { id, message, type }];
    // While hovered nothing times out; the timer is armed on pointer leave.
    if (!this.timersSuspended) this.armTimer(id);
  }

  private dropOverflowingToasts() {
    for (const dropped of this.toasts.slice(0, Math.max(0, this.toasts.length + 1 - MAX_TOASTS))) {
      this.removeToast(dropped.id);
    }
  }

  private removeToast(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
    // Action toasts can be removed while the pointer is still over the group
    // (hitting Cancel, or an owner dismissing a toast whose countdown just
    // expired). Emptying the group unmounts the container, so no pointerleave
    // ever arrives to clear the hover state; leaving it set would suspend
    // every later toast's timeout and they would never dismiss themselves.
    if (this.toasts.length === 0) this.timersSuspended = false;
    this.syncUndoKeydownListener();
  }

  private armTimer(id: string, timeoutMs: number = TOAST_TIMEOUT_MS) {
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    this.timers.set(
      id,
      setTimeout(() => this.removeToast(id), timeoutMs),
    );
  }

  private syncUndoKeydownListener() {
    const shouldAttach = this.toasts.some((toast) => toast.action && toast.undoable !== false);
    if (shouldAttach === this.undoKeydownAttached) return;
    this.undoKeydownAttached = shouldAttach;
    if (shouldAttach) {
      window.addEventListener("keydown", this.handleUndoKeydown, true);
    } else {
      window.removeEventListener("keydown", this.handleUndoKeydown, true);
    }
  }
}

export const sidebarToasts = new SidebarToastsState();
