import type { SessionId } from "@agentclientprotocol/sdk";
import { camberAcpApprovalsRespond, type ACPApproval } from "@camber/helperapi";
import type { ACPElicitationOutput, ACPElicitationParams } from "@camber/helperapi/schemas";
import { find } from "lodash";
import type { ACPConversationStatusRepository } from "../acp";
import type { FieldValue } from "./types";

interface PendingElicitation {
  request: ACPElicitationParams;
  /** Legacy (host-RPC-delivered) elicitations resolve a local promise. */
  resolve?: (response: ACPElicitationOutput) => void;
  /**
   * Store-backed elicitations (reconciled from the helper's approval store)
   * answer through camber/acp/approvals/respond instead; removal arrives
   * with the next didChange push.
   */
  approval?: { agentServer: string; sessionId: string; kind: "elicitation"; id: string };
}
export class ElicitationRepository {
  private conversationStatus: ACPConversationStatusRepository;

  constructor(conversationStatus: ACPConversationStatusRepository) {
    this.conversationStatus = conversationStatus;
  }

  // Map of elicitationId -> pending elicitation awaiting user response
  private pendingByElicitationId = $state<Map<string, PendingElicitation>>(new Map());
  private approvalsRevision = 0;

  /**
   * Answers typed into a form that has not been resolved yet, by elicitation
   * id. They live here, not in the form component, for two reasons: the
   * component is remounted by an ordinary conversation switch, and only this
   * class can tell an optimistic removal from an authoritative one. A draft
   * dropped on the optimistic removal below would be gone by the time a failed
   * response restored the card, taking the user's answers with it.
   */
  private draftsByElicitationId = new Map<string, Record<string, FieldValue>>();

  /** Answers already entered for a pending elicitation, if any. */
  draftFor(elicitationId: string): Record<string, FieldValue> | undefined {
    return this.draftsByElicitationId.get(elicitationId);
  }

  rememberAnswer(elicitationId: string, name: string, value: FieldValue): void {
    this.draftsByElicitationId.set(elicitationId, {
      ...this.draftsByElicitationId.get(elicitationId),
      [name]: value,
    });
  }

  /**
   * First pending elicitation shown in a given chat. Entries tagged with a
   * session belong to that chat only; unattributed entries (no sessionId,
   * e.g. legacy hosts) cannot be routed to one chat, so every chat shows them.
   */
  firstPendingForChat(
    sessionId: SessionId | null,
    agentServer: string | null,
  ): ACPElicitationParams | undefined {
    for (const { request } of this.pendingByElicitationId.values()) {
      if (visibleInChat(request, sessionId, agentServer)) return request;
    }
    return undefined;
  }

  hasPendingForChat(sessionId: SessionId | null, agentServer: string | null): boolean {
    return this.firstPendingForChat(sessionId, agentServer) != null;
  }

  register(request: ACPElicitationParams): Promise<ACPElicitationOutput> {
    if (request.sessionId != null && request.agentServer != null) {
      this.conversationStatus.markWaitingForUser({
        type: "elicitation",
        sessionId: request.sessionId as SessionId,
        agentServer: request.agentServer,
      });
    }
    return new Promise<ACPElicitationOutput>((resolve) => {
      const next = new Map(this.pendingByElicitationId);
      next.set(request.elicitationId, { request, resolve });
      this.pendingByElicitationId = next;
    });
  }

  accept(elicitationId: string, content: Record<string, unknown>) {
    this.resolve(elicitationId, { action: "accept", content });
  }

  decline(elicitationId: string) {
    this.resolve(elicitationId, { action: "decline" });
  }

  /** Declines the elicitations a given chat shows (see firstPendingForChat). */
  declineAllForChat(sessionId: SessionId | null, agentServer: string | null) {
    for (const [elicitationId, entry] of Array.from(this.pendingByElicitationId)) {
      if (visibleInChat(entry.request, sessionId, agentServer)) {
        this.resolve(elicitationId, { action: "decline" });
      }
    }
  }

  cancel(elicitationId: string) {
    this.resolve(elicitationId, { action: "cancel" });
  }

  isElicitationPending(elicitationId: string): boolean {
    return this.pendingByElicitationId.has(elicitationId);
  }

  hasPendingForSession(sessionId: SessionId, agentServer: string): boolean {
    return (
      find(
        Array.from(this.pendingByElicitationId.values()),
        ({ request }) => request.sessionId === sessionId && request.agentServer === agentServer,
      ) != null
    );
  }

  /**
   * Reconcile helper-pushed elicitation approvals: the pending map's
   * store-backed entries are fully replaced on every push, so an elicitation
   * answered on any surface disappears here too, and reconnect re-delivery is
   * idempotent. Legacy promise-backed entries are preserved.
   */
  reconcileApprovals(pending: ACPApproval[]): void {
    this.approvalsRevision++;
    const next = new Map<string, PendingElicitation>();
    for (const [id, entry] of this.pendingByElicitationId) {
      if (!entry.approval) next.set(id, entry);
    }
    for (const approval of pending) {
      if (approval.kind !== "elicitation" || !approval.elicitation) continue;
      const existing = this.pendingByElicitationId.get(approval.id);
      if (existing?.approval) {
        next.set(approval.id, existing);
        continue;
      }
      const request = {
        ...approval.elicitation,
        sessionId: approval.sessionId,
        agentServer: approval.agentServer,
      } as ACPElicitationParams;
      next.set(approval.id, {
        request,
        approval: {
          agentServer: approval.agentServer,
          sessionId: approval.sessionId,
          kind: "elicitation",
          id: approval.id,
        },
      });
      if (approval.sessionId) {
        this.conversationStatus.markWaitingForUser({
          type: "elicitation",
          sessionId: approval.sessionId as SessionId,
          agentServer: approval.agentServer,
        });
      }
    }
    // Clear waiting status for store-backed entries that vanished. Their
    // drafts go too: the helper no longer holds the request, so it was
    // answered — here or on another surface — and will not be asked again.
    for (const [id, entry] of this.pendingByElicitationId) {
      if (!entry.approval || next.has(id)) continue;
      this.draftsByElicitationId.delete(id);
      if (entry.request.sessionId != null && entry.request.agentServer != null) {
        this.conversationStatus.clearWaitingForUser(
          entry.request.sessionId as SessionId,
          entry.request.agentServer,
        );
      }
    }
    if (!sameEntries(this.pendingByElicitationId, next)) {
      this.pendingByElicitationId = next;
    }
  }

  private resolve(elicitationId: string, response: ACPElicitationOutput) {
    const entry = this.pendingByElicitationId.get(elicitationId);
    if (!entry) return;
    if (entry.approval) {
      // Answer through the helper; the entry is removed optimistically and
      // authoritative removal arrives with the next didChange push. A losing
      // race answer reports already_resolved, which lands on the same removal.
      const approvalsRevision = this.approvalsRevision;
      void camberAcpApprovalsRespond({
        ...entry.approval,
        action: response.action as "accept" | "decline" | "cancel",
        ...(response.content ? { content: response.content } : {}),
      })
        .then(({ outcome }) => {
          if (outcome === "invalid") {
            this.restoreStoreBackedEntry(elicitationId, entry, approvalsRevision);
            return;
          }
          // Only now is the removal above authoritative, so only now may the
          // draft go: the two failure paths put the card back, and it has to
          // come back with the answers still in it.
          this.draftsByElicitationId.delete(elicitationId);
        })
        .catch((error) => {
          console.error("acp: elicitation respond failed", error);
          this.restoreStoreBackedEntry(elicitationId, entry, approvalsRevision);
        });
    }
    if (entry.request.sessionId != null && entry.request.agentServer != null) {
      this.conversationStatus.clearWaitingForUser(
        entry.request.sessionId as SessionId,
        entry.request.agentServer,
      );
    }
    // A promise-backed entry has no round trip to lose, so its removal is
    // authoritative immediately; store-backed ones drop their draft in the
    // response handler above.
    if (!entry.approval) this.draftsByElicitationId.delete(elicitationId);
    entry.resolve?.(response);
    const next = new Map(this.pendingByElicitationId);
    next.delete(elicitationId);
    this.pendingByElicitationId = next;
  }

  private restoreStoreBackedEntry(
    elicitationId: string,
    entry: PendingElicitation,
    approvalsRevision: number,
  ): void {
    if (
      this.approvalsRevision !== approvalsRevision ||
      this.pendingByElicitationId.has(elicitationId)
    ) {
      return;
    }
    if (entry.request.sessionId != null && entry.request.agentServer != null) {
      this.conversationStatus.markWaitingForUser({
        type: "elicitation",
        sessionId: entry.request.sessionId as SessionId,
        agentServer: entry.request.agentServer,
      });
    }
    const next = new Map(this.pendingByElicitationId);
    next.set(elicitationId, entry);
    this.pendingByElicitationId = next;
  }
}

function visibleInChat(
  request: ACPElicitationParams,
  sessionId: SessionId | null,
  agentServer: string | null,
): boolean {
  // "" counts as unattributed too: helper-pushed approvals always carry a
  // string sessionId (no omitempty), which is empty when the helper had no
  // active session to attribute the elicitation to.
  if (request.sessionId == null || request.sessionId === "") return true;
  if (request.sessionId !== sessionId) return false;
  return request.agentServer == null || request.agentServer === agentServer;
}

function sameEntries(a: Map<string, PendingElicitation>, b: Map<string, PendingElicitation>) {
  if (a.size !== b.size) return false;
  for (const [id, entry] of a) {
    if (b.get(id) !== entry) return false;
  }
  return true;
}
