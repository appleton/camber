import { writable } from "svelte/store";

/**
 * Desktop self-update affordance state. The desktop host sets this once an app
 * update has been downloaded (see the desktop-assistant `src/updater.ts`); the
 * sidebar chrome renders the "Update" pill from it, mirroring Camber Studio.
 *
 * `version` is absent when the host detected that the installed bundle was
 * replaced by something other than our own updater — the restart is still the
 * fix, but the incoming version is not ours to know.
 */
export type DesktopUpdateState =
  | { available: false; busy: boolean; downloading: boolean; progress?: number }
  | {
      available: true;
      busy: false;
      waitingForIdle?: boolean;
      version?: string;
      /** User-facing release notes (markdown) for the staged update, if the feed carried any. */
      notes?: string;
      apply: () => Promise<void>;
    };

export const desktopUpdate = writable<DesktopUpdateState>({
  available: false,
  busy: false,
  downloading: false,
});
