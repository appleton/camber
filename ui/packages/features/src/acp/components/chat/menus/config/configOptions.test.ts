import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  booleanCurrentValue,
  configIcon,
  configValueAppearance,
  effortBars,
  effortValueName,
  fastToggleState,
  hasValueDescriptions,
  isFastConfigOption,
  modeAppearance,
  modeIconClass,
  orderClaudeModelValues,
  promptConfigKind,
  valueDescription,
} from "./configOptions";

function select(id: string, category?: string): SessionConfigOption {
  return {
    id,
    type: "select",
    name: id,
    category,
    currentValue: "a",
    options: [{ value: "a", name: "a" }],
  } as SessionConfigOption;
}

function onOffSelect(id: string, name: string, currentValue: string): SessionConfigOption {
  return {
    id,
    type: "select",
    name,
    currentValue,
    options: [
      { value: "on", name: "On" },
      { value: "off", name: "Off" },
    ],
  } as SessionConfigOption;
}

function boolean(id: string, currentValue = false): SessionConfigOption {
  return { id, type: "boolean", name: id, currentValue } as SessionConfigOption;
}

function selectWith(
  id: string,
  category: string,
  currentValue: string,
  values: SessionConfigSelectOption[],
): SessionConfigOption {
  return {
    id,
    type: "select",
    name: id,
    category,
    currentValue,
    options: values,
  } as SessionConfigOption;
}

function values(...vals: string[]): SessionConfigSelectOption[] {
  return vals.map((value) => ({ value, name: value }));
}

describe("promptConfigKind", () => {
  it("classifies by semantic category", () => {
    expect(promptConfigKind(select("x", "model"))).toBe("model");
    expect(promptConfigKind(select("x", "mode"))).toBe("mode");
    expect(promptConfigKind(select("x", "thought_level"))).toBe("effort");
  });

  it("falls back to id/name keywords when category is missing", () => {
    expect(promptConfigKind(select("model"))).toBe("model");
    expect(promptConfigKind(select("mode"))).toBe("mode");
    expect(promptConfigKind(select("effort"))).toBe("effort");
    // Unknown agents with descriptive ids still classify.
    expect(promptConfigKind(select("permission_mode"))).toBe("mode");
    expect(promptConfigKind(select("approvalMode"))).toBe("mode");
    expect(promptConfigKind(select("reasoning_effort"))).toBe("effort");
    expect(promptConfigKind(select("thought_level"))).toBe("effort");
    expect(promptConfigKind(select("chat_model"))).toBe("model");
    // Mistral Vibe and Goose ship a bare "thinking" id/name for the same
    // reasoning-depth control ("thinking_effort" already matched via the
    // "effort" token, and camelCase splitting means "thinkingEffort" does
    // too — this covers the bare word).
    expect(promptConfigKind(select("thinking"))).toBe("effort");
    expect(promptConfigKind(onOffSelect("level", "Thinking", "off"))).toBe("effort");
  });

  it("keeps the collaboration mode apart from the approval mode", () => {
    // Codex and Camber give the option different ids, and both names carry
    // the "mode" token — only the category tells the two selectors apart.
    expect(promptConfigKind(select("collaboration_mode", "collaboration_mode"))).toBe(
      "collaboration",
    );
    expect(promptConfigKind(select("agent_mode", "collaboration_mode"))).toBe("collaboration");
    // The approval option alongside it still classifies as the mode selector.
    expect(promptConfigKind(select("mode", "mode"))).toBe("mode");
  });

  it("falls back to the canonical collaboration identity when category is missing", () => {
    expect(promptConfigKind(select("collaboration_mode"))).toBe("collaboration");
    // An agent_mode option without the category is indistinguishable from an
    // approval mode by name, so it keeps the existing classification.
    expect(promptConfigKind(select("agent_mode"))).toBe("mode");
  });

  it("treats fast-named boolean options as a fast toggle", () => {
    expect(promptConfigKind(boolean("fast_mode"))).toBe("fast");
    // Unrelated booleans stay unclassified (generic config menu only).
    expect(promptConfigKind(boolean("verbose_logging"))).toBeNull();
    // Booleans only ever classify as "fast" (checked first); a "thinking"
    // boolean has no effort magnitude to render, so it stays unclassified
    // rather than picking up the new "thinking" effort token.
    expect(promptConfigKind(boolean("thinking"))).toBeNull();
  });

  it("treats an on/off select named fast as a fast toggle", () => {
    expect(promptConfigKind(onOffSelect("fast", "Fast mode", "off"))).toBe("fast");
  });

  it("returns null for unrecognized selects so they stay in the config menu", () => {
    // A non-exact category alone must not classify (Claude puts fast mode and
    // other tuning under "model_config").
    expect(promptConfigKind(select("temperature", "model_config"))).toBeNull();
    // Keywords match whole tokens: "fast"/"mode" inside a word don't count.
    expect(promptConfigKind(onOffSelect("breakfast", "Breakfast", "off"))).toBeNull();
    expect(promptConfigKind(select("commodel_x"))).toBeNull();
  });
});

describe("valueDescription", () => {
  it("returns the agent's description of a value", () => {
    expect(
      valueDescription({
        value: "opus",
        name: "Opus",
        description: "Opus 5 · Best for everyday, complex tasks",
      }),
    ).toBe("Opus 5 · Best for everyday, complex tasks");
  });

  it("drops a description that only repeats the name", () => {
    // Camber publishes every model with its own name as the description;
    // rendering it as subtext would print the same string twice.
    expect(
      valueDescription({
        value: "anthropic/claude-opus-5",
        name: "anthropic/claude-opus-5",
        description: "anthropic/claude-opus-5",
      }),
    ).toBeNull();
    expect(valueDescription({ value: "a", name: "Plan", description: " plan " })).toBeNull();
  });

  it("treats missing and blank descriptions alike", () => {
    expect(valueDescription({ value: "a", name: "Low" })).toBeNull();
    expect(valueDescription({ value: "a", name: "Low", description: "   " })).toBeNull();
    expect(valueDescription({ value: "a", name: "Low", description: null })).toBeNull();
  });

  it("reports whether any value in a list carries subtext", () => {
    expect(
      hasValueDescriptions([
        { value: "a", name: "A", description: "A" },
        { value: "b", name: "B", description: "Does something" },
      ]),
    ).toBe(true);
    expect(hasValueDescriptions([{ value: "a", name: "A", description: "A" }])).toBe(false);
    expect(hasValueDescriptions([])).toBe(false);
  });
});

describe("orderClaudeModelValues", () => {
  it("orders models default first, then Fable, Opus, Sonnet, Haiku", () => {
    const ordered = orderClaudeModelValues([
      { value: "claude-haiku-4-5", name: "Haiku 4.5" },
      { value: "claude-sonnet-5", name: "Sonnet 5" },
      { value: "claude-opus-4-8", name: "Opus 4.8" },
      { value: "default", name: "Default (recommended)" },
      { value: "claude-fable-5", name: "Fable 5" },
    ]);

    expect(ordered.map((value) => value.value)).toEqual([
      "default",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  it("keeps the agent order within a family and puts unknown families last", () => {
    const ordered = orderClaudeModelValues([
      { value: "claude-mystery-6", name: "Mystery 6" },
      { value: "claude-fable-5[1m]", name: "Fable 5 (1M context)" },
      { value: "claude-opus-4-8", name: "Opus 4.8" },
      { value: "claude-fable-5", name: "Fable 5" },
    ]);

    expect(ordered.map((value) => value.value)).toEqual([
      "claude-fable-5[1m]",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-mystery-6",
    ]);
  });

  it("recognizes a family by display name when the value is opaque", () => {
    const ordered = orderClaudeModelValues([
      { value: "model-b", name: "Sonnet 5" },
      { value: "model-a", name: "Opus 4.8" },
    ]);

    expect(ordered.map((value) => value.name)).toEqual(["Opus 4.8", "Sonnet 5"]);
  });
});

describe("isFastConfigOption", () => {
  it("matches fast-named booleans and on/off selects", () => {
    expect(isFastConfigOption(boolean("fast"))).toBe(true);
    expect(isFastConfigOption(boolean("fast_mode"))).toBe(true);
    expect(isFastConfigOption(onOffSelect("fast", "Fast mode", "off"))).toBe(true);
  });

  it("rejects non-fast booleans and fast-named selects without an on/off pair", () => {
    expect(isFastConfigOption(boolean("anything"))).toBe(false);
    expect(isFastConfigOption(select("fast"))).toBe(false);
  });
});

describe("fastToggleState", () => {
  it("reads a boolean directly", () => {
    expect(fastToggleState(boolean("fast", true))).toMatchObject({ isBoolean: true, isOn: true });
  });

  it("maps a select's on/off values", () => {
    expect(fastToggleState(onOffSelect("fast", "Fast mode", "on"))).toMatchObject({
      isBoolean: false,
      isOn: true,
      canToggle: true,
      onValue: "on",
      offValue: "off",
    });
    expect(fastToggleState(onOffSelect("fast", "Fast mode", "off")).isOn).toBe(false);
  });
});

describe("configIcon", () => {
  it("uses the bolt icon for fast options", () => {
    expect(configIcon(boolean("fast"))).toBe("bolt");
    expect(configIcon(onOffSelect("fast", "Fast mode", "off"))).toBe("bolt");
  });

  it("maps recognized select categories to their icons", () => {
    expect(configIcon(select("x", "mode"))).toBe("plan");
    expect(configIcon(select("x", "model"))).toBe("sparkles");
    expect(configIcon(select("x", "thought_level"))).toBe("wand");
    expect(configIcon(select("permission_mode"))).toBe("plan");
    expect(configIcon(select("temperature"))).toBe("config");
  });
});

describe("modeAppearance", () => {
  const modes = [
    // Camber
    { name: "Always ask", value: "read-only", category: "normal", icon: "ask" },
    { name: "Accept edits", value: "acceptEdits", category: "normal", icon: "apply" },
    { name: "Plan", value: "plan", category: "plan", icon: "plan" },
    {
      name: "Allow all",
      value: "always-allow",
      category: "dangerous",
      icon: "fast-forward",
    },
    // Claude
    { name: "Auto", value: "auto", category: "auto", icon: "shield" },
    { name: "Default", value: "default", category: "normal", icon: "ask" },
    { name: "Accept Edits", value: "accept-edits", category: "normal", icon: "apply" },
    { name: "Plan Mode", value: "planMode", category: "plan", icon: "plan" },
    { name: "Don't Ask", value: "dontAsk", category: "restricted", icon: "block" },
    {
      name: "Bypass Permissions",
      value: "bypassPermissions",
      category: "dangerous",
      icon: "fast-forward",
    },
    // Codex
    { name: "Read-only", value: "read-only", category: "restricted", icon: "block" },
    {
      name: "Agent",
      value: "workspace-write",
      category: "auto",
      icon: "shield",
    },
    {
      name: "Agent (full access)",
      value: "danger-full-access",
      category: "dangerous",
      icon: "fast-forward",
    },
  ] as const;

  it("maps every Camber, Claude, and Codex mode to the approved category and icon", () => {
    for (const mode of modes) {
      const option = selectWith("mode", "mode", mode.value, [
        { value: mode.value, name: mode.name },
      ]);
      const appearance = modeAppearance(option);

      expect(appearance.category, mode.name).toBe(mode.category);
      expect(appearance.icon, mode.name).toBe(mode.icon);
    }
  });

  it("colours only Dangerous mode icons, leaving Auto neutral", () => {
    const dangerous = modeAppearance(
      selectWith("mode", "mode", "full-access", values("full-access")),
    );
    const auto = modeAppearance(selectWith("mode", "mode", "auto", values("auto")));

    expect(modeIconClass(dangerous)).toContain("rose");
    expect(modeIconClass(auto)).toBe("");
  });

  it("uses display names to distinguish agents that reuse the same wire value", () => {
    const camber = selectWith("mode", "mode", "read-only", [
      { value: "read-only", name: "Always ask" },
    ]);
    const codex = selectWith("mode", "mode", "read-only", [
      { value: "read-only", name: "Read-only" },
    ]);

    expect(modeAppearance(camber)).toMatchObject({ category: "normal", icon: "ask" });
    expect(modeAppearance(codex)).toMatchObject({ category: "restricted", icon: "block" });
  });

  it("gives unknown modes a neutral generic icon without guessing a category", () => {
    const appearance = modeAppearance(
      selectWith("mode", "mode", "something-new", values("something-new")),
    );
    expect(appearance).toEqual({ category: null, icon: "config" });
  });
});

describe("configValueAppearance", () => {
  it("preserves category icons for non-mode config values", () => {
    expect(configValueAppearance(select("model", "model"), "a")).toEqual({
      icon: "sparkles",
      category: null,
    });
  });

  it("pairs the collaboration modes' plan and build glyphs", () => {
    const camber = selectWith("agent_mode", "collaboration_mode", "build", [
      { value: "build", name: "Build" },
      { value: "plan", name: "Plan" },
    ]);
    const codex = selectWith("collaboration_mode", "collaboration_mode", "default", [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ]);

    expect(configValueAppearance(camber, "build")).toEqual({ category: null, icon: "code" });
    expect(configValueAppearance(camber, "plan")).toEqual({ category: "plan", icon: "plan" });
    // Codex's non-plan value shares the permission taxonomy's "default" wire
    // value but means "carry out the work", not "prompt on first use".
    expect(configValueAppearance(codex, "default")).toEqual({ category: null, icon: "code" });
    expect(configValueAppearance(codex, "plan")).toEqual({ category: "plan", icon: "plan" });
  });

  it("leaves unknown collaboration values neutral", () => {
    const option = selectWith("collaboration_mode", "collaboration_mode", "review", [
      { value: "review", name: "Review" },
    ]);
    expect(configValueAppearance(option, "review")).toEqual({ category: null, icon: "config" });
  });
});

describe("effortBars", () => {
  it("separates the default entry as auto and keeps magnitudes as bars", () => {
    const option = selectWith(
      "effort",
      "thought_level",
      "default",
      values("default", "low", "medium", "high", "xhigh", "max"),
    );
    const bars = effortBars(option);
    expect(bars).not.toBeNull();
    expect(bars?.levels.map((l) => l.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(bars?.levels.map((l) => l.name)).toEqual(["Low", "Medium", "High", "Extra High", "Max"]);
    expect(bars?.levels.map((l) => l.filled)).toEqual([1, 2, 3, 4, 5]);
    expect(bars?.total).toBe(5);
    expect(bars?.auto?.value).toBe("default");
    expect(bars?.auto?.name).toBe("Default");
    expect(bars?.isAuto).toBe(true);
    expect(bars?.activeFilled).toBeNull();
  });

  it("locates the active magnitude", () => {
    const option = selectWith(
      "effort",
      "thought_level",
      "high",
      values("default", "low", "medium", "high", "xhigh", "max"),
    );
    expect(effortBars(option)?.activeFilled).toBe(3);
    expect(effortBars(option)?.isAuto).toBe(false);
  });

  it("uses signal bars for Claude models that do not support xhigh", () => {
    const option = selectWith(
      "effort",
      "thought_level",
      "default",
      values("default", "low", "medium", "high", "max"),
    );
    const bars = effortBars(option);
    expect(bars?.levels.map((l) => l.name)).toEqual(["Low", "Medium", "High", "Max"]);
    expect(bars?.levels.map((l) => l.filled)).toEqual([1, 2, 3, 4]);
    expect(bars?.total).toBe(4);
    expect(bars?.auto).toEqual({ value: "default", name: "Default" });
    expect(bars?.isAuto).toBe(true);
  });

  it("sorts levels ascending by depth and gives none zero bars", () => {
    const option = selectWith(
      "thought_level",
      "thought_level",
      "xhigh",
      values("default", "xhigh", "high", "medium", "low", "minimal", "none"),
    );
    const bars = effortBars(option);
    expect(bars?.levels.map((l) => l.value)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // "none" lights zero bars and doesn't count toward the total.
    expect(bars?.levels.map((l) => l.filled)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(bars?.total).toBe(5);
    expect(bars?.activeFilled).toBe(5);
  });

  it("handles a set with no default entry", () => {
    const option = selectWith(
      "reasoning_effort",
      "thought_level",
      "medium",
      values("low", "medium", "high", "xhigh"),
    );
    const bars = effortBars(option);
    expect(bars?.total).toBe(4);
    expect(bars?.levels.map((l) => l.name)).toEqual(["Light", "Medium", "High", "Extra High"]);
    expect(bars?.auto).toBeNull();
    expect(bars?.activeFilled).toBe(2);
    expect(bars?.isAuto).toBe(false);
  });

  it("uses signal bars and the requested labels for current Codex effort options", () => {
    const option = selectWith(
      "reasoning_effort",
      "thought_level",
      "ultra",
      values("low", "medium", "high", "xhigh", "max", "ultra"),
    );
    const bars = effortBars(option);
    expect(bars?.levels.map((l) => l.value)).toEqual(["low", "medium", "high", "xhigh", "ultra"]);
    expect(bars?.levels.map((l) => l.name)).toEqual([
      "Light",
      "Medium",
      "High",
      "Extra High",
      "Ultra",
    ]);
    expect(bars?.levels.map((l) => l.filled)).toEqual([1, 2, 3, 4, 5]);
    expect(bars?.total).toBe(5);
    expect(bars?.activeFilled).toBe(5);
    expect(bars?.activeValue).toBe("ultra");
    expect(effortValueName(option)).toBe("Ultra");
  });

  it("folds a selected Codex max value into the visible Ultra tier", () => {
    const option = selectWith(
      "reasoning_effort",
      "thought_level",
      "max",
      values("low", "medium", "high", "xhigh", "max", "ultra"),
    );
    const bars = effortBars(option);
    expect(bars?.activeFilled).toBe(5);
    expect(bars?.activeValue).toBe("ultra");
    expect(effortValueName(option)).toBe("Ultra");
  });

  it("matches a known range by display names when values are opaque", () => {
    const option = selectWith("effort", "thought_level", "auto", [
      { value: "auto", name: "Automatic" },
      { value: "1", name: "Low" },
      { value: "2", name: "Medium" },
      { value: "3", name: "High" },
      { value: "4", name: "Xhigh" },
    ]);
    const bars = effortBars(option);
    expect(bars?.levels.map((l) => l.name)).toEqual(["Low", "Medium", "High", "Xhigh"]);
    expect(bars?.auto?.value).toBe("auto");
    expect(bars?.isAuto).toBe(true);
  });

  it("returns null when an unrecognized level is present, even next to known ones", () => {
    // A future "superDuperMegaReasoning" level → render the list as given.
    const option = selectWith(
      "effort",
      "thought_level",
      "low",
      values("low", "medium", "high", "xhigh", "superDuperMegaReasoning"),
    );
    expect(effortBars(option)).toBeNull();
  });

  it("returns null when known values don't form a known range", () => {
    // A subset (or superset) of a known range is not a known range.
    expect(
      effortBars(selectWith("effort", "thought_level", "low", values("low", "high"))),
    ).toBeNull();
    expect(
      effortBars(
        selectWith(
          "effort",
          "thought_level",
          "low",
          values("none", "minimal", "low", "medium", "high", "xhigh", "max"),
        ),
      ),
    ).toBeNull();
  });

  it("returns null for non-effort options", () => {
    expect(effortBars(selectWith("model", "model", "a", values("a")))).toBeNull();
  });
});

describe("booleanCurrentValue", () => {
  it("reads the current value of a boolean option", () => {
    expect(booleanCurrentValue(boolean("fast", true))).toBe(true);
    expect(booleanCurrentValue(boolean("fast", false))).toBe(false);
  });

  it("returns false for non-boolean options", () => {
    expect(booleanCurrentValue(select("model", "model"))).toBe(false);
  });
});
