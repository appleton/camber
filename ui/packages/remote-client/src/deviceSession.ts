// Silent session recovery. The helper keeps remote session tokens in memory
// with a 12h TTL, so every helper restart (any desktop app restart) and every
// long gap invalidates the cookie. The device token from pairing is persisted
// in localStorage and can mint a fresh session without user interaction —
// auth failures must recover in place instead of reloading into the pairing
// flow (a page reload throws away the transcript, cursors, and scroll state
// over nothing more than an expired cookie).

export const DEVICE_TOKEN_STORAGE_KEY = "camber-remote-device-token";

// CamberQA worktree development: each worktree slot's mobile app is a
// different origin (same host, different port), so localStorage — and with it
// the device token — does not carry across a slot jump, even though every
// worktree helper accepts the same token (they share one paired-device state
// file). The jump hands the token over in the URL *fragment*: fragments are
// never sent to the server, so the token stays out of request lines, proxy
// logs, and helper logs; the receiving app adopts it into localStorage and
// immediately scrubs it from the address bar and history.
export const DEVICE_TOKEN_HANDOFF_PARAM = "camberDeviceToken";

/**
 * The hash fragment carrying this origin's device token for a cross-origin
 * slot jump, or "" when no token is stored (the target will show its pair
 * screen — correct, since we have nothing to hand over).
 */
export function deviceTokenHandoffHash(): string {
  const token = localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY);
  if (!token) return "";
  return `#${DEVICE_TOKEN_HANDOFF_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Adopt a device token handed over in the URL fragment, storing it for this
 * origin and scrubbing it from the address bar and history. Must run before
 * the boot-time auth check; a no-op when the fragment carries no handoff.
 * An existing stored token is overwritten deliberately: the handoff is newer
 * intent (the user just jumped from a logged-in instance) and all worktree
 * helpers accept the same tokens anyway.
 */
export function adoptHandoffDeviceToken(
  location: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  history: Pick<History, "replaceState"> = window.history,
): boolean {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const token = params.get(DEVICE_TOKEN_HANDOFF_PARAM);
  if (!token) return false;
  localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, token);
  params.delete(DEVICE_TOKEN_HANDOFF_PARAM);
  const rest = params.toString();
  history.replaceState(null, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
  return true;
}

export type SessionRecovery =
  | { status: "recovered"; deviceId: string | null }
  // The stored device token was rejected (revoked or unknown) or none is
  // stored: only real re-pairing can fix this.
  | { status: "unauthorized" }
  // Network trouble; worth retrying later, the token may still be good.
  | { status: "unavailable" };

export async function recoverSession(fetchFn: typeof fetch = fetch): Promise<SessionRecovery> {
  const deviceToken = localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY);
  if (!deviceToken) return { status: "unauthorized" };
  try {
    const resp = await fetchFn("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ deviceToken }),
    });
    if (resp.status === 401 || resp.status === 403) return { status: "unauthorized" };
    if (!resp.ok) return { status: "unavailable" };
    const body = (await resp.json()) as { deviceId?: string };
    return {
      status: "recovered",
      deviceId: typeof body.deviceId === "string" ? body.deviceId : null,
    };
  } catch {
    return { status: "unavailable" };
  }
}
