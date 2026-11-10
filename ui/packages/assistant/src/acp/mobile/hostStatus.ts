// Identity and liveness of the desktop the mobile shell remote-controls. The
// host app owns the values (it knows the transport and the paired machine);
// the shell only renders them in the top bar. Implementations should be
// reactive ($state-backed) so the connection dot tracks the socket live.

import type { MobileCamberQAInstance } from "@camber/features/acp";

export interface MobileHostStatus {
  /** Display name of the connected computer, e.g. "Andys-MacBook-Pro"; null until known. */
  readonly name: string | null;
  /** True while the transport socket is open. */
  readonly connected: boolean;
  /** CamberQA worktree identity of the serving helper (dev only); null on
   * production helpers. The shell shows the worktree name (with its slot
   * colour) in place of the host name and the sidebar offers jumping to
   * another live slot's mobile app. */
  readonly camberqa?: MobileCamberQAInstance | null;
}
