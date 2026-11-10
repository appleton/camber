import type { AssistantTerminalTab } from "@camber/rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeStatefulModule, type HostMessageSender } from "../hostRpc";
import {
  AssistantTerminalRepositoryWriter,
  type AssistantTerminalOpener,
} from "./AssistantTerminalRepository.svelte";

function tab(
  id: string,
  worktreePath: string,
  createdAt: string,
  overrides: Partial<AssistantTerminalTab> = {},
): AssistantTerminalTab {
  return {
    id,
    title: id,
    cwd: worktreePath,
    worktreePath,
    createdAt,
    ...overrides,
  };
}

describe("AssistantTerminalRepositoryWriter", () => {
  let sender: ReturnType<typeof vi.fn<HostMessageSender>>;

  beforeEach(() => {
    sender = vi.fn();
    initializeStatefulModule(sender);
    // The repository persists the last measured terminal size; clear it so
    // spawn sizes don't leak between tests.
    localStorage.clear();
  });

  it("loads existing tabs for a worktree and selects the first tab", async () => {
    sender.mockResolvedValueOnce([
      tab("later", "/repo", "2026-05-20T10:00:00Z", { buffer: "late" }),
      tab("earlier", "/repo", "2026-05-20T09:00:00Z", { buffer: "early" }),
    ]);
    const repo = new AssistantTerminalRepositoryWriter();

    await repo.setWorktreePath("/repo");

    expect(sender).toHaveBeenCalledWith("listAssistantTerminals", ["/repo"]);
    expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["earlier", "later"]);
    expect(repo.activeTabId).toBe("later");
    expect(repo.activeTab?.id).toBe("later");
    expect(repo.buffers).toEqual({ later: "late", earlier: "early" });
  });

  it("creates one tab when ensuring an empty worktree", async () => {
    sender
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    const repo = new AssistantTerminalRepositoryWriter();

    await repo.ensureTabForWorktree("/repo");

    expect(sender).toHaveBeenNthCalledWith(1, "listAssistantTerminals", ["/repo"]);
    expect(sender).toHaveBeenNthCalledWith(2, "createAssistantTerminal", [
      "/repo",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(repo.activeTabId).toBe("terminal-1");
    expect(repo.consumeInitialResizeClear("terminal-1")).toBe(true);
  });

  it("spawns new terminals at the last measured size and skips the startup clear", async () => {
    sender.mockResolvedValue(undefined);
    const seeded = new AssistantTerminalRepositoryWriter();
    seeded.terminalDidOpen(tab("seed", "/repo", "2026-05-20T09:00:00Z"));
    await seeded.resize("seed", 191, 53);

    sender = vi.fn();
    initializeStatefulModule(sender);
    sender
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    // A fresh repository picks the persisted size up from storage.
    const repo = new AssistantTerminalRepositoryWriter();

    await repo.ensureTabForWorktree("/repo");

    expect(sender).toHaveBeenNthCalledWith(2, "createAssistantTerminal", [
      "/repo",
      undefined,
      undefined,
      undefined,
      undefined,
      191,
      53,
    ]);
    // The first fit measured the size the shell spawned at: no clear (and no
    // `^L` flash from the compensating Ctrl+L) is needed.
    expect(repo.consumeInitialResizeClear("terminal-1", 191, 53)).toBe(false);
  });

  it("requests the startup clear when the measured size differs from the spawn size", async () => {
    sender
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    const repo = new AssistantTerminalRepositoryWriter();

    await repo.ensureTabForWorktree("/repo");

    // Spawned at the 80x24 default (nothing measured yet) but the pane
    // measured something else: the wrongly-wrapped prompt must be cleared.
    expect(repo.consumeInitialResizeClear("terminal-1", 191, 53)).toBe(true);
    expect(repo.consumeInitialResizeClear("terminal-1", 191, 53)).toBe(false);
  });

  it("creates explicit tabs, writes, resizes, and deletes through rpc", async () => {
    sender.mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    sender.mockResolvedValueOnce(undefined);
    sender.mockResolvedValueOnce(undefined);
    sender.mockResolvedValueOnce(undefined);
    const repo = new AssistantTerminalRepositoryWriter();

    await repo.createTab("/repo", "pnpm test");
    await repo.write("terminal-1", "input");
    await repo.resize("terminal-1", 100, 24);
    await repo.deleteTab("terminal-1");

    expect(sender).toHaveBeenNthCalledWith(1, "createAssistantTerminal", [
      "/repo",
      "pnpm test",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(sender).toHaveBeenNthCalledWith(2, "writeAssistantTerminal", ["terminal-1", "input"]);
    expect(sender).toHaveBeenNthCalledWith(3, "resizeAssistantTerminal", ["terminal-1", 100, 24]);
    expect(sender).toHaveBeenNthCalledWith(4, "deleteAssistantTerminal", ["terminal-1"]);
    expect(repo.tabs).toEqual([]);
  });

  it("marks only newly-created interactive empty terminals for initial resize clear", async () => {
    sender
      .mockResolvedValueOnce(tab("interactive", "/repo", "2026-05-20T10:00:00Z"))
      .mockResolvedValueOnce(tab("command", "/repo", "2026-05-20T10:01:00Z"))
      .mockResolvedValueOnce(tab("non-interactive", "/repo", "2026-05-20T10:02:00Z"))
      .mockResolvedValueOnce([tab("restored", "/repo", "2026-05-20T10:03:00Z")]);
    const repo = new AssistantTerminalRepositoryWriter();

    await repo.createTab("/repo");
    await repo.createTab("/repo", "pnpm test");
    await repo.createTab("/repo", undefined, undefined, "nonInteractive");
    await repo.setWorktreePath("/repo");

    expect(repo.consumeInitialResizeClear("interactive")).toBe(true);
    expect(repo.consumeInitialResizeClear("interactive")).toBe(false);
    expect(repo.consumeInitialResizeClear("command")).toBe(false);
    expect(repo.consumeInitialResizeClear("non-interactive")).toBe(false);
    expect(repo.consumeInitialResizeClear("restored")).toBe(false);
  });

  it("tracks terminal lifecycle notifications and buffers", () => {
    const repo = new AssistantTerminalRepositoryWriter();

    repo.terminalDidOpen(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    repo.terminalDidUpdate({
      terminalId: "terminal-1",
      title: "npm test",
      cwd: "/repo/packages/features",
    });
    repo.terminalDidWrite("terminal-1", "hello");
    repo.terminalDidWrite("terminal-1", " world");
    repo.terminalDidExit("terminal-1", 130);

    expect(repo.tabs[0]).toMatchObject({
      id: "terminal-1",
      title: "npm test",
      cwd: "/repo/packages/features",
      exitCode: 130,
    });
    expect(repo.buffers["terminal-1"]).toBe("hello world");

    repo.terminalDidClose("terminal-1");

    expect(repo.tabs).toEqual([]);
    expect(repo.buffers).toEqual({});
  });

  it("tracks the start offset when capped terminal buffers slide forward", () => {
    const repo = new AssistantTerminalRepositoryWriter();
    repo.terminalDidOpen(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));

    repo.terminalDidWrite("terminal-1", "a".repeat(199_999));
    repo.terminalDidWrite("terminal-1", "bc");

    expect(repo.buffers["terminal-1"]).toHaveLength(200_000);
    expect(repo.buffers["terminal-1"]?.startsWith("a")).toBe(true);
    expect(repo.buffers["terminal-1"]?.endsWith("bc")).toBe(true);
    expect(repo.bufferStartOffsets["terminal-1"]).toBe(1);

    repo.terminalDidWrite("terminal-1", "d");

    expect(repo.buffers["terminal-1"]).toHaveLength(200_000);
    expect(repo.buffers["terminal-1"]?.endsWith("bcd")).toBe(true);
    expect(repo.bufferStartOffsets["terminal-1"]).toBe(2);

    repo.terminalDidClose("terminal-1");

    expect(repo.bufferStartOffsets).toEqual({});
  });

  it("clears a terminal buffer and notifies the host", async () => {
    sender.mockResolvedValueOnce(undefined);
    const repo = new AssistantTerminalRepositoryWriter();
    repo.terminalDidOpen(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    repo.terminalDidWrite("terminal-1", "noisy output");

    await repo.clear("terminal-1");

    expect(repo.buffers["terminal-1"]).toBe("");
    expect(sender).toHaveBeenCalledWith("clearAssistantTerminal", ["terminal-1"]);
  });

  it("closes all tabs for a project path and nested worktrees", async () => {
    sender
      .mockResolvedValueOnce(tab("pending", "/repo", "2026-05-20T12:00:00Z"))
      .mockResolvedValueOnce(undefined);
    const repo = new AssistantTerminalRepositoryWriter();
    repo.terminalDidOpen(tab("project", "/repo", "2026-05-20T09:00:00Z"));
    repo.terminalDidOpen(tab("worktree", "/repo/worktrees/feature", "2026-05-20T10:00:00Z"));
    repo.terminalDidOpen(tab("other", "/other", "2026-05-20T11:00:00Z"));
    await repo.createTab("/repo");
    repo.terminalDidWrite("project", "project buffer");
    repo.terminalDidWrite("worktree", "worktree buffer");
    repo.terminalDidWrite("other", "other buffer");
    repo.terminalDidWrite("pending", "pending buffer");

    await repo.closeProject("/repo");

    expect(sender).toHaveBeenCalledWith("createAssistantTerminal", [
      "/repo",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(sender).toHaveBeenCalledWith("closeAssistantTerminalsForProject", ["/repo"]);
    expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["other"]);
    expect(repo.buffers).toEqual({ other: "other buffer" });
    expect(repo.consumeInitialResizeClear("pending")).toBe(false);
  });

  it("runs a command and resolves when the terminal exits", async () => {
    sender.mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    const repo = new AssistantTerminalRepositoryWriter();

    const exit = repo.runCommandAndWait("/repo", "pnpm clean");
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );
    repo.terminalDidExit("terminal-1", 0);

    await expect(exit).resolves.toBe(0);
    expect(sender).toHaveBeenCalledWith(
      "createAssistantTerminal",
      expect.arrayContaining(["/repo", expect.stringContaining("pnpm clean")]),
    );
  });

  it("runs a command through a registered visible terminal opener", async () => {
    const repo = new AssistantTerminalRepositoryWriter();
    const opener = vi
      .fn<AssistantTerminalOpener>()
      .mockResolvedValue(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    repo.setVisibleTerminalOpener(opener);

    const exit = repo.runCommandAndWait("/repo", "pnpm clean", undefined, {
      visible: true,
      placement: "splitRight",
    });
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );
    const command = opener.mock.calls[0]?.[1]?.command;
    expect(opener).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        command: expect.stringContaining("pnpm clean"),
        commandMode: "nonInteractive",
        placement: "splitRight",
      }),
    );
    expect(command).toContain("CamberCommandDone");
    expect(command).toContain('"$?"');
    expect(command).not.toContain("__camber_command_status");
    expect(command).not.toContain("unset");
    expect(sender).not.toHaveBeenCalled();

    repo.terminalDidExit("terminal-1", 0);

    await expect(exit).resolves.toBe(0);
  });

  it("keeps a visible command terminal alive after completion", async () => {
    const repo = new AssistantTerminalRepositoryWriter();
    const opener = vi
      .fn<AssistantTerminalOpener>()
      .mockResolvedValue(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    repo.setVisibleTerminalOpener(opener);

    const exit = repo.runCommandAndWait("/repo", "pnpm clean", undefined, {
      visible: true,
      keepAliveAfterCommand: true,
      placement: "splitRight",
    });
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );
    const command = opener.mock.calls[0]?.[1]?.command;
    const token = command?.match(/CamberCommandDone=([^:]+):%s/)?.[1];
    expect(opener).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        command: expect.stringContaining("pnpm clean"),
        commandMode: "nonInteractive",
        placement: "splitRight",
      }),
    );
    expect(command).toContain('exec "${SHELL:-/bin/sh}"');
    expect(token).toBeTruthy();

    repo.terminalDidWrite("terminal-1", `\x1b]1337;CamberCommandDone=${token}:0\x07`);

    await expect(exit).resolves.toBe(0);
    expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]);
  });

  it("forwards reuseExisting to the visible terminal opener", async () => {
    const repo = new AssistantTerminalRepositoryWriter();
    const opener = vi
      .fn<AssistantTerminalOpener>()
      .mockResolvedValue(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    repo.setVisibleTerminalOpener(opener);

    const exit = repo.runCommandAndWait("/repo", "pnpm clean", undefined, {
      visible: true,
      reuseExisting: true,
      keepAliveAfterCommand: true,
      placement: "splitRight",
      layoutKey: "conversation-1",
    });
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );

    expect(opener).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        command: expect.stringContaining("pnpm clean"),
        commandMode: "nonInteractive",
        placement: "splitRight",
        layoutKey: "conversation-1",
        reuseExisting: true,
      }),
    );
    repo.terminalDidExit("terminal-1", 0);

    await expect(exit).resolves.toBe(0);
  });

  it("forwards a background open to the visible terminal opener", async () => {
    const repo = new AssistantTerminalRepositoryWriter();
    const opener = vi
      .fn<AssistantTerminalOpener>()
      .mockResolvedValue(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    repo.setVisibleTerminalOpener(opener);

    const exit = repo.runCommandAndWait("/repo", "pnpm install", undefined, {
      visible: true,
      placement: "splitRight",
      focus: false,
    });
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );

    expect(opener).toHaveBeenCalledWith("/repo", expect.objectContaining({ focus: false }));
    repo.terminalDidExit("terminal-1", 0);

    await expect(exit).resolves.toBe(0);
  });

  it("does not ask the opener for reuse when reuseExisting is not set", async () => {
    const repo = new AssistantTerminalRepositoryWriter();
    const opener = vi
      .fn<AssistantTerminalOpener>()
      .mockResolvedValue(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    repo.setVisibleTerminalOpener(opener);

    const exit = repo.runCommandAndWait("/repo", "pnpm clean", undefined, {
      visible: true,
      placement: "splitRight",
    });
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );

    expect(opener).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ reuseExisting: undefined }),
    );
    repo.terminalDidExit("terminal-1", 0);

    await expect(exit).resolves.toBe(0);
  });

  it("runs a command and resolves when its completion marker is emitted", async () => {
    sender.mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    const repo = new AssistantTerminalRepositoryWriter();

    const exit = repo.runCommandAndWait("/repo", "pnpm clean");
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );
    const command = sender.mock.calls[0][1]?.[1] as string;
    const token = command.match(/CamberCommandDone=([^:]+):%s/)?.[1];
    expect(token).toBeTruthy();

    repo.terminalDidWrite("terminal-1", `\x1b]1337;CamberCommandDone=${token}:7\x07`);

    await expect(exit).resolves.toBe(7);
    expect(repo.buffers["terminal-1"]).toBeUndefined();
  });

  it("streams command output without completion markers", async () => {
    sender.mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    const repo = new AssistantTerminalRepositoryWriter();
    const onOutput = vi.fn();

    const exit = repo.runCommandAndWait("/repo", "pnpm clean", undefined, {
      onOutput,
    });
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );
    const command = sender.mock.calls[0][1]?.[1] as string;
    const token = command.match(/CamberCommandDone=([^:]+):%s/)?.[1];
    expect(token).toBeTruthy();
    expect(sender).toHaveBeenCalledWith("createAssistantTerminal", [
      "/repo",
      expect.stringContaining("pnpm clean"),
      undefined,
      "nonInteractive",
      undefined,
      undefined,
      undefined,
    ]);

    repo.terminalDidWrite("terminal-1", `hello\n\x1b]1337;CamberCommandDone=${token}:0\x07`);

    await expect(exit).resolves.toBe(0);
    expect(onOutput).toHaveBeenCalledWith("hello\n");
    expect(repo.buffers["terminal-1"]).toBe("hello\n");
  });

  it("runs a command and resolves when ctrl-c is sent to the startup command", async () => {
    sender
      .mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"))
      .mockResolvedValueOnce(undefined);
    const repo = new AssistantTerminalRepositoryWriter();

    const exit = repo.runCommandAndWait("/repo", "pnpm clean");
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );
    await repo.write("terminal-1", "\x03");

    await expect(exit).resolves.toBeUndefined();
    expect(sender).toHaveBeenLastCalledWith("writeAssistantTerminal", ["terminal-1", "\x03"]);
  });

  it("runs a command and resolves when the abort signal fires", async () => {
    sender.mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    const repo = new AssistantTerminalRepositoryWriter();
    const controller = new AbortController();

    const exit = repo.runCommandAndWait("/repo", "pnpm clean", controller.signal);
    await vi.waitFor(() =>
      expect(repo.tabs.map((candidate) => candidate.id)).toEqual(["terminal-1"]),
    );
    controller.abort();

    await expect(exit).resolves.toBeUndefined();
    expect((repo as unknown as { exitWaiters: Map<string, unknown> }).exitWaiters.size).toBe(0);
  });

  it("runs a command with an already aborted signal without hanging", async () => {
    sender.mockResolvedValueOnce(tab("terminal-1", "/repo", "2026-05-20T10:00:00Z"));
    const repo = new AssistantTerminalRepositoryWriter();
    const controller = new AbortController();
    controller.abort();

    await expect(repo.runCommandAndWait("/repo", "pnpm clean", controller.signal)).resolves.toBe(
      undefined,
    );
    expect((repo as unknown as { exitWaiters: Map<string, unknown> }).exitWaiters.size).toBe(0);
  });
});
