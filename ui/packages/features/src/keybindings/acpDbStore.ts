// Desktop override store backed by the ACP nav database (owned by camber-helper).
//
// The KeybindingService reads overrides synchronously, but the ACP DB is reached
// over async JSON-RPC. So this store keeps an in-memory mirror: `hydrate()` loads
// it once at startup, reads serve from memory, and every edit writes the whole
// map back to the helper (fire-and-forget — a failed write only loses persistence,
// never the in-session binding). The helper persists it under a single
// `keybindings` metadata key; see pkg/camber-helper/internal/handler/acpnav.

import type { KeyChord } from "./chord";
import type { CommandId } from "./commands";
import type { KeybindingOverrideStore } from "./service";

const GET_METHOD = "camber/acpNav/getKeybindings";
const SET_METHOD = "camber/acpNav/setKeybindings";

/** Minimal helper-RPC surface — satisfied by `createHelperApiClient()`. */
export interface KeybindingRpcClient {
  jsonrpcCall(method: string, params: object): Promise<unknown>;
}

export interface HydratableOverrideStore extends KeybindingOverrideStore {
  /** Load persisted overrides from the ACP DB into memory. Safe to call once at startup. */
  hydrate(): Promise<void>;
}

interface KeybindingsPayload {
  keybindings?: Record<string, KeyChord | null> | null;
}

export function createAcpDbKeybindingStore(
  client: KeybindingRpcClient,
  onHydrated?: () => void,
): HydratableOverrideStore {
  const overrides = new Map<CommandId, KeyChord | null>();

  async function persist(): Promise<void> {
    const keybindings: Record<string, KeyChord | null> = {};
    for (const [id, chord] of overrides) keybindings[id] = chord;
    try {
      await client.jsonrpcCall(SET_METHOD, { keybindings });
    } catch (error) {
      console.error("[keybindings] failed to persist overrides to the ACP DB", error);
    }
  }

  return {
    async hydrate() {
      try {
        const result = (await client.jsonrpcCall(GET_METHOD, {})) as KeybindingsPayload | null;
        overrides.clear();
        for (const [id, chord] of Object.entries(result?.keybindings ?? {})) {
          overrides.set(id as CommandId, chord ?? null);
        }
        onHydrated?.();
      } catch (error) {
        console.error("[keybindings] failed to load overrides from the ACP DB", error);
      }
    },
    get: (id) => overrides.get(id),
    set: (id, chord) => {
      overrides.set(id, chord);
      void persist();
    },
    clear: (id) => {
      overrides.delete(id);
      void persist();
    },
  };
}
