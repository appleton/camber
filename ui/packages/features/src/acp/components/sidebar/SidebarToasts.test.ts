import { INFO_MESSAGE_EVENT, InfoMessageType } from "@camber/rpc";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SidebarToasts from "./SidebarToasts.svelte";
import { sidebarToasts } from "./sidebarToastsState.svelte";

afterEach(() => {
  for (const toast of [...sidebarToasts.toasts]) sidebarToasts.dismiss(toast.id);
});

describe("SidebarToasts", () => {
  it("renders a cancellable archive countdown and runs its action", async () => {
    const onCancel = vi.fn();
    render(SidebarToasts);

    sidebarToasts.addProgressToast(
      "archive:test",
      "Archiving conversation...",
      { kind: "countdown", durationMs: 3000 },
      { label: "Cancel", onClick: onCancel },
    );

    expect(await screen.findByText("Archiving conversation...")).toBeInTheDocument();
    const progress = screen.getByRole("progressbar", {
      name: "Archiving conversation... progress",
    });
    expect(progress.firstElementChild).toHaveClass("sidebar-toast-progress-countdown");
    const cancelButton = screen.getByRole("button", {
      name: "Cancel archiving conversation...",
    });

    await fireEvent.click(cancelButton);

    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByText("Archiving conversation...")).not.toBeInTheDocument();
  });

  it("shows every active toast without requiring hover", async () => {
    render(SidebarToasts);

    window.dispatchEvent(
      new CustomEvent(INFO_MESSAGE_EVENT, {
        detail: { message: "First message", type: InfoMessageType.info },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(INFO_MESSAGE_EVENT, {
        detail: { message: "Second message", type: InfoMessageType.warning },
      }),
    );
    await tick();

    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toBeVisible();
    expect(statuses[1]).toBeVisible();
  });

  it("undoes the newest cancellable action with the native undo shortcut", async () => {
    const cancelArchive = vi.fn();
    const cancelWorktreeDelete = vi.fn();
    render(SidebarToasts);

    sidebarToasts.addProgressToast(
      "archive:keyboard-test",
      "Archiving conversation...",
      { kind: "countdown", durationMs: 3000 },
      { label: "Cancel", onClick: cancelArchive },
    );
    sidebarToasts.addProgressToast(
      "worktree:keyboard-test",
      "Deleting worktree...",
      { kind: "countdown", durationMs: 3000 },
      { label: "Cancel", onClick: cancelWorktreeDelete },
    );
    expect(await screen.findByText("Deleting worktree...")).toBeInTheDocument();

    const undoWorktreeDelete = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(undoWorktreeDelete);
    await tick();

    expect(undoWorktreeDelete.defaultPrevented).toBe(true);
    expect(cancelWorktreeDelete).toHaveBeenCalledOnce();
    expect(cancelArchive).not.toHaveBeenCalled();
    expect(sidebarToasts.toasts.some((toast) => toast.id === "worktree:keyboard-test")).toBe(false);
    expect(screen.getByText("Archiving conversation...")).toBeInTheDocument();

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();

    expect(cancelArchive).toHaveBeenCalledOnce();
    expect(sidebarToasts.toasts).toHaveLength(0);
  });

  it("preserves native undo in editable controls", () => {
    const onCancel = vi.fn();
    const input = document.createElement("input");
    document.body.append(input);
    render(SidebarToasts);

    sidebarToasts.addProgressToast(
      "archive:editable-test",
      "Archiving conversation...",
      { kind: "countdown", durationMs: 3000 },
      { label: "Cancel", onClick: onCancel },
    );

    const undoTextEdit = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(undoTextEdit);

    expect(undoTextEdit.defaultPrevented).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();

    sidebarToasts.dismiss("archive:editable-test");
    input.remove();
  });

  it("moves worktree deletion from grace period to teardown and error", async () => {
    const onCancel = vi.fn();
    render(SidebarToasts);

    sidebarToasts.addProgressToast(
      "worktree:test",
      "Deleting worktree...",
      { kind: "countdown", durationMs: 3000 },
      { label: "Cancel", onClick: onCancel },
    );
    expect(
      await screen.findByRole("button", { name: "Cancel deleting worktree..." }),
    ).toBeInTheDocument();
    const progress = screen.getByRole("progressbar", {
      name: "Deleting worktree... progress",
    });
    const fill = progress.firstElementChild;
    expect(fill).toHaveClass("sidebar-toast-progress-countdown");

    sidebarToasts.updateProgressToast("worktree:test", "Running teardown script", {
      kind: "indeterminate",
    });
    expect(await screen.findByText("Running teardown script")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Running teardown script progress" })).toBe(
      progress,
    );
    expect(progress.firstElementChild).toBe(fill);
    expect(fill).toHaveClass("sidebar-toast-progress-processing");
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();

    const undoTeardown = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(undoTeardown);
    expect(undoTeardown.defaultPrevented).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();

    sidebarToasts.showProgressError("worktree:test", "Error running teardown script");
    expect(await screen.findByText("Error running teardown script")).toBeInTheDocument();
    expect(screen.queryByText("Running teardown script")).not.toBeInTheDocument();

    sidebarToasts.dismiss("worktree:test");
  });

  it("still dismisses later toasts after the group empties under the pointer", async () => {
    vi.useFakeTimers();
    try {
      render(SidebarToasts);

      sidebarToasts.addProgressToast(
        "archive:hover-test",
        "Archiving conversation...",
        { kind: "countdown", durationMs: 3000 },
        { label: "Cancel", onClick: vi.fn() },
      );
      await tick();

      // Hovering suspends the timers; cancelling the only toast then empties
      // the stack and unmounts the container, so no pointerleave follows.
      sidebarToasts.suspendTimers();
      sidebarToasts.runAction("archive:hover-test");
      await tick();
      expect(sidebarToasts.toasts).toHaveLength(0);

      window.dispatchEvent(
        new CustomEvent(INFO_MESSAGE_EVENT, {
          detail: { message: "Something happened", type: InfoMessageType.info },
        }),
      );
      await tick();
      expect(screen.getByText("Something happened")).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(5000);
      expect(sidebarToasts.toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
