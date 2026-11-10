// CamberQA worktree development support for the mobile remote app. When the
// serving helper was launched by `camberqa worktree up`, /api/me reports the
// helper's worktree identity and the other live worktree slots on the same
// machine (see pkg/camber-helper/internal/handler/remoteaccess/camberqa.go).
// The mobile shell shows the worktree name (with its slot colour) in place of
// the host name, and the sidebar offers "Open Worktree's Mobile App" on
// worktree long-press to jump to another slot's mobile surface.

import type { ACPNavProject } from "./navTypes";

export interface MobileCamberQAInstance {
  /** Slot serving this app; 0 is the main workspace. */
  readonly slot: number;
  /** Worktree id/branch name; empty for the main workspace. */
  readonly worktreeName?: string;
  /** Slot accent colour (hex), matching the desktop app's title chip. */
  readonly color?: string;
  /** Live worktree slots on this machine. */
  readonly slots: readonly MobileCamberQASlot[];
  /** Host-provided, resolved at jump time: a URL fragment (e.g.
   * "#camberDeviceToken=…") appended to slot-jump URLs so device auth
   * carries across origins — each slot's app is a different origin, so
   * localStorage (and the device token in it) does not follow. Fragments
   * never reach the server, keeping the token out of request lines and
   * logs. See remote-client's deviceTokenHandoffHash / adoptHandoffDeviceToken. */
  readonly getHandoffHash?: () => string;
}

export interface MobileCamberQASlot {
  readonly slot: number;
  /** Worktree id (matches ACPNavProject.name for camberqa worktrees). */
  readonly id: string;
  /** The slot's remote-access port — swap it into the current origin to
   * reach that worktree's mobile app. */
  readonly remotePort: number;
}

/**
 * The live slot serving the given worktree project, or null when the project
 * is not a camberqa worktree with a running mobile surface — or when it is
 * the slot already serving this app (jumping to yourself is noise).
 */
export function camberqaSlotForWorktree(
  project: Pick<ACPNavProject, "name" | "isWorktree">,
  camberqa: MobileCamberQAInstance | null | undefined,
): MobileCamberQASlot | null {
  if (!camberqa || !project.isWorktree) return null;
  const slot = camberqa.slots.find((candidate) => candidate.id === project.name);
  if (!slot || slot.slot === camberqa.slot) return null;
  return slot;
}

/**
 * The URL of a slot's mobile app root: the current protocol and hostname with
 * the slot's remote-access port, path reset to "/" (deep routes are
 * per-instance state and would not resolve on the target). The phone reaches
 * every slot's helper the same way (Tailscale hostname, same TLS story), only
 * the port differs (portsForSlot in ui/packages/camberqa/src/worktree/shared.ts).
 * IPv6 literals are fine: Location.hostname keeps the brackets ("[::1]") per
 * the WHATWG URL standard.
 */
export function camberqaSlotMobileUrl(
  slot: Pick<MobileCamberQASlot, "remotePort">,
  location: Pick<Location, "protocol" | "hostname">,
  handoffHash = "",
): string {
  return `${location.protocol}//${location.hostname}:${slot.remotePort}/${handoffHash}`;
}
