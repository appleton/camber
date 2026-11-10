import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserMCPServersRepository } from "./UserMCPServersRepository.svelte";

let helperJsonrpcCall: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  helperJsonrpcCall = vi.fn(async (method: string) => {
    if (method === "camber/mcpServers/list") return { servers: [] };
    return {};
  });
  initializeHelperApi({
    jsonrpcCall: helperJsonrpcCall,
    jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
  });
});

describe("UserMCPServersRepository", () => {
  it("notifies subscribers after a connector mutation succeeds", async () => {
    const repo = new UserMCPServersRepository();
    const listener = vi.fn();
    const unsubscribe = repo.onDidChange(listener);

    await repo.upsert({ name: "linear", enabled: true, url: "https://mcp.linear.app/mcp" });

    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    await repo.setEnabled("linear", false);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not notify subscribers when a connector mutation fails", async () => {
    helperJsonrpcCall.mockRejectedValueOnce(new Error("save failed"));
    const repo = new UserMCPServersRepository();
    repo.servers = [{ name: "linear", enabled: true }];
    const listener = vi.fn();
    repo.onDidChange(listener);

    await expect(repo.setEnabled("linear", false)).rejects.toThrow("save failed");

    expect(listener).not.toHaveBeenCalled();
    expect(repo.servers[0]?.enabled).toBe(true);
  });

  it("keeps rapid connector toggles optimistic and persists them in order", async () => {
    const firstSave = deferred<Record<string, never>>();
    const secondSave = deferred<Record<string, never>>();
    const writes: boolean[] = [];
    helperJsonrpcCall.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "camber/mcpServers/setEnabled") {
        writes.push((params as { enabled: boolean }).enabled);
        return await (writes.length === 1 ? firstSave.promise : secondSave.promise);
      }
      return {};
    });
    const repo = new UserMCPServersRepository();
    repo.servers = [{ name: "linear", enabled: true }];

    const disable = repo.setEnabled("linear", false);
    const enable = repo.setEnabled("linear", true);

    expect(repo.servers[0]?.enabled).toBe(true);
    await Promise.resolve();
    expect(writes).toEqual([false]);

    firstSave.resolve({});
    await disable;
    expect(writes).toEqual([false, true]);
    expect(repo.servers[0]?.enabled).toBe(true);

    secondSave.resolve({});
    await enable;
    expect(repo.servers[0]?.enabled).toBe(true);
  });

  it("does not surface an error from a save superseded by a newer toggle", async () => {
    const firstSave = deferred<Record<string, never>>();
    const secondSave = deferred<Record<string, never>>();
    const writes: boolean[] = [];
    helperJsonrpcCall.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "camber/mcpServers/setEnabled") {
        writes.push((params as { enabled: boolean }).enabled);
        return await (writes.length === 1 ? firstSave.promise : secondSave.promise);
      }
      return {};
    });
    const repo = new UserMCPServersRepository();
    repo.servers = [{ name: "linear", enabled: true }];

    const disable = repo.setEnabled("linear", false);
    const enable = repo.setEnabled("linear", true);

    firstSave.reject(new Error("boom"));
    await expect(disable).rejects.toThrow("boom");
    expect(repo.error).toBeNull();
    expect(repo.servers[0]?.enabled).toBe(true);

    secondSave.resolve({});
    await enable;
    expect(repo.error).toBeNull();
    expect(repo.servers[0]?.enabled).toBe(true);
  });

  it("reconciles local OAuth state when the helper invalidates a credential", async () => {
    let oauthAuthenticated = true;
    helperJsonrpcCall.mockImplementation(async (method: string) => {
      if (method === "camber/mcpServers/list") {
        return {
          servers: [
            {
              name: "huggingface",
              enabled: true,
              url: "https://huggingface.co/mcp",
              authMode: "oauth",
              oauthAuthenticated,
            },
          ],
        };
      }
      return {};
    });
    const repo = new UserMCPServersRepository();
    await repo.load();
    await repo.authenticate("huggingface");
    expect(repo.isOAuthAuthenticated(repo.servers[0]!)).toBe(true);

    oauthAuthenticated = false;
    await repo.load();

    expect(repo.isOAuthAuthenticated(repo.servers[0]!)).toBe(false);
    expect(repo.needsOAuthSignIn(repo.servers[0]!)).toBe(true);
  });

  it("records a readable error when a late OAuth callback rejects authenticate()", async () => {
    helperJsonrpcCall.mockImplementation(async (method: string) => {
      if (method === "camber/mcpServers/list") return { servers: [] };
      if (method === "camber/mcpServers/authenticate") {
        throw new Error("no pending OAuth flow matches the callback state");
      }
      return {};
    });
    const repo = new UserMCPServersRepository();
    repo.servers = [{ name: "huggingface", enabled: true, authMode: "oauth" }];

    await expect(repo.authenticate("huggingface")).rejects.toThrow(
      "no pending OAuth flow matches the callback state",
    );

    expect(repo.error).toBe("no pending OAuth flow matches the callback state");
    expect(repo.isOAuthAuthenticated(repo.servers[0]!)).toBe(false);
  });
});
