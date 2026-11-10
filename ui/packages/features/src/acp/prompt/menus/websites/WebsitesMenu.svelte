<script lang="ts">
  import { InfoMessageType } from "@camber/rpc";
  import * as Prompt from "@camber/components/prompt";
  import { getItems } from "@camber/components/prompt";
  import type { InsertChipActionProps } from "@camber/components/prompt";
  import { tick } from "svelte";
  import { getContextRepoContext } from "../../../../context";
  import { rpc } from "../../../hostRpc";

  let search = $state<string>("");

  const contextRepo = getContextRepoContext();
  const { selectFirst } = getItems();

  $effect(() => {
    if (!search) return;
    tick().then(() => selectFirst());
  });

  const handleInsert: InsertChipActionProps["onInsert"] = async ({ value }, { undo }) => {
    contextRepo.attachUrl({ status: "loading", url: value });

    try {
      const url = await rpc.getUrlContents(value);
      if (!url) return;

      // URL has been removed by user (e.g. got fed up waiting), don't re-attach
      if (!contextRepo.attachedUrls.find(({ url }) => url === value)) return;

      contextRepo.removeUrl(value);
      contextRepo.attachUrl({ status: "attached", ...url });
    } catch (error) {
      contextRepo.removeUrl(value);
      rpc.showInfoMessage(`Failed to attach "${value}": ${error}`, InfoMessageType.error);
      undo();
    }
  };

  function handleRemove(value: string) {
    contextRepo.removeUrl(value);
  }
</script>

<Prompt.Menu.Popup.Root bind:search>
  <Prompt.Menu.Popup.Header
    title="Add website"
    subtitle="Start typing or paste a URL"
    icon="files"
  />

  {#if search}
    <Prompt.Menu.Popup.Separator alwaysRender />
  {/if}

  <Prompt.Menu.Popup.List>
    {#if search}
      <Prompt.Menu.Popup.Section>
        <Prompt.Menu.Popup.Item title={search}>
          <Prompt.Actions.Insert
            type="chip"
            content={({ queryMatch }) => {
              if (!queryMatch) return;
              const value = queryMatch[1] ? queryMatch[0] : "https://" + queryMatch[0];
              const label = queryMatch[2] + (queryMatch[3] ?? "");
              return {
                icon: "web",
                label,
                value,
                clipboard: `[${label}](${value})`,
              };
            }}
            onInsert={handleInsert}
            onRemove={handleRemove}
          />
        </Prompt.Menu.Popup.Item>
      </Prompt.Menu.Popup.Section>
    {/if}
  </Prompt.Menu.Popup.List>
</Prompt.Menu.Popup.Root>
