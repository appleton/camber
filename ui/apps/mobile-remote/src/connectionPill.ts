// Fixed pill showing the connection state; hidden while the socket is open.
// Routine blips must not flash chrome at the user: the pill only appears once
// the connection has been down for a continuous 10 seconds. When a drop was
// visible (the pill made it on screen), recovery is acknowledged with a short
// "Connected" flash; invisible drops recover silently.

import type { ConnectionStatus } from "@camber/remote-client";

export const OFFLINE_PILL_DELAY_MS = 10_000;
const CONNECTED_FLASH_MS = 1_500;

export function createConnectionPill(): (status: ConnectionStatus) => void {
  let pill: HTMLDivElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let sawOpen = false;
  let lastStatus: ConnectionStatus = "connecting";

  const show = (text: string, kind: "pending" | "ok") => {
    if (hideTimer != null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (!pill) {
      pill = document.createElement("div");
      document.body.appendChild(pill);
    }
    pill.className = `connection-pill connection-pill-${kind}`;
    pill.textContent = text;
  };
  const hide = () => {
    pill?.remove();
    pill = null;
  };
  const cancelPendingShow = () => {
    if (showTimer != null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  };
  const disconnectedText = () =>
    lastStatus === "connecting"
      ? sawOpen
        ? "Reconnecting…"
        : "Connecting…"
      : "Offline — retrying…";

  return (status: ConnectionStatus) => {
    lastStatus = status;
    if (status === "open") {
      cancelPendingShow();
      const dropWasVisible = pill != null;
      sawOpen = true;
      if (dropWasVisible) {
        show("Connected", "ok");
        hideTimer = setTimeout(hide, CONNECTED_FLASH_MS);
      }
      return;
    }
    if (pill != null) {
      // Already visible (long outage, or a drop mid "Connected" flash): keep
      // the text current instead of re-arming the grace timer.
      show(disconnectedText(), "pending");
    } else if (showTimer == null) {
      showTimer = setTimeout(() => {
        showTimer = null;
        show(disconnectedText(), "pending");
      }, OFFLINE_PILL_DELAY_MS);
    }
  };
}
