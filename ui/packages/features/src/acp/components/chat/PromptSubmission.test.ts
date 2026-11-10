import { fireEvent, render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../../hostAdapter";
import Prompt from "./Prompt.svelte";

const mocks = vi.hoisted(() => {
  const chatSession = {
    activeAgentServer: "poolside",
    canChangeAgent: false,
    canEnqueuePrompt: false,
    canSteerPrompt: false,
    configOptions: [],
    conversationId: "conversation-1",
    ensureDraftPersisted: vi.fn(),
    isChat: false,
    isPrompting: false,
    isRemoteWorking: false,
    isSending: false,
    isSessionSetupPending: false,
    enqueuePrompt: vi.fn(),
    pendingConversationId: "conversation-1" as string | null,
    pendingSessionCwd: "/workspace",
    promptContentOptions: { supportsEmbeddedContext: false, supportsImages: false },
    promptFocusRequested: false,
    send: vi.fn(async () => {
      chatSession.isSending = true;
      return "session-1";
    }),
    steerPrompt: vi.fn().mockResolvedValue(undefined),
    sessionAgentServer: null,
    sessionInfo: null,
  };

  return {
    chatSession,
    context: {
      activeFiles: [],
      asPromptContentBlocks: vi.fn(() => []),
      reset: vi.fn(),
    },
    conversations: {
      setDraftPromptPresence: vi.fn(),
      setDraftTitle: vi.fn(),
    },
    registry: {
      getAgent: vi.fn(),
    },
    keybindings: {
      register: vi.fn(),
    },
  };
});

vi.mock("@camber/components/prompt", async () => ({
  Root: (await import("./PromptSubmit.test.svelte")).default,
}));
vi.mock("../../features/ChatSessionScope.svelte", () => ({
  getACPChatSessionScope: () => mocks.chatSession,
}));
vi.mock("../../features/ConversationRepository.svelte", () => ({
  getACPConversationRepo: () => mocks.conversations,
}));
vi.mock("../../features/AgentRegistryRepository.svelte", () => ({
  getACPAgentRegistryRepo: () => mocks.registry,
}));
vi.mock("../../../context", () => ({
  getContextRepoContext: () => mocks.context,
}));
vi.mock("../../../keybindings", () => ({
  getKeybindingService: () => mocks.keybindings,
  withShortcut: (label: string) => `${label} (⌘.)`,
}));

describe("ACP Prompt submission", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
    mocks.chatSession.activeAgentServer = "poolside";
    mocks.chatSession.isChat = false;
    mocks.chatSession.canEnqueuePrompt = false;
    mocks.chatSession.canSteerPrompt = false;
    mocks.chatSession.isPrompting = false;
    mocks.chatSession.isSending = false;
    mocks.chatSession.pendingConversationId = "conversation-1";
    mocks.registry.getAgent.mockReturnValue(undefined);
    mocks.keybindings.register.mockReturnValue(vi.fn());
    const currentAppState = get(appState);
    appState.set({
      ...currentAppState,
      environment: { ...currentAppState.environment, desktopSteerWithEnter: false },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the draft indicator when a pending conversation is submitted", async () => {
    render(Prompt, { props: { draftKey: "conversation-1" } });

    await fireEvent.input(screen.getByTestId("prompt-input"), {
      target: { value: "Start the conversation" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.conversations.setDraftTitle).toHaveBeenCalledWith(
      "conversation-1",
      "Start the conversation",
    );

    await fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(mocks.chatSession.send).toHaveBeenCalled();
    expect(mocks.conversations.setDraftPromptPresence).toHaveBeenCalledWith(
      "conversation-1",
      false,
    );
  });

  it("enables native prompt suggestions for an aliased Claude agent", async () => {
    mocks.chatSession.activeAgentServer = "my-claude";
    mocks.registry.getAgent.mockReturnValue({ id: "claude-acp", name: "Claude" });
    render(Prompt, { props: { draftKey: "conversation-1" } });

    await fireEvent.input(screen.getByTestId("prompt-input"), {
      target: { value: "Start the conversation" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(mocks.chatSession.send).toHaveBeenCalledWith(
      "Start the conversation",
      undefined,
      {
        claudeCode: {
          options: { promptSuggestions: true },
          emitRawSDKMessages: [{ type: "prompt_suggestion" }, { type: "active_goal" }],
        },
      },
      "/workspace",
      [{ type: "text", text: "Start the conversation" }],
    );
  });

  it("uses every submitted chat message as the sidebar title", async () => {
    mocks.chatSession.isChat = true;
    mocks.chatSession.pendingConversationId = null;
    render(Prompt, { props: { draftKey: "conversation-1" } });

    await fireEvent.input(screen.getByTestId("prompt-input"), {
      target: { value: "Second chat message" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.conversations.setDraftTitle).not.toHaveBeenCalled();
    expect(mocks.conversations.setDraftPromptPresence).toHaveBeenCalledWith("conversation-1", true);

    await fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(mocks.conversations.setDraftTitle).toHaveBeenCalledWith(
      "conversation-1",
      "Second chat message",
    );
    expect(mocks.conversations.setDraftPromptPresence).toHaveBeenCalledWith(
      "conversation-1",
      false,
    );
  });

  it("keeps established project conversation titles stable while composing", async () => {
    mocks.chatSession.pendingConversationId = null;
    render(Prompt, { props: { draftKey: "conversation-1" } });

    await fireEvent.input(screen.getByTestId("prompt-input"), {
      target: { value: "Project follow-up" },
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.conversations.setDraftTitle).not.toHaveBeenCalled();
    expect(mocks.conversations.setDraftPromptPresence).toHaveBeenCalledWith("conversation-1", true);
  });

  it("enqueues and interrupts an active turn when submitting with Command+Enter", async () => {
    const onInterrupt = vi.fn();
    mocks.chatSession.canEnqueuePrompt = true;
    mocks.chatSession.isPrompting = true;
    render(Prompt, { props: { draftKey: "conversation-1", onInterrupt } });

    await fireEvent.input(screen.getByTestId("prompt-input"), {
      target: { value: "Send this now" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Interrupt & Send Now" }));

    expect(mocks.chatSession.enqueuePrompt).toHaveBeenCalledWith({
      text: "Send this now",
      content: [{ type: "text", text: "Send this now" }],
      cwd: "/workspace",
    });
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(mocks.chatSession.send).not.toHaveBeenCalled();
  });

  it("steers an active turn when the agent advertises steering", async () => {
    const onInterrupt = vi.fn();
    mocks.chatSession.canEnqueuePrompt = true;
    mocks.chatSession.canSteerPrompt = true;
    mocks.chatSession.isPrompting = true;
    render(Prompt, { props: { draftKey: "conversation-1", onInterrupt } });

    await fireEvent.input(screen.getByTestId("prompt-input"), {
      target: { value: "Focus on the failing test" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Interrupt & Send Now" }));

    expect(mocks.chatSession.steerPrompt).toHaveBeenCalledWith("Focus on the failing test", [
      { type: "text", text: "Focus on the failing test" },
    ]);
    expect(mocks.chatSession.enqueuePrompt).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("swaps Enter to steer and Command+Enter to enqueue when configured", async () => {
    const currentAppState = get(appState);
    appState.set({
      ...currentAppState,
      environment: { ...currentAppState.environment, desktopSteerWithEnter: true },
    });
    mocks.chatSession.canEnqueuePrompt = true;
    mocks.chatSession.canSteerPrompt = true;
    mocks.chatSession.isPrompting = true;
    render(Prompt, { props: { draftKey: "conversation-1", onInterrupt: vi.fn() } });

    await fireEvent.input(screen.getByTestId("prompt-input"), {
      target: { value: "Steer with Enter" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(mocks.chatSession.steerPrompt).toHaveBeenCalledWith("Steer with Enter", [
      { type: "text", text: "Steer with Enter" },
    ]);

    await fireEvent.input(screen.getByTestId("prompt-input"), {
      target: { value: "Queue with Command+Enter" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Interrupt & Send Now" }));

    expect(mocks.chatSession.enqueuePrompt).toHaveBeenCalledWith({
      text: "Queue with Command+Enter",
      content: [{ type: "text", text: "Queue with Command+Enter" }],
      cwd: "/workspace",
    });
  });

  it("registers the stop-agent shortcut only while a turn is active", () => {
    const onInterrupt = vi.fn();
    mocks.chatSession.isPrompting = true;
    render(Prompt, { props: { draftKey: "conversation-1", onInterrupt } });

    expect(mocks.keybindings.register).toHaveBeenCalledWith("interrupt", onInterrupt);
  });

  it("does not claim the stop-agent shortcut while idle", () => {
    render(Prompt, { props: { draftKey: "conversation-1", onInterrupt: vi.fn() } });

    expect(mocks.keybindings.register).not.toHaveBeenCalled();
  });
});
