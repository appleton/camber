import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adoptHandoffDeviceToken,
  DEVICE_TOKEN_STORAGE_KEY,
  deviceTokenHandoffHash,
  recoverSession,
} from "./deviceSession";

function response(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

describe("recoverSession", () => {
  beforeEach(() => {
    localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, "device-token-1");
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("mints a new session with the stored device token", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/session");
      expect(JSON.parse(String(init?.body))).toEqual({ deviceToken: "device-token-1" });
      return response(200, { deviceId: "dev-1" });
    });
    expect(await recoverSession(fetchFn as typeof fetch)).toEqual({
      status: "recovered",
      deviceId: "dev-1",
    });
  });

  it("reports unauthorized when the token is rejected", async () => {
    const fetchFn = vi.fn(async () => response(401, { error: "unknown device token" }));
    expect(await recoverSession(fetchFn as typeof fetch)).toEqual({ status: "unauthorized" });
  });

  it("reports unauthorized when no token is stored", async () => {
    localStorage.clear();
    const fetchFn = vi.fn();
    expect(await recoverSession(fetchFn as unknown as typeof fetch)).toEqual({
      status: "unauthorized",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports unavailable on network errors and 5xx (token may still be good)", async () => {
    expect(await recoverSession(vi.fn(async () => response(502)) as typeof fetch)).toEqual({
      status: "unavailable",
    });
    expect(
      await recoverSession(
        vi.fn(async () => {
          throw new TypeError("network down");
        }) as unknown as typeof fetch,
      ),
    ).toEqual({ status: "unavailable" });
  });
});

describe("deviceTokenHandoffHash", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("encodes the stored token into a fragment", () => {
    localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, "tok/en+1");
    expect(deviceTokenHandoffHash()).toBe("#camberDeviceToken=tok%2Fen%2B1");
  });

  it("returns empty when no token is stored", () => {
    expect(deviceTokenHandoffHash()).toBe("");
  });
});

describe("adoptHandoffDeviceToken", () => {
  afterEach(() => {
    localStorage.clear();
  });

  function fakeHistory() {
    return { replaceState: vi.fn() } as unknown as Pick<History, "replaceState"> & {
      replaceState: ReturnType<typeof vi.fn>;
    };
  }

  it("stores the token and scrubs it from the URL", () => {
    const history = fakeHistory();
    const adopted = adoptHandoffDeviceToken(
      { hash: "#camberDeviceToken=tok%2Fen%2B1", pathname: "/", search: "" },
      history,
    );
    expect(adopted).toBe(true);
    expect(localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY)).toBe("tok/en+1");
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("overwrites an existing token (the handoff is newer intent)", () => {
    localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, "old");
    adoptHandoffDeviceToken(
      { hash: "#camberDeviceToken=new", pathname: "/", search: "" },
      fakeHistory(),
    );
    expect(localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY)).toBe("new");
  });

  it("ignores route hashes and empty fragments", () => {
    const history = fakeHistory();
    expect(adoptHandoffDeviceToken({ hash: "#/c/abc", pathname: "/", search: "" }, history)).toBe(
      false,
    );
    expect(adoptHandoffDeviceToken({ hash: "", pathname: "/", search: "" }, history)).toBe(false);
    expect(localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY)).toBe(null);
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
