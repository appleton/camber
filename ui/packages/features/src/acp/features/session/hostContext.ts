import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  HANDOFF_CONTEXT_RESOURCE_URI_PREFIX,
  HANDOFF_CONTEXT_TAG,
  isHandoffContextBlock,
} from "./handoffContext";

export const HOST_CONTEXT_RESOURCE_URI = "camber://host-context.md";
export const SYSTEM_INSTRUCTIONS_TAG = "camber-system-instructions";
export const PROJECT_INSTRUCTIONS_TAG = "project-instructions";

interface HostContextOptions {
  assistantVersion?: string;
  userPrompt?: string;
}

type HostContextBlock = Extract<ContentBlock, { type: "resource" }> & {
  resource: {
    uri: string;
    mimeType: string;
    text: string;
  };
};

// The whole context lives inside <camber-system-instructions> so that agents
// which flatten history into plain text on session/load leave us a marker we
// can strip when re-rendering user messages (see stripInjectedContextFromText).
function hostContextText(options: HostContextOptions = {}): string {
  const assistantVersion = options.assistantVersion?.trim();
  const userPrompt = options.userPrompt?.trim();
  const versionText = assistantVersion ? `\nCamber Assistant version: ${assistantVersion}\n` : "\n";
  const userPromptText = userPrompt
    ? `\n<${PROJECT_INSTRUCTIONS_TAG}>\n${userPrompt}\n</${PROJECT_INSTRUCTIONS_TAG}>\n`
    : "";

  return `<${SYSTEM_INSTRUCTIONS_TAG}>
# Camber Host Context

You are running within Camber Assistant via the Agent Client Protocol (ACP). Camber Assistant is a GUI application for working with agents.
${versionText}${userPromptText}</${SYSTEM_INSTRUCTIONS_TAG}>`;
}

export function hostContextBlock(options?: HostContextOptions): HostContextBlock {
  return {
    type: "resource",
    resource: {
      uri: HOST_CONTEXT_RESOURCE_URI,
      mimeType: "text/markdown",
      text: hostContextText(options),
    },
  };
}

// The camber agent preserves structured blocks on session/load but replays
// the embedded resource downgraded to a resource_link, so both forms count.
export function isHostContextBlock(block: ContentBlock): boolean {
  if (block.type === "resource") return block.resource.uri === HOST_CONTEXT_RESOURCE_URI;
  return block.type === "resource_link" && block.uri === HOST_CONTEXT_RESOURCE_URI;
}

export function withoutHostContextBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks
    .filter((block) => !isHostContextBlock(block) && !isHandoffContextBlock(block))
    .map(stripInjectedContextBlock)
    .filter((block) => block.type !== "text" || block.text.length > 0);
}

// Agents that do not preserve structured content blocks re-serialize the whole
// prompt as one text block when replaying history on session/load, so the host
// context resource comes back glued to the user's message. Each pattern below
// is anchored to a Camber-specific marker so it cannot match genuine user
// text, and each tolerates a missing closing tag (truncated histories).
const INJECTED_CONTEXT_PATTERNS: RegExp[] = [
  // Cross-agent handoff resources use a session-specific URI.
  new RegExp(
    `(?:${HANDOFF_CONTEXT_RESOURCE_URI_PREFIX}[^\\s\"]+\\.md\\s*)?<context\\s+ref=\"${HANDOFF_CONTEXT_RESOURCE_URI_PREFIX}[^\"]+\">[\\s\\S]*?(?:<\\/context>|$)`,
    "g",
  ),
  new RegExp(`<${HANDOFF_CONTEXT_TAG}>[\\s\\S]*?(?:</${HANDOFF_CONTEXT_TAG}>|$)`, "g"),
  // A bare handoff resource link left at either end of the flattened text
  // (e.g. an agent-derived title truncated before the <context> wrapper).
  new RegExp(
    `^\\s*${HANDOFF_CONTEXT_RESOURCE_URI_PREFIX}[^\\s"]+\\.md\\s*|\\s*${HANDOFF_CONTEXT_RESOURCE_URI_PREFIX}[^\\s"]+\\.md\\s*$`,
    "g",
  ),
  // claude-code-acp replays a resource as its URI followed by a
  // <context ref="..."> wrapper around the resource text.
  /(?:camber:\/\/host-context\.md\s*)?<context\s+ref="camber:\/\/host-context\.md">[\s\S]*?(?:<\/context>|$)/g,
  // Any agent that inlines the raw resource text.
  new RegExp(`<${SYSTEM_INSTRUCTIONS_TAG}>[\\s\\S]*?(?:</${SYSTEM_INSTRUCTIONS_TAG}>|$)`, "g"),
  // A bare resource link left at either end of the flattened text.
  /^\s*camber:\/\/host-context\.md\s*|\s*camber:\/\/host-context\.md\s*$/g,
];

// Old transcripts retain their original injected resource URIs and tags.
const COMPATIBLE_CONTEXT_PATTERNS = INJECTED_CONTEXT_PATTERNS.flatMap((pattern) => [
  pattern,
  new RegExp(pattern.source.replaceAll("camber", "poolside"), pattern.flags),
]);

export function stripInjectedContextFromText(text: string): string {
  let result = text;
  for (const pattern of COMPATIBLE_CONTEXT_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result === text ? text : result.trim();
}

export function stripInjectedContextBlock(block: ContentBlock): ContentBlock {
  if (block.type !== "text") return block;
  const text = stripInjectedContextFromText(block.text);
  return text === block.text ? block : { ...block, text };
}
