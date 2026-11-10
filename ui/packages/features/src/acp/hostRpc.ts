import type { HostClient } from "@camber/rpc";

export type HostMessageSender = (method: string, args: any[]) => Promise<any>;
type RawJsonRPC = Pick<HostClient, "jsonrpc" | "jsonrpcNotify">;
export type RPCClient = Omit<HostClient, keyof RawJsonRPC>;

export interface HelperAPIClient {
  jsonrpcCall(method: string, params: object): Promise<unknown>;
  jsonrpcNotify(method: string, params: object): Promise<void>;
}

let hostMessageSender: HostMessageSender | undefined;

export function initializeStatefulModule(sender: HostMessageSender) {
  hostMessageSender = sender;
}

function getHostMessageSender() {
  if (!hostMessageSender) {
    console.error("Missing host message sender; it should be installed before the client is used");
  }
  return hostMessageSender!;
}

function rawJsonrpc(method: string, params: object): Promise<unknown> {
  return getHostMessageSender()("jsonrpc", [method, params]);
}

function rawJsonrpcNotify(method: string, params: object): Promise<void> {
  return getHostMessageSender()("jsonrpcNotify", [method, params]);
}

export function createHelperApiClient(): HelperAPIClient {
  return {
    async jsonrpcCall(method, params) {
      return await rawJsonrpc(method, params);
    },
    async jsonrpcNotify(method, params) {
      void rawJsonrpcNotify(method, params).catch((error) => {
        console.error("failed to notify", { error });
      });
    },
  };
}

export const rpc = new Proxy<RPCClient>({} as RPCClient, {
  get(_, method) {
    return function (...args: any[]) {
      const methodName = method.toString();
      const sender = getHostMessageSender();
      return sender(methodName, args);
    };
  },
});
