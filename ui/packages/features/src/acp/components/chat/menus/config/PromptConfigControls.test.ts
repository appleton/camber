import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../../../../hostAdapter";
import { CAMBER_ROUNDEL_ICON_URL } from "../../../../localAgentIcon";
import { presentNativeMenu, type MenuSpecItem } from "../../../ui/menuSpec";
import Harness from "./PromptConfigControls.test.svelte";

vi.mock("../../../ui/menuSpec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../ui/menuSpec")>()),
  presentNativeMenu: vi.fn(),
}));

// Deterministic brand-tint resolution: raw colors pass through, var()
// references (Camber's vibrant) resolve to a fixed marker color rather than
// whatever jsdom's style engine computes.
vi.mock("../../nativeMenuTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeMenuTheme")>()),
  resolveCssColorToHex: vi.fn((value?: string) =>
    value === undefined ? undefined : value.startsWith("var(") ? "#00ffcc" : value,
  ),
}));

const mockPresentNativeMenu = vi.mocked(presentNativeMenu);

function setEnvironment(assistantHost: string, operatingSystem?: string): void {
  appState.update((state) => ({
    ...state,
    environment: { ...state.environment, assistantHost, operatingSystem },
  }));
}

// --- fixtures ---------------------------------------------------------------

function modelOption(): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "opus",
    options: [
      { value: "opus", name: "Opus 5", description: "Most capable model" },
      { value: "sonnet", name: "Sonnet 5", description: "Balanced speed and smarts" },
    ],
  } as SessionConfigOption;
}

function fastOption(): SessionConfigOption {
  return {
    id: "fast",
    name: "Fast Mode",
    type: "boolean",
    currentValue: false,
  } as SessionConfigOption;
}

// Claude-style effort range: recognized magnitudes plus a default/auto entry.
function effortOption(): SessionConfigOption {
  return {
    id: "effort",
    name: "Effort",
    type: "select",
    currentValue: "high",
    options: [
      { value: "default", name: "Default" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra High" },
      { value: "max", name: "Max" },
    ],
  } as SessionConfigOption;
}

// Unclassified select with no dedicated picker slot; its values carry ":" to
// prove the extras' opt:-id routing round-trips them.
function providerOption(): SessionConfigOption {
  return {
    id: "provider",
    name: "Provider",
    type: "select",
    currentValue: "openai:gpt-5",
    options: [
      { value: "openai:gpt-5", name: "OpenAI GPT-5" },
      { value: "anthropic:claude", name: "Anthropic Claude", description: "Best for code" },
    ],
  } as SessionConfigOption;
}

// A SECOND model-shaped select: the first stays in the dedicated Model slot,
// so this one must land in extras.
function subModelOption(): SessionConfigOption {
  return {
    id: "sub_model",
    name: "Sub Model",
    type: "select",
    currentValue: "mini",
    options: [
      { value: "mini", name: "Mini" },
      { value: "maxi", name: "Maxi" },
    ],
  } as SessionConfigOption;
}

// Claude's persona picker ships with the id "agent": the live case of a
// user-controlled option id spelled exactly like a built-in star-group name.
function personaOption(): SessionConfigOption {
  return {
    id: "agent",
    name: "Persona",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "reviewer", name: "Reviewer" },
    ],
  } as SessionConfigOption;
}

// Unclassified boolean (not fast-named): extras render it as an On/Off pair.
function notificationsOption(): SessionConfigOption {
  return {
    id: "notifications",
    name: "Notifications",
    type: "boolean",
    currentValue: false,
  } as SessionConfigOption;
}

// Mode-kind option: the ModeControl owns it, so the picker must skip it.
function permissionModeOption(): SessionConfigOption {
  return {
    id: "permission_mode",
    name: "Permission Mode",
    type: "select",
    category: "mode",
    currentValue: "default",
    options: [
      { value: "default", name: "Always Ask" },
      { value: "bypass", name: "Bypass Permissions" },
    ],
  } as SessionConfigOption;
}

interface RepoOptions {
  configOptions?: SessionConfigOption[];
  agentServerNames?: string[];
  agentServer?: string;
  configLoading?: boolean;
  authRequired?: boolean;
  // Option id -> the value its default is pinned to (pressed star = pinned).
  pinnedConfigOptions?: Record<string, string>;
  defaultAgentServerPinned?: boolean;
}

// Doubles the session repository for both the repo context and the chat
// session scope: a sessionless conversation (agent still switchable) whose
// config options come from the fixture.
function makeRepo(options: RepoOptions = {}) {
  const pinned = options.pinnedConfigOptions ?? {};
  const session = {
    sessionId: null,
    conversationId: null,
    pendingConversationId: "conversation:test",
    pendingCwd: "/work/project",
    pendingHandoff: null,
    agentServer: options.agentServer ?? "poolside",
    isSending: false,
    isPromptActive: false,
    queuedPrompts: [] as unknown[],
    pendingPermissionRequests: [] as unknown[],
    handoffTargetAgentServer: null,
    sessionInfo: null,
    events: [] as unknown[],
    turns: [] as unknown[],
    configOptions: options.configOptions ?? [],
    setConfigOption: vi.fn().mockResolvedValue(undefined),
    setBooleanConfigOption: vi.fn().mockResolvedValue(undefined),
  };
  const repo = {
    getSessionByConversationId: () => session,
    createSession: vi.fn(() => ({ conversationId: "conversation:new" })),
    handoffSession: vi.fn().mockResolvedValue(undefined),
    agents: {
      agentServerNames: options.agentServerNames ?? ["poolside", "claude-acp"],
      defaultAgentServer: "poolside",
      defaultAgentServerPinned: options.defaultAgentServerPinned ?? false,
      isConfigCacheLoadingFor: () => options.configLoading ?? false,
      authRequiredForAgent: () => options.authRequired ?? false,
      defaultConfigOptionsFor: () => ({ ...pinned }),
      isPinnedConfigOption: (_agentServer: string, configId: string) => configId in pinned,
      setPinnedDefaultConfigOption: vi.fn().mockResolvedValue(undefined),
      unpinDefaultConfigOption: vi.fn().mockResolvedValue(undefined),
    },
  };
  return { repo, session };
}

const claudeRegistry = {
  getAgent: (id: string) =>
    id === "claude-acp"
      ? { id: "claude-acp", name: "Claude Code", icon: "https://example.com/claude.svg" }
      : undefined,
};

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: "Agent, model and options" });
}

function lastSpec(): MenuSpecItem[] {
  const call = mockPresentNativeMenu.mock.calls.at(-1);
  if (!call) throw new Error("presentNativeMenu was not called");
  return call[0];
}

describe("PromptConfigControls native menu", () => {
  beforeEach(() => {
    setEnvironment("desktop", "darwin");
    mockPresentNativeMenu.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    setEnvironment("", undefined);
  });

  it("builds the native spec for a loaded config: agent submenu, inline models, fast, effort", async () => {
    const { repo } = makeRepo({
      configOptions: [modelOption(), fastOption(), effortOption()],
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    expect(mockPresentNativeMenu).toHaveBeenCalledExactlyOnceWith(
      expect.any(Array),
      expect.objectContaining({ align: "end" }),
      // The DOM panel's 390px width rides along as the native minimum so
      // sublabels wrap instead of stretching the menu; star clicks route
      // through onSetDefault.
      { highlightStyle: "themed", minWidth: 390, onSetDefault: expect.any(Function) },
    );
    expect(lastSpec()).toEqual([
      {
        kind: "submenu",
        label: "Agent",
        // The DOM row's dimmed current-selection text rides along as detail.
        detail: "Camber",
        // Brand-tinted like the DOM rows: Camber masks in the vibrant token
        // (resolved to hex), Claude in its orange.
        icon: { url: CAMBER_ROUNDEL_ICON_URL, color: "#00ffcc" },
        // The DOM sub-panel's fixed 390px width rides on every submenu so its
        // sublabels wrap natively instead of stretching the submenu.
        minWidth: 390,
        items: [
          {
            kind: "action",
            id: "agent:poolside",
            label: "Camber",
            icon: { url: CAMBER_ROUNDEL_ICON_URL, color: "#00ffcc" },
            checked: true,
            enabled: true,
            // Star rows everywhere a DOM row carries the star; nothing is
            // pinned in this fixture, so all stars are empty. The agent rows
            // share their own built-in radio group, apart from every option's
            // opt:-prefixed group.
            star: { starred: false },
            starGroup: "agent-server",
          },
          {
            kind: "action",
            id: "agent:claude-acp",
            label: "Claude Code",
            icon: { url: "https://example.com/claude.svg", color: "#d97757" },
            checked: false,
            enabled: true,
            star: { starred: false },
            starGroup: "agent-server",
          },
        ],
      },
      { kind: "separator" },
      {
        kind: "action",
        id: "model:opus",
        label: "Opus 5",
        sublabel: "Most capable model",
        icon: undefined,
        checked: true,
        toolTip: undefined,
        star: { starred: false },
        // One radio group per option, keyed by the option's id under the
        // opt: namespace: starring a model clears only the other model stars.
        starGroup: "opt:model",
      },
      {
        kind: "action",
        id: "model:sonnet",
        label: "Sonnet 5",
        sublabel: "Balanced speed and smarts",
        icon: undefined,
        checked: false,
        toolTip: undefined,
        star: { starred: false },
        starGroup: "opt:model",
      },
      { kind: "separator" },
      {
        kind: "submenu",
        label: "Fast Mode",
        detail: "Off",
        icon: "bolt",
        minWidth: 390,
        items: [
          // Boolean rows carry no star, as in the DOM.
          { kind: "action", id: "fast:true", label: "On", icon: "bolt", checked: false },
          { kind: "action", id: "fast:false", label: "Off", icon: "bolt", checked: true },
        ],
      },
      {
        kind: "submenu",
        label: "Effort",
        detail: "High",
        // The real EffortBarsIcon, serialized for rasterization (no SF Symbol
        // substitute).
        icon: { svg: expect.stringContaining("<svg") },
        minWidth: 390,
        items: [
          {
            kind: "action",
            id: "effort:default",
            label: "Default",
            sublabel: undefined,
            icon: "wand",
            checked: false,
            toolTip: undefined,
            star: { starred: false },
            starGroup: "opt:effort",
          },
          {
            kind: "action",
            id: "effort:low",
            label: "Low",
            sublabel: undefined,
            icon: { svg: expect.stringContaining("<svg") },
            checked: false,
            toolTip: undefined,
            star: { starred: false },
            starGroup: "opt:effort",
          },
          {
            kind: "action",
            id: "effort:medium",
            label: "Medium",
            sublabel: undefined,
            icon: { svg: expect.stringContaining("<svg") },
            checked: false,
            toolTip: undefined,
            star: { starred: false },
            starGroup: "opt:effort",
          },
          {
            kind: "action",
            id: "effort:high",
            label: "High",
            sublabel: undefined,
            icon: { svg: expect.stringContaining("<svg") },
            checked: true,
            toolTip: undefined,
            star: { starred: false },
            starGroup: "opt:effort",
          },
          {
            kind: "action",
            id: "effort:xhigh",
            label: "Extra High",
            sublabel: undefined,
            icon: { svg: expect.stringContaining("<svg") },
            checked: false,
            toolTip: undefined,
            star: { starred: false },
            starGroup: "opt:effort",
          },
          {
            kind: "action",
            id: "effort:max",
            label: "Max",
            sublabel: undefined,
            icon: { svg: expect.stringContaining("<svg") },
            checked: false,
            toolTip: undefined,
            star: { starred: false },
            starGroup: "opt:effort",
          },
        ],
      },
    ]);
    // The serialized bars carry the level: unfilled bars render at 0.3
    // opacity, so Low has dimmed bars while Max has none.
    const effortMenu = lastSpec().find(
      (item) => item.kind === "submenu" && item.label === "Effort",
    );
    if (effortMenu?.kind !== "submenu") throw new Error("expected an Effort submenu");
    const effortIconSvg = (id: string): string => {
      const row = effortMenu.items.find((item) => item.kind === "action" && item.id === id);
      if (row?.kind !== "action" || typeof row.icon !== "object" || !("svg" in row.icon)) {
        throw new Error(`expected an svg icon on ${id}`);
      }
      return row.icon.svg;
    };
    expect(effortIconSvg("effort:low")).toContain('opacity="0.3"');
    expect(effortIconSvg("effort:max")).not.toContain('opacity="0.3"');
    // Inline model rows sit at the same level as the icon-bearing
    // Agent/Fast Mode/Effort rows but must stay flush-left: no icon, and no
    // reserved icon slot either (the opt-in is for the extras openers only).
    for (const id of ["model:opus", "model:sonnet"]) {
      const row = lastSpec().find((item) => item.kind === "action" && item.id === id);
      if (row?.kind !== "action") throw new Error(`expected an inline model row ${id}`);
      expect(row.icon).toBeUndefined();
      expect("reserveIconSlot" in row).toBe(false);
    }
    // No DOM menu renders; the OS owns the surface.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("puts a long model list behind a Model submenu with the selected value first", async () => {
    const values = Array.from({ length: 16 }, (_, index) => ({
      value: `m${index + 1}`,
      name: `Model ${index + 1}`,
    }));
    const { repo } = makeRepo({
      agentServerNames: ["poolside"],
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "m3",
          options: values,
        } as SessionConfigOption,
      ],
    });
    render(Harness, { props: { repo } });

    await fireEvent.click(trigger());

    const items = lastSpec();
    expect(items).toHaveLength(1);
    const modelMenu = items[0];
    if (modelMenu.kind !== "submenu") throw new Error("expected a Model submenu");
    expect(modelMenu.label).toBe("Model");
    // The current model's name rides along as the submenu's detail text.
    expect(modelMenu.detail).toBe("Model 3");
    expect(modelMenu.icon).toBe("sparkles");
    // The DOM sub-panel's fixed width, so model descriptions wrap natively.
    expect(modelMenu.minWidth).toBe(390);
    // Single-agent install: the header separator names whose models these are.
    expect(modelMenu.items[0]).toEqual({ kind: "separator", label: "Camber models" });
    expect(modelMenu.items).toHaveLength(17);
    expect(modelMenu.items[1]).toMatchObject({ id: "model:m3", checked: true });
    expect(modelMenu.items[2]).toMatchObject({ id: "model:m1", checked: false });
  });

  it("shows a disabled loading item while the config probe is in flight", async () => {
    const { repo } = makeRepo({ agentServerNames: ["poolside"], configLoading: true });
    render(Harness, { props: { repo } });

    await fireEvent.click(trigger());

    expect(lastSpec()).toEqual([
      {
        kind: "action",
        id: "status:loading",
        label: "Loading Camber options...",
        sublabel:
          "Getting available models and settings from the agent. The first launch can take a few seconds while the agent starts up.",
        enabled: false,
      },
    ]);
  });

  it("shows a disabled log-in note when the agent wants auth before publishing options", async () => {
    const { repo } = makeRepo({ agentServerNames: ["poolside"], authRequired: true });
    render(Harness, { props: { repo } });

    await fireEvent.click(trigger());

    expect(lastSpec()).toEqual([
      {
        kind: "action",
        id: "status:needs-auth",
        label: "Log in to Camber to load its models and options.",
        enabled: false,
      },
    ]);
  });

  it("carries local-model warmth as tooltips on model rows", async () => {
    const { repo } = makeRepo({
      agentServer: "local",
      agentServerNames: ["local"],
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "org/model-a",
          options: [
            { value: "org/model-a", name: "Model A" },
            { value: "org/model-b", name: "Model B" },
          ],
        } as SessionConfigOption,
      ],
    });
    const localInference = {
      state: {
        runtime: {
          status: "running",
          loadedModelId: "org/model-a",
          loadedMemoryBytes: 20 * 1024 ** 3,
          lastActivityUnixMs: Date.now() - 30_000,
          idleUnloadSeconds: 0,
        },
        catalog: [{ id: "org/model-a", name: "Model A", downloaded: true }],
      },
      refreshIfStale: vi.fn().mockResolvedValue(undefined),
    };
    render(Harness, { props: { repo, localInference } });

    await fireEvent.click(trigger());

    expect(lastSpec()).toEqual([
      { kind: "separator", label: "Camber Local models" },
      {
        kind: "action",
        id: "model:org/model-a",
        label: "Model A",
        sublabel: undefined,
        icon: undefined,
        checked: true,
        toolTip: "Loaded in memory (20 GB) · last prompt just now",
        star: { starred: false },
        starGroup: "opt:model",
      },
      {
        kind: "action",
        id: "model:org/model-b",
        label: "Model B",
        sublabel: undefined,
        icon: undefined,
        checked: false,
        toolTip: "Not loaded — first prompt loads the model",
        star: { starred: false },
        starGroup: "opt:model",
      },
    ]);
  });

  it("dispatches a model selection to setConfigOption", async () => {
    const { repo, session } = makeRepo({
      configOptions: [modelOption(), fastOption(), effortOption()],
    });
    mockPresentNativeMenu.mockResolvedValue("model:sonnet");
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    await waitFor(() =>
      expect(session.setConfigOption).toHaveBeenCalledExactlyOnceWith("model", "sonnet"),
    );
    expect(session.setBooleanConfigOption).not.toHaveBeenCalled();
  });

  it("dispatches a fast-mode selection to setBooleanConfigOption", async () => {
    const { repo, session } = makeRepo({
      configOptions: [modelOption(), fastOption(), effortOption()],
    });
    mockPresentNativeMenu.mockResolvedValue("fast:true");
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    await waitFor(() =>
      expect(session.setBooleanConfigOption).toHaveBeenCalledExactlyOnceWith("fast", true),
    );
    expect(session.setConfigOption).not.toHaveBeenCalled();
  });

  it("dispatches an effort selection to setConfigOption", async () => {
    const { repo, session } = makeRepo({
      configOptions: [modelOption(), fastOption(), effortOption()],
    });
    mockPresentNativeMenu.mockResolvedValue("effort:max");
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    await waitFor(() =>
      expect(session.setConfigOption).toHaveBeenCalledExactlyOnceWith("effort", "max"),
    );
  });

  it("dispatches an agent selection through the same session-creation path as the DOM rows", async () => {
    const { repo } = makeRepo({
      configOptions: [modelOption()],
    });
    mockPresentNativeMenu.mockResolvedValue("agent:claude-acp");
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    await waitFor(() =>
      expect(repo.createSession).toHaveBeenCalledExactlyOnceWith(
        "/work/project",
        "claude-acp",
        "conversation:test",
        {},
      ),
    );
  });

  it("remembers an agent selection as the last-used agent for new conversations", async () => {
    const { repo } = makeRepo({
      configOptions: [modelOption()],
    });
    const agentServers = { setDefaultAgentServer: vi.fn().mockResolvedValue(undefined) };
    mockPresentNativeMenu.mockResolvedValue("agent:claude-acp");
    render(Harness, { props: { repo, registry: claudeRegistry, agentServers } });

    await fireEvent.click(trigger());

    await waitFor(() =>
      expect(agentServers.setDefaultAgentServer).toHaveBeenCalledExactlyOnceWith("claude-acp"),
    );
    // The selection itself still goes through the normal session-creation path.
    expect(repo.createSession).toHaveBeenCalledExactlyOnceWith(
      "/work/project",
      "claude-acp",
      "conversation:test",
      {},
    );
  });

  it("skips the last-used write when the selected agent is already remembered", async () => {
    const { repo } = makeRepo({
      configOptions: [modelOption()],
    });
    repo.agents.defaultAgentServer = "claude-acp";
    const agentServers = { setDefaultAgentServer: vi.fn().mockResolvedValue(undefined) };
    mockPresentNativeMenu.mockResolvedValue("agent:claude-acp");
    render(Harness, { props: { repo, registry: claudeRegistry, agentServers } });

    await fireEvent.click(trigger());

    await waitFor(() => expect(repo.createSession).toHaveBeenCalledTimes(1));
    expect(agentServers.setDefaultAgentServer).not.toHaveBeenCalled();
  });

  it("skips the last-used write entirely while the default agent is pinned", async () => {
    const { repo } = makeRepo({
      configOptions: [modelOption()],
      defaultAgentServerPinned: true,
    });
    const agentServers = { setDefaultAgentServer: vi.fn().mockResolvedValue(undefined) };
    mockPresentNativeMenu.mockResolvedValue("agent:claude-acp");
    render(Harness, { props: { repo, registry: claudeRegistry, agentServers } });

    await fireEvent.click(trigger());

    // The selection itself still goes through, but the pinned default agent
    // is not overwritten by last use.
    await waitFor(() => expect(repo.createSession).toHaveBeenCalledTimes(1));
    expect(agentServers.setDefaultAgentServer).not.toHaveBeenCalled();
  });

  it("fills the native stars only on pinned defaults (pinned, not merely current)", async () => {
    const { repo } = makeRepo({
      configOptions: [modelOption(), fastOption(), effortOption()],
      // Sonnet is pinned while Opus is the CURRENT value: the checkmark and
      // the filled star sit on different rows. The agent default is pinned to
      // the app-wide default (camber).
      pinnedConfigOptions: { model: "sonnet" },
      defaultAgentServerPinned: true,
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    const spec = lastSpec();
    expect(spec[0]).toMatchObject({
      kind: "submenu",
      label: "Agent",
      items: [
        { id: "agent:poolside", checked: true, star: { starred: true } },
        { id: "agent:claude-acp", checked: false, star: { starred: false } },
      ],
    });
    const row = (id: string) => spec.find((item) => item.kind === "action" && item.id === id);
    expect(row("model:opus")).toMatchObject({ checked: true, star: { starred: false } });
    expect(row("model:sonnet")).toMatchObject({ checked: false, star: { starred: true } });
  });

  it("routes native star clicks to pin and unpin, matching each row's handler", async () => {
    const { repo } = makeRepo({
      configOptions: [modelOption(), fastOption(), effortOption(), providerOption()],
    });
    const agentServers = {
      setDefaultAgentServer: vi.fn().mockResolvedValue(undefined),
      setPinnedDefaultAgentServer: vi.fn().mockResolvedValue(undefined),
      unpinDefaultAgentServer: vi.fn().mockResolvedValue(undefined),
    };
    render(Harness, { props: { repo, registry: claudeRegistry, agentServers } });

    await fireEvent.click(trigger());
    await waitFor(() => expect(mockPresentNativeMenu).toHaveBeenCalledTimes(1));
    const onSetDefault = mockPresentNativeMenu.mock.calls[0]?.[2]?.onSetDefault;
    if (!onSetDefault) throw new Error("expected an onSetDefault handler");

    // Starring pins the row's value; un-starring unpins the key.
    onSetDefault("model:sonnet", true);
    await waitFor(() =>
      expect(repo.agents.setPinnedDefaultConfigOption).toHaveBeenCalledExactlyOnceWith(
        "poolside",
        "model",
        "sonnet",
      ),
    );
    // Effort is follow-managed, so its unpin keeps the stored value for the
    // last-used auto-follow to keep overwriting.
    onSetDefault("effort:max", false);
    await waitFor(() =>
      expect(repo.agents.unpinDefaultConfigOption).toHaveBeenCalledExactlyOnceWith(
        "poolside",
        "effort",
        { clearValue: false },
      ),
    );

    // Extras route through their opt: ids (":" in the value round-trips).
    onSetDefault("opt:provider:anthropic:claude", true);
    await waitFor(() =>
      expect(repo.agents.setPinnedDefaultConfigOption).toHaveBeenCalledWith(
        "poolside",
        "provider",
        "anthropic:claude",
      ),
    );
    // The uncategorized extra is one the auto-follow never writes: its unpin
    // clears the stored value too, or applyDefaultConfigOptions would keep
    // seeding new sessions with an invisible, unclearable default.
    onSetDefault("opt:provider:anthropic:claude", false);
    await waitFor(() =>
      expect(repo.agents.unpinDefaultConfigOption).toHaveBeenCalledWith("poolside", "provider", {
        clearValue: true,
      }),
    );

    // Agent stars pin and unpin the app-wide default agent.
    onSetDefault("agent:claude-acp", true);
    await waitFor(() =>
      expect(agentServers.setPinnedDefaultAgentServer).toHaveBeenCalledExactlyOnceWith(
        "claude-acp",
      ),
    );
    onSetDefault("agent:claude-acp", false);
    await waitFor(() => expect(agentServers.unpinDefaultAgentServer).toHaveBeenCalledTimes(1));

    // No selection was dispatched by any star click.
    expect(repo.createSession).not.toHaveBeenCalled();
    expect(agentServers.setDefaultAgentServer).not.toHaveBeenCalled();
  });

  it("ignores star reports for boolean rows", async () => {
    const { repo } = makeRepo({
      configOptions: [modelOption(), fastOption(), notificationsOption()],
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());
    await waitFor(() => expect(mockPresentNativeMenu).toHaveBeenCalledTimes(1));
    const onSetDefault = mockPresentNativeMenu.mock.calls[0]?.[2]?.onSetDefault;
    if (!onSetDefault) throw new Error("expected an onSetDefault handler");

    // Boolean rows carry no star; a stray report must not pin anything.
    onSetDefault("fast:true", true);
    onSetDefault("opt:notifications:true", true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(repo.agents.setPinnedDefaultConfigOption).not.toHaveBeenCalled();
    expect(repo.agents.unpinDefaultConfigOption).not.toHaveBeenCalled();
  });

  it("keeps the trigger in its open state while the menu is up and dispatches nothing on dismissal", async () => {
    const { repo, session } = makeRepo({
      configOptions: [modelOption(), fastOption(), effortOption()],
    });
    let resolveMenu!: (id: string | undefined) => void;
    mockPresentNativeMenu.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMenu = resolve;
        }),
    );
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    resolveMenu(undefined);
    await waitFor(() => expect(trigger()).toHaveAttribute("aria-expanded", "false"));
    expect(session.setConfigOption).not.toHaveBeenCalled();
    expect(session.setBooleanConfigOption).not.toHaveBeenCalled();
    expect(repo.createSession).not.toHaveBeenCalled();
  });

  it("keeps the DOM dropdown on hosts without native menus", async () => {
    setEnvironment("vscode", "darwin");
    const { repo } = makeRepo({
      configOptions: [modelOption(), fastOption(), effortOption()],
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    expect(mockPresentNativeMenu).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Agent, model and options" })).toBeInTheDocument();
    // Small model lists render inline; Fast Mode keeps its submenu opener row.
    expect(screen.getByRole("menuitem", { name: /Opus 5/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Fast Mode/ })).toBeInTheDocument();
  });

  it("renders DOM stars pressed on the pinned default and toggles pin state on click", async () => {
    setEnvironment("vscode", "darwin");
    const { repo } = makeRepo({
      configOptions: [modelOption(), fastOption(), effortOption()],
      // Sonnet pinned while Opus is current: pressed = pinned, not selected.
      pinnedConfigOptions: { model: "sonnet" },
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    const sonnetStar = screen.getByRole("button", { name: "Use Sonnet 5 by default" });
    const opusStar = screen.getByRole("button", { name: "Use Opus 5 by default" });
    expect(sonnetStar).toHaveAttribute("aria-pressed", "true");
    expect(sonnetStar).toHaveAttribute("title", "Default");
    expect(opusStar).toHaveAttribute("aria-pressed", "false");
    expect(opusStar).toHaveAttribute("title", "Make default");

    // Clicking an unpressed star pins that row's value...
    await fireEvent.click(opusStar);
    await waitFor(() =>
      expect(repo.agents.setPinnedDefaultConfigOption).toHaveBeenCalledExactlyOnceWith(
        "poolside",
        "model",
        "opus",
      ),
    );

    // ...and clicking the pressed star unpins the key — keeping the stored
    // value, since the model follows last use.
    await fireEvent.click(sonnetStar);
    await waitFor(() =>
      expect(repo.agents.unpinDefaultConfigOption).toHaveBeenCalledExactlyOnceWith(
        "poolside",
        "model",
        { clearValue: false },
      ),
    );
    // Neither click selected the row.
    expect(repo.createSession).not.toHaveBeenCalled();
  });
});

describe("PromptConfigControls extras", () => {
  beforeEach(() => {
    setEnvironment("desktop", "darwin");
    mockPresentNativeMenu.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    setEnvironment("", undefined);
  });

  it("gives every unhandled select/boolean an extras submenu, preserving agent order", async () => {
    const { repo } = makeRepo({
      configOptions: [
        modelOption(),
        providerOption(),
        subModelOption(),
        permissionModeOption(),
        notificationsOption(),
      ],
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    const spec = lastSpec();
    // The FIRST model-shaped option keeps the dedicated (inline) model slot.
    expect(spec.some((item) => item.kind === "action" && item.id === "model:opus")).toBe(true);
    // The mode-kind option belongs to the ModeControl, never the extras.
    expect(spec.some((item) => item.kind === "submenu" && item.label === "Permission Mode")).toBe(
      false,
    );
    // After the dedicated rows: a plain separator, then one submenu per extra
    // in the agent's own order (provider, sub model, notifications).
    expect(spec.slice(-4)).toEqual([
      { kind: "separator" },
      {
        kind: "submenu",
        label: "Provider",
        detail: "OpenAI GPT-5",
        reserveIconSlot: true,
        // Like the dedicated openers: the DOM sub-panel's fixed width, so a
        // 100+ character option description wraps instead of stretching the
        // native submenu to near screen width.
        minWidth: 390,
        items: [
          // Select-shaped extras carry the star — pinning is deliberate, so
          // it is allowed even for options the last-used auto-follow ignores
          // — and each extra's rows form their own radio group.
          {
            kind: "action",
            id: "opt:provider:openai:gpt-5",
            label: "OpenAI GPT-5",
            sublabel: undefined,
            checked: true,
            star: { starred: false },
            starGroup: "opt:provider",
          },
          {
            kind: "action",
            id: "opt:provider:anthropic:claude",
            label: "Anthropic Claude",
            sublabel: "Best for code",
            checked: false,
            star: { starred: false },
            starGroup: "opt:provider",
          },
        ],
      },
      {
        kind: "submenu",
        label: "Sub Model",
        detail: "Mini",
        reserveIconSlot: true,
        minWidth: 390,
        items: [
          {
            kind: "action",
            id: "opt:sub_model:mini",
            label: "Mini",
            sublabel: undefined,
            checked: true,
            star: { starred: false },
            starGroup: "opt:sub_model",
          },
          {
            kind: "action",
            id: "opt:sub_model:maxi",
            label: "Maxi",
            sublabel: undefined,
            checked: false,
            star: { starred: false },
            starGroup: "opt:sub_model",
          },
        ],
      },
      {
        kind: "submenu",
        label: "Notifications",
        detail: "Off",
        reserveIconSlot: true,
        minWidth: 390,
        items: [
          // Boolean extras stay star-less, like every boolean row.
          {
            kind: "action",
            id: "opt:notifications:true",
            label: "On",
            sublabel: undefined,
            checked: false,
          },
          {
            kind: "action",
            id: "opt:notifications:false",
            label: "Off",
            sublabel: undefined,
            checked: true,
          },
        ],
      },
    ]);
    // Extras carry no icon anywhere — not even the surplus model-shaped
    // option — neither on the submenu opener nor on its value rows. (toEqual
    // ignores undefined-valued keys, so pin the keys' absence explicitly.)
    // Alignment beside the icon-bearing Fast/Effort openers comes from the
    // openers' explicit reserveIconSlot opt-in; their value rows neither
    // carry an icon nor reserve the slot.
    for (const item of spec.slice(-3)) {
      if (item.kind !== "submenu") throw new Error("expected an extras submenu");
      expect("icon" in item).toBe(false);
      expect(item.reserveIconSlot).toBe(true);
      for (const row of item.items) {
        expect("icon" in row).toBe(false);
        expect("reserveIconSlot" in row).toBe(false);
      }
    }
  });

  it("keeps an extras option literally id 'agent' out of the agent rows' star group", async () => {
    const { repo } = makeRepo({
      configOptions: [modelOption(), personaOption()],
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    const spec = lastSpec();
    const agentMenu = spec[0];
    if (agentMenu?.kind !== "submenu" || agentMenu.label !== "Agent") {
      throw new Error("expected the Agent submenu first");
    }
    const starGroups = (items: MenuSpecItem[]): (string | undefined)[] =>
      items
        .filter((item): item is Extract<MenuSpecItem, { kind: "action" }> => item.kind === "action")
        .map((item) => item.starGroup);
    const agentGroups = starGroups(agentMenu.items);
    expect(agentGroups).toEqual(["agent-server", "agent-server"]);

    const personaMenu = spec.find((item) => item.kind === "submenu" && item.label === "Persona");
    if (personaMenu?.kind !== "submenu") throw new Error("expected a Persona submenu");
    const personaGroups = starGroups(personaMenu.items);
    expect(personaGroups).toEqual(["opt:agent", "opt:agent"]);
    // The collision this prevents: starring the persona must never clear the
    // pinned agent-server star in the same open menu.
    for (const group of personaGroups) {
      expect(agentGroups).not.toContain(group);
    }
  });

  it("routes an extra select row to setConfigOption, round-tripping ':' in the value", async () => {
    const { repo, session } = makeRepo({
      configOptions: [modelOption(), providerOption(), notificationsOption()],
    });
    mockPresentNativeMenu.mockResolvedValue("opt:provider:anthropic:claude");
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    await waitFor(() =>
      expect(session.setConfigOption).toHaveBeenCalledExactlyOnceWith(
        "provider",
        "anthropic:claude",
      ),
    );
    expect(session.setBooleanConfigOption).not.toHaveBeenCalled();
  });

  it("routes an extra boolean row to setBooleanConfigOption", async () => {
    const { repo, session } = makeRepo({
      configOptions: [modelOption(), providerOption(), notificationsOption()],
    });
    mockPresentNativeMenu.mockResolvedValue("opt:notifications:true");
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());

    await waitFor(() =>
      expect(session.setBooleanConfigOption).toHaveBeenCalledExactlyOnceWith("notifications", true),
    );
    expect(session.setConfigOption).not.toHaveBeenCalled();
  });

  it("keeps the picker reachable for an agent with only exotic options", async () => {
    const { repo } = makeRepo({
      agentServerNames: ["poolside"],
      configOptions: [providerOption()],
    });
    render(Harness, { props: { repo } });

    // The trigger renders at all only because extras count toward hasOptions.
    await fireEvent.click(trigger());

    // Extras are the whole menu: no leading separator, just the (icon-less)
    // submenu.
    expect(lastSpec()).toEqual([
      {
        kind: "submenu",
        label: "Provider",
        detail: "OpenAI GPT-5",
        reserveIconSlot: true,
        minWidth: 390,
        items: expect.any(Array),
      },
    ]);
  });

  it("mirrors the extras in the DOM panel and dispatches a select value", async () => {
    setEnvironment("vscode", "darwin");
    const { repo, session } = makeRepo({
      configOptions: [modelOption(), providerOption(), notificationsOption()],
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());
    await fireEvent.click(screen.getByRole("menuitem", { name: /Provider/ }));

    expect(screen.getByRole("menu", { name: "Provider options" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: /Anthropic Claude/ }));

    await waitFor(() =>
      expect(session.setConfigOption).toHaveBeenCalledExactlyOnceWith(
        "provider",
        "anthropic:claude",
      ),
    );
  });

  it("mirrors a boolean extra as On/Off rows in the DOM panel", async () => {
    setEnvironment("vscode", "darwin");
    const { repo, session } = makeRepo({
      configOptions: [modelOption(), providerOption(), notificationsOption()],
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());
    await fireEvent.click(screen.getByRole("menuitem", { name: /Notifications/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "On" }));

    await waitFor(() =>
      expect(session.setBooleanConfigOption).toHaveBeenCalledExactlyOnceWith("notifications", true),
    );
    expect(session.setConfigOption).not.toHaveBeenCalled();
  });

  it("stars DOM extras select rows but not boolean rows", async () => {
    setEnvironment("vscode", "darwin");
    const { repo } = makeRepo({
      configOptions: [modelOption(), providerOption(), notificationsOption()],
      pinnedConfigOptions: { provider: "openai:gpt-5" },
    });
    render(Harness, { props: { repo, registry: claudeRegistry } });

    await fireEvent.click(trigger());
    await fireEvent.click(screen.getByRole("menuitem", { name: /Provider/ }));

    // The pinned value's star is pressed; pinning another value routes to the
    // pin handler with ":" in the value intact.
    expect(screen.getByRole("button", { name: "Use OpenAI GPT-5 by default" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await fireEvent.click(screen.getByRole("button", { name: "Use Anthropic Claude by default" }));
    await waitFor(() =>
      expect(repo.agents.setPinnedDefaultConfigOption).toHaveBeenCalledExactlyOnceWith(
        "poolside",
        "provider",
        "anthropic:claude",
      ),
    );

    // Boolean extras carry no star at all.
    await fireEvent.click(screen.getByRole("menuitem", { name: /Notifications/ }));
    expect(screen.queryByRole("button", { name: "Use On by default" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use Off by default" })).toBeNull();
  });
});
