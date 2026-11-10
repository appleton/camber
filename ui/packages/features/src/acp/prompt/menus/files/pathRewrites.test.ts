import { classifyQuery } from "@camber/lib/path-query";
import { describe, expect, it } from "vitest";
import {
  folderContextQuery,
  isExactSingleMatch,
  isWindowsOperatingSystem,
  navigationTarget,
  parentQuery,
  preferredSeparator,
  replacementQuery,
} from "./pathRewrites.js";

describe("preferredSeparator", () => {
  it("uses the separator already in the query", () => {
    expect(preferredSeparator("~/foo", "/abs/path")).toBe("/");
    expect(preferredSeparator("C:\\foo", "C:\\path")).toBe("\\");
  });

  it("falls back to backslash when path is Windows-style and query is bare", () => {
    expect(preferredSeparator("foo", "C:\\Users\\me")).toBe("\\");
  });

  it("falls back to forward slash otherwise", () => {
    expect(preferredSeparator("", "")).toBe("/");
    expect(preferredSeparator("foo", "/Users/me")).toBe("/");
  });
});

describe("folderContextQuery", () => {
  it("returns the input when it ends with a separator", () => {
    expect(folderContextQuery("~/Documents/")).toBe("~/Documents/");
    expect(folderContextQuery("./src/")).toBe("./src/");
  });

  it("strips the trailing segment when there's a separator", () => {
    expect(folderContextQuery("~/Documents/note")).toBe("~/Documents/");
    expect(folderContextQuery("./src/file.ts")).toBe("./src/");
  });

  it("expands `~` and `.` shorthands", () => {
    expect(folderContextQuery("~")).toBe("~/");
    expect(folderContextQuery(".")).toBe("./");
  });

  it("returns bare names unchanged", () => {
    expect(folderContextQuery("foo")).toBe("foo");
  });
});

describe("parentQuery", () => {
  it("walks up one directory in user mode", () => {
    expect(parentQuery("~/Documents/notes/")).toBe("~/Documents/");
  });

  it("walks up one directory in absolute mode", () => {
    expect(parentQuery("/etc/nginx/")).toBe("/etc/");
  });

  it("walks up from the directory context when the query points at a file", () => {
    // The user typing `/etc/hosts` is browsing `/etc/` with `hosts` as the
    // partial filter; the parent control should walk up *from that directory*,
    // not from the typed file path.
    expect(parentQuery("/etc/hosts")).toBe("/");
  });

  it("returns the context when there is no parent to walk to", () => {
    expect(parentQuery("foo")).toBe("foo");
    expect(parentQuery("~/")).toBe("~/");
  });
});

describe("navigationTarget", () => {
  it("preserves the `~/` shorthand when drilling in", () => {
    const query = classifyQuery("~/Doc");
    expect(navigationTarget(query, { path: "/Users/me/Documents", isDirectory: true })).toBe(
      "~/Documents/",
    );
  });

  it("preserves the `./` shorthand when drilling in", () => {
    const query = classifyQuery("./src/foo");
    expect(navigationTarget(query, { path: "/repo/src/foo", isDirectory: true })).toBe(
      "./src/foo/",
    );
  });

  it("falls back to the absolute path for absolute mode", () => {
    const query = classifyQuery("/tmp/foo");
    expect(navigationTarget(query, { path: "/tmp/foo", isDirectory: true })).toBe("/tmp/foo/");
  });

  it("wraps in opening quote when the result has spaces", () => {
    const query = classifyQuery('"~/My Folder/"');
    expect(navigationTarget(query, { path: "/Users/me/My Folder/Sub", isDirectory: true })).toBe(
      '"~/My Folder/Sub/',
    );
  });

  it("preserves the user's quoted mode even when target has no spaces", () => {
    const query = classifyQuery('"~/');
    expect(navigationTarget(query, { path: "/Users/me/Documents", isDirectory: true })).toBe(
      '"~/Documents/',
    );
  });

  it("respects the chosen separator on Windows-style queries", () => {
    const query = classifyQuery("~\\Documents", { isWindows: true });
    expect(navigationTarget(query, { path: "C:\\Users\\me\\Documents\\notes" })).toBe("~\\notes\\");
  });

  it("uses an explicit navigationPath when provided", () => {
    const query = classifyQuery("./");
    expect(
      navigationTarget(query, {
        path: "/repo/packages/app",
        isDirectory: true,
        navigationPath: "./App Workspace/",
      }),
    ).toBe('"./App Workspace/');
  });
});

describe("replacementQuery", () => {
  it("wraps in opening quote when the new query has spaces", () => {
    const query = classifyQuery("foo");
    expect(replacementQuery("a b/", query)).toBe('"a b/');
  });

  it("preserves quoted mode even without spaces", () => {
    const query = classifyQuery('"abc');
    expect(replacementQuery("def/", query)).toBe('"def/');
  });

  it("returns the input untouched when neither condition triggers", () => {
    const query = classifyQuery("foo");
    expect(replacementQuery("bar/", query)).toBe("bar/");
  });
});

describe("isExactSingleMatch", () => {
  it("matches against the absolute path", () => {
    const query = classifyQuery('"/tmp/notes.md"');
    expect(isExactSingleMatch(query, [{ path: "/tmp/notes.md" }])).toBe(true);
  });

  it("matches against the displayPath shorthand", () => {
    const query = classifyQuery('"~/notes.md"');
    expect(
      isExactSingleMatch(query, [{ path: "/Users/me/notes.md", displayPath: "~/notes.md" }]),
    ).toBe(true);
  });

  it("ignores trailing separators in either side", () => {
    const query = classifyQuery('"/tmp/dir/"');
    expect(isExactSingleMatch(query, [{ path: "/tmp/dir" }])).toBe(true);
  });

  it("returns false for partial matches", () => {
    const query = classifyQuery("/tmp/note");
    expect(isExactSingleMatch(query, [{ path: "/tmp/notes.md" }])).toBe(false);
  });

  it("returns false when there is more than one file", () => {
    const query = classifyQuery("/tmp/notes.md");
    expect(
      isExactSingleMatch(query, [{ path: "/tmp/notes.md" }, { path: "/tmp/notes-2.md" }]),
    ).toBe(false);
  });
});

describe("isWindowsOperatingSystem", () => {
  it("uses the host operating system value instead of browser platform hints", () => {
    expect(isWindowsOperatingSystem("win32")).toBe(true);
    expect(isWindowsOperatingSystem("darwin")).toBe(false);
    expect(isWindowsOperatingSystem(undefined)).toBe(false);
  });
});
