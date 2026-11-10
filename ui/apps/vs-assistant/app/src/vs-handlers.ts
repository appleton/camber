import type { RPCError } from "@camber/rpc/generics";

declare var extensionOperations: any;

export const rpcWebViewResponseHandler = (
  command: string,
  payload: { requestId: string; response?: any; error?: RPCError | string },
) => {
  if (payload.error) {
    const message = typeof payload.error === "string" ? payload.error : payload.error.message;
    extensionOperations["webViewRPCError"](payload.requestId, message);
  } else {
    extensionOperations["webViewRPCSuccess"](payload.requestId, JSON.stringify(payload.response));
  }
};

export const rpcHostRequestHandler = async (method: string, args: any[]) => {
  if (!extensionOperations[method]) {
    throw new Error(`No such host RPC method '${method}'`);
  }
  if (method === "reportError") {
    // Make sure we never throw on reportError, otherwise it will call
    // report error again and again.
    try {
      // Wrap string errors into an object with a message property
      const normalizedArgs = args.map((arg) => (typeof arg === "string" ? { message: arg } : arg));
      await extensionOperations[method](...normalizedArgs);
    } catch (error) {
      console.error("Error ocurred while running reportError", error);
    }
    return;
  }
  try {
    return await extensionOperations[method](...args);
  } catch (error) {
    // The host encodes structured JSON-RPC errors (e.g. ACP auth-required, -32000) as a
    // JSON envelope in the exception message, because the CefSharp C#->JS bridge only
    // carries Exception.Message. Decode it back into a structured rejection so the ACP
    // layer sees the real code instead of a generic internal error.
    throw decodeHostRpcError(error);
  }
};

type HostRpcErrorEnvelope = { code: number; message: string; data?: unknown };

function decodeHostRpcError(error: unknown): unknown {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (message === undefined || !message.includes("__acpRpcError")) {
    return error;
  }
  // The envelope may be wrapped with bridge-added prefixes/suffixes, so slice out the
  // JSON object rather than parsing the whole message.
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return error;
  }
  try {
    const parsed = JSON.parse(message.slice(start, end + 1));
    if (parsed?.__acpRpcError === true && typeof parsed.code === "number") {
      const envelope: HostRpcErrorEnvelope = {
        code: parsed.code,
        message: typeof parsed.message === "string" ? parsed.message : "",
        data: parsed.data,
      };
      return envelope;
    }
  } catch {
    // Not actually an envelope; fall through to the original error.
  }
  return error;
}
