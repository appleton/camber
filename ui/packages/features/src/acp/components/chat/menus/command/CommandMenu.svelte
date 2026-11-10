<script lang="ts">
  import type { AvailableCommand, SessionConfigOption } from "@agentclientprotocol/sdk";
  import * as Prompt from "@camber/components/prompt";
  import Kbd from "@camber/components/kbd";
  import { shortcutHint } from "../../../../../keybindings";
  import { getACPChatSessionScope } from "../../../../features/ChatSessionScope.svelte";
  import { menus } from "../../../../prompt/menus/menus";
  import { getACPAgentRegistryRepo } from "../../../../features/AgentRegistryRepository.svelte";
  import { agentName, selectedAgentServer } from "../config/agentConfig";
  import { DEFAULT_AGENT_SERVER } from "../../../../agentServers";
  import type { AcpSlashCommand } from "./commands";
  import { AcpSlashCommand as LocalCommand } from "./commands";
  import {
    configIcon,
    configValueAppearance,
    promptConfigKind,
    selectedValueName,
  } from "../config/configOptions";
  import {
    AGENT_CONFIG_OPTION_ID,
    AGENT_CONFIG_OPTION_LABEL,
    configMenuValue,
    isAgentPickerOptionId,
  } from "../menus";
  import {
    isSkillCommand,
    resolvedSkillCommands,
    visibleServerCommandEntries,
  } from "./serverCommands";
  import SkillCommandItems from "./SkillCommandItems.svelte";
  import type { Snippet } from "svelte";
  import { slashCommandIcon } from "../../goalPresentation";

  interface Props {
    onCommand?: (command: AcpSlashCommand) => void;
    promptCommandItems?: Snippet;
    fallbackSkills?: AvailableCommand[];
  }

  let { onCommand, promptCommandItems, fallbackSkills = [] }: Props = $props();

  const registry = getACPAgentRegistryRepo();
  const chatSession = getACPChatSessionScope();
  const { close, search } = Prompt.getMenus();

  type SelectSessionConfigOption = SessionConfigOption & {
    type: "select";
    currentValue: string;
  };

  type BooleanSessionConfigOption = SessionConfigOption & {
    type: "boolean";
    currentValue: boolean;
  };

  const selectOptions = $derived(
    chatSession.configOptions.filter(
      (option): option is SelectSessionConfigOption => option.type === "select",
    ),
  );
  // A build/plan switch is driven locally: the synthetic /plan toggles both
  // ways instantly, while an agent's own plan command needs a prompt round
  // trip (and Codex's only turns plan on). Agents offering more collaboration
  // modes keep their own command and get the picker instead.
  const planIsLocal = $derived(
    chatSession.canTogglePlanMode && chatSession.collaborationModeSurface === "plan-toggle",
  );
  // A build/plan switch is deliberately absent from the config rows: /plan and
  // the plan chip are its whole surface, so a row would only duplicate them. A
  // richer collaboration option is listed like any other config.
  const nonAgentSelectOptions = $derived(
    selectOptions.filter(
      (option) =>
        !isAgentPickerOptionId(option.id) &&
        !(planIsLocal && promptConfigKind(option) === "collaboration"),
    ),
  );
  const booleanOptions = $derived(
    chatSession.configOptions.filter(
      (option): option is BooleanSessionConfigOption => option.type === "boolean",
    ),
  );

  function booleanSubtitle(option: BooleanSessionConfigOption): string {
    const pending = chatSession.pendingConfigOption(option.id);
    if (pending && !pending.error) {
      return pending.value === "true" ? "Turning on..." : "Turning off...";
    }
    return option.currentValue ? "On" : "Off";
  }

  async function toggleBoolean(option: BooleanSessionConfigOption): Promise<void> {
    try {
      await chatSession.setBooleanConfigOption(option.id, !option.currentValue);
    } catch (error) {
      console.error("Failed to set ACP session config option", error);
    }
  }

  const skillCommands = $derived(
    visibleServerCommandEntries(
      resolvedSkillCommands(chatSession.availableCommands, fallbackSkills),
      $search,
    ),
  );
  const otherCommands = $derived(
    chatSession.availableCommands.filter(
      (command) => !isSkillCommand(command) && !(planIsLocal && command.name === "plan"),
    ),
  );
  const visibleCommandEntries = $derived(visibleServerCommandEntries(otherCommands, $search));
  const isCamberServer = $derived(selectedAgentServer(chatSession) === DEFAULT_AGENT_SERVER);

  // When the agent publishes its own "plan" command it shows up in the
  // Commands section, so the local plan/build toggle would list "plan" twice.
  const hasServerPlanCommand = $derived(
    chatSession.availableCommands.some((command) => command.name === "plan"),
  );

  function configSubtitle(option: SelectSessionConfigOption): string {
    const pending = chatSession.pendingConfigOption(option.id);
    if (!pending) return selectedValueName(option);
    const target = selectedValueName({ ...option, currentValue: pending.value });
    if (pending.error) return `Failed to switch to ${target}`;
    return `Switching to ${target}...`;
  }

  function commandSubtitle(command: AvailableCommand): string {
    if (command.name !== "goal" || !chatSession.goal) return command.description;
    const status = {
      active: "Active",
      paused: "Paused",
      blocked: "Blocked",
      usageLimited: "Usage limited",
      budgetLimited: "Budget limited",
      complete: "Complete",
    }[chatSession.goal.status];
    return `${status}: ${chatSession.goal.objective}`;
  }
</script>

<Prompt.Menu.Popup.Root>
  <Prompt.Menu.Popup.List>
    <Prompt.Menu.Popup.Empty title="No matching commands" icon="slash" />

    <Prompt.Menu.Popup.Section>
      <Prompt.Menu.Popup.Item
        title="new"
        subtitle="Start a new conversation"
        icon="new"
        keywords={["clear", "done"]}
      >
        <Prompt.Actions.Clear onClear={() => onCommand?.(LocalCommand.new)} />
      </Prompt.Menu.Popup.Item>

      <Prompt.Menu.Popup.Item
        title="dump"
        subtitle="Save raw ACP messages as Pool-compatible JSON"
        icon="debug"
        keywords={["debug", "json", "acp"]}
      >
        <Prompt.Actions.Action onAction={() => onCommand?.(LocalCommand.dump)} />
      </Prompt.Menu.Popup.Item>

      <Prompt.Menu.Popup.Item
        title="load"
        subtitle="Load a Pool-compatible ACP JSON dump"
        icon="file"
        keywords={["debug", "json", "acp"]}
      >
        <Prompt.Actions.Action onAction={() => onCommand?.(LocalCommand.load)} />
      </Prompt.Menu.Popup.Item>
    </Prompt.Menu.Popup.Section>

    <Prompt.Menu.Popup.Separator />

    <Prompt.Menu.Popup.Section title="Config">
      {#if chatSession.isPreparingSessionOptions || chatSession.isConfigCacheLoading}
        <Prompt.Menu.Popup.Item title="Loading session options" icon="loading" disabled />
      {/if}

      <Prompt.Menu.Popup.Item
        title={AGENT_CONFIG_OPTION_LABEL}
        subtitle={agentName(registry, selectedAgentServer(chatSession))}
        icon="sparkles"
        keywords={["agent", "agents"]}
        disabled={!chatSession.canChangeAgent}
      >
        <Prompt.Actions.Push
          menu={configMenuValue(AGENT_CONFIG_OPTION_ID)}
          completion={AGENT_CONFIG_OPTION_LABEL}
        />
      </Prompt.Menu.Popup.Item>

      {#if planIsLocal || (chatSession.canTogglePlanMode && !hasServerPlanCommand)}
        {@const planModeHint = shortcutHint("togglePlanMode")}
        {#snippet planModeAccessories()}
          <Kbd label={planModeHint ?? ""} aria-hidden="true" />
        {/snippet}
        <!-- Where /plan is the only way in and out of plan mode, the command
             keeps that name in both states so typing it always matches; it
             reads as a toggle. Agents with a mode (or collaboration) picker
             keep the plan/build rename their users know. -->
        <Prompt.Menu.Popup.Item
          title={chatSession.isPlanModeActive && !planIsLocal ? "build" : "plan"}
          subtitle={chatSession.isPlanModeActive
            ? planIsLocal
              ? "Exit plan mode"
              : "Switch to build mode"
            : "Switch to plan mode"}
          icon={chatSession.isPlanModeActive ? "code" : "plan"}
          keywords={["mode"]}
          accessories={planModeHint ? planModeAccessories : undefined}
        >
          <Prompt.Actions.Action onAction={() => onCommand?.(LocalCommand.plan)} />
        </Prompt.Menu.Popup.Item>
      {/if}

      {#each nonAgentSelectOptions as option (option.id)}
        {@const appearance = configValueAppearance(option, option.currentValue)}
        <Prompt.Menu.Popup.Item
          title={option.id}
          subtitle={configSubtitle(option)}
          icon={appearance.icon}
          keywords={[option.name]}
        >
          <Prompt.Actions.Push menu={configMenuValue(option.id)} completion={option.id} />
        </Prompt.Menu.Popup.Item>
      {/each}

      {#each booleanOptions as option (option.id)}
        <Prompt.Menu.Popup.Item
          title={option.id}
          subtitle={booleanSubtitle(option)}
          icon={configIcon(option)}
          keywords={[option.name]}
        >
          <Prompt.Actions.Action onAction={() => void toggleBoolean(option)} />
        </Prompt.Menu.Popup.Item>
      {/each}

      {#if isCamberServer}
        <Prompt.Menu.Popup.Item
          title="secrets"
          subtitle="Create or delete secrets, and control which the agent can use"
          icon="key"
          keywords={["secret", "secrets"]}
        >
          <Prompt.Actions.Push
            menu={menus.secrets.value}
            onPush={() => onCommand?.(LocalCommand.secrets)}
          />
        </Prompt.Menu.Popup.Item>
      {/if}

      {@render promptCommandItems?.()}
    </Prompt.Menu.Popup.Section>

    {#if skillCommands.length > 0}
      <Prompt.Menu.Popup.Separator />
      <Prompt.Menu.Popup.Section title="Skills">
        <SkillCommandItems skills={skillCommands} />
      </Prompt.Menu.Popup.Section>
    {/if}

    {#if visibleCommandEntries.length > 0}
      <Prompt.Menu.Popup.Separator />
      <Prompt.Menu.Popup.Section title="Commands">
        {#each visibleCommandEntries as { command, key } (key)}
          {@const commandName = command.name}
          <Prompt.Menu.Popup.Item
            title={commandName}
            subtitle={commandSubtitle(command)}
            icon={slashCommandIcon(commandName)}
          >
            <Prompt.Actions.Insert
              type="chip"
              content={{
                label: commandName,
                icon: slashCommandIcon(commandName),
                value: commandName,
                clipboard: `/${commandName}`,
              }}
              onInsert={() => close()}
            />
          </Prompt.Menu.Popup.Item>
        {/each}
      </Prompt.Menu.Popup.Section>
    {/if}
  </Prompt.Menu.Popup.List>
</Prompt.Menu.Popup.Root>
