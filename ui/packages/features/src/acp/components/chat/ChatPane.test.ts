import { camberGitStatus, type GitStatusOutput } from "@camber/helperapi";
import { InfoMessageType } from "@camber/rpc";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { fromStore, get, writable } from "svelte/store";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACPError } from "../../errors";
import { appState } from "../../hostAdapter";
import { initializeStatefulModule } from "../../hostRpc";
import Harness from "./ChatPane.test.svelte";
import { ScrollManager } from "./ScrollManager";

vi.mock("./Prompt.svelte", async () => ({
  default: (await import("./Prompt.mock.svelte")).default,
}));

vi.mock("@camber/components/interactive-logo", async () => ({
  default: (await import("./InteractiveLogo.mock.svelte")).default,
  InteractiveLogo: (await import("./InteractiveLogo.mock.svelte")).default,
}));

vi.mock("@camber/helperapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@camber/helperapi")>()),
  camberGitStatus: vi.fn(),
}));

// jsdom cannot host @pierre/diffs' shadow-DOM renderer; swap PatchDiff for a
// stub that renders the new-side text so assertions still see diff content.
vi.mock("@camber/components/file-diff", async () => ({
  PatchDiff: (await import("../shared/PatchDiff.mock.svelte")).default,
}));

describe("AcpChatPane", () => {
  let hostMessageSender: ReturnType<typeof vi.fn>;
  const gitStatusMock = vi.mocked(camberGitStatus);
  let resizeObserverCallbacks: ResizeObserverCallback[] = [];

  beforeAll(() => {
    Element.prototype.animate = vi.fn().mockImplementation(() => ({
      cancel: vi.fn(),
      finish: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
      reverse: vi.fn(),
    }));
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => {
        resizeObserverCallbacks.push(callback);
        return {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
    );
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      window.setTimeout(() => callback(performance.now()), 0);
      return 0;
    });
  });

  beforeEach(() => {
    resizeObserverCallbacks = [];
    gitStatusMock.mockReset();
    gitStatusMock.mockResolvedValue(gitStatus());
    hostMessageSender = vi.fn().mockResolvedValue(undefined);
    initializeStatefulModule(hostMessageSender);
    const previousAppState = get(appState);
    appState.set({
      ...previousAppState,
      isEditorFocused: true,
      environment: {
        ...previousAppState.environment,
        assistantHost: "vscode",
        capabilities: {
          ...previousAppState.environment.capabilities,
          terminalPanel: false,
        },
      },
      workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
      defaultCwd: "/workspace",
    });
  });

  it("wires the stop button to session cancel and preserves an enqueued prompt", async () => {
    const sessionRepo = makeSessionRepo();

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    screen.getByRole("button", { name: "Stop" }).click();

    expect(sessionRepo.clearQueuedPrompt).not.toHaveBeenCalled();
    expect(sessionRepo.cancel).toHaveBeenCalledOnce();
    expect(sessionRepo.cancel).toHaveBeenCalledWith({ sendQueuedPrompt: true });
  }, 10_000);

  it("claims the active conversation as visible and releases it on unmount", async () => {
    const release = vi.fn();
    const sessionRepo = makeSessionRepo({
      claimVisibleConversation: vi.fn(() => release),
    });

    const { unmount } = render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(sessionRepo.claimVisibleConversation).toHaveBeenCalledWith("conversation-current");
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("unmounts the transcript renderer while hidden and remounts it when visible", async () => {
    const sessionRepo = makeSessionRepo({
      events: [
        {
          eventKind: "user_message",
          messageId: null,
          content: [{ type: "text", text: "hello transcript" }],
        },
      ],
    });

    const rendered = render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        markReadWhenVisible: false,
      },
    });

    // Hidden: the pane shell renders, but the transcript body does not.
    expect(rendered.container.querySelector("[data-user-message]")).not.toBeInTheDocument();

    await rendered.rerender({ markReadWhenVisible: true });

    // Visible again: the transcript remounts from the still-current session state.
    expect(rendered.container.querySelector("[data-user-message]")).toBeInTheDocument();
  });

  it("renders and clears an enqueued prompt above the prompt", async () => {
    const sessionRepo = makeSessionRepo({
      queuedPrompts: [
        {
          id: "queued-1",
          text: "queued follow-up",
          content: [{ type: "text", text: "queued follow-up" }],
          cwd: "/workspace",
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(await screen.findByText("queued follow-up")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel prompt" }));

    expect(sessionRepo.clearQueuedPrompt).toHaveBeenCalledWith("queued-1");
  });

  it("renders and independently controls multiple enqueued prompts", async () => {
    const sessionRepo = makeSessionRepo({
      queuedPrompts: [
        {
          id: "queued-1",
          text: "first follow-up",
          content: [{ type: "text", text: "first follow-up" }],
          cwd: "/workspace",
        },
        {
          id: "queued-2",
          text: "second follow-up",
          content: [{ type: "text", text: "second follow-up" }],
          cwd: "/workspace",
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(await screen.findByText("first follow-up")).toBeInTheDocument();
    expect(screen.getByText("second follow-up")).toBeInTheDocument();
    expect(screen.getByText("Next after current turn")).toBeInTheDocument();
    expect(screen.getByText("Queued 2 of 2")).toBeInTheDocument();

    const queuedCards = screen.getAllByRole("button", { name: "Cancel prompt" });
    await fireEvent.click(queuedCards[1]);
    expect(sessionRepo.clearQueuedPrompt).toHaveBeenCalledWith("queued-2");
  });

  it("sends an enqueued prompt immediately", async () => {
    const sessionRepo = makeSessionRepo({
      queuedPrompts: [
        {
          id: "queued-1",
          text: "queued follow-up",
          content: [{ type: "text", text: "queued follow-up" }],
          cwd: "/workspace",
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await fireEvent.click(await screen.findByRole("button", { name: "Interrupt & Send Now" }));

    expect(sessionRepo.clearQueuedPrompt).not.toHaveBeenCalled();
    expect(sessionRepo.prioritizeQueuedPrompt).toHaveBeenCalledWith("queued-1");
    expect(sessionRepo.cancel).toHaveBeenCalledOnce();
    expect(sessionRepo.cancel).toHaveBeenCalledWith({ sendQueuedPrompt: true });
  });

  it("sends a held queued prompt directly once the steered turn is idle", async () => {
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      queuedPrompts: [
        {
          id: "queued-1",
          text: "queued follow-up",
          content: [{ type: "text", text: "queued follow-up" }],
          cwd: "/workspace",
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(await screen.findByText("Queued 1 of 1")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Send Now" }));

    expect(sessionRepo.sendQueuedPrompt).toHaveBeenCalledWith("queued-1");
    expect(sessionRepo.cancel).not.toHaveBeenCalled();
  });

  it("steers with an enqueued prompt when the agent supports it", async () => {
    const sessionRepo = makeSessionRepo({
      queuedPrompts: [
        {
          id: "queued-1",
          text: "queued follow-up",
          content: [{ type: "text", text: "queued follow-up" }],
          cwd: "/workspace",
        },
      ],
      agents: {
        supportsSteering: vi.fn(() => true),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await fireEvent.click(await screen.findByRole("button", { name: "Steer" }));

    expect(sessionRepo.steerQueuedPrompt).toHaveBeenCalledWith("queued-1");
    expect(sessionRepo.cancel).not.toHaveBeenCalled();
  });

  it("renders an enqueued prompt above the session plan and git changes summary", async () => {
    gitStatusMock.mockResolvedValue(
      gitStatus({
        staged: [{ path: "changed.ts", status: "modified" }],
        additions: 2,
        deletions: 1,
      }),
    );

    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({
          isPrompting: false,
          queuedPrompts: [
            {
              id: "queued-1",
              text: "queued follow-up",
              content: [{ type: "text", text: "queued follow-up" }],
              cwd: "/workspace",
            },
          ],
          plan: {
            entries: [
              { content: "alpha", priority: "medium", status: "completed" },
              { content: "beta", priority: "medium", status: "pending" },
            ],
          },
        }),
        conversationRepo: makeConversationRepo(),
      },
    });

    const enqueued = await screen.findByText("queued follow-up");
    const plan = screen.getByText("Completed 1 of 2 steps");
    const changesSummary = await screen.findByTestId("desktop-git-changes-summary");
    const overlays = enqueued.closest("[data-conversation-overlays]");
    expect(overlays).not.toBeNull();
    expect(overlays).toContainElement(plan);
    expect(overlays).toContainElement(changesSummary);
    expect(enqueued.compareDocumentPosition(plan)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(enqueued.compareDocumentPosition(changesSummary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("layers prompt menus above the desktop todo and review stack", async () => {
    const previous = get(appState);
    appState.set({
      ...previous,
      environment: { ...previous.environment, assistantHost: "desktop" },
    });
    gitStatusMock.mockResolvedValue(
      gitStatus({
        staged: [{ path: "changed.ts", status: "modified" }],
        additions: 2,
        deletions: 1,
      }),
    );

    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({
          isPrompting: false,
          events: [
            {
              eventKind: "agent_message",
              messageId: "message-with-changes",
              content: [{ type: "text", text: "Done" }],
            },
          ],
          plan: {
            entries: [{ content: "alpha", priority: "medium", status: "pending" }],
          },
        }),
        conversationRepo: makeConversationRepo(),
      },
    });

    const reviewStack = await screen.findByTestId("desktop-git-changes-summary");
    const overlays = reviewStack.closest("[data-conversation-overlays]");
    expect(overlays).toContainElement(screen.getByText("Completed 0 of 1 step"));
    expect(overlays).toHaveClass("z-10");
    expect(screen.getByTestId("prompt-interaction-container")).toHaveClass("relative", "z-20");
  });

  it("shows the review bar on the Visual Studio host and opens native source control", async () => {
    const previous = get(appState);
    appState.set({
      ...previous,
      environment: { ...previous.environment, assistantHost: "vs" },
    });
    gitStatusMock.mockResolvedValue(
      gitStatus({
        staged: [{ path: "changed.ts", status: "modified" }],
        additions: 2,
        deletions: 1,
      }),
    );

    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({
          events: [
            {
              eventKind: "agent_message",
              messageId: "message-with-changes",
              content: [{ type: "text", text: "Done" }],
            },
          ],
        }),
        conversationRepo: makeConversationRepo(),
      },
    });

    await screen.findByTestId("desktop-git-changes-summary");
    await fireEvent.click(screen.getByTitle("Stage and Commit..."));

    expect(hostMessageSender).toHaveBeenCalledWith("revealSourceControl", []);
  });

  it("hides the branch bar on the new conversation page", async () => {
    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({
          sessionId: null,
          sessionInfo: null,
          isPrompting: false,
          events: [],
        }),
        conversationRepo: makeConversationRepo(),
      },
    });

    await waitFor(() => expect(gitStatusMock).toHaveBeenCalled());
    expect(screen.queryByTestId("desktop-git-changes-summary")).not.toBeInTheDocument();
  });

  it("shows the branch bar for a clean repo once the conversation has started", async () => {
    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({
          isPrompting: false,
          events: [
            {
              eventKind: "agent_message",
              messageId: "clean-repo-message",
              content: [{ type: "text", text: "Ready" }],
            },
          ],
        }),
        conversationRepo: makeConversationRepo(),
      },
    });

    const summary = await screen.findByTestId("desktop-git-changes-summary");
    expect(within(summary).getByTitle("Stage and Commit...")).toHaveTextContent("main");
    expect(within(summary).queryByTitle("Review Diff...")).toBeNull();
  });

  it("hides the branch bar when the conversation directory is not a git repo", async () => {
    gitStatusMock.mockResolvedValue(gitStatus({ isRepo: false, branch: "" }));

    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({
          sessionId: null,
          sessionInfo: null,
          isPrompting: false,
          events: [],
        }),
        conversationRepo: makeConversationRepo(),
      },
    });

    await waitFor(() => expect(gitStatusMock).toHaveBeenCalled());
    expect(screen.queryByTestId("desktop-git-changes-summary")).not.toBeInTheDocument();
  });

  it("renders injected prompt snippets inside the prompt", async () => {
    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo(),
        conversationRepo: makeConversationRepo(),
        promptBannerText: "Injected prompt banner",
        promptCommandItemText: "Injected command item",
      },
    });

    expect(
      within(screen.getByTestId("prompt-mock-root")).getByTestId("injected-prompt-banner"),
    ).toHaveTextContent("Injected prompt banner");
    expect(
      within(screen.getByTestId("prompt-mock-root")).getByTestId("injected-command-item"),
    ).toHaveTextContent("Injected command item");
  });

  it("keys prompt drafts by active session", async () => {
    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({ conversationId: "conversation-current" }),
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(await screen.findByTestId("prompt-session-key")).toHaveTextContent(
      "conversation-current",
    );
  });

  it("keys prompt drafts by pending conversation before a session exists", async () => {
    const sessionRepo = makeSessionRepo({
      sessionId: null,
      conversationId: "conversation-1",
      hasSession: false,
      pendingConversationId: "conversation-1",
      pendingSessionCwd: "/tmp/project",
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        activeConversationId: "conversation-1",
      },
    });

    expect(await screen.findByTestId("prompt-session-key")).toHaveTextContent("conversation-1");
  });

  it("keeps the empty state visible while config is loading", async () => {
    const sessionRepo = makeSessionRepo({
      sessionId: null,
      conversationId: "conversation-loading",
      isPrompting: false,
      events: [],
      isConfigCacheLoading: true,
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        activeConversationId: "conversation-loading",
      },
    });

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("acp-session-config-loading")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(sessionRepo.createSession).not.toHaveBeenCalled();
  });

  // PE-2460: a conversation the agent restored without any history used to
  // render the new-conversation hero, so the sidebar listed a chat whose pane
  // claimed nothing had ever happened in it.
  it("explains an empty transcript the agent could not restore", async () => {
    const sessionRepo = makeSessionRepo({
      conversationId: "conversation-lost",
      isPrompting: false,
      events: [],
      restoredWithoutHistory: true,
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        activeConversationId: "conversation-lost",
      },
    });

    expect(screen.getByTestId("history-unavailable-notice")).toBeInTheDocument();
    expect(screen.queryByText("Start a new conversation")).not.toBeInTheDocument();
    // The composer stays usable, and the copy says so: the next prompt starts
    // a fresh session.
    expect(screen.getByTestId("history-unavailable-notice")).toHaveTextContent(
      "You can keep prompting here",
    );
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();

    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(sessionRepo.reloadLiveSession).toHaveBeenCalledWith("s-current", "poolside");
    expect(sessionRepo.retryAfterError).not.toHaveBeenCalled();
  });

  // The "keep prompting here" promise must not sit above an editor that
  // cannot be typed into (agent needs authentication → composer is inert).
  it("does not promise prompting over an inert composer", async () => {
    const sessionRepo = makeSessionRepo({
      conversationId: "conversation-lost",
      isPrompting: false,
      events: [],
      restoredWithoutHistory: true,
      agents: {
        authRequiredForAgent: vi.fn(() => true),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        activeConversationId: "conversation-lost",
      },
    });

    const notice = screen.getByTestId("history-unavailable-notice");
    expect(notice).toHaveTextContent("The agent couldn't restore this conversation's history.");
    expect(notice).not.toHaveTextContent("You can keep prompting here");
  });

  // A read-only preview cannot act on the session, so the notice must not
  // offer retry or promise prompting.
  it("suppresses the history-unavailable retry in a read-only preview", async () => {
    const sessionRepo = makeSessionRepo({
      conversationId: "conversation-lost",
      isPrompting: false,
      events: [],
      restoredWithoutHistory: true,
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        activeConversationId: "conversation-lost",
        readOnlyPreview: true,
      },
    });

    const notice = screen.getByTestId("history-unavailable-notice");
    expect(notice).not.toHaveTextContent("You can keep prompting here");
    expect(screen.queryByTestId("history-retry-button")).not.toBeInTheDocument();
  });

  it("disables sending while ACP agent server config is loading", async () => {
    const sessionRepo = makeSessionRepo({
      sessionId: null,
      conversationId: "conversation-loading",
      isPrompting: false,
      events: [],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        activeConversationId: "conversation-loading",
        agentServersState: { status: "loading" },
      },
    });

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(sessionRepo.createSession).not.toHaveBeenCalled();
  });

  it("keeps the empty-state heading but disables the prompt when the selected agent requires auth", () => {
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      events: [],
      agents: {
        authRequiredForAgent: vi.fn(() => true),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    // The heading (with its agent picker) stays visible so the user can
    // switch to an agent they are logged in to; only the composer is disabled.
    expect(screen.getByTestId("empty-state-container")).toBeInTheDocument();
    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-input")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("prompt-input")).toHaveAttribute("contenteditable", "false");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });

  it("keeps the prompt banners interactive when the selected agent requires auth", () => {
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      events: [],
      agents: {
        authRequiredForAgent: vi.fn(() => true),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        promptBannerText: "Injected prompt banner",
      },
    });

    // PE-2466: the agent update banner lives in this container. Marking the
    // whole container inert made its buttons unclickable with no visible cue,
    // and an out-of-date agent is a common reason authentication fails in the
    // first place, so the banners must stay reachable while the composer is not.
    const banner = screen.getByTestId("injected-prompt-banner");
    expect(banner.closest("[inert]")).toBeNull();
    expect(screen.getByTestId("prompt-interaction-container")).not.toHaveAttribute("inert");
    // The composer it sits above stays blocked.
    expect(screen.getByTestId("prompt-input")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });

  it("keeps the empty-state heading and prompt enabled when the selected agent is authenticated", () => {
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      events: [],
      agents: {
        authRequiredForAgent: vi.fn(() => false),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(screen.getByTestId("empty-state-container")).toHaveTextContent(
      "Start a new conversation using",
    );
    expect(screen.getByTestId("prompt-input")).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByTestId("prompt-input")).toHaveAttribute("contenteditable", "true");
    expect(screen.getByRole("button", { name: "Submit" })).not.toBeDisabled();
  });

  it("does not render the page-level agent control or error in the empty state", () => {
    const sessionRepo = makeSessionRepo({
      sessionId: null,
      conversationId: "conversation-error",
      isPrompting: false,
      events: [],
      agents: {
        restart: vi.fn().mockResolvedValue(undefined),
        nonSessionErrorFor: vi.fn(
          () =>
            new ACPError({
              code: -32603,
              message: "ACP agent server exited",
              data: { error: "credential expired: Failed to authenticate" },
            }),
        ),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        activeConversationId: "conversation-error",
      },
    });

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    expect(screen.queryByText("Agent:")).not.toBeInTheDocument();
    expect(screen.queryByTestId("acp-empty-agent-error")).not.toBeInTheDocument();
    expect(sessionRepo.agents.restart).not.toHaveBeenCalled();
  });

  it("keeps an editable composer mounted while history is loading", async () => {
    const history = writable({ loading: true });
    const state = fromStore(history);
    const sessionRepo = makeSessionRepo({ events: [], isPrompting: false });
    Object.defineProperty(sessionRepo, "sessionLoadState", {
      get: () => ({ status: state.current.loading ? "loading" : "success" }),
    });
    render(Harness, { props: { sessionRepo, conversationRepo: makeConversationRepo() } });
    const editor = screen.getByRole("textbox", { name: "Prompt" });
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Loading conversation" })).toBeInTheDocument();
    expect(screen.queryByText("Start a new conversation")).not.toBeInTheDocument();
    editor.textContent = "A draft composed during loading";
    editor.focus();
    history.set({ loading: false });
    await tick();
    expect(screen.queryByRole("status", { name: "Loading conversation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBe(editor);
    expect(editor).toHaveTextContent("A draft composed during loading");
    expect(editor).toHaveFocus();
  });

  it("offers local recovery when the initial navigation snapshot fails", async () => {
    appState.update((state) => ({
      ...state,
      environment: { ...state.environment, assistantHost: "desktop" },
    }));
    const conversations = makeConversationRepo({
      refreshState: { status: "failure", error: new Error("offline") },
    });
    render(Harness, {
      props: { sessionRepo: makeSessionRepo({ events: [] }), conversationRepo: conversations },
    });
    expect(screen.getByRole("status", { name: "Conversation unavailable" })).toHaveTextContent(
      "Couldn’t load your conversations.",
    );
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(conversations.refresh).toHaveBeenCalled());
  });

  it("keeps sending blocked when configured agents could not be loaded", () => {
    appState.update((state) => ({
      ...state,
      environment: { ...state.environment, assistantHost: "desktop" },
    }));
    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({ events: [], isPrompting: false }),
        conversationRepo: makeConversationRepo(),
        agentServersState: { status: "failure" },
      },
    });
    expect(screen.getByRole("status", { name: "Conversation unavailable" })).toHaveTextContent(
      "Couldn’t load your agents.",
    );
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });

  it("keys an unresolved conversation draft by the selected conversation", async () => {
    const sessionRepo = makeSessionRepo();
    sessionRepo.getSessionByConversationId = vi.fn(() => null);
    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        activeConversationId: "conversation-unresolved",
      },
    });
    expect(screen.getByTestId("prompt-session-key")).toHaveTextContent("conversation-unresolved");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });

  it("keeps the transcript visible while a first-send session is being created", async () => {
    const sessionRepo = makeSessionRepo({
      sessionId: null,
      conversationId: "conversation-new",
      isPrompting: false,
      isSending: true,
      setupStatus: "Creating session...",
      sessionLoadState: { status: "loading" },
      sessionLoadIntent: "new",
      events: [
        {
          eventKind: "user_message",
          messageId: null,
          content: [{ type: "text", text: "hello" }],
        },
      ],
    });

    const rendered = render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
        activeConversationId: "conversation-new",
      },
    });

    expect(rendered.container.querySelector("[data-user-message]")).toBeInTheDocument();
    expect(screen.getByText("Creating session...")).toBeInTheDocument();
    expect(screen.queryByText("Start a new conversation")).not.toBeInTheDocument();
  });

  it("shows read-only feedback and disables sending for read-only sessions", async () => {
    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({ isReadOnly: true }),
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(await screen.findByText("Read-only conversation")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    await fireEvent.click(screen.getByRole("button", { name: "Dismiss read-only notice" }));

    expect(screen.queryByText("Read-only conversation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });

  it("reuses the compact config picker without the empty-state option card", async () => {
    const sessionRepo = makeSessionRepo({
      sessionId: "s-empty",
      isPrompting: false,
      events: [],
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "sonnet",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
          ],
        },
        {
          type: "select",
          id: "mode",
          name: "Mode",
          category: "mode",
          currentValue: "plan",
          options: [
            { value: "plan", name: "Plan" },
            { value: "code", name: "Code" },
          ],
        },
      ],
    });

    const rendered = render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    const emptyStateHeader = screen.getByTestId("empty-state-container");
    expect(within(emptyStateHeader).getByText("Start a new conversation")).toBeInTheDocument();
    expect(within(emptyStateHeader).getByText("using")).toBeInTheDocument();
    expect(
      within(emptyStateHeader).queryByText("Start a new conversation in"),
    ).not.toBeInTheDocument();
    expect(emptyStateHeader).toHaveTextContent("Start a new conversation using");
    expect(within(emptyStateHeader).getByText("Start a new conversation").nextElementSibling).toBe(
      within(emptyStateHeader).getByText("using"),
    );
    expect(screen.queryByText("Agent:")).not.toBeInTheDocument();
    expect(screen.queryByText("Model:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sonnet" })).not.toBeInTheDocument();
    expect(screen.queryByText("Mode:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plan" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent, model and options" })).toBeInTheDocument();

    const newConversationView = rendered.container.querySelector(
      "[data-new-conversation-view-centered]",
    );
    const emptyState = rendered.container.querySelector("[data-centered-layout]");
    const composer = rendered.container.querySelector("[data-acp-composer]");
    expect(newConversationView).toHaveAttribute("data-new-conversation-view-centered", "true");
    expect(emptyState).toHaveAttribute("data-centered-layout", "true");
    expect(composer).toHaveAttribute("data-new-conversation-centered", "true");
    expect(screen.getByTestId("prompt-config-controls-visibility")).toHaveTextContent("hidden");

    await fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(newConversationView).toHaveAttribute("data-new-conversation-view-centered", "false");
    expect(emptyState).toHaveAttribute("data-centered-layout", "false");
    expect(composer).toHaveAttribute("data-new-conversation-centered", "false");
    expect(screen.getByTestId("prompt-config-controls-visibility")).toHaveTextContent("visible");
  });

  it("renders the ACP plan-mode banner and toggles it off", async () => {
    const sessionRepo = makeSessionRepo({
      isPlanModeActive: true,
      canTogglePlanMode: true,
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(screen.getByText("Plan mode")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Disable Plan Mode" }));

    expect(sessionRepo.togglePlanMode).toHaveBeenCalledTimes(1);
  });

  it("suppresses the plan-mode banner for collaboration plan mode", async () => {
    const sessionRepo = makeSessionRepo({
      isPlanModeActive: true,
      canTogglePlanMode: true,
      planModeViaCollaboration: true,
      collaborationModeSurface: "plan-toggle",
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    // Collaboration agents surface plan state as the compact chip beside the
    // mode control (see PlanModeIndicator.test.ts), not the full-width banner.
    expect(screen.queryByText("Plan mode")).not.toBeInTheDocument();
  });

  it("renders the session plan only when it has entries", async () => {
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      plan: {
        entries: [
          { content: "alpha", priority: "medium", status: "completed" },
          { content: "beta", priority: "medium", status: "pending" },
        ],
      },
    });

    const { unmount } = render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(screen.getByText("Completed 1 of 2 steps")).toBeInTheDocument();
    unmount();

    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({
          isPrompting: false,
          plan: { entries: [] },
        }),
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(screen.queryByText("Completed 0 of 0 steps")).not.toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
  });

  it("dismisses the current session plan", async () => {
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      plan: {
        entries: [
          { content: "alpha", priority: "medium", status: "completed" },
          { content: "beta", priority: "medium", status: "pending" },
        ],
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Dismiss todo list" }));

    expect(screen.queryByText("Completed 1 of 2 steps")).not.toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
  });

  it("renders ACP image content inline from agent messages", async () => {
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      events: [
        {
          eventKind: "agent_message",
          messageId: "m-image",
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: imageData,
              uri: "/workspace/screenshot.png",
            },
          ],
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    const image = screen.getByAltText("Image");
    expect(image).toHaveAttribute("src", `data:image/png;base64,${imageData}`);
    expect(image).toHaveAttribute("data-camber-image-path", "/workspace/screenshot.png");
    expect(image).toHaveAttribute("data-camber-image-name", "/workspace/screenshot.png");
    expect(screen.queryByRole("region", { name: "Image preview" })).not.toBeInTheDocument();
  });

  it("routes transcript image context menus through the desktop image handler", async () => {
    hostMessageSender.mockImplementation((method: string) => {
      if (method === "getDesktopSettings") {
        return Promise.resolve({
          fileOpeners: [
            { id: "poolside", label: "In-app viewer", kind: "inApp" },
            { id: "default", label: "Default macOS app", kind: "default" },
          ],
        });
      }
      return Promise.resolve(undefined);
    });

    render(Harness, {
      props: {
        sessionRepo: makeSessionRepo({
          isPrompting: false,
          events: [
            {
              eventKind: "agent_message",
              messageId: "m-image-menu",
              content: [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: imageData,
                  uri: "/workspace/screenshot.png",
                },
              ],
            },
          ],
        }),
        conversationRepo: makeConversationRepo(),
      },
    });

    const image = screen.getByAltText("Image");
    const previousAppState = get(appState);
    appState.set({
      ...previousAppState,
      environment: { ...previousAppState.environment, assistantHost: "desktop" },
    });
    await tick();
    expect(get(appState).environment.assistantHost).toBe("desktop");

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 36,
    });
    image.dispatchEvent(event);

    await waitFor(() => {
      expect(hostMessageSender).toHaveBeenCalledWith("getDesktopSettings", []);
    });
  });

  it("renders pending ACP permission requests and submits the selected option", async () => {
    const toolCallContext = {
      eventKind: "tool_call",
      toolCallId: "tool-1",
      title: 'Greet from the workspace: cd ./ && echo "hello"',
      kind: "execute",
      status: "pending",
      rawInput: undefined,
      content: [],
    };
    const sessionRepo = makeSessionRepo({
      events: [toolCallContext],
      plan: {
        entries: [
          { content: "Inspect permission layout", priority: "high", status: "completed" },
          { content: "TODO: follow up after approval", priority: "medium", status: "pending" },
        ],
      },
      pendingPermissionRequests: [
        {
          id: "permission-1",
          agentServer: "poolside",
          sessionId: "s-current",
          toolCall: {
            toolCallId: "tool-1",
            title: 'Greet from the workspace: cd ./ && echo "hello"',
            kind: "execute",
            _meta: { "camber/permission_command_heads": ["cd", "echo"] },
            rawInput: { cmd: 'cd ./ && echo "hello"' },
          },
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
            {
              optionId: "allow-always",
              kind: "allow_always",
              name: "Always allow: gh pr checks 123 *",
              _meta: { "camber/permission_suggested_rules": ["gh pr checks 123 *"] },
            },
            { optionId: "reject-once", kind: "reject_once", name: "Deny" },
          ],
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    const permissionRequest = screen.getByTestId("acp-permission-request");
    expect(permissionRequest).toBeInTheDocument();
    expect(screen.queryByText("TODO: follow up after approval")).not.toBeInTheDocument();
    expect(screen.getByText("Camber wants to")).toBeInTheDocument();
    expect(screen.getByText("execute")).toBeInTheDocument();
    expect(screen.getByText("cd, echo")).toBeInTheDocument();
    expect(screen.getByText("$")).toBeInTheDocument();
    expect(within(permissionRequest).getByText("Greet from the workspace")).toBeInTheDocument();
    expect(screen.getByText("Allow Once")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick a broader allow rule" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    expect(sessionRepo.selectPermissionOption).toHaveBeenCalledWith("permission-1", "allow-once");
  });

  it("renders ACP permission tool call content before raw input", async () => {
    const sessionRepo = makeSessionRepo({
      pendingPermissionRequests: [
        {
          id: "permission-plan",
          agentServer: "poolside",
          sessionId: "s-current",
          toolCall: {
            toolCallId: "tool-plan",
            title: "Ready to code?",
            kind: "switch_mode",
            rawInput: { plan: "# Raw plan should not be the primary display" },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "## Implementation Plan\n\n- Add one README note",
                },
              },
            ],
          },
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject-once", kind: "reject_once", name: "Deny" },
          ],
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(await screen.findByText("Implementation Plan")).toBeInTheDocument();
    expect(await screen.findByText("Add one README note")).toBeInTheDocument();
    expect(screen.queryByText(/Raw plan should not be the primary display/)).toBeNull();
  });

  it("renders multiline ACP execute permission titles from the command head", async () => {
    const command = `git commit -m "$(cat <<'EOF'
feat: improve ACP tool rendering

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"`;
    const sessionRepo = makeSessionRepo({
      pendingPermissionRequests: [
        {
          id: "permission-commit",
          agentServer: "codex",
          sessionId: "s-current",
          toolCall: {
            toolCallId: "tool-commit",
            title: command,
            kind: "execute",
            rawInput: {
              command: ["/bin/zsh", "-lc", command],
              parsed_cmd: [{ cmd: command, type: "unknown" }],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: `Do you want to run this command?\nProposed Amendment: /bin/zsh\n-lc\n${command}`,
                },
              },
            ],
          },
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject-once", kind: "reject_once", name: "Deny" },
          ],
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    const permissionRequest = screen.getByTestId("acp-permission-request");
    const header = permissionRequest.querySelector(".group\\/header");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText("codex wants to")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("execute")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("git")).toBeInTheDocument();
    expect(within(header as HTMLElement).queryByText("Claude")).not.toBeInTheDocument();
    const commandBlock = within(permissionRequest).getByTestId("acp-permission-command");
    expect(commandBlock).toHaveClass("max-h-56", "overflow-auto", "overscroll-contain");
    expect(commandBlock.querySelector("pre")).toHaveClass("whitespace-pre-wrap", "break-all");
    expect(commandBlock.querySelector("span.select-none")).toHaveClass(
      "text-psx-foreground-secondary",
    );
    expect(permissionRequest).toHaveTextContent("git commit -m");
    expect(permissionRequest).toHaveTextContent("feat: improve ACP tool rendering");
    expect(permissionRequest).toHaveTextContent("Co-Authored-By: Claude Opus 4.6");
  });

  it("renders ACP permission diff content without requiring a tool context", async () => {
    const sessionRepo = makeSessionRepo({
      pendingPermissionRequests: [
        {
          id: "permission-edit",
          agentServer: "poolside",
          sessionId: "s-current",
          toolCall: {
            toolCallId: "tool-edit",
            title: "Update README.md",
            kind: "edit",
            content: [
              {
                type: "diff",
                path: "/workspace/README.md",
                oldText: "Before\n",
                newText: "After\n",
              },
            ],
          },
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject-once", kind: "reject_once", name: "Deny" },
          ],
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    const permissionRequest = screen.getByTestId("acp-permission-request");
    expect(permissionRequest).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
    expect(
      within(permissionRequest).getByRole("button", { name: "copy to clipboard" }),
    ).toBeInTheDocument();
  });

  it("submits ACP permission override rules from the broader allow dropdown", async () => {
    const sessionRepo = makeSessionRepo({
      pendingPermissionRequests: [
        {
          id: "permission-1",
          agentServer: "poolside",
          sessionId: "s-current",
          toolCall: {
            toolCallId: "tool-1",
            title: "Run gh command",
            kind: "execute",
            rawInput: { cmd: "gh pr checks 123" },
          },
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
            {
              optionId: "allow-always",
              kind: "allow_always",
              name: "Always allow: gh pr checks 123 *",
              _meta: { "camber/permission_suggested_rules": ["gh pr checks 123 *"] },
            },
            { optionId: "reject-once", kind: "reject_once", name: "Deny" },
          ],
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Pick a broader allow rule" }));
    await fireEvent.click(screen.getByRole("button", { name: "gh pr *" }));

    expect(sessionRepo.selectPermissionOption).toHaveBeenCalledWith(
      "permission-1",
      "allow-always",
      ["gh pr *"],
    );
  });

  it("renders prompt errors below the transcript and retries the failed prompt", async () => {
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      promptError: {
        error: new ACPError({
          code: -32603,
          message: "Internal error",
          data: { details: "prompt rejected" },
        }),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(await screen.findByTestId("error-message")).toHaveTextContent(
      "Could not send prompt: prompt rejected",
    );
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(sessionRepo.retryLastPrompt).toHaveBeenCalledTimes(1);
  });

  it("renders server errors below the transcript and reconnects", async () => {
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      sessionLoadState: {
        status: "failure",
        error: new ACPError({
          code: -32603,
          message: "server exited",
          data: { error: "credential expired" },
        }),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    expect(await screen.findByTestId("error-message")).toHaveTextContent(
      "Error: credential expired",
    );
    await fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    expect(sessionRepo.retryAfterError).toHaveBeenCalledTimes(1);
  });

  it("clears unread for the active chat when the host app is focused", async () => {
    const sessionRepo = makeSessionRepo({
      getConversationStatus: vi.fn(() => ({
        working: false,
        waitingForUser: false,
        unread: true,
      })),
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await waitFor(() =>
      expect(sessionRepo.clearUnread).toHaveBeenCalledWith("s-current", "poolside"),
    );
  });

  it("does not clear unread for the active chat while the host app is unfocused", async () => {
    const previousAppState = get(appState);
    appState.set({
      ...previousAppState,
      isEditorFocused: false,
    });
    const sessionRepo = makeSessionRepo({
      getConversationStatus: vi.fn(() => ({
        working: false,
        waitingForUser: false,
        unread: true,
      })),
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await screen.findByTestId("prompt-mock-root");

    expect(sessionRepo.clearUnread).not.toHaveBeenCalled();
  });

  it("jumps to the bottom when an existing ACP session transcript mounts", async () => {
    const scrollToBottom = vi.spyOn(ScrollManager.prototype, "scrollToBottom");
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      events: [
        {
          eventKind: "user_message",
          messageId: "m1",
          content: [{ type: "text", text: "first" }],
        },
        {
          eventKind: "agent_message",
          messageId: "m2",
          content: [{ type: "text", text: "second" }],
        },
      ],
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await waitFor(() => expect(scrollToBottom).toHaveBeenCalledWith("instant"));
    scrollToBottom.mockRestore();
  });

  it("tracks transcript overflow for top and bottom edge fades", async () => {
    const rendered = render(Harness, {
      props: {
        sessionRepo: makeSessionRepo(),
        conversationRepo: makeConversationRepo(),
      },
    });
    const scroller = rendered.container.querySelector<HTMLElement>(
      "[data-chat-transcript-scroller]",
    );
    if (!scroller) throw new Error("Expected the transcript scroller to render");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });

    await fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(scroller).toHaveAttribute("data-overflow-top", "false");
      expect(scroller).toHaveAttribute("data-overflow-bottom", "true");
    });

    scroller.scrollTop = 50;
    await fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(scroller).toHaveAttribute("data-overflow-top", "true");
      expect(scroller).toHaveAttribute("data-overflow-bottom", "true");
    });

    scroller.scrollTop = 200;
    await fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(scroller).toHaveAttribute("data-overflow-top", "true");
      expect(scroller).toHaveAttribute("data-overflow-bottom", "false");
    });
  });

  it("defers transcript size reconciliation outside ResizeObserver delivery", () => {
    const schedule = vi.spyOn(ScrollManager.prototype, "scheduleContentSizeReconciliation");
    const reconcile = vi.spyOn(ScrollManager.prototype, "reconcileContentSize");

    const rendered = render(Harness, {
      props: {
        sessionRepo: makeSessionRepo(),
        conversationRepo: makeConversationRepo(),
      },
    });
    expect(
      rendered.container.querySelector<HTMLElement>("[data-chat-transcript-scroller]"),
    ).not.toBeNull();

    for (const callback of resizeObserverCallbacks) {
      callback([], {} as ResizeObserver);
    }

    expect(schedule).toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    schedule.mockRestore();
    reconcile.mockRestore();
  });

  it("polls terminal auth while keeping the normal action label", async () => {
    let authRequired = true;
    const hostMessageSender = vi.fn((method: string) => {
      if (method === "createAssistantTerminal") {
        return Promise.resolve({
          id: "terminal-1",
          worktreePath: "/workspace",
          createdAt: "2026-05-20T10:00:00Z",
        });
      }
      return Promise.resolve(undefined);
    });
    initializeStatefulModule(hostMessageSender);
    const sessionRepo = makeSessionRepo({
      agents: {
        probeAuthentication: vi.fn().mockImplementation(async () => {
          authRequired = false;
          return "authenticated";
        }),
        authRequiredForAgent: vi.fn(() => authRequired),
        authMethodsForAgent: vi.fn(() => [
          {
            type: "terminal",
            id: "login",
            name: "Login",
            command: "pool",
            args: ["login"],
          },
        ]),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Login" }));

    expect(sessionRepo.agents.authenticate).not.toHaveBeenCalled();
    // Launching the flow swaps the login buttons for the manual confirmation
    // pair: login completes outside the panel (terminal TUI / browser).
    const tryAgainButton = await screen.findByRole("button", { name: "Try again" });
    const confirmButton = screen.getByRole("button", { name: "I'm logged in" });
    expect(screen.queryByRole("button", { name: "Login" })).not.toBeInTheDocument();
    expect(tryAgainButton.nextElementSibling).toBe(confirmButton);
    expect(hostMessageSender).toHaveBeenCalledWith("createAssistantTerminal", [
      "/workspace",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // The confirmation pair appears as soon as the flow launches; the terminal
    // write lands shortly after the terminal is created.
    await waitFor(() => {
      expect(hostMessageSender).toHaveBeenCalledWith("writeAssistantTerminal", [
        "terminal-1",
        "pool login\n",
      ]);
    });

    // "Try again" restores the login buttons; relaunching writes to a fresh
    // terminal and restarts the background poll.
    await fireEvent.click(tryAgainButton);
    await fireEvent.click(await screen.findByRole("button", { name: "Login" }));
    await waitFor(() => {
      expect(
        hostMessageSender.mock.calls.filter(([method]) => method === "writeAssistantTerminal"),
      ).toHaveLength(2);
    });

    await waitFor(
      () =>
        expect(sessionRepo.agents.probeAuthentication).toHaveBeenCalledWith("login", "poolside"),
      { timeout: 2_500 },
    );
    expect(sessionRepo.agents.refreshCachedConfig).toHaveBeenCalledWith(
      "poolside",
      expect.any(String),
    );
  });

  it("re-verifies with a fresh probe when the user confirms an external login", async () => {
    let authRequired = true;
    const hostMessageSender = vi.fn((method: string) => {
      if (method === "createAssistantTerminal") {
        return Promise.resolve({
          id: "terminal-1",
          worktreePath: "/workspace",
          createdAt: "2026-05-20T10:00:00Z",
        });
      }
      return Promise.resolve(undefined);
    });
    initializeStatefulModule(hostMessageSender);
    const sessionRepo = makeSessionRepo({
      agents: {
        // The adapter rejects programmatic authentication (e.g. Claude), so
        // polling never resolves; only the manual confirmation can.
        probeAuthentication: vi.fn().mockResolvedValue("failed"),
        refreshCachedConfig: vi.fn().mockImplementation(async () => {
          authRequired = false;
        }),
        authRequiredForAgent: vi.fn(() => authRequired),
        authMethodsForAgent: vi.fn(() => [
          {
            type: "terminal",
            id: "login",
            name: "Login",
            command: "claude",
            args: ["/login"],
          },
        ]),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Login" }));
    await fireEvent.click(await screen.findByRole("button", { name: "I'm logged in" }));

    await waitFor(() => {
      expect(sessionRepo.agents.refreshCachedConfig).toHaveBeenCalledWith(
        "poolside",
        expect.any(String),
        { fresh: true },
      );
    });
    // The probe cleared auth-required, so the confirmation state resolves.
    // (The mocked authRequiredForAgent is not reactive, so the panel itself
    // stays mounted in this harness; the attempted state clearing — login
    // buttons returning — is the observable part of the dismissal.)
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "I'm logged in" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
  });

  it("reopens the browser auth URL when retrying authentication", async () => {
    const authUri = "https://auth.poolside.ai/device?code=example";
    const sessionRepo = makeSessionRepo({
      agents: {
        authRequiredForAgent: vi.fn(() => true),
        authInProgressForAgent: vi.fn(() => true),
        authMethodsForAgent: vi.fn(() => [
          {
            type: "agent",
            id: "browser-login",
            name: "Continue in browser",
          },
        ]),
        authUriForAgent: vi.fn(() => authUri),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    const action = screen.getByRole("button", { name: "Continue in browser" });
    expect(action).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(hostMessageSender).toHaveBeenCalledWith("openExternalURL", [authUri]);
    expect(sessionRepo.agents.authenticate).not.toHaveBeenCalled();
  });

  it("runs terminal auth through the configured agent command when available", async () => {
    const previousAppState = get(appState);
    appState.set({
      ...previousAppState,
      userSettings: {
        ...previousAppState.userSettings,
        acpAgentServers: {
          "claude-acp": {
            command: "npx",
            args: ["-y", "@agentclientprotocol/claude-agent-acp@0.49.0"],
          },
        },
      },
    });
    const hostMessageSender = vi.fn((method: string) => {
      if (method === "createAssistantTerminal") {
        return Promise.resolve({
          id: "terminal-1",
          worktreePath: "/workspace",
          createdAt: "2026-05-20T10:00:00Z",
        });
      }
      return Promise.resolve(undefined);
    });
    initializeStatefulModule(hostMessageSender);
    const sessionRepo = makeSessionRepo({
      sessionAgentServer: "claude-acp",
      agents: {
        defaultAgentServer: "claude-acp",
        authRequiredForAgent: vi.fn(() => true),
        authMethodsForAgent: vi.fn(() => [
          {
            type: "terminal",
            id: "claude-subscription",
            name: "Claude Subscription",
            command: "/Users/poolie/.asdf/installs/nodejs/24.7.0/bin/node",
            args: ["--cli", "auth", "login", "--claudeai"],
          },
        ]),
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Claude Subscription" }));

    await waitFor(() =>
      expect(hostMessageSender).toHaveBeenCalledWith("writeAssistantTerminal", [
        "terminal-1",
        "npx -y '@agentclientprotocol/claude-agent-acp@0.49.0' --cli auth login --claudeai\n",
      ]),
    );
  });

  it("switches a pending draft's project/worktree from the empty state on desktop", async () => {
    const previous = get(appState);
    appState.set({
      ...previous,
      environment: { ...previous.environment, assistantHost: "desktop" },
    });

    const sessionRepo = makeSessionRepo({
      sessionId: null,
      sessionAgentServer: null,
      conversationId: "pending-conversation",
      hasSession: false,
      isPrompting: false,
      events: [],
      pendingSessionCwd: "/tmp/project-a",
      pendingConversationId: "pending-conversation",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "sonnet",
          options: [{ value: "sonnet", name: "Sonnet" }],
        },
      ],
    });

    const navProject = (path: string, name: string, extra: Record<string, unknown> = {}) => ({
      path,
      name,
      isWorktree: false,
      collapsed: false,
      displayOrder: 0,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      ...extra,
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo({
          projects: [
            navProject("/tmp/project-a", "project-a"),
            navProject("/tmp/project-a/worktree", "worktree", {
              isWorktree: true,
              parentPath: "/tmp/project-a",
            }),
          ],
        }),
        activeConversationId: "pending-conversation",
      },
    });

    const emptyStateHeader = screen.getByTestId("empty-state-container");
    expect(emptyStateHeader).toHaveClass(
      "items-center",
      "justify-center",
      "gap-[3px]",
      "flex-wrap",
    );
    const composer = screen.getByTestId("empty-state-container").parentElement;
    expect(composer).toHaveAttribute("data-acp-composer");
    expect(composer).toHaveClass("gap-5");
    expect(within(emptyStateHeader).getByText("Start a new conversation in")).toBeInTheDocument();

    const projectPicker = screen.getByRole("button", { name: /Change chat, project/ });
    const usingLabel = within(emptyStateHeader).getByText("using");
    const compositePicker = within(emptyStateHeader).getByRole("button", {
      name: "Agent, model and options",
    });
    const projectPickerOffset = projectPicker.parentElement?.parentElement;
    const compositePickerOffset = compositePicker.parentElement?.parentElement;
    expect(projectPicker.parentElement).toHaveClass("desktop-empty-state-control-wrap");
    expect(compositePicker.parentElement).toHaveClass("desktop-empty-state-control-wrap");
    expect(projectPickerOffset).toHaveClass("translate-y-px");
    expect(projectPickerOffset?.nextElementSibling).toBe(usingLabel);
    expect(usingLabel.nextElementSibling).toBe(compositePickerOffset);
    // The desktop empty state renders pill triggers without the dotted
    // underline used by other hosts.
    expect(projectPicker).toHaveClass("desktop-empty-state-control");
    expect(compositePicker).toHaveClass("desktop-empty-state-control");
    expect(projectPicker).not.toHaveClass("bg-psx-chrome", "rounded-xl", "shadow-low");
    expect(within(projectPicker).getByText("project-a")).not.toHaveClass("underline");
    expect(within(compositePicker).getByText("Sonnet")).not.toHaveClass("underline");
    const projectIcon = projectPicker.querySelector('[data-type="product"]');
    expect(projectIcon).toHaveClass("translate-y-px");

    await fireEvent.click(compositePicker);
    const compositeMenu = screen.getByRole("menu", { name: "Agent, model and options" });
    expect(compositeMenu).toHaveAttribute("data-placement", "bottom");
    await fireEvent.click(compositePicker);

    await fireEvent.click(projectPicker);
    await fireEvent.click(screen.getByRole("menuitem", { name: /worktree/ }));

    expect(sessionRepo.createSession).toHaveBeenCalledWith(
      "/tmp/project-a/worktree",
      "poolside",
      "pending-conversation",
      { isChat: false },
    );
  });

  it("clears chat scope when a pending chat moves to a project", async () => {
    const previous = get(appState);
    appState.set({
      ...previous,
      environment: { ...previous.environment, assistantHost: "desktop" },
    });

    const sessionRepo = makeSessionRepo({
      sessionId: null,
      sessionAgentServer: null,
      conversationId: "pending-chat",
      hasSession: false,
      isChat: true,
      isPrompting: false,
      events: [],
      pendingSessionCwd: "/state/camber/chats/pending-chat",
      pendingConversationId: "pending-chat",
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo({
          projects: [
            {
              path: "/tmp/project-a",
              name: "project-a",
              isWorktree: false,
              collapsed: false,
              displayOrder: 0,
              createdAt: "2026-06-01T00:00:00Z",
              updatedAt: "2026-06-01T00:00:00Z",
            },
          ],
        }),
        activeConversationId: "pending-chat",
      },
    });

    const projectPicker = screen.getByRole("button", {
      name: /Change chat, project, or worktree — current: Chat/,
    });
    await fireEvent.click(projectPicker);
    await fireEvent.click(screen.getByRole("menuitem", { name: /project-a/ }));

    expect(sessionRepo.createSession).toHaveBeenCalledWith(
      "/tmp/project-a",
      "poolside",
      "pending-chat",
      { isChat: false },
    );
    expect(sessionRepo.isChat).toBe(false);
  });

  it("keeps agent names unchanged before a draft has an active session", async () => {
    const sessionRepo = makeSessionRepo({
      sessionId: null,
      sessionAgentServer: null,
      sessionInfo: null,
      conversationId: "pending-conversation",
      hasSession: false,
      isPrompting: false,
      events: [],
      pendingSessionCwd: "/workspace",
      pendingConversationId: "pending-conversation",
      agents: {
        agentServerNames: ["poolside", "codex-acp"],
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Agent, model and options" }));
    await fireEvent.click(
      within(screen.getByRole("menu", { name: "Agent, model and options" })).getByRole("menuitem", {
        name: /^Agent/,
      }),
    );

    const agentMenu = screen.getByRole("menu", { name: "agent options" });
    expect(agentMenu).not.toHaveTextContent("(handoff)");
    expect(within(agentMenu).getByText("codex-acp")).toBeInTheDocument();
  });

  it("confirms an active-session handoff selected from the prompt config picker", async () => {
    let rejectHandoff: (error: unknown) => void = () => {};
    const handoffSession = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectHandoff = reject;
        }),
    );
    const sessionRepo = makeSessionRepo({
      isPrompting: false,
      handoffSession,
      agents: {
        agentServerNames: ["poolside", "codex-acp"],
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    const picker = screen.getByRole("button", { name: "Agent, model and options" });
    await fireEvent.click(picker);
    await fireEvent.click(
      within(screen.getByRole("menu", { name: "Agent, model and options" })).getByRole("menuitem", {
        name: /^Agent/,
      }),
    );
    const agentMenu = screen.getByRole("menu", { name: "agent options" });
    expect(within(agentMenu).getByText("Camber")).toBeInTheDocument();
    expect(within(agentMenu).queryByText("Camber (handoff)")).toBeNull();
    expect(within(agentMenu).getByText("codex-acp (handoff)")).toBeInTheDocument();
    await fireEvent.click(
      within(agentMenu).getByRole("menuitem", {
        name: /codex-acp/,
      }),
    );

    let dialog = screen.getByRole("dialog", { name: "Hand off to codex-acp?" });
    expect(dialog).toHaveTextContent("codex-acp will take over when you send your next message.");
    expect(handoffSession).not.toHaveBeenCalled();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Hand off to codex-acp?" })).toBeNull();

    await fireEvent.click(picker);
    await fireEvent.click(
      within(screen.getByRole("menu", { name: "Agent, model and options" })).getByRole("menuitem", {
        name: /^Agent/,
      }),
    );
    await fireEvent.click(
      within(screen.getByRole("menu", { name: "agent options" })).getByRole("menuitem", {
        name: /codex-acp/,
      }),
    );
    dialog = screen.getByRole("dialog", { name: "Hand off to codex-acp?" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Hand Off" }));

    expect(screen.queryByRole("dialog", { name: "Hand off to codex-acp?" })).toBeNull();
    expect(handoffSession).toHaveBeenCalledWith("conversation-current", "codex-acp");

    rejectHandoff({ message: "target agent unavailable" });
    await waitFor(() =>
      expect(hostMessageSender).toHaveBeenCalledWith("showInfoMessage", [
        "target agent unavailable",
        InfoMessageType.error,
      ]),
    );
  });

  it("routes a staged handoff agent change through handoff replacement", async () => {
    const handoffSession = vi.fn().mockResolvedValue(undefined);
    const sessionRepo = makeSessionRepo({
      conversationId: "conversation-staged",
      sessionId: null,
      sessionAgentServer: "codex-acp",
      sessionInfo: null,
      pendingSessionCwd: "/workspace",
      pendingConversationId: "conversation-staged",
      pendingHandoff: { handoffId: "handoff-staged" },
      isPrompting: false,
      handoffSession,
      agents: {
        agentServerNames: ["poolside", "codex-acp"],
      },
    });

    render(Harness, {
      props: {
        sessionRepo,
        conversationRepo: makeConversationRepo(),
      },
    });

    const picker = screen.getByRole("button", { name: "Agent, model and options" });
    await fireEvent.click(picker);
    await fireEvent.click(
      within(screen.getByRole("menu", { name: "Agent, model and options" })).getByRole("menuitem", {
        name: /^Agent/,
      }),
    );
    await fireEvent.click(
      within(screen.getByRole("menu", { name: "agent options" })).getByRole("menuitem", {
        name: "Camber",
      }),
    );

    const dialog = screen.getByRole("dialog", { name: "Hand off to Camber?" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Hand Off" }));

    expect(handoffSession).toHaveBeenCalledWith("conversation-staged", "poolside");
    expect(sessionRepo.createSession).not.toHaveBeenCalled();
  });
});

const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s8vH4QAAAAASUVORK5CYII=";

function gitStatus(overrides: Partial<GitStatusOutput> = {}): GitStatusOutput {
  return {
    isRepo: true,
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    stashCount: 0,
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

function makeSessionRepo(overrides: Record<string, any> = {}): any {
  const { agents: agentOverrides, ...repoOverrides } = overrides;
  const repo: any = {
    conversationId: "conversation-current",
    sessionId: "s-current",
    sessionAgentServer: "poolside",
    sessionInfo: {
      sessionId: "s-current",
      cwd: "/workspace",
      title: "Current session",
      updatedAt: null,
      source: "native_session",
      readOnly: false,
      conversationId: "conversation-current",
      conversationKind: null,
      _meta: {},
    },
    sessionLoadState: { status: "waiting" },
    sessionLoadIntent: null,
    agents: {
      defaultAgentServer: "poolside",
      agentServerNames: ["poolside"],
      isConfigCacheLoadingFor: vi.fn(() => repo.isConfigCacheLoading),
      authRequiredForAgent: vi.fn(() => false),
      authInProgressForAgent: vi.fn(() => false),
      authMethodsForAgent: vi.fn(() => []),
      authUriForAgent: vi.fn(() => null),
      authenticate: vi.fn().mockResolvedValue(undefined),
      probeAuthentication: vi.fn().mockResolvedValue("pending"),
      refreshCachedConfig: vi.fn().mockResolvedValue(undefined),
      clearNonSessionError: vi.fn(),
      getInitializeResponse: vi.fn(),
      capabilitiesFor: vi.fn(() => null),
      promptCapabilitiesFor: vi.fn(() => null),
      supportsSteering: vi.fn(() => false),
      nonSessionErrorFor: vi.fn(() => null),
      defaultAgentServerPinned: false,
      defaultConfigOptionsFor: vi.fn(() => ({})),
      isPinnedConfigOption: vi.fn(() => false),
      setPinnedDefaultConfigOption: vi.fn().mockResolvedValue(undefined),
      unpinDefaultConfigOption: vi.fn().mockResolvedValue(undefined),
    },
    pendingSessionCwd: null,
    pendingConversationId: null,
    emitter: new EventTarget(),
    configOptions: [],
    availableCommands: [],
    availableModes: [],
    isSending: false,
    isPrompting: true,
    handoffTargetAgentServer: null,
    queuedPrompt: null,
    queuedPrompts: [],
    pendingHandoff: null,
    setupStatus: null,
    promptError: null,
    events: [
      {
        eventKind: "user_message",
        messageId: "m1",
        content: [{ type: "text", text: "hello" }],
      },
    ],
    turns: [],
    pendingPermissionRequests: [],
    plan: null,
    compacting: false,
    isChat: false,
    isReadOnly: false,
    isConfigCacheLoading: false,
    currentModeId: null,
    isPlanModeActive: false,
    canTogglePlanMode: false,
    planModeViaCollaboration: false,
    collaborationModeSurface: "none",
    createSession: vi.fn(
      (
        cwd: string,
        agentServer = "poolside",
        conversationId: string | null = null,
        options: { isChat?: boolean } = {},
      ) => {
        Object.assign(repo, {
          conversationId: conversationId ?? "conversation:local",
          sessionId: null,
          sessionAgentServer: agentServer,
          sessionInfo: null,
          pendingSessionCwd: cwd,
          pendingConversationId: conversationId ?? "conversation:local",
          ...(options.isChat === undefined ? {} : { isChat: options.isChat }),
        });
        return { conversationId: repo.conversationId };
      },
    ),
    getConversationStatus: vi.fn(() => ({ working: false, waitingForUser: false, unread: false })),
    clearUnread: vi.fn(),
    claimVisibleConversation: vi.fn(() => () => {}),
    retryLastPrompt: vi.fn().mockResolvedValue(undefined),
    retryAfterError: vi.fn().mockResolvedValue(undefined),
    reloadLiveSession: vi.fn().mockResolvedValue(true),
    cancel: vi.fn().mockResolvedValue(undefined),
    enqueuePrompt: vi.fn(),
    clearQueuedPrompt: vi.fn(),
    prioritizeQueuedPrompt: vi.fn(),
    sendQueuedPrompt: vi.fn(),
    steerQueuedPrompt: vi.fn().mockResolvedValue(undefined),
    pendingConfigOption: vi.fn(() => null),
    setConfigOption: vi.fn(),
    togglePlanMode: vi.fn().mockResolvedValue(undefined),
    handoffSession: vi.fn().mockResolvedValue(undefined),
    selectPermissionOption: vi.fn(),
    unboundPermissionRequestsFor: vi.fn(() => []),
    pendingApprovals: [],
    ...repoOverrides,
  };
  Object.assign(repo.agents, agentOverrides);

  const session = {
    get sessionId() {
      return repo.sessionId;
    },
    get agentServer() {
      return repo.sessionAgentServer ?? repo.agents.defaultAgentServer;
    },
    get cwd() {
      return repo.pendingSessionCwd ?? repo.sessionInfo?.cwd ?? "/workspace";
    },
    get conversationId() {
      return repo.conversationId;
    },
    get pendingCwd() {
      return repo.sessionId === null ? repo.pendingSessionCwd : null;
    },
    get pendingConversationId() {
      return repo.sessionId === null ? repo.pendingConversationId : null;
    },
    get isChat() {
      return repo.isChat;
    },
    get sessionInfo() {
      return repo.sessionInfo ? { ...repo.sessionInfo, readOnly: repo.isReadOnly } : null;
    },
    get loadState() {
      return repo.sessionLoadState;
    },
    get loadIntent() {
      return repo.sessionLoadIntent;
    },
    get setupStatus() {
      return repo.setupStatus;
    },
    get isPrompting() {
      return repo.isPrompting;
    },
    get isPromptActive() {
      return repo.isPrompting;
    },
    get isSending() {
      return repo.isSending;
    },
    get restoredWithoutHistory() {
      return repo.restoredWithoutHistory ?? false;
    },
    get handoffTargetAgentServer() {
      return repo.handoffTargetAgentServer;
    },
    get queuedPrompt() {
      return repo.queuedPrompts[0] ?? null;
    },
    get queuedPrompts() {
      return repo.queuedPrompts;
    },
    get pendingHandoff() {
      return repo.pendingHandoff;
    },
    get events() {
      return repo.events;
    },
    get turns() {
      return repo.turns;
    },
    get plan() {
      return repo.plan;
    },
    get compacting() {
      return repo.compacting;
    },
    get promptError() {
      return repo.promptError;
    },
    get pendingPermissionRequests() {
      return repo.pendingPermissionRequests;
    },
    get configOptions() {
      return repo.configOptions;
    },
    get availableCommands() {
      return repo.availableCommands;
    },
    get availableModes() {
      return repo.availableModes;
    },
    get isPlanModeActive() {
      return repo.isPlanModeActive;
    },
    get canTogglePlanMode() {
      return repo.canTogglePlanMode;
    },
    get planModeViaCollaboration() {
      return repo.planModeViaCollaboration;
    },
    get collaborationModeSurface() {
      return repo.collaborationModeSurface;
    },
    pendingConfigOption: (configId: string) => repo.pendingConfigOption(configId),
    enqueuePrompt: (prompt: any) => repo.enqueuePrompt(prompt),
    clearQueuedPrompt: (id?: string) => repo.clearQueuedPrompt(id),
    prioritizeQueuedPrompt: (id?: string) => repo.prioritizeQueuedPrompt(id),
    sendQueuedPrompt: (id?: string) => repo.sendQueuedPrompt(id),
    steerQueuedPrompt: (id?: string) => repo.steerQueuedPrompt(id),
    cancel: (options?: any) => repo.cancel(options),
    retryLastPrompt: () => repo.retryLastPrompt(),
    retryAfterError: () => repo.retryAfterError(),
    setConfigOption: (configId: string, value: string) => repo.setConfigOption(configId, value),
    togglePlanMode: () => repo.togglePlanMode(),
    serialize: (operation: (generation: number) => Promise<string | null>) => operation(0),
    sendCore: vi.fn().mockResolvedValue(null),
  };

  repo.getSessionByConversationId = vi.fn((conversationId: string | null | undefined) =>
    conversationId ? session : null,
  );

  return repo;
}

function makeConversationRepo(overrides: Record<string, any> = {}): any {
  const sessions = overrides.sessions ?? [];
  return {
    projects: [],
    sessions,
    refreshState: { status: "success", value: sessions },
    emitter: new EventTarget(),
    refresh: vi.fn().mockResolvedValue(undefined),
    upsertProject: vi.fn().mockResolvedValue(undefined),
    createPendingConversation: vi.fn(),
    getSession: vi.fn(),
    getWorktreeBusy: vi.fn(),
    setWorktreeBusy: vi.fn(),
    clearWorktreeBusy: vi.fn(),
    requestDelete: vi.fn(),
    isDeleteRequested: vi.fn(() => false),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
