import type { Plan } from "@agentclientprotocol/sdk";
import type { ACPNavConversationLeg } from "@camber/helperapi/schemas";
import type { SessionEvent, TurnMetadata } from "../../TurnMaterializer";

export const HANDOFF_HISTORY_SCHEMA_VERSION = 1;

export type MaterializedConversationHistory = {
  events: SessionEvent[];
  turns: TurnMetadata[];
  plan: Plan | null;
  skippedLegs: number;
};

/**
 * Rebuild the immutable prefix of a handed-off conversation. Each persisted
 * leg stores agent-local event indexes, so turn ranges are shifted as legs and
 * their handoff boundary entries are joined into one transcript.
 */
export function materializeConversationHistory(history: unknown): MaterializedConversationHistory {
  const events: SessionEvent[] = [];
  const turns: TurnMetadata[] = [];
  let plan: Plan | null = null;
  let skippedLegs = 0;

  const legs = conversationLegs(history).sort((a, b) => a.ordinal - b.ordinal);
  for (const leg of legs) {
    if (leg.schemaVersion !== HANDOFF_HISTORY_SCHEMA_VERSION || !isSessionEventArray(leg.events)) {
      skippedLegs++;
      continue;
    }

    const localTurns = validTurns(leg.turns, leg.events.length);

    const eventOffset = events.length;
    events.push(...leg.events);
    turns.push(
      ...localTurns.map((turn) => ({
        ...turn,
        startIndex: turn.startIndex + eventOffset,
        endIndex: turn.endIndex + eventOffset,
      })),
    );
    events.push({
      eventKind: "handoff",
      sourceAgentServer: leg.agentServer,
      sourceSessionId: leg.sessionId,
      targetAgentServer: leg.targetAgentServer,
      createdAt: leg.createdAt,
    });

    if (isPlan(leg.plan)) plan = leg.plan;
  }

  return { events, turns, plan, skippedLegs };
}

function conversationLegs(history: unknown): ACPNavConversationLeg[] {
  if (!isRecord(history) || !Array.isArray(history.legs)) return [];
  return history.legs.filter(isConversationLeg);
}

function isConversationLeg(value: unknown): value is ACPNavConversationLeg {
  return (
    isRecord(value) &&
    typeof value.handoffId === "string" &&
    Number.isInteger(value.ordinal) &&
    typeof value.agentServer === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.targetAgentServer === "string" &&
    typeof value.createdAt === "string" &&
    Number.isInteger(value.schemaVersion)
  );
}

function isSessionEventArray(value: unknown): value is SessionEvent[] {
  return Array.isArray(value) && value.every(isSessionEvent);
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value) || typeof value.eventKind !== "string") return false;
  return [
    "user_message",
    "agent_message",
    "agent_thought",
    "tool_call",
    "mode_change",
    "handoff",
  ].includes(value.eventKind);
}

/**
 * Turns are advisory display metadata over the leg's events. A malformed or
 * out-of-range turn is dropped individually; the events themselves must never
 * be lost over bad turn metadata.
 */
function validTurns(value: unknown, eventCount: number): TurnMetadata[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isTurnMetadata)
    .filter(
      (turn) =>
        turn.startIndex >= 0 && turn.endIndex >= turn.startIndex && turn.endIndex < eventCount,
    );
}

function isTurnMetadata(value: unknown): value is TurnMetadata {
  return (
    isRecord(value) &&
    typeof value.startedAt === "string" &&
    typeof value.endedAt === "string" &&
    Number.isInteger(value.startIndex) &&
    Number.isInteger(value.endIndex) &&
    (value.interrupted === undefined || typeof value.interrupted === "boolean")
  );
}

function isPlan(value: unknown): value is Plan {
  return isRecord(value) && Array.isArray(value.entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
