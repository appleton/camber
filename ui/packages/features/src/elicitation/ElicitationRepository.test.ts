import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ACPConversationStatusRepository } from "../acp";
import { ElicitationRepository } from "./ElicitationRepository.svelte";

let helperJsonrpcCall: ReturnType<typeof vi.fn>;

beforeEach(() => {
  helperJsonrpcCall = vi.fn().mockResolvedValue({});
  initializeHelperApi({
    jsonrpcCall: helperJsonrpcCall,
    jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
  });
});

const request = (elicitationId: string) => ({
  mode: "form" as const,
  elicitationId,
  message: "test",
});

const conversationStatus = () =>
  ({
    markWaitingForUser: vi.fn(),
    clearWaitingForUser: vi.fn(),
  }) as unknown as ACPConversationStatusRepository;

describe("ElicitationRepository", () => {
  it("accept resolves the registered promise with content", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const promise = repo.register(request("tc-1"));
    repo.accept("tc-1", { q0: "yes" });

    const response = await promise;
    expect(response).toEqual({ action: "accept", content: { q0: "yes" } });
  });

  it("decline resolves without content", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const promise = repo.register(request("tc-2"));
    repo.decline("tc-2");

    expect(await promise).toEqual({ action: "decline" });
  });

  it("cancel resolves without content", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const promise = repo.register(request("tc-3"));
    repo.cancel("tc-3");

    expect(await promise).toEqual({ action: "cancel" });
  });

  it("removes the entry after resolution", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const promise = repo.register(request("tc-4"));
    repo.accept("tc-4", {});
    await promise;

    expect(repo.isElicitationPending("tc-4")).toBe(false);
  });

  it("declineAllForChat resolves entries without routing info", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const promise = repo.register(request("tc-5"));

    repo.declineAllForChat(null, null);

    expect(await promise).toEqual({ action: "decline" });
    expect(repo.isElicitationPending("tc-5")).toBe(false);
  });

  it("declineAllForChat leaves other sessions' entries pending", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const mine = repo.register({
      ...request("tc-mine"),
      sessionId: "session-1",
      agentServer: "agent-a",
    });
    repo.register({ ...request("tc-other"), sessionId: "session-2", agentServer: "agent-a" });

    repo.declineAllForChat("session-1", "agent-a");

    expect(await mine).toEqual({ action: "decline" });
    expect(repo.isElicitationPending("tc-mine")).toBe(false);
    expect(repo.isElicitationPending("tc-other")).toBe(true);
  });

  it("ignores accept/decline/cancel for unknown toolCallId", () => {
    const repo = new ElicitationRepository(conversationStatus());
    repo.register(request("tc-6"));

    expect(repo.isElicitationPending("tc-6")).toBe(true);

    repo.accept("unknown", {});
    repo.decline("unknown");
    repo.cancel("unknown");

    expect(repo.isElicitationPending("tc-6")).toBe(true);
  });

  it("detects pending elicitations for a session", () => {
    const repo = new ElicitationRepository(conversationStatus());
    repo.register({
      ...request("tc-7"),
      sessionId: "session-1",
      agentServer: "agent-a",
    });

    expect(repo.hasPendingForSession("session-1", "agent-a")).toBe(true);
    expect(repo.hasPendingForSession("session-1", "agent-b")).toBe(false);
  });

  it("scopes chat visibility to the tagged session", () => {
    const repo = new ElicitationRepository(conversationStatus());
    repo.register({
      ...request("tc-8"),
      sessionId: "session-1",
      agentServer: "agent-a",
    });

    expect(repo.firstPendingForChat("session-1", "agent-a")?.elicitationId).toBe("tc-8");
    expect(repo.hasPendingForChat("session-1", "agent-a")).toBe(true);
    expect(repo.firstPendingForChat("session-2", "agent-a")).toBeUndefined();
    expect(repo.hasPendingForChat("session-2", "agent-a")).toBe(false);
    expect(repo.hasPendingForChat(null, null)).toBe(false);
  });

  it("shows unattributed elicitations in every chat", () => {
    const repo = new ElicitationRepository(conversationStatus());
    repo.register(request("tc-9"));

    expect(repo.firstPendingForChat("session-1", "agent-a")?.elicitationId).toBe("tc-9");
    expect(repo.firstPendingForChat(null, null)?.elicitationId).toBe("tc-9");
  });

  it("treats an empty-string sessionId as unattributed", () => {
    // Helper-pushed approvals always carry a string sessionId; it is "" when
    // the helper had no active session to attribute the elicitation to.
    const repo = new ElicitationRepository(conversationStatus());
    repo.register({ ...request("tc-10"), sessionId: "", agentServer: "agent-a" });

    expect(repo.firstPendingForChat("session-1", "agent-a")?.elicitationId).toBe("tc-10");
    expect(repo.firstPendingForChat(null, null)?.elicitationId).toBe("tc-10");
  });

  it("restores an optimistically removed elicitation after an invalid response", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const approval = {
      agentServer: "agent-a",
      sessionId: "session-1",
      kind: "elicitation" as const,
      id: "tc-store",
      elicitation: request("tc-store"),
    };
    repo.reconcileApprovals([approval]);
    helperJsonrpcCall.mockResolvedValue({ outcome: "invalid" });

    repo.accept("tc-store", {});

    await vi.waitFor(() => expect(repo.isElicitationPending("tc-store")).toBe(true));
    expect(helperJsonrpcCall).not.toHaveBeenCalledWith("camber/acp/approvals/list", {});
  });

  // A store-backed answer is removed optimistically and only put back if the
  // helper rejects it. The draft has to outlive that window, or the restored
  // card comes back empty and the user retypes everything.
  it("keeps the draft when an invalid response restores the elicitation", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const approval = {
      agentServer: "agent-a",
      sessionId: "session-1",
      kind: "elicitation" as const,
      id: "tc-draft-restore",
      elicitation: request("tc-draft-restore"),
    };
    repo.reconcileApprovals([approval]);
    repo.rememberAnswer("tc-draft-restore", "answer", "Purple");
    helperJsonrpcCall.mockResolvedValue({ outcome: "invalid" });

    repo.accept("tc-draft-restore", { answer: "Purple" });

    await vi.waitFor(() => expect(repo.isElicitationPending("tc-draft-restore")).toBe(true));
    expect(repo.draftFor("tc-draft-restore")).toEqual({ answer: "Purple" });
  });

  it("keeps the draft when the response transport fails", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const approval = {
      agentServer: "agent-a",
      sessionId: "session-1",
      kind: "elicitation" as const,
      id: "tc-draft-throw",
      elicitation: request("tc-draft-throw"),
    };
    repo.reconcileApprovals([approval]);
    repo.rememberAnswer("tc-draft-throw", "answer", "Purple");
    helperJsonrpcCall.mockRejectedValue(new Error("transport closed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      repo.accept("tc-draft-throw", { answer: "Purple" });

      await vi.waitFor(() => expect(repo.isElicitationPending("tc-draft-throw")).toBe(true));
      expect(repo.draftFor("tc-draft-throw")).toEqual({ answer: "Purple" });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("drops the draft once the response is accepted", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const approval = {
      agentServer: "agent-a",
      sessionId: "session-1",
      kind: "elicitation" as const,
      id: "tc-draft-ok",
      elicitation: request("tc-draft-ok"),
    };
    repo.reconcileApprovals([approval]);
    repo.rememberAnswer("tc-draft-ok", "answer", "Purple");
    helperJsonrpcCall.mockResolvedValue({ outcome: "accepted" });

    repo.accept("tc-draft-ok", { answer: "Purple" });

    await vi.waitFor(() => expect(repo.draftFor("tc-draft-ok")).toBeUndefined());
  });

  // Answered on another surface: the helper stops pushing it, which is as
  // authoritative as our own response landing.
  it("drops the draft when the elicitation vanishes from a pushed snapshot", () => {
    const repo = new ElicitationRepository(conversationStatus());
    const approval = {
      agentServer: "agent-a",
      sessionId: "session-1",
      kind: "elicitation" as const,
      id: "tc-draft-elsewhere",
      elicitation: request("tc-draft-elsewhere"),
    };
    repo.reconcileApprovals([approval]);
    repo.rememberAnswer("tc-draft-elsewhere", "answer", "Purple");

    repo.reconcileApprovals([]);

    expect(repo.draftFor("tc-draft-elsewhere")).toBeUndefined();
  });

  it("does not restore a failed response after a newer approval snapshot", async () => {
    const repo = new ElicitationRepository(conversationStatus());
    const approval = {
      agentServer: "agent-a",
      sessionId: "session-1",
      kind: "elicitation" as const,
      id: "tc-race",
      elicitation: request("tc-race"),
    };
    repo.reconcileApprovals([approval]);

    let rejectRespond!: (error: Error) => void;
    helperJsonrpcCall.mockReturnValue(
      new Promise((_, reject) => {
        rejectRespond = reject;
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      repo.accept("tc-race", {});
      repo.reconcileApprovals([]);
      rejectRespond(new Error("transport closed"));

      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
      expect(repo.isElicitationPending("tc-race")).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });
});
