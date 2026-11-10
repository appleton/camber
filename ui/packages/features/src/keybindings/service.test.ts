import { describe, expect, it, vi } from "vitest";
import { ALL_COMMANDS, COMMAND_GROUPS } from "./commands";
import { createDelegatedKeybindingService, createDesktopKeybindingService } from "./service";

function keydown(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    target: init.target ?? null,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe("registry integrity", () => {
  it("has unique command ids", () => {
    const ids = ALL_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares a default only for hosts it targets", () => {
    for (const command of ALL_COMMANDS) {
      for (const host of Object.keys(command.defaults)) {
        expect(command.hosts).toContain(host);
      }
    }
  });

  it("keeps unrelated webview commands off native split shortcuts", () => {
    const nativeSplitChords = new Set(["mod+d", "mod+shift+d"]);
    for (const command of ALL_COMMANDS) {
      expect(nativeSplitChords).not.toContain(command.defaults.desktop);
    }
  });

  it("keeps a stable, author-controlled order for the settings page", () => {
    expect(COMMAND_GROUPS.map((g) => g.category)).toEqual([
      "Conversation",
      "Project",
      "Prompt",
      "Approvals",
      "Panels",
      "Application",
    ]);
  });
});

describe("desktop service", () => {
  it("dispatches the registered handler when its chord matches", () => {
    const kb = createDesktopKeybindingService({ platform: "mac" });
    const handler = vi.fn();
    kb.register("focusInput", handler);

    kb.handleKeydown(keydown({ key: "i", metaKey: true })); // mod+i on mac
    expect(handler).toHaveBeenCalledTimes(1);

    kb.handleKeydown(keydown({ key: "i" }));
    expect(handler).toHaveBeenCalledTimes(1); // no extra fire
  });

  it("dispatches Command-Period as the macOS stop-agent alternative", () => {
    const kb = createDesktopKeybindingService({ platform: "mac" });
    const handler = vi.fn();
    const event = keydown({ key: ".", metaKey: true });
    kb.register("interrupt", handler);

    kb.handleKeydown(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  const input = { tagName: "INPUT" } as HTMLElement;
  const insideInput = { isEditableTarget: (target: EventTarget | null) => target === input };

  it("fires a modifier chord even inside an editable target", () => {
    const kb = createDesktopKeybindingService({ platform: "mac", ...insideInput });
    const handler = vi.fn();
    kb.register("focusInput", handler); // default mod+i carries a modifier
    kb.handleKeydown(keydown({ key: "i", metaKey: true, target: input }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not steal a bare key inside an editable target", () => {
    const overrides = new Map<string, string | null>([["focusInput", "i"]]);
    const kb = createDesktopKeybindingService({
      platform: "mac",
      ...insideInput,
      overrides: {
        get: (id) => overrides.get(id),
        set: (id, chord) => overrides.set(id, chord),
        clear: (id) => overrides.delete(id),
      },
    });
    const handler = vi.fn();
    kb.register("focusInput", handler); // overridden to the bare key "i"

    kb.handleKeydown(keydown({ key: "i", target: input }));
    expect(handler).not.toHaveBeenCalled(); // suppressed while typing in an input

    kb.handleKeydown(keydown({ key: "i", target: null }));
    expect(handler).toHaveBeenCalledTimes(1); // but fires outside an editable target
  });

  it("respects user overrides over registry defaults", () => {
    const overrides = new Map<string, string | null>([["focusInput", "mod+j"]]);
    const kb = createDesktopKeybindingService({
      platform: "mac",
      overrides: {
        get: (id) => overrides.get(id),
        set: (id, chord) => overrides.set(id, chord),
        clear: (id) => overrides.delete(id),
      },
    });
    expect(kb.binding("focusInput")).toBe("mod+j");
    expect(kb.hint("focusInput")).toBe("⌘J");
  });

  it("records a new binding, suppresses dispatch mid-record, and resets to default", () => {
    const kb = createDesktopKeybindingService({ platform: "mac" });
    const handler = vi.fn();
    kb.register("focusInput", handler);

    kb.beginRecording();
    kb.handleKeydown(keydown({ key: "i", metaKey: true })); // old chord ignored while recording
    expect(handler).not.toHaveBeenCalled();
    kb.setBinding("focusInput", "mod+j");
    kb.endRecording();

    kb.handleKeydown(keydown({ key: "j", metaKey: true })); // new chord fires
    expect(handler).toHaveBeenCalledTimes(1);
    kb.handleKeydown(keydown({ key: "i", metaKey: true })); // old chord no longer bound
    expect(handler).toHaveBeenCalledTimes(1);

    kb.resetBinding("focusInput");
    expect(kb.binding("focusInput")).toBe("mod+i"); // back to registry default
  });
});

describe("delegated (vscode) service", () => {
  it("returns no binding dispatch and prefers host-resolved hints", () => {
    const hints: Record<string, string | undefined> = { "camber.togglePlanMode": "⇧⇥" };
    const kb = createDelegatedKeybindingService({ platform: "mac", getHostHints: () => hints });

    const handler = vi.fn();
    kb.register("togglePlanMode", handler);
    kb.handleKeydown(keydown({ key: "Tab", shiftKey: true }));
    expect(handler).not.toHaveBeenCalled(); // host dispatches, not the webview

    expect(kb.hint("togglePlanMode")).toBe("⇧⇥"); // host-resolved hint wins
  });
});
