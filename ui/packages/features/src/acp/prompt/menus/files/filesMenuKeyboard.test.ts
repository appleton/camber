import { classifyQuery } from "@camber/lib/path-query";
import { describe, expect, it } from "vitest";
import { decideFilePickerAction, type KeyboardSnapshot } from "./filesMenuKeyboard.js";
import type { FileLike } from "./pathRewrites.js";

function event(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...init });
}

function snapshot(overrides: Partial<KeyboardSnapshot> = {}): KeyboardSnapshot {
  return {
    query: classifyQuery(""),
    files: [],
    selectedFile: null,
    selectedControl: null,
    hasParentControl: false,
    hasSelectedAction: false,
    searchComplete: true,
    ...overrides,
  };
}

describe("decideFilePickerAction — open quote handling", () => {
  it('closes the quote and fires the selected action on `"` when there is an exact match', () => {
    const file: FileLike = { path: "/tmp/notes.md", displayPath: "/tmp/notes.md" };
    const action = decideFilePickerAction(
      event('"'),
      snapshot({
        query: classifyQuery('"/tmp/notes.md'),
        files: [file],
        selectedFile: file,
        hasSelectedAction: true,
      }),
    );
    expect(action.kind).toBe("close-quote-and-action");
  });

  it("closes the quote without firing an action when there is no exact match", () => {
    const action = decideFilePickerAction(
      event('"'),
      snapshot({
        query: classifyQuery('"/tmp/no'),
        files: [{ path: "/tmp/notes.md" }],
      }),
    );
    expect(action.kind).toBe("close-quote");
  });

  it("rewrites and closes when the user types a space into an empty open-quoted query", () => {
    const action = decideFilePickerAction(
      event(" "),
      snapshot({
        query: classifyQuery('"abc'),
        files: [],
        searchComplete: true,
      }),
    );
    expect(action).toEqual({ kind: "rewrite-and-close", suffix: " " });
  });

  it("rewrites and closes on Tab/Enter/Escape with an empty open-quoted query", () => {
    for (const key of ["Tab", "Enter", "Escape"] as const) {
      const action = decideFilePickerAction(
        event(key),
        snapshot({
          query: classifyQuery('"abc'),
          files: [],
          searchComplete: true,
        }),
      );
      expect(action).toEqual({ kind: "rewrite-and-close", suffix: "" });
    }
  });

  it("does not rewrite on unrelated keys", () => {
    const action = decideFilePickerAction(
      event("a"),
      snapshot({
        query: classifyQuery('"abc'),
        files: [],
        searchComplete: true,
      }),
    );
    expect(action.kind).toBe("passthrough");
  });
});

describe("decideFilePickerAction — folder controls", () => {
  it("navigates to parent on Enter when parent control is selected", () => {
    const action = decideFilePickerAction(event("Enter"), snapshot({ selectedControl: "parent" }));
    expect(action.kind).toBe("navigate-to-parent");
  });

  it("navigates to parent on Tab when parent control is selected", () => {
    const action = decideFilePickerAction(event("Tab"), snapshot({ selectedControl: "parent" }));
    expect(action.kind).toBe("navigate-to-parent");
  });

  it("navigates to parent on Shift+Tab when a parent control is available", () => {
    const dir: FileLike = { path: "/Users/me/Documents", isDirectory: true };
    const action = decideFilePickerAction(
      event("Tab", { shiftKey: true }),
      snapshot({
        query: classifyQuery("~/Documents/"),
        selectedFile: dir,
        hasParentControl: true,
      }),
    );
    expect(action.kind).toBe("navigate-to-parent");
  });

  it("passes Shift+Tab through when no parent control is available", () => {
    const dir: FileLike = { path: "/Users/me/Documents", isDirectory: true };
    const action = decideFilePickerAction(
      event("Tab", { shiftKey: true }),
      snapshot({
        query: classifyQuery("~/Doc"),
        selectedFile: dir,
        hasParentControl: false,
      }),
    );
    expect(action.kind).toBe("passthrough");
  });

  it("swallows Tab/Enter on the no-match row", () => {
    expect(
      decideFilePickerAction(event("Tab"), snapshot({ selectedControl: "no-match" })).kind,
    ).toBe("noop");
    expect(
      decideFilePickerAction(event("Enter"), snapshot({ selectedControl: "no-match" })).kind,
    ).toBe("noop");
  });
});

describe("decideFilePickerAction — directory drill-in", () => {
  const dir: FileLike = { path: "/Users/me/Documents", isDirectory: true };

  it("drills into a directory on Tab when in folder mode", () => {
    const action = decideFilePickerAction(
      event("Tab"),
      snapshot({ query: classifyQuery("~/Doc"), selectedFile: dir }),
    );
    expect(action).toEqual({ kind: "navigate-into", file: dir });
  });

  it("does not drill in for fuzzy queries", () => {
    const action = decideFilePickerAction(
      event("Tab"),
      snapshot({ query: classifyQuery("Doc"), selectedFile: dir }),
    );
    expect(action.kind).toBe("passthrough");
  });

  it("does not drill in when the selected hit is a regular file", () => {
    const file: FileLike = { path: "/Users/me/Documents/notes.md", isDirectory: false };
    const action = decideFilePickerAction(
      event("Tab"),
      snapshot({ query: classifyQuery("~/Doc"), selectedFile: file }),
    );
    expect(action.kind).toBe("passthrough");
  });

  it("drills into a directory on Enter when in folder mode", () => {
    const action = decideFilePickerAction(
      event("Enter"),
      snapshot({ query: classifyQuery("~/Doc"), selectedFile: dir }),
    );
    expect(action).toEqual({ kind: "navigate-into", file: dir });
  });
});
