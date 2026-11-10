<script lang="ts">
  import type { AvailableCommand } from "@agentclientprotocol/sdk";
  import * as Prompt from "@camber/components/prompt";
  import { getACPChatSessionScope } from "../../../../features/ChatSessionScope.svelte";
  import { resolvedSkillCommands, visibleServerCommandEntries } from "./serverCommands";
  import SkillCommandItems from "./SkillCommandItems.svelte";

  interface Props {
    fallbackSkills?: AvailableCommand[];
  }

  let { fallbackSkills = [] }: Props = $props();

  const chatSession = getACPChatSessionScope();
  const { search } = Prompt.getMenus();

  const skills = $derived(
    visibleServerCommandEntries(
      resolvedSkillCommands(chatSession.availableCommands, fallbackSkills),
      $search,
    ),
  );
</script>

<Prompt.Menu.Popup.Root>
  <Prompt.Menu.Popup.List>
    <Prompt.Menu.Popup.Empty title="No skills available" icon="skills" />
    <Prompt.Menu.Popup.Section title="Skills">
      <SkillCommandItems {skills} />
    </Prompt.Menu.Popup.Section>
  </Prompt.Menu.Popup.List>
</Prompt.Menu.Popup.Root>
