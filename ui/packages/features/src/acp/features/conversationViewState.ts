// Reports which conversation this surface is viewing to the helper. The
// helper tracks watchers per client connection: a completing turn marks its
// conversation unread only when NO surface is watching it, and activating a
// conversation clears its unread flag for every surface. This is what makes
// the sidebar's unread dot a single shared signal across the desktop app, the
// mobile remote, and IDE hosts instead of a per-surface guess.
//
// Split hosts (VS Code / Visual Studio) report panel visibility from their
// extension process, where it lives; only hosts that render the chat pane in
// the same webview as the sidebar (desktop, mobile) report from here.
//
// Reports are serialized through one promise chain so an activate/deactivate
// pair from a fast conversation switch cannot land out of order, and the
// first report after a webview boot carries reset:true so entries a previous
// webview lifetime left behind stop counting as watched.

import { camberAcpNavReportConversationViewState } from "@camber/helperapi";
import { currentACPHostState } from "../hostAdapter";

const VIEW_STATE_HOSTS = new Set(["desktop", "mobile"]);

export interface ConversationViewStateReport {
  sessionId: string;
  agentServer: string;
  active: boolean;
}

interface ReporterState {
  queue: Promise<void>;
  // The boot reset rides along until one report SUCCEEDS: a failed first
  // report (socket mid-reconnect) must not lose the reset for this webview
  // lifetime, or entries from before a reload would suppress unread forever.
  resetDone: boolean;
}

const state: ReporterState = { queue: Promise.resolve(), resetDone: false };

export function reportConversationViewState(report: ConversationViewStateReport): void {
  if (!VIEW_STATE_HOSTS.has(currentACPHostState().environment.assistantHost)) return;
  state.queue = state.queue.then(async () => {
    const reset = !state.resetDone;
    try {
      await camberAcpNavReportConversationViewState({
        agentServer: report.agentServer,
        sessionId: report.sessionId,
        active: report.active,
        ...(reset ? { reset: true } : {}),
      });
      state.resetDone = true;
    } catch (error) {
      // Losing a report never breaks the UI — the helper's per-connection
      // cleanup and the next report self-correct — so log and move on.
      console.debug("camber: conversation view-state report failed", error);
    }
  });
}
