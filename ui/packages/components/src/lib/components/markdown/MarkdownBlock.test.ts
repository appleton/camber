import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { userEvent } from "@testing-library/user-event";
import { readable } from "svelte/store";
import { beforeAll, describe, expect, it, vi } from "vitest";
import MarkdownBlock from "./MarkdownBlock.svelte";
import type { MarkdownHostAdapter } from "./host.js";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })),
  );
});

describe("MarkdownBlock", () => {
  it("inserts ordinary Markdown before the initial Svelte flush can paint", () => {
    const { container } = render(MarkdownBlock, {
      props: { content: "Rendered without an empty intermediate frame." },
    });

    expect(container.querySelector("p")?.textContent).toBe(
      "Rendered without an empty intermediate frame.",
    );
  });

  it("preserves settled block DOM while only the streaming tail changes", async () => {
    const { container, rerender } = render(MarkdownBlock, {
      props: { content: "First paragraph", streaming: true },
    });

    await waitFor(() => expect(container.querySelector("p")?.textContent).toBe("First paragraph"));
    const firstSegment = container.querySelector(":scope > .markdown > .markdown");
    expect(firstSegment).not.toBeNull();

    await rerender({ content: "First paragraph\n\nSecond", streaming: true });
    const afterSettlement = await waitFor(() => {
      const elements = container.querySelectorAll(":scope > .markdown > .markdown");
      expect(elements).toHaveLength(2);
      return elements;
    });
    expect(afterSettlement).toHaveLength(2);
    expect(afterSettlement[0]).toBe(firstSegment);
    const liveSegment = afterSettlement[1];

    await rerender({ content: "First paragraph\n\nSecond grows", streaming: true });
    const afterTailGrowth = await waitFor(() => {
      const elements = container.querySelectorAll(":scope > .markdown > .markdown");
      expect(elements[1]?.textContent).toContain("Second grows");
      return elements;
    });
    expect(afterTailGrowth[0]).toBe(firstSegment);
    expect(afterTailGrowth[1]).toBe(liveSegment);
    expect(afterTailGrowth[1]?.textContent).toContain("Second grows");
  });

  it("opens markdown links that target workspace files", async () => {
    const openFile = vi.fn();
    const checkFileExists = vi.fn(async (path: string) => path === "/repo/docs/review.md");
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [{ path: "/repo" }],
      }),
      checkFileExists,
      openFile,
    };

    render(MarkdownBlock, {
      props: {
        content: "[docs/review.md](docs/review.md)",
        host,
      },
    });

    const link = await screen.findByRole("button", { name: "Open file docs/review.md" });
    await userEvent.click(link);

    expect(checkFileExists).toHaveBeenCalledWith("/repo/docs/review.md");
    expect(openFile).toHaveBeenCalledWith("/repo/docs/review.md", undefined, undefined, {
      preferredEditor: false,
    });
  });

  it("renders quoted file paths in prose as file chips, swallowing the quotes", async () => {
    const openFile = vi.fn();
    const checkFileExists = vi.fn(async (path: string) => path === "/repo/src/main.ts");
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [{ path: "/repo" }],
      }),
      checkFileExists,
      openFile,
    };

    const { container } = render(MarkdownBlock, {
      props: {
        content: 'The entry point is "src/main.ts", open it.',
        host,
      },
    });

    const chip = await screen.findByRole("button", { name: "Open file main.ts" });
    expect(container.textContent).not.toContain('"');
    expect(container.textContent).toContain("The entry point is ");
    expect(container.textContent).toContain(", open it.");

    await userEvent.click(chip);
    expect(openFile).toHaveBeenCalledWith("/repo/src/main.ts", undefined, undefined, {
      preferredEditor: false,
    });
  });

  it("renders a quoted path inside inline code as a file chip", async () => {
    const checkFileExists = vi.fn(async (path: string) => path === "/repo/src/main.ts");
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [{ path: "/repo" }],
      }),
      checkFileExists,
      openFile: vi.fn(),
    };

    const { container } = render(MarkdownBlock, {
      props: {
        content: 'See `"src/main.ts"` for details',
        host,
      },
    });

    await screen.findByRole("button", { name: "Open file main.ts" });
    expect(container.textContent).not.toContain('"');
  });

  it("renders $-invoked skills and slash commands as chips", async () => {
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [],
      }),
      getSlashCommands: () => ({ commands: ["plan", "goal"], skills: ["$uv"] }),
      getSlashCommandIcon: (commandName) => (commandName === "goal" ? "target" : undefined),
    };

    const { container } = render(MarkdownBlock, {
      props: { content: "try $uv then /plan and /goal now", isUser: true, host },
    });

    await waitFor(() => expect(container.querySelector("[data-skill]")).toBeTruthy());
    const skillChip = container.querySelector("[data-skill]");
    expect(skillChip?.getAttribute("data-skill")).toBe("$uv");
    expect(skillChip?.textContent?.trim()).toBe("uv");
    expect(container.querySelector("[data-command]")?.getAttribute("data-command")).toBe("plan");
    const goalChip = container.querySelector('[data-command="goal"]');
    expect(goalChip).toBeTruthy();
    expect(goalChip?.querySelector("svg")?.getAttribute("overflow")).toBe("visible");
    const goalIconPaths = Array.from(goalChip?.querySelectorAll("path") ?? [], (path) =>
      path.getAttribute("d"),
    ).join(" ");
    expect(goalIconPaths).toContain("M9.2 6.8L6.5 9.5");
    expect(goalIconPaths).toContain(
      "M11.3 2.3L8.75 4.85V6.35L9.65 7.25H11.15L13.7 4.7L10.588 5.412L11.3 2.3Z",
    );
    expect(container.textContent).toContain("try ");
    expect(container.textContent).toContain(" then ");
    expect(container.textContent).toContain(" now");
  });

  it("retokenizes settled markdown when the known skill list loads", async () => {
    const state = readable({
      userSettings: {},
      environment: { assistantHost: "desktop" },
      workspaces: [],
    });
    const initialHost: MarkdownHostAdapter = {
      state,
      getSlashCommands: () => ({ commands: [], skills: [] }),
    };
    const loadedHost: MarkdownHostAdapter = {
      state,
      getSlashCommands: () => ({ commands: [], skills: ["$helper-only"] }),
    };

    const { container, rerender } = render(MarkdownBlock, {
      props: {
        content: "$helper-only please",
        isUser: true,
        host: initialHost,
      },
    });

    expect(container.querySelector("[data-skill]")).toBeNull();
    await rerender({
      content: "$helper-only please",
      isUser: true,
      host: loadedHost,
    });

    await waitFor(() =>
      expect(container.querySelector("[data-skill]")?.textContent?.trim()).toBe("helper-only"),
    );
  });

  it("opens markdown file links in the preferred editor on platform-primary click", async () => {
    const openFile = vi.fn();
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [{ path: "/repo" }],
      }),
      checkFileExists: vi.fn(async (path: string) => path === "/repo/docs/review.md"),
      openFile,
    };

    render(MarkdownBlock, {
      props: {
        content: "[docs/review.md](docs/review.md:12:3)",
        host,
      },
    });

    const link = await screen.findByRole("button", { name: "Open file docs/review.md" });
    await fireEvent.click(link, { ctrlKey: true });

    expect(openFile).toHaveBeenCalledWith("/repo/docs/review.md", 12, 3, {
      preferredEditor: true,
    });
  });

  it("delegates markdown file link context menus to the host", async () => {
    const showFileContextMenu = vi.fn();
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [{ path: "/repo" }],
      }),
      checkFileExists: vi.fn(async (path: string) => path === "/repo/docs/review.md"),
      showFileContextMenu,
    };

    render(MarkdownBlock, {
      props: {
        content: "[docs/review.md](docs/review.md:12:3)",
        host,
      },
    });

    const link = await screen.findByRole("button", { name: "Open file docs/review.md" });
    await userEvent.pointer({
      keys: "[MouseRight]",
      target: link,
      coords: { clientX: 17, clientY: 23 },
    });

    expect(showFileContextMenu).toHaveBeenCalledWith({
      path: "/repo/docs/review.md",
      line: 12,
      column: 3,
      position: { x: 17, y: 23 },
    });
  });

  it("uses custom markdown link text as the file link label", async () => {
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [{ path: "/repo" }],
      }),
      checkFileExists: vi.fn(async (path: string) => path === "/repo/docs/review.md"),
      openFile: vi.fn(),
    };

    render(MarkdownBlock, {
      props: {
        content: "[review notes](docs/review.md)",
        host,
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open file review notes" })).toBeInTheDocument();
    });
  });

  it("previews image file chips on hover", async () => {
    const imageData =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const getImageFileData = vi.fn(async (path: string) => ({
      data: imageData,
      mimeType: "image/png",
      path,
    }));
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [{ path: "/repo" }],
      }),
      checkFileExists: vi.fn(async (path: string) => path === "/repo/assets/cat.png"),
      getImageFileData,
      openFile: vi.fn(),
    };

    render(MarkdownBlock, {
      props: {
        content: "[cat.png](assets/cat.png)",
        host,
      },
    });

    const chip = await screen.findByRole("button", { name: "Open file cat.png" });
    await userEvent.hover(chip);

    await waitFor(() => {
      expect(getImageFileData).toHaveBeenCalledWith("/repo/assets/cat.png");
    });
    const preview = await screen.findByAltText("Preview of cat.png");
    expect(preview).toHaveAttribute("src", `data:image/png;base64,${imageData}`);
    expect(preview).toHaveClass("block", "max-w-full");
    expect(preview.parentElement).toHaveClass("box-border", "max-w-80", "overflow-hidden");
  });

  it("opens absolute markdown file links with encoded spaces and line numbers", async () => {
    const decodedPath =
      "/Users/poolie/Library/Application Support/camber/worktrees/pale-porthole/ui/packages/components/src/lib/components/markdown/RenderedMarkdown.svelte";
    const encodedTarget = decodedPath.replace("Application Support", "Application%20Support");
    const openFile = vi.fn();
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [
          {
            path: "/Users/poolie/Library/Application Support/camber/worktrees/pale-porthole",
          },
        ],
      }),
      checkFileExists: vi.fn(async (path: string) => path === decodedPath),
      openFile,
    };

    render(MarkdownBlock, {
      props: {
        content: `[RenderedMarkdown.svelte](${encodedTarget}:299)`,
        host,
      },
    });

    const link = await screen.findByRole("button", { name: "Open file RenderedMarkdown.svelte" });
    await userEvent.click(link);

    expect(openFile).toHaveBeenCalledWith(decodedPath, 299, undefined, {
      preferredEditor: false,
    });
  });

  it("preserves a settled code block while the streaming tail changes", async () => {
    const { container, rerender } = render(MarkdownBlock, {
      props: { content: "```js\nconst x = 1;\n```\n\nTail", streaming: true },
    });

    const firstHost = await waitFor(() => {
      const el = container.querySelector("[data-code]");
      if (!el) throw new Error("code-host not found");
      return el;
    });

    await rerender({ content: "```js\nconst x = 1;\n```\n\nTail grows", streaming: true });

    await waitFor(() => {
      const host = container.querySelector("[data-code]");
      expect(host).not.toBeNull();
      expect(host).toBe(firstHost);
    });
  });

  it("appends an open streaming fence without replacing its text node", async () => {
    const { container, rerender } = render(MarkdownBlock, {
      props: { content: "```ts\nconst value = 1", streaming: true },
    });

    const code = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(
        '[data-streaming-render-mode="code"] code',
      );
      expect(element?.textContent).toBe("const value = 1");
      return element;
    });
    const textNode = code?.firstChild;

    await rerender({ content: "```ts\nconst value = 123456", streaming: true });
    await waitFor(() => expect(code?.textContent).toBe("const value = 123456"));

    expect(container.querySelector('[data-streaming-render-mode="code"] code')).toBe(code);
    expect(code?.firstChild).toBe(textNode);
  });

  it("preserves live paragraph DOM while coalescing rapid updates", async () => {
    const { container, rerender } = render(MarkdownBlock, {
      props: { content: "Initial", streaming: true },
    });
    const paragraph = await waitFor(() => {
      const element = container.querySelector("p");
      expect(element?.textContent).toBe("Initial");
      return element;
    });
    const textNode = paragraph?.firstChild;
    let characterDataMutations = 0;
    const observer = new MutationObserver((records) => {
      characterDataMutations += records.filter((record) => record.type === "characterData").length;
    });
    if (textNode) observer.observe(textNode, { characterData: true });

    for (let index = 1; index <= 12; index += 1) {
      await rerender({ content: `Initial ${index}`, streaming: true });
    }
    await waitFor(() => expect(paragraph?.textContent).toBe("Initial 12"));
    await Promise.resolve();
    observer.disconnect();

    expect(container.querySelector("p")).toBe(paragraph);
    expect(paragraph?.firstChild).toBe(textNode);
    expect(characterDataMutations).toBeLessThan(12);
  });

  it("switches oversized unresolved Markdown to the append-only fallback", async () => {
    const prefix = `**unfinished ${"x".repeat(32 * 1024)}`;
    const { container, rerender } = render(MarkdownBlock, {
      props: { content: prefix, streaming: true },
    });

    const fallback = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-streaming-render-mode="plain"]');
      expect(element?.textContent).toBe(prefix);
      return element;
    });
    const textNode = fallback?.firstChild;

    await rerender({ content: `${prefix}tail`, streaming: true });
    await waitFor(() => expect(fallback?.textContent).toBe(`${prefix}tail`));

    expect(container.querySelector('[data-streaming-render-mode="plain"]')).toBe(fallback);
    expect(fallback?.firstChild).toBe(textNode);
  });

  it("windows independently renderable chunks in a large settled assistant reply", async () => {
    const source = Array.from(
      { length: 20 },
      (_, index) =>
        `## Section ${index}\n\n${"prose ".repeat(350)}\n\n\`\`\`text\ncode ${index}\n\`\`\`\n\n`,
    ).join("");
    const scrollElement = document.createElement("div");
    const { container } = render(MarkdownBlock, {
      props: { content: source, scrollElement },
    });

    await waitFor(() => {
      expect(container.querySelector("[data-virtualized-markdown]")).not.toBeNull();
      expect(container.querySelector(".virtual-list--windowed")).not.toBeNull();
    });
    const mountedCodeBlocks = container.querySelectorAll("[data-code]").length;
    expect(mountedCodeBlocks).toBeGreaterThan(0);
    expect(mountedCodeBlocks).toBeLessThan(20);
  });

  it("renders content with bare/autolinked URLs without overflowing the stack", async () => {
    // A custom link renderer used to re-parse the link text inline, which
    // re-discovered the autolinked URL and recursed forever — bare URLs (e.g.
    // web-search results) rendered as an empty block. Regression guard.
    render(MarkdownBlock, {
      props: {
        content:
          'Web search results.\n\nLinks: [{"title":"Paris","url":"https://www.timeanddate.com/weather/france/paris"}] ' +
          "and a bare https://example.com/a/b/c here.",
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/Web search results/)).toBeInTheDocument();
    });
    const link = screen.getByRole("link", { name: "https://example.com/a/b/c" });
    expect(link).toHaveAttribute("href", "https://example.com/a/b/c");
  });

  it("preserves encoded literal percent escapes in markdown file links", async () => {
    const openFile = vi.fn();
    const host: MarkdownHostAdapter = {
      state: readable({
        userSettings: {},
        environment: { assistantHost: "desktop" },
        workspaces: [{ path: "/repo" }],
      }),
      checkFileExists: vi.fn(async (path: string) => path === "/repo/src/a%2Fb.ts"),
      openFile,
    };

    render(MarkdownBlock, {
      props: {
        content: "[encoded percent](src/a%252Fb.ts)",
        host,
      },
    });

    const link = await screen.findByRole("button", { name: "Open file encoded percent" });
    await userEvent.click(link);

    expect(openFile).toHaveBeenCalledWith("/repo/src/a%2Fb.ts", undefined, undefined, {
      preferredEditor: false,
    });
  });
});
