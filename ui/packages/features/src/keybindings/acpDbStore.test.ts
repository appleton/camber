import { describe, expect, it, vi } from "vitest";
import { createAcpDbKeybindingStore } from "./acpDbStore";

function client(initial: Record<string, string | null> = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  let stored = initial;
  return {
    calls,
    get stored() {
      return stored;
    },
    jsonrpcCall: vi.fn(async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "camber/acpNav/getKeybindings") return { keybindings: stored };
      if (method === "camber/acpNav/setKeybindings") {
        stored = params.keybindings;
        return { keybindings: stored };
      }
      return null;
    }),
  };
}

describe("createAcpDbKeybindingStore", () => {
  it("hydrates overrides from the ACP DB into memory", async () => {
    const c = client({ focusInput: "mod+j", togglePlanMode: null });
    const store = createAcpDbKeybindingStore(c);
    expect(store.get("focusInput")).toBeUndefined(); // not loaded yet

    await store.hydrate();
    expect(store.get("focusInput")).toBe("mod+j");
    expect(store.get("togglePlanMode")).toBeNull(); // explicit unbind preserved
    expect(store.get("newConversation")).toBeUndefined();
  });

  it("persists the whole map on set and clear", async () => {
    const c = client();
    const store = createAcpDbKeybindingStore(c);

    store.set("focusInput", "mod+j");
    store.set("togglePlanMode", null);
    await vi.waitFor(() => expect(c.stored).toEqual({ focusInput: "mod+j", togglePlanMode: null }));

    store.clear("focusInput");
    await vi.waitFor(() => expect(c.stored).toEqual({ togglePlanMode: null }));
  });

  it("keeps the in-memory binding even when persistence fails", async () => {
    const store = createAcpDbKeybindingStore({
      jsonrpcCall: vi.fn(async () => {
        throw new Error("helper unavailable");
      }),
    });
    store.set("focusInput", "mod+j");
    expect(store.get("focusInput")).toBe("mod+j");
    await expect(store.hydrate()).resolves.toBeUndefined(); // swallows load failure
  });
});
