<script lang="ts">
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import * as Prompt from "@camber/components/prompt";
  import Icon from "@camber/components/icon";
  import { getACPAgentRegistryRepo } from "../../../../features/AgentRegistryRepository.svelte";
  import { getACPAgentServersRepo } from "../../../../features/AgentServersRepository.svelte";
  import { getACPSessionRepo } from "../../../../features/SessionRepository.svelte";
  import { getACPChatSessionScope } from "../../../../features/ChatSessionScope.svelte";
  import { appState, resolveSessionCwd } from "../../../../hostAdapter";
  import RegistryAgentIcon from "../../../RegistryAgentIcon.svelte";
  import {
    agentName,
    agentPickerIconProps,
    agentPickerIconUrl,
    agentServerOptions,
    selectedAgentServer,
    shouldResetSessionForAgentSelection,
  } from "./agentConfig";
  import {
    configIcon,
    configValueAppearance,
    modeIconClass,
    optionGroups,
    shouldPersistConfigSelection,
    valueDescription,
    type SelectOptionGroup,
  } from "./configOptions";
  import {
    AGENT_CONFIG_OPTION_ID,
    AGENT_CONFIG_OPTION_LABEL,
    configMenuValue,
    isAgentPickerOptionId,
  } from "../menus";
  import { Badge } from "@camber/components/badge";
  import DefaultStarButton from "./DefaultStarButton.svelte";

  interface Props {
    onConfigureAgents?: () => void;
  }

  let { onConfigureAgents }: Props = $props();

  const registry = getACPAgentRegistryRepo();
  const agentServers = getACPAgentServersRepo();
  const repo = getACPSessionRepo();
  const chatSession = getACPChatSessionScope();

  // The collaboration option keeps its (unlisted) value menu even though the
  // command menu hides its row: typing its exact id still opens the picker,
  // and the typed-command handler in Prompt relies on the registration.
  const selectOptions = $derived(
    chatSession.configOptions.filter(
      (option) => option.type === "select" && !isAgentPickerOptionId(option.id),
    ),
  );
  const configureAgentsTitle = $derived(
    $appState.environment.assistantHost === "desktop" ? "Settings" : "Configure Agents",
  );
  const agentMenuValue = configMenuValue(AGENT_CONFIG_OPTION_ID);

  async function handleAgentSelect(agentServer: string): Promise<void> {
    if (shouldResetSessionForAgentSelection(chatSession, agentServer)) {
      rememberLastUsedAgent(agentServer);
      chatSession.createSession(
        chatSession.pendingSessionCwd ?? resolveSessionCwd($appState),
        agentServer,
        chatSession.pendingConversationId,
      );
    }
  }

  // An explicit agent pick becomes the remembered agent for the next new
  // conversation. Fire-and-forget: persistence must never block or break the
  // selection itself. Same-value writes are skipped, and a pinned default
  // agent is never followed — the pin fixes the default deliberately.
  function rememberLastUsedAgent(agentServer: string): void {
    if (repo.agents.defaultAgentServerPinned) return;
    if (agentServer === repo.agents.defaultAgentServer) return;
    void agentServers.setDefaultAgentServer(agentServer).catch((error: unknown) => {
      console.error("Failed to remember last-used ACP agent", error);
    });
  }

  async function handleConfigSelect(optionId: string, value: string): Promise<void> {
    try {
      await chatSession.setConfigOption(optionId, value);
    } catch (error) {
      console.error("Failed to set ACP session config option", error);
    }
  }

  // --- pinned defaults (the star buttons) -------------------------------------
  // A pressed star means PINNED: clicking an unpressed star pins the row's
  // value as the fixed default, clicking the pressed star unpins it (the
  // value stays but resumes following last use).

  function isPinnedDefaultAgent(agentServer: string): boolean {
    return repo.agents.defaultAgentServerPinned && agentServer === repo.agents.defaultAgentServer;
  }

  async function handleAgentStar(agentServer: string, pinned: boolean): Promise<void> {
    try {
      if (pinned) await agentServers.setPinnedDefaultAgentServer(agentServer);
      else await agentServers.unpinDefaultAgentServer();
    } catch (error) {
      console.error("Failed to update pinned default ACP agent", error);
    }
  }

  function isPinnedDefault(optionId: string, value: string): boolean {
    const agentServer = selectedAgentServer(chatSession);
    return (
      repo.agents.isPinnedConfigOption(agentServer, optionId) &&
      repo.agents.defaultConfigOptionsFor(agentServer)[optionId] === value
    );
  }

  async function handleConfigStar(
    option: SessionConfigOption,
    value: string,
    pinned: boolean,
  ): Promise<void> {
    try {
      if (pinned) {
        await repo.agents.setPinnedDefaultConfigOption(
          selectedAgentServer(chatSession),
          option.id,
          value,
        );
      } else {
        await repo.agents.unpinDefaultConfigOption(selectedAgentServer(chatSession), option.id, {
          // Follow-managed options (model/effort/fast and the other
          // persistable categories) keep their value on unpin — the
          // last-used auto-follow overwrites it. For anything else the
          // follow never writes the key, yet applyDefaultConfigOptions would
          // keep seeding every new session with it — an invisible default
          // with no UI left to clear — so the unpin removes the stored value
          // too.
          clearValue: !shouldPersistConfigSelection(option),
        });
      }
    } catch (error) {
      console.error("Failed to update pinned ACP config option", error);
    }
  }

  function valueKeywords(optionId: string, optionName: string, group: SelectOptionGroup): string[] {
    return [optionId, optionName, group.name].filter((v): v is string => Boolean(v));
  }
</script>

<Prompt.Menu.Root value={agentMenuValue}>
  <Prompt.Menu.Popup.Root>
    <Prompt.Menu.Popup.List>
      <Prompt.Menu.Popup.Empty title="No matching agents" icon="sparkles" />

      <Prompt.Menu.Popup.Section>
        {#each agentServerOptions(repo) as agentServer (agentServer)}
          {@const isSelected = agentServer === selectedAgentServer(chatSession)}
          {@const agentPinned = isPinnedDefaultAgent(agentServer)}
          {@const iconUrl = agentPickerIconUrl(registry, agentServer)}
          {#snippet agentIcon()}
            <RegistryAgentIcon
              {iconUrl}
              fallback="sparkles"
              size={16}
              {...agentPickerIconProps(registry, agentServer)}
            />
          {/snippet}
          {#snippet accessories()}
            <DefaultStarButton
              label="Use {agentName(registry, agentServer)} by default"
              pressed={agentPinned}
              onPress={() => void handleAgentStar(agentServer, !agentPinned)}
            />
            {#if isSelected}
              <Badge class="uppercase">Selected</Badge>
            {/if}
          {/snippet}
          <Prompt.Menu.Popup.Item
            title={agentName(registry, agentServer)}
            keywords={[AGENT_CONFIG_OPTION_LABEL, "agents", agentServer]}
            icon={agentIcon}
            class="group"
            {accessories}
          >
            <Prompt.Actions.Action
              onAction={() => {
                void handleAgentSelect(agentServer);
              }}
            />
          </Prompt.Menu.Popup.Item>
        {/each}
      </Prompt.Menu.Popup.Section>

      <Prompt.Menu.Popup.Separator />

      <Prompt.Menu.Popup.Section>
        <Prompt.Menu.Popup.Item
          title={configureAgentsTitle}
          icon="gear"
          keywords={[AGENT_CONFIG_OPTION_LABEL, "agents", "configure", "settings"]}
        >
          <Prompt.Actions.Action
            onAction={() => {
              onConfigureAgents?.();
            }}
          />
        </Prompt.Menu.Popup.Item>
      </Prompt.Menu.Popup.Section>
    </Prompt.Menu.Popup.List>
  </Prompt.Menu.Popup.Root>
</Prompt.Menu.Root>

{#each selectOptions as option (option.id)}
  <Prompt.Menu.Root value={configMenuValue(option.id)}>
    <Prompt.Menu.Popup.Root>
      <Prompt.Menu.Popup.List>
        <Prompt.Menu.Popup.Empty title="No matching options" icon={configIcon(option)} />

        {#each optionGroups(option) as group, groupIndex (group.name ?? `_${groupIndex}`)}
          <Prompt.Menu.Popup.Section title={group.name}>
            {#each group.options as value (value.value)}
              {@const appearance = configValueAppearance(option, value.value)}
              {@const isSelected = value.value === option.currentValue}
              {@const pinned = isPinnedDefault(option.id, value.value)}
              {@const pending = chatSession.pendingConfigOption(option.id)}
              {@const isPending = pending?.value === value.value && !pending.error}
              {@const isFailed = pending?.value === value.value && pending.error}
              {#snippet accessories()}
                <DefaultStarButton
                  label="Use {value.name} by default"
                  pressed={pinned}
                  onPress={() => void handleConfigStar(option, value.value, !pinned)}
                />
                {#if isSelected}
                  <Badge class="uppercase">Selected</Badge>
                {:else if isPending}
                  <Badge class="uppercase">Switching</Badge>
                {:else if isFailed}
                  <Badge class="uppercase">Failed</Badge>
                {/if}
              {/snippet}
              {#snippet valueIcon()}
                <Icon
                  name={appearance.icon}
                  size={16}
                  class={modeIconClass(appearance)}
                  aria-hidden="true"
                />
              {/snippet}
              <!-- The section header already names the group, so the agent's
                   own description of the value is the more useful subtitle. -->
              <Prompt.Menu.Popup.Item
                title={value.name}
                subtitle={valueDescription(value) ?? group.name}
                icon={valueIcon}
                keywords={valueKeywords(option.id, option.name, group)}
                class="group"
                {accessories}
              >
                <Prompt.Actions.Action
                  onAction={() => {
                    void handleConfigSelect(option.id, value.value);
                  }}
                />
              </Prompt.Menu.Popup.Item>
            {/each}
          </Prompt.Menu.Popup.Section>
        {/each}
      </Prompt.Menu.Popup.List>
    </Prompt.Menu.Popup.Root>
  </Prompt.Menu.Root>
{/each}
