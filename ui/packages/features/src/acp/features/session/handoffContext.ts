import type { ContentBlock, Plan } from "@agentclientprotocol/sdk";
import type { SessionEvent } from "../../types";
import type { ACPSessionMetadataSnapshot } from "./SessionMetadata";

export const HANDOFF_CONTEXT_RESOURCE_URI_PREFIX = "camber://handoff/";
export const HANDOFF_CONTEXT_TAG = "camber-handoff";

const MAX_TRANSCRIPT_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TRANSCRIPT_CHARS = 12_000;

export interface ACPHandoffSource {
  agentServer: string;
  sessionId: string;
  cwd: string;
  title?: string | null;
  events: readonly SessionEvent[];
  plan: Plan | null;
  metadata: ACPSessionMetadataSnapshot;
}

/**
 * Build the portable, semantic part of a cross-agent handoff. The working
 * tree remains authoritative; this packet deliberately includes only bounded
 * conversation text and deterministic UI metadata, never raw tool output,
 * credentials, approvals, or environment state.
 */
export function handoffContextContent(
  source: ACPHandoffSource,
  targetAgentServer: string,
  supportsEmbeddedContext: boolean,
): ContentBlock {
  const text = handoffContextText(source, targetAgentServer);
  if (!supportsEmbeddedContext) {
    return { type: "text", text };
  }

  return {
    type: "resource",
    resource: {
      uri: handoffResourceUri(source.sessionId),
      mimeType: "text/markdown",
      text,
    },
  };
}

export function handoffResourceUri(sourceSessionId: string): string {
  return `${HANDOFF_CONTEXT_RESOURCE_URI_PREFIX}${encodeURIComponent(sourceSessionId)}.md`;
}

export function handoffContextText(source: ACPHandoffSource, targetAgentServer: string): string {
  const sections = [
    `# Camber ACP Session Handoff`,
    [
      `This is a semantic handoff from ACP agent \`${source.agentServer}\` (session \`${source.sessionId}\`) to \`${targetAgentServer}\`.`,
      `The repository and the user's original requests are authoritative. Treat the prior agent's work as historical context to verify.`,
      `Continue the work now from the most useful next step. Do not ask the user to repeat context unless something essential is missing.`,
    ].join("\n"),
    markdownSection(
      "Conversation",
      [source.title ? `Title: ${singleLine(source.title)}` : null, `Workspace: \`${source.cwd}\``]
        .filter((line): line is string => line !== null)
        .join("\n"),
    ),
    workspaceActivity(source.metadata),
    planSection(source.plan),
    transcriptSection(source.events),
  ].filter((section): section is string => Boolean(section));

  return `<${HANDOFF_CONTEXT_TAG}>\n${sections.join("\n\n")}\n</${HANDOFF_CONTEXT_TAG}>`;
}

export function sourceTitleFromHandoffContext(text: string): string | null {
  const handoffStart = text.indexOf(`<${HANDOFF_CONTEXT_TAG}>`);
  if (handoffStart < 0) return null;

  const match = text
    .slice(handoffStart)
    .match(/(?:^|\r?\n)## Conversation[ \t]*\r?\nTitle:[ \t]*([^\r\n]+)/);
  const title = match?.[1]?.trim();
  if (!title) return null;
  return title.replaceAll(`<\\/${HANDOFF_CONTEXT_TAG}>`, `</${HANDOFF_CONTEXT_TAG}>`);
}

export function isHandoffContextBlock(block: ContentBlock): boolean {
  if (block.type === "resource") {
    return block.resource.uri.startsWith(HANDOFF_CONTEXT_RESOURCE_URI_PREFIX);
  }
  return (
    block.type === "resource_link" && block.uri.startsWith(HANDOFF_CONTEXT_RESOURCE_URI_PREFIX)
  );
}

function workspaceActivity(metadata: ACPSessionMetadataSnapshot): string | null {
  const lines: string[] = [];
  if (metadata.edited.length > 0) {
    lines.push("Edited files:", ...metadata.edited.map((file) => `- \`${file.filePath}\``));
  }
  if (metadata.explored.length > 0) {
    lines.push("Explored files:", ...metadata.explored.map((file) => `- \`${file}\``));
  }
  return lines.length > 0 ? markdownSection("Known workspace activity", lines.join("\n")) : null;
}

function planSection(plan: Plan | null): string | null {
  if (!plan || plan.entries.length === 0) return null;
  return markdownSection(
    "Last known plan",
    plan.entries.map((entry) => `- [${entry.status}] ${singleLine(entry.content)}`).join("\n"),
  );
}

function transcriptSection(events: readonly SessionEvent[]): string | null {
  const messages = events.flatMap((event) => {
    if (event.eventKind !== "user_message" && event.eventKind !== "agent_message") return [];
    const text = event.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) return [];
    return [{ speaker: event.eventKind === "user_message" ? "User" : "Previous agent", text }];
  });

  let remaining = MAX_TRANSCRIPT_CHARS;
  const bounded: Array<{ speaker: string; text: string }> = [];
  for (const message of messages.slice(-MAX_TRANSCRIPT_MESSAGES).reverse()) {
    if (remaining <= 0) break;
    const text = boundedText(message.text, Math.min(MAX_MESSAGE_CHARS, remaining));
    remaining -= text.length;
    bounded.unshift({ ...message, text });
  }
  if (bounded.length === 0) return null;

  return markdownSection(
    "Recent conversation",
    bounded.map((message) => `### ${message.speaker}\n${message.text}`).join("\n\n"),
  );
}

function markdownSection(title: string, content: string): string {
  return `## ${title}\n${content}`;
}

function boundedText(text: string, max: number): string {
  const escaped = escapeClosingTag(text);
  if (escaped.length <= max) return escaped;
  if (max <= 1) return escaped.slice(-max);
  const prefixLength = Math.min(400, Math.floor((max - 1) / 3));
  const suffixLength = max - prefixLength - 1;
  return `${escaped.slice(0, prefixLength)}…${escaped.slice(-suffixLength)}`;
}

function singleLine(text: string): string {
  return escapeClosingTag(text).trim().replace(/\s+/g, " ");
}

/**
 * Titles, plan entries, and transcript text are agent-controlled; a literal
 * closing tag inside them would terminate the handoff envelope early.
 */
function escapeClosingTag(text: string): string {
  return text.replaceAll(`</${HANDOFF_CONTEXT_TAG}>`, `<\\/${HANDOFF_CONTEXT_TAG}>`);
}
