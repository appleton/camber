import {
  camberGitDiffContents,
  camberGitDiffList,
  camberGitDiffRead,
  type GitDiffChunk,
} from "@camber/helperapi";
import { render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { diffCodeViewMock } from "../shared/DiffCodeView.mock.svelte";
import DesktopDiffDocument from "./DesktopDiffDocument.svelte";

vi.mock("@camber/helperapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@camber/helperapi")>()),
  camberGitDiffList: vi.fn(),
  camberGitDiffRead: vi.fn(),
  camberGitDiffContents: vi.fn(),
}));

vi.mock("@camber/components/file-diff", async () => ({
  DiffCodeView: (await import("../shared/DiffCodeView.mock.svelte")).default,
}));

const readMock = vi.mocked(camberGitDiffRead);
const listMock = vi.mocked(camberGitDiffList);
const contentsMock = vi.mocked(camberGitDiffContents);

function patchFor(path: string, marker = "new"): string {
  return `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,1 +1,1 @@
-old
+${marker}
`;
}

function chunkFor(path: string, marker = "new"): GitDiffChunk {
  return { patch: patchFor(path, marker), rows: 2, additions: 1, deletions: 1 };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    initialFiles: [{ path: "large.ts", status: "modified" as const }],
    manifestComplete: true,
    scope: "uncommitted" as const,
    layout: "unified" as const,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ files: [], complete: true });
  readMock.mockImplementation(async ({ file }: { file: string }) => ({
    chunk: chunkFor(file),
    complete: true,
  }));
  contentsMock.mockResolvedValue({ hasContents: false });
});

describe("DesktopDiffDocument", () => {
  it("loads whole files by looping read cursors until complete", async () => {
    readMock
      .mockResolvedValueOnce({
        chunk: chunkFor("large.ts", "first-chunk"),
        nextCursor: "1",
        complete: false,
      })
      .mockResolvedValueOnce({
        chunk: {
          patch: "@@ -10,1 +10,1 @@\n-older\n+second-chunk\n",
          rows: 2,
          additions: 1,
          deletions: 1,
        },
        complete: true,
      });

    const { getByTestId } = render(DesktopDiffDocument, { props: baseProps() });

    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
    expect(readMock).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      file: "large.ts",
      cursor: "",
    });
    expect(readMock).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      file: "large.ts",
      cursor: "1",
    });
    // Both chunks land in one item, as a single joined patch.
    await waitFor(() => {
      const patch = getByTestId("diff-item-patch").textContent ?? "";
      expect(patch).toContain("+first-chunk");
      expect(patch).toContain("+second-chunk");
    });
    // The join strips the duplicated file header from later chunks.
    const patch = getByTestId("diff-item-patch").textContent ?? "";
    expect(patch.match(/diff --git/g)).toHaveLength(1);
  });

  it("drops a later chunk that repeats the header without any hunk", async () => {
    readMock
      .mockResolvedValueOnce({
        chunk: chunkFor("large.ts", "only-chunk"),
        nextCursor: "1",
        complete: false,
      })
      .mockResolvedValueOnce({
        // Header-only repeat with no "@@ " hunk line: contributes nothing.
        chunk: {
          patch: "diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n",
          rows: 0,
          additions: 0,
          deletions: 0,
        },
        complete: true,
      });

    const { getByTestId } = render(DesktopDiffDocument, { props: baseProps() });

    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(getByTestId("diff-item-patch").textContent).toContain("+only-chunk"),
    );
    const patch = getByTestId("diff-item-patch").textContent ?? "";
    expect(patch.match(/diff --git/g)).toHaveLength(1);
    expect(patch.match(/\+\+\+ /g)).toHaveLength(1);
  });

  it("renders a header-only item for binary files instead of dropping them", async () => {
    readMock.mockResolvedValue({
      chunk: { patch: "", rows: 0, additions: 0, deletions: 0, binary: true },
      complete: true,
    });

    const { container } = render(DesktopDiffDocument, {
      props: baseProps({ initialFiles: [{ path: "image.png", status: "modified" }] }),
    });

    // The file stays in the document as a synthesized header-only patch so
    // its header (with the binary note) renders.
    await waitFor(() =>
      expect(container.querySelector("[data-item-id='image.png']")).toBeInTheDocument(),
    );
    const patch = container.querySelector("[data-testid='diff-item-patch']")?.textContent ?? "";
    expect(patch).toBe("diff --git a/image.png b/image.png\n");
    await waitFor(() =>
      expect(container.querySelector(".diff-file-header-note")?.textContent?.trim()).toBe(
        "Binary file",
      ),
    );
  });

  it("renders a header-only item for files whose diff has no textual patch", async () => {
    readMock.mockResolvedValue({
      chunk: { patch: "", rows: 0, additions: 0, deletions: 0 },
      complete: true,
    });

    const { container } = render(DesktopDiffDocument, {
      props: baseProps({ initialFiles: [{ path: "empty.ts", status: "added" }] }),
    });

    await waitFor(() =>
      expect(container.querySelector("[data-item-id='empty.ts']")).toBeInTheDocument(),
    );
    expect(container.querySelector(".diff-file-header-badge")?.textContent).toBe("A");
  });

  it("abandons a pending reveal when the target file fails to load", async () => {
    readMock.mockImplementation(async ({ file }: { file: string }) => {
      if (file === "broken.ts") throw new Error("unreadable");
      return { chunk: chunkFor(file), complete: true };
    });

    const { component, getByText } = render(DesktopDiffDocument, {
      props: baseProps({ initialFiles: [{ path: "large.ts", status: "modified" }] }),
    });

    await component.revealFile("broken.ts");

    // The failed target never yields an item, so the pending scroll is
    // dropped rather than held forever.
    await waitFor(() => expect(getByText("Failed to load 1 file")).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(diffCodeViewMock.scrollToItem).not.toHaveBeenCalled();
  });

  it("renders files in manifest order as their patches resolve", async () => {
    const { container } = render(DesktopDiffDocument, {
      props: baseProps({
        initialFiles: [
          { path: "a.ts", status: "modified" },
          { path: "b.ts", status: "added" },
        ],
      }),
    });

    await waitFor(() =>
      expect(container.querySelectorAll("[data-testid='diff-item']")).toHaveLength(2),
    );
    const ids = Array.from(
      container.querySelectorAll<HTMLElement>("[data-testid='diff-item']"),
    ).map((row) => row.dataset["itemId"]);
    expect(ids).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps manifest order when opened to a target file", async () => {
    const { container } = render(DesktopDiffDocument, {
      props: baseProps({
        initialFiles: [
          { path: "a.ts", status: "modified" },
          { path: "b.ts", status: "modified" },
          { path: "c.ts", status: "modified" },
        ],
        // Opened by clicking c.ts in the changes list: prioritized for
        // loading and scrolling, but never re-ordered to the top.
        target: { path: "c.ts", status: "modified" },
      }),
    });

    await waitFor(() =>
      expect(container.querySelectorAll("[data-testid='diff-item']")).toHaveLength(3),
    );
    const ids = Array.from(
      container.querySelectorAll<HTMLElement>("[data-testid='diff-item']"),
    ).map((row) => row.dataset["itemId"]);
    expect(ids).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("slots an out-of-manifest target into manifest position once listed", async () => {
    listMock.mockResolvedValueOnce({
      files: [
        { path: "a.ts", status: "modified" },
        { path: "deep/target.ts", status: "modified" },
        { path: "z.ts", status: "modified" },
      ],
      complete: true,
    });

    const { container } = render(DesktopDiffDocument, {
      props: baseProps({
        initialFiles: [],
        nextCursor: "0",
        manifestComplete: false,
        // Target not in the (empty) first page: appended provisionally,
        // then sorted into its true slot when the manifest lands.
        target: { path: "deep/target.ts", status: "modified" },
      }),
    });

    await waitFor(() =>
      expect(container.querySelectorAll("[data-testid='diff-item']")).toHaveLength(3),
    );
    const ids = Array.from(
      container.querySelectorAll<HTMLElement>("[data-testid='diff-item']"),
    ).map((row) => row.dataset["itemId"]);
    expect(ids).toEqual(["a.ts", "deep/target.ts", "z.ts"]);
  });

  it("streams remaining manifest pages eagerly", async () => {
    listMock
      .mockResolvedValueOnce({
        files: [{ path: "next.ts", status: "added" }],
        nextCursor: "200",
        complete: false,
      })
      .mockResolvedValueOnce({
        files: [{ path: "last.ts", status: "modified" }],
        complete: true,
      });

    const { container } = render(DesktopDiffDocument, {
      props: baseProps({ initialFiles: [], nextCursor: "100", manifestComplete: false }),
    });

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(listMock).toHaveBeenNthCalledWith(1, { sessionId: "session-1", cursor: "100" });
    expect(listMock).toHaveBeenNthCalledWith(2, { sessionId: "session-1", cursor: "200" });
    await waitFor(() =>
      expect(container.querySelectorAll("[data-testid='diff-item']")).toHaveLength(2),
    );
  });

  it("enriches matching contents so pierre can expand collapsed context", async () => {
    contentsMock.mockResolvedValue({
      hasContents: true,
      oldContent: "old\n",
      newContent: "new\n",
    });

    const { container } = render(DesktopDiffDocument, { props: baseProps() });

    await waitFor(() =>
      expect(
        container.querySelector("[data-testid='diff-item']")?.getAttribute("data-enriched"),
      ).toBe("true"),
    );
    expect(contentsMock).toHaveBeenCalledWith({ sessionId: "session-1", file: "large.ts" });
  });

  it("skips enrichment when contents do not match the patch", async () => {
    contentsMock.mockResolvedValue({
      hasContents: true,
      oldContent: "drifted since the snapshot\n",
      newContent: "also drifted\n",
    });

    const { container } = render(DesktopDiffDocument, { props: baseProps() });

    await waitFor(() => expect(contentsMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        container.querySelector("[data-testid='diff-item']")?.getAttribute("data-enriched"),
      ).toBe("false"),
    );
  });

  it("does not request contents for added or deleted files", async () => {
    render(DesktopDiffDocument, {
      props: baseProps({
        initialFiles: [
          { path: "created.ts", status: "added" },
          { path: "removed.ts", status: "deleted" },
        ],
      }),
    });

    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(contentsMock).not.toHaveBeenCalled();
  });

  it("surfaces file read failures with a retry that reloads them", async () => {
    readMock.mockRejectedValue(new Error("git is not installed"));
    const { getByRole, getByText, container } = render(DesktopDiffDocument, {
      props: baseProps(),
    });

    await waitFor(() => expect(getByText("Failed to load 1 file")).toBeInTheDocument());

    readMock.mockImplementation(async ({ file }: { file: string }) => ({
      chunk: chunkFor(file, "recovered"),
      complete: true,
    }));
    getByRole("button", { name: "Retry" }).click();

    await waitFor(() =>
      expect(container.querySelector("[data-testid='diff-item-patch']")).toHaveTextContent(
        "+recovered",
      ),
    );
  });

  it("collapses and expands files through the public API", async () => {
    const { component, container } = render(DesktopDiffDocument, { props: baseProps() });
    const collapsedState = () =>
      container.querySelector("[data-testid='diff-item']")?.getAttribute("data-collapsed");

    await waitFor(() => expect(collapsedState()).toBe("false"));

    component.setAllCollapsed(true);
    await waitFor(() => expect(collapsedState()).toBe("true"));

    expect(component.expandFile("large.ts")).toBe(true);
    await waitFor(() => expect(collapsedState()).toBe("false"));
  });

  it("reports collapse counts to the owner", async () => {
    const onCollapsedChange = vi.fn();
    const { component } = render(DesktopDiffDocument, {
      props: baseProps({ onCollapsedChange }),
    });

    await waitFor(() => expect(onCollapsedChange).toHaveBeenCalledWith(0, 1));
    component.setAllCollapsed(true);
    await waitFor(() => expect(onCollapsedChange).toHaveBeenCalledWith(1, 1));
  });

  it("can reveal and demand-load a file not yet present in the manifest", async () => {
    const { component } = render(DesktopDiffDocument, {
      props: baseProps({ initialFiles: [] }),
    });

    await component.revealFile("deep/target.ts");

    await waitFor(() =>
      expect(readMock).toHaveBeenCalledWith({
        sessionId: "session-1",
        file: "deep/target.ts",
        cursor: "",
      }),
    );
    // Scrolls via pierre's item targeting once the file has rendered, with
    // the distance-capped smooth glide.
    await waitFor(() =>
      expect(diffCodeViewMock.scrollToItem.mock.lastCall).toEqual([
        "deep/target.ts",
        "smooth-auto",
      ]),
    );
  });

  it("prioritizes the reveal target over earlier manifest files", async () => {
    const pending = new Map<string, () => void>();
    readMock.mockImplementation(
      ({ file }: { file: string }) =>
        new Promise((resolve) => {
          pending.set(file, () => resolve({ chunk: chunkFor(file), complete: true }));
        }),
    );
    const manyFiles = Array.from({ length: 6 }, (_, i) => ({
      path: `file-${i}.ts`,
      status: "modified" as const,
    }));
    const { component } = render(DesktopDiffDocument, {
      props: baseProps({ initialFiles: manyFiles }),
    });

    // The three-wide pipeline fills with the first manifest files.
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(3));

    await component.revealFile("file-5.ts");
    // Release one slot; the reveal target must be read next, ahead of file-3.
    pending.get("file-0.ts")?.();
    await waitFor(() =>
      expect(
        readMock.mock.calls.some(([params]: [{ file: string }]) => params.file === "file-5.ts"),
      ).toBe(true),
    );
  });

  it("shows the empty state when the manifest finishes with no files", async () => {
    const { getByText } = render(DesktopDiffDocument, {
      props: baseProps({ initialFiles: [], nextCursor: "0", manifestComplete: false }),
    });

    await waitFor(() => expect(listMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(getByText("No changes to show.")).toBeInTheDocument());
  });

  it("adopts a replacement session in place, re-reading loaded files", async () => {
    const { container, rerender, getByTestId } = render(DesktopDiffDocument, {
      props: baseProps({ sessionId: "session-A" }),
    });
    await waitFor(() => expect(getByTestId("diff-item-patch")).toHaveTextContent("+new"));
    const mockRoot = container.querySelector("[data-testid='diff-code-view-mock']");
    const versionBefore = container
      .querySelector("[data-testid='diff-item']")
      ?.getAttribute("data-version");

    readMock.mockImplementation(async ({ file }: { file: string }) => ({
      chunk: chunkFor(file, "updated"),
      complete: true,
    }));
    listMock.mockResolvedValue({
      files: [{ path: "large.ts", status: "modified" }],
      complete: true,
    });
    await rerender({ sessionId: "session-B" });

    await waitFor(() => expect(getByTestId("diff-item-patch")).toHaveTextContent("+updated"));
    expect(readMock).toHaveBeenLastCalledWith({
      sessionId: "session-B",
      file: "large.ts",
      cursor: "",
    });
    // Changed content bumps the item version so pierre re-renders it.
    expect(
      container.querySelector("[data-testid='diff-item']")?.getAttribute("data-version"),
    ).not.toBe(versionBefore);
    // Same mock root node: the document reconciled rather than remounting.
    expect(container.querySelector("[data-testid='diff-code-view-mock']")).toBe(mockRoot);
  });

  it("keeps item versions stable when an adopted session returns identical patches", async () => {
    const { container, rerender, getByTestId } = render(DesktopDiffDocument, {
      props: baseProps({ sessionId: "session-A" }),
    });
    await waitFor(() => expect(getByTestId("diff-item-patch")).toHaveTextContent("+new"));
    const versionBefore = container
      .querySelector("[data-testid='diff-item']")
      ?.getAttribute("data-version");

    listMock.mockResolvedValue({
      files: [{ path: "large.ts", status: "modified" }],
      complete: true,
    });
    await rerender({ sessionId: "session-B" });

    await waitFor(() =>
      expect(
        readMock.mock.calls.some(
          ([params]: [{ sessionId: string }]) => params.sessionId === "session-B",
        ),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container.querySelector("[data-testid='diff-item']")?.getAttribute("data-version")).toBe(
      versionBefore,
    );
  });

  it("drops files that left the diff after a session swap", async () => {
    const { rerender, container, getByText } = render(DesktopDiffDocument, {
      props: baseProps({
        sessionId: "session-A",
        initialFiles: [{ path: "gone.ts", status: "modified" }],
      }),
    });
    await waitFor(() =>
      expect(container.querySelector("[data-item-id='gone.ts']")).toBeInTheDocument(),
    );

    listMock.mockResolvedValue({ files: [], complete: true });
    await rerender({ sessionId: "session-B" });

    await waitFor(() =>
      expect(container.querySelector("[data-item-id='gone.ts']")).not.toBeInTheDocument(),
    );
    expect(getByText("No changes to show.")).toBeInTheDocument();
  });

  it("reports ready once the first file has rendered", async () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn();
      render(DesktopDiffDocument, { props: baseProps({ onReady }) });

      await vi.advanceTimersByTimeAsync(50);
      expect(onReady).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports ready at the deadline when reads hang", async () => {
    vi.useFakeTimers();
    try {
      readMock.mockReturnValue(new Promise(() => undefined));
      const onReady = vi.fn();
      render(DesktopDiffDocument, { props: baseProps({ onReady }) });

      await vi.advanceTimersByTimeAsync(500);
      expect(onReady).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(150);
      expect(onReady).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders custom headers with name, badge, and counts", async () => {
    const { container } = render(DesktopDiffDocument, { props: baseProps() });

    await waitFor(() => expect(container.querySelector(".diff-file-header")).toBeInTheDocument());
    const header = container.querySelector(".diff-file-header");
    expect(header?.querySelector(".diff-file-header-name")?.textContent?.trim()).toBe("large.ts");
    expect(header?.querySelector(".diff-file-header-badge")?.textContent).toBe("M");
    const counts = header?.querySelector(".diff-file-header-counts");
    expect(counts?.textContent).toContain("1");
    expect(counts?.textContent).toContain("addition");
    expect(counts?.textContent).toContain("deletion");
  });

  it("re-renders mounted headers reactively when collapse state changes", async () => {
    const { component, container } = render(DesktopDiffDocument, { props: baseProps() });

    await waitFor(() => expect(container.querySelector(".diff-file-header")).toBeInTheDocument());
    const chevron = container.querySelector(".diff-file-header-collapse");
    expect(chevron).toHaveAttribute("aria-expanded", "true");

    component.setAllCollapsed(true);
    // Same mounted header element updates in place via Svelte reactivity.
    await waitFor(() => expect(chevron).toHaveAttribute("aria-expanded", "false"));
    expect(chevron).toHaveClass("is-collapsed");
  });
});
