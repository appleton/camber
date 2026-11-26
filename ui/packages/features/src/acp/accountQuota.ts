import { camberAcpQuotaRead } from "@camber/helperapi";
import type { ACPReadQuotaOutput } from "@camber/helperapi/schemas";
import { writable } from "svelte/store";
import { normalizeAgentServerName } from "./agentServers";
import type { ACPConnectionPool } from "./ConnectionPool";

const refreshIntervalMs = 10_000;
type QuotaConnection = Pick<ACPConnectionPool, "connect">;
const quotasByPool = new WeakMap<
  QuotaConnection,
  Map<string, ReturnType<typeof createAccountQuota>>
>();

/** All composers on one host connection share quota results for an agent. */
export function getAccountQuota(agentServer: string, connectionPool?: QuotaConnection) {
  const server = normalizeAgentServerName(agentServer);
  const create = () =>
    createAccountQuota(async () => {
      await connectionPool?.connect(server);
      return await camberAcpQuotaRead({ agentServer: server });
    });

  if (!connectionPool) return create();
  let quotas = quotasByPool.get(connectionPool);
  if (!quotas) {
    quotas = new Map();
    quotasByPool.set(connectionPool, quotas);
  }
  let quota = quotas.get(server);
  if (!quota) {
    quota = create();
    quotas.set(server, quota);
  }
  return quota;
}

export function createAccountQuota(read: () => Promise<ACPReadQuotaOutput>) {
  let snapshot: ACPReadQuotaOutput = { buckets: [] };
  const state = writable({ ...snapshot, loading: false, unavailable: false });
  let reading = false;
  let readAfterTurn = false;
  let lastFinishedAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function refresh(afterTurn = false): void {
    if (reading) {
      readAfterTurn ||= afterTurn;
      return;
    }
    const delay = lastFinishedAt + refreshIntervalMs - Date.now();
    if (delay > 0) {
      if (afterTurn && timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          refresh(true);
        }, delay);
      }
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    void load();
  }

  async function load(): Promise<void> {
    reading = true;
    state.set({ ...snapshot, loading: true, unavailable: false });
    try {
      snapshot = await read();
      state.set({ ...snapshot, loading: false, unavailable: false });
    } catch {
      snapshot = { buckets: snapshot.buckets };
      state.set({ ...snapshot, loading: false, unavailable: true });
    } finally {
      reading = false;
      lastFinishedAt = Date.now();
      if (readAfterTurn) {
        readAfterTurn = false;
        refresh(true);
      }
    }
  }

  return { subscribe: state.subscribe, refresh };
}
