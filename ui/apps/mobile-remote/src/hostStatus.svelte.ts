// Reactive MobileHostStatus implementation: main.ts mutates it (socket status
// callbacks, the /api/me host name and camberqa worktree identity) and the
// mounted shell re-renders.

import type { MobileCamberQAInstance, MobileHostStatus } from "@camber/assistant";

export interface MutableHostStatus extends MobileHostStatus {
  name: string | null;
  connected: boolean;
  camberqa: MobileCamberQAInstance | null;
}

export function createHostStatus(): MutableHostStatus {
  let name = $state<string | null>(null);
  let connected = $state(false);
  let camberqa = $state<MobileCamberQAInstance | null>(null);
  return {
    get name() {
      return name;
    },
    set name(value) {
      name = value;
    },
    get connected() {
      return connected;
    },
    set connected(value) {
      connected = value;
    },
    get camberqa() {
      return camberqa;
    },
    set camberqa(value) {
      camberqa = value;
    },
  };
}
