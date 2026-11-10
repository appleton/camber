export const DEBUG_RPC_REQUEST_EVENT = "camber:debug-rpc-request";
export const DEBUG_RPC_RESPONSE_EVENT = "camber:debug-rpc-response";

export type DebugRPCEvents = {
  requestEvent: string;
  responseEvent: string;
};

export const DEBUG_RPC_EVENTS = {
  requestEvent: DEBUG_RPC_REQUEST_EVENT,
  responseEvent: DEBUG_RPC_RESPONSE_EVENT,
} as const satisfies DebugRPCEvents;

export type DebugRPCRequest = {
  id: string;
  method: string;
  params?: unknown;
};

export type DebugRPCResponse =
  | {
      id: string;
      ok: true;
      result?: unknown;
    }
  | {
      id: string;
      ok: false;
      error: string;
    };

export type DebugRPCHandler = (params: unknown) => unknown | Promise<unknown>;

export type DebugRPCWindowRequest = {
  events: DebugRPCEvents;
  method: string;
  params?: unknown;
  timeoutMs?: number;
};

/**
 * Minimal in-webview debug RPC server for automation-only app APIs.
 *
 * This is intentionally separate from the host/webview RPC channel: some
 * automation targets, currently CamberQA's VS Code target, can evaluate code
 * inside the Camber webview frame but cannot call the app's internal Svelte
 * contexts directly. The current caller is CamberQA, which invokes
 * `requestDebugRPCInWindow` through Playwright's raw frame evaluation.
 */
export function installDebugRPC(
  handlers: Record<string, DebugRPCHandler>,
  target: Window = window,
): () => void {
  function respond(response: DebugRPCResponse): void {
    target.dispatchEvent(new CustomEvent(DEBUG_RPC_EVENTS.responseEvent, { detail: response }));
  }

  async function handleRequest(event: Event): Promise<void> {
    const request = (event as CustomEvent<DebugRPCRequest>).detail;
    if (!request?.id || !request.method) return;

    const handler = handlers[request.method];
    if (!handler) {
      respond({ id: request.id, ok: false, error: `Unknown debug RPC method: ${request.method}` });
      return;
    }

    try {
      respond({ id: request.id, ok: true, result: await handler(request.params) });
    } catch (error) {
      respond({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  target.addEventListener(DEBUG_RPC_EVENTS.requestEvent, handleRequest);
  return () => target.removeEventListener(DEBUG_RPC_EVENTS.requestEvent, handleRequest);
}

/**
 * Raw-frame-safe Debug RPC client. This function is designed to be passed
 * directly to Playwright's `frame.evaluate`, so every value it needs must come
 * from its serializable argument.
 */
export async function requestDebugRPCInWindow<T = unknown>({
  events,
  method,
  params,
  timeoutMs = 5000,
}: DebugRPCWindowRequest): Promise<T> {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      globalThis.removeEventListener(events.responseEvent, listener);
    };

    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("Debug RPC bridge is not available"));
    }, timeoutMs);

    const listener = (event: Event) => {
      const detail = (event as CustomEvent<DebugRPCResponse>).detail;
      if (detail?.id !== id) return;

      cleanup();
      if (detail.ok) {
        resolve(detail.result as T);
      } else {
        reject(new Error(detail.error));
      }
    };

    globalThis.addEventListener(events.responseEvent, listener);
    globalThis.dispatchEvent(
      new CustomEvent(events.requestEvent, {
        detail: { id, method, params } satisfies DebugRPCRequest,
      }),
    );
  });
}
