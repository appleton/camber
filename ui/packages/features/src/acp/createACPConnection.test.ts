import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { ACPClient } from "./Client";
import { createACPConnection } from "./createACPConnection";
import type { ACPSessionRepositoryWriter } from "./features/SessionRepository.svelte";
import { RPCTransport } from "./RPCTransport";

function recordingRepo(calls: string[]): ACPSessionRepositoryWriter {
  return {
    handleSessionUpdate: vi.fn((_agentServer: string, params: SessionNotification) => {
      const update = params.update as { sessionUpdate: string; content?: { text?: string } };
      calls.push(`update:${update.content?.text ?? update.sessionUpdate}`);
    }),
    handleSessionReplayStarted: vi.fn((_agentServer: string, sessionId: string) => {
      calls.push(`replayStarted:${sessionId}`);
    }),
    handleTurnEnded: vi.fn((_agentServer: string, params: { sessionId: string }) => {
      calls.push(`turnEnded:${params.sessionId}`);
    }),
  } as unknown as ACPSessionRepositoryWriter;
}

function chunk(sessionUpdate: string, text: string) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate, content: { type: "text", text } } },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createACPConnection", () => {
  it("delivers helper extension notifications in order with the session updates around them", async () => {
    const calls: string[] = [];
    const transport = new RPCTransport({
      jsonrpcCall: vi.fn().mockResolvedValue({}),
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    createACPConnection(() => new ACPClient(recordingRepo(calls), "claude-acp"), transport);

    // A live attach arrives as one burst: a live update the snapshot already
    // contains, the replay marker, then the snapshot from the session's start.
    transport.receive(chunk("agent_message_chunk", "live before snapshot"));
    transport.receive({
      jsonrpc: "2.0",
      method: "camber/acp/session_replay_started",
      params: { sessionId: "s1" },
    });
    transport.receive(chunk("user_message_chunk", "initial prompt"));
    transport.receive(chunk("agent_message_chunk", "first reply"));
    transport.receive({
      jsonrpc: "2.0",
      method: "camber/acp/turn_ended",
      params: { sessionId: "s1" },
    });
    transport.receive(chunk("agent_message_chunk", "next turn"));
    await settle();

    expect(calls).toEqual([
      "update:live before snapshot",
      "replayStarted:s1",
      "update:initial prompt",
      "update:first reply",
      "turnEnded:s1",
      "update:next turn",
    ]);
  });
});
