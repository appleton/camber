import { describe, expect, it, vi } from "vitest";
import { removeProjectFromApp } from "./removeProject";

describe("removeProjectFromApp", () => {
  it("unregisters the project, closes its terminals, then refreshes conversations", async () => {
    const order: string[] = [];
    const deps = {
      projects: { removeProject: vi.fn(async (path: string) => void order.push(`remove:${path}`)) },
      worktrees: { closeProject: vi.fn(async (path: string) => void order.push(`close:${path}`)) },
      conversations: { refresh: vi.fn(async () => void order.push("refresh")) },
    };

    await removeProjectFromApp(deps, "/repo");

    expect(order).toEqual(["remove:/repo", "close:/repo", "refresh"]);
  });

  it("stops when unregistering fails", async () => {
    const deps = {
      projects: { removeProject: vi.fn().mockRejectedValue(new Error("nope")) },
      worktrees: { closeProject: vi.fn() },
      conversations: { refresh: vi.fn() },
    };

    await expect(removeProjectFromApp(deps, "/repo")).rejects.toThrow("nope");
    expect(deps.worktrees.closeProject).not.toHaveBeenCalled();
  });
});
