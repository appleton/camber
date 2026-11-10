import type {
  ClientSideConnection,
  ContentBlock,
  InitializeResponse,
  SessionId,
} from "@agentclientprotocol/sdk";

export const ACP_SESSION_STEERING_METHOD = "_session/steering";
// Keep in sync with methods.ACPUserMessageSteerMetaKey. The helper stamps
// relayed steer messages with this so every connected surface can keep them
// inside the active turn instead of treating them as a new prompt.
export const ACP_USER_MESSAGE_STEER_META_KEY = "camber/steer";
// Keep in sync with methods.ACPSteerFallbackMetaKey. Marks a session/prompt
// that re-delivers a steer message the agent declined to inject (outcome
// "promptRequired"). The helper mirrored that user message to the other
// surfaces when the steer was attempted, so it must not mirror this prompt's
// copy again.
export const ACP_STEER_FALLBACK_META_KEY = "camber/steer_fallback";

// "injected" delivers into the running turn. When no turn is running, agents
// that honor the idleBehavior opt-in below return "promptRequired" and leave
// the message undelivered for the client to send as an ordinary prompt;
// agents that predate the opt-in start a detached turn themselves and return
// "startedNewTurn".
export type ACPSteerOutcome = "injected" | "failed" | "promptRequired" | "startedNewTurn";
export type ACPSteerTransport = { kind: "extension" };

export interface ACPSteerRequest {
  sessionId: SessionId;
  prompt: ContentBlock[];
  _meta?: { steering: { idleBehavior: "promptRequired" } };
}

export interface ACPSteerResponse {
  // Typed as string, not ACPSteerOutcome: the wire can carry outcomes this
  // client does not know yet, and callers must narrow before trusting it.
  outcome: string;
}

export function sessionSteeringTransport(
  response: InitializeResponse | null,
): ACPSteerTransport | null {
  const steering = response?._meta?.steering;
  if (
    typeof steering === "object" &&
    steering !== null &&
    "supported" in steering &&
    steering.supported === true
  ) {
    return { kind: "extension" };
  }

  return null;
}

export function supportsSessionSteering(response: InitializeResponse | null): boolean {
  return sessionSteeringTransport(response) !== null;
}

export function steerSession(
  conn: ClientSideConnection,
  request: ACPSteerRequest,
): Promise<ACPSteerResponse> {
  return conn.request<ACPSteerResponse, ACPSteerRequest>(ACP_SESSION_STEERING_METHOD, {
    ...request,
    // Opt in to being handed the message back ("promptRequired") when the
    // turn has already ended, instead of the agent starting a detached turn
    // no client owns. Agents that predate the opt-in ignore it.
    _meta: { ...request._meta, steering: { idleBehavior: "promptRequired" } },
  });
}
