import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { buildSessionInfo } from "../../sessionInfo";
import { TurnMaterializer } from "../../TurnMaterializer";
import type { ACPSession } from "./Session.svelte";
import { ACPSessionTitles, parseInlineSessionTitle } from "./SessionTitles";
import { ACP_SESSION_TITLE_EVENT } from "./types";

function sessionStub(agentServer = "codex-acp") {
  const emitter = new EventTarget();
  const titles: string[] = [];
  emitter.addEventListener(ACP_SESSION_TITLE_EVENT, (event) => {
    titles.push((event as CustomEvent<{ title: string }>).detail.title);
  });
  const session = {
    sessionId: "s1",
    agentServer,
    conversationId: "conversation:c1",
    sessionInfo: null,
    env: { emitter },
  } as unknown as ACPSession;
  return { session, titles };
}

function agentTextChunk(text: string, messageId = "message-1"): SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  };
}

describe("ACPSessionTitles.emit", () => {
  it("emits a trimmed agent-authored title", () => {
    const { session, titles } = sessionStub();
    new ACPSessionTitles(session).emit("  Generated title  ");
    expect(titles).toEqual(["Generated title"]);
  });

  it("strips flattened handoff context from a replayed title", () => {
    const { session, titles } = sessionStub();
    new ACPSessionTitles(session).emit(
      'continuecamber://handoff/56a2ba59.md <context ref="camber://handoff/56a2ba59.md">handoff body',
    );
    expect(titles).toEqual(["continue"]);
  });

  it("drops a title that is nothing but injected context", () => {
    const { session, titles } = sessionStub();
    new ACPSessionTitles(session).emit(
      '<context ref="camber://handoff/56a2ba59.md">handoff body</context>',
    );
    expect(titles).toEqual([]);
  });
});

describe("ACPSessionTitles.extractFromAgentMessage", () => {
  it.each(["cursor", "devin"])(
    "extracts an inline title from split %s message chunks",
    (agentServer) => {
      const { session, titles } = sessionStub(agentServer);
      const sessionTitles = new ACPSessionTitles(session);
      const materializer = new TurnMaterializer();

      for (const text of ["tit", "le: Greet", "ing\n\nHi! How can I help?"]) {
        const update = agentTextChunk(text);
        materializer.apply(update);
        sessionTitles.extractFromAgentMessage(materializer, update);
      }

      expect(titles).toEqual(["Greeting"]);
      expect(materializer.events).toEqual([
        {
          eventKind: "agent_message",
          messageId: "message-1",
          content: [{ type: "text", text: "Hi! How can I help?" }],
        },
      ]);
    },
  );

  it("extracts the bold Markdown title form shown by Devin", () => {
    const { session, titles } = sessionStub("devin");
    const sessionTitles = new ACPSessionTitles(session);
    const materializer = new TurnMaterializer();
    const update = agentTextChunk("**title: Greeting**\n\nHi!");

    materializer.apply(update);
    sessionTitles.extractFromAgentMessage(materializer, update);

    expect(titles).toEqual(["Greeting"]);
    expect(update).toEqual(agentTextChunk("**title: Greeting**\n\nHi!"));
    expect(materializer.events[0]).toMatchObject({
      content: [{ type: "text", text: "Hi!" }],
    });
  });

  it("updates replay session info with the extracted title", () => {
    const { session, titles } = sessionStub("devin");
    session.replaySessionInfo = {
      ...buildSessionInfo("s1", "/repo", "native_session"),
      title: "Initial prompt",
    };
    const sessionTitles = new ACPSessionTitles(session);
    const materializer = new TurnMaterializer();
    const update = agentTextChunk("title: Better title\n\nReplayed reply");

    materializer.apply(update);
    sessionTitles.extractFromAgentMessage(materializer, update, { replay: true });

    expect(session.replaySessionInfo.title).toBe("Better title");
    expect(titles).toEqual(["Better title"]);
  });

  it("leaves title-like later messages untouched", () => {
    const { session, titles } = sessionStub("cursor");
    const sessionTitles = new ACPSessionTitles(session);
    const materializer = new TurnMaterializer();
    const firstUpdate = agentTextChunk("Hello!\n", "message-1");
    const laterUpdate = agentTextChunk("title: Draft\n\nExample body", "message-2");

    materializer.apply(firstUpdate);
    sessionTitles.extractFromAgentMessage(materializer, firstUpdate);
    materializer.apply(laterUpdate);
    sessionTitles.extractFromAgentMessage(materializer, laterUpdate);

    expect(titles).toEqual([]);
    expect(materializer.events[1]).toMatchObject({
      content: [{ type: "text", text: "title: Draft\n\nExample body" }],
    });
  });

  it("finalizes a title-only first message without mutating the update", () => {
    const { session, titles } = sessionStub("devin");
    const sessionTitles = new ACPSessionTitles(session);
    const materializer = new TurnMaterializer();
    const update = agentTextChunk("title: Greeting");

    materializer.apply(update);
    sessionTitles.extractFromAgentMessage(materializer, update);
    expect(titles).toEqual([]);

    sessionTitles.finalizeInlineTitle(materializer);

    expect(titles).toEqual(["Greeting"]);
    expect(update).toEqual(agentTextChunk("title: Greeting"));
    expect(materializer.events[0]).toMatchObject({
      content: [{ type: "text", text: "" }],
    });
  });

  it("finalizes a title-only header before a second agent message", () => {
    const { session, titles } = sessionStub("cursor");
    const sessionTitles = new ACPSessionTitles(session);
    const materializer = new TurnMaterializer();
    const titleUpdate = agentTextChunk("title: Greeting", "message-1");
    const bodyUpdate = agentTextChunk("Hi!", "message-2");

    materializer.apply(titleUpdate);
    sessionTitles.extractFromAgentMessage(materializer, titleUpdate);
    materializer.apply(bodyUpdate);
    sessionTitles.extractFromAgentMessage(materializer, bodyUpdate);

    expect(titles).toEqual(["Greeting"]);
    expect(materializer.events).toEqual([
      {
        eventKind: "agent_message",
        messageId: "message-1",
        content: [{ type: "text", text: "" }],
      },
      {
        eventKind: "agent_message",
        messageId: "message-2",
        content: [{ type: "text", text: "Hi!" }],
      },
    ]);
  });

  it("leaves other agents' messages untouched", () => {
    const { session, titles } = sessionStub("codex-acp");
    const sessionTitles = new ACPSessionTitles(session);
    const materializer = new TurnMaterializer();
    const update = agentTextChunk("title: Greeting\n\nHi!");

    materializer.apply(update);
    sessionTitles.extractFromAgentMessage(materializer, update);

    expect(titles).toEqual([]);
    expect(materializer.events[0]).toMatchObject({
      content: [{ type: "text", text: "title: Greeting\n\nHi!" }],
    });
  });
});

describe("parseInlineSessionTitle", () => {
  it("waits for a complete first line", () => {
    expect(parseInlineSessionTitle("title: Greeting")).toBeNull();
  });

  it("accepts a title-only message when finalized", () => {
    expect(parseInlineSessionTitle("title: Greeting", { final: true })).toEqual({
      title: "Greeting",
      message: "",
    });
  });

  it("does not consume title-like text after the first line", () => {
    expect(parseInlineSessionTitle("Here is an example:\ntitle: Greeting")).toBeNull();
  });
});
