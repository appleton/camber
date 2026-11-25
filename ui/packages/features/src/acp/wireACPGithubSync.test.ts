import { describe, expect, it, vi } from "vitest";
import { ACP_WORKTREE_RENAMED_EVENT } from "./navTypes";
import { wireACPGithubSync } from "./wireACPGithubSync";

describe("wireACPGithubSync", () => {
  it("force-refreshes on worktree rename until unsubscribed", () => {
    const emitter = new EventTarget();
    const github = { refresh: vi.fn().mockResolvedValue(undefined) };
    const stop = wireACPGithubSync({ emitter, github });

    emitter.dispatchEvent(new Event(ACP_WORKTREE_RENAMED_EVENT));
    expect(github.refresh).toHaveBeenCalledWith(undefined, { force: true });

    stop();
    emitter.dispatchEvent(new Event(ACP_WORKTREE_RENAMED_EVENT));
    expect(github.refresh).toHaveBeenCalledTimes(1);
  });
});
