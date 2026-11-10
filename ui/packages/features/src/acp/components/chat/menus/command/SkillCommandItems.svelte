<script lang="ts">
  import * as Prompt from "@camber/components/prompt";
  import type { ServerCommandEntry } from "./serverCommands";
  import { skillInvocation } from "./serverCommands";

  interface Props {
    skills: ServerCommandEntry[];
  }

  let { skills }: Props = $props();

  const { close } = Prompt.getMenus();
</script>

<!-- Keyed by the entry key, not the skill name: agents can expose two skills
     with the same name (e.g. a `configure` from two plugins), and duplicate
     each-keys crash the menu. -->
{#each skills as { command: skill, key } (key)}
  {@const invocation = skillInvocation(skill.name)}
  {@const label = invocation.slice(1)}
  <Prompt.Menu.Popup.Item title={label} subtitle={skill.description} icon="skills">
    <Prompt.Actions.Insert
      type="chip"
      content={{
        label,
        icon: "skills",
        value: invocation,
        clipboard: invocation,
      }}
      onInsert={() => close()}
    />
  </Prompt.Menu.Popup.Item>
{/each}
