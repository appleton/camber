import { describe, expect, it } from "vitest";
import { handoffContextContent } from "./handoffContext";
import {
  hostContextBlock,
  PROJECT_INSTRUCTIONS_TAG,
  stripInjectedContextFromText,
  SYSTEM_INSTRUCTIONS_TAG,
} from "./hostContext";
import { EMPTY_ACP_SESSION_METADATA } from "./SessionMetadata";

function hostContextText(options?: { assistantVersion?: string; userPrompt?: string }): string {
  const block = hostContextBlock(options);
  if (block.type !== "resource" || !("text" in block.resource)) {
    throw new Error("expected embedded text resource");
  }
  return block.resource.text;
}

describe("hostContextBlock", () => {
  it("wraps the context in the system instructions tag", () => {
    const text = hostContextText({ assistantVersion: "4.3.8" });
    expect(text.startsWith(`<${SYSTEM_INSTRUCTIONS_TAG}>`)).toBe(true);
    expect(text.endsWith(`</${SYSTEM_INSTRUCTIONS_TAG}>`)).toBe(true);
    expect(text).toContain("Camber Assistant version: 4.3.8");
  });

  it("nests project instructions in a child tag", () => {
    const text = hostContextText({ userPrompt: "Always reply like a pirate." });
    expect(text).toContain(
      `<${PROJECT_INSTRUCTIONS_TAG}>\nAlways reply like a pirate.\n</${PROJECT_INSTRUCTIONS_TAG}>`,
    );
  });

  it("omits the project instructions tag without a user prompt", () => {
    expect(hostContextText()).not.toContain(`<${PROJECT_INSTRUCTIONS_TAG}>`);
  });
});

describe("stripInjectedContextFromText", () => {
  const context = hostContextText({
    assistantVersion: "4.3.8",
    userPrompt: "Always reply like a pirate.",
  });

  it("strips a claude-style context wrapper with link preamble", () => {
    const flattened = [
      "What is 2 plus 2?camber://host-context.md",
      '<context ref="camber://host-context.md">',
      context,
      "</context>",
    ].join("\n");
    expect(stripInjectedContextFromText(flattened)).toBe("What is 2 plus 2?");
  });

  it("strips a raw inlined system instructions tag", () => {
    expect(stripInjectedContextFromText(`What is 2 plus 2?\n${context}`)).toBe("What is 2 plus 2?");
  });

  it("strips an unclosed system instructions tag to the end of the text", () => {
    const truncated = context.slice(0, context.length - 20);
    expect(stripInjectedContextFromText(`What is 2 plus 2?\n${truncated}`)).toBe(
      "What is 2 plus 2?",
    );
  });

  it("strips a bare host context link at either end", () => {
    expect(stripInjectedContextFromText("What is 2 plus 2?\ncamber://host-context.md")).toBe(
      "What is 2 plus 2?",
    );
    expect(stripInjectedContextFromText("camber://host-context.md\nWhat is 2 plus 2?")).toBe(
      "What is 2 plus 2?",
    );
  });

  it("keeps a host context link in the middle of user text", () => {
    const text = "why does camber://host-context.md appear in my message?";
    expect(stripInjectedContextFromText(text)).toBe(text);
  });

  it("leaves plain user text untouched", () => {
    const text = "  keep my whitespace \n and my <context>raw</context> tags  ";
    expect(stripInjectedContextFromText(text)).toBe(text);
  });

  it("strips embedded and flattened cross-agent handoff context", () => {
    const handoff = handoffContextContent(
      {
        agentServer: "poolside",
        sessionId: "source-session",
        cwd: "/repo",
        events: [],
        plan: null,
        metadata: EMPTY_ACP_SESSION_METADATA,
      },
      "codex-acp",
      false,
    );
    if (handoff.type !== "text") throw new Error("expected text fallback");

    expect(stripInjectedContextFromText(`Continue\n${handoff.text}`)).toBe("Continue");
    expect(
      stripInjectedContextFromText(
        `Continuecamber://handoff/source-session.md\n<context ref=\"camber://handoff/source-session.md\">\n${handoff.text}\n</context>`,
      ),
    ).toBe("Continue");
  });

  it("strips a bare handoff link at either end", () => {
    // An agent-derived title can be truncated before the <context> wrapper,
    // leaving only the flattened resource link glued to the user's text.
    expect(stripInjectedContextFromText("continuecamber://handoff/56a2ba59.md")).toBe("continue");
    expect(stripInjectedContextFromText("camber://handoff/56a2ba59.md\ncontinue")).toBe("continue");
  });

  it("keeps a handoff link in the middle of user text", () => {
    const text = "why does camber://handoff/abc.md show up in my title?";
    expect(stripInjectedContextFromText(text)).toBe(text);
  });
});

describe("legacy transcript context", () => {
  it.each(["camber", "poolside"])("strips %s host context from existing transcripts", (brand) => {
    const text = `Hello${brand}://host-context.md\n<context ref="${brand}://host-context.md"><${brand}-system-instructions>internal</${brand}-system-instructions></context>`;
    expect(stripInjectedContextFromText(text)).toBe("Hello");
  });
});
