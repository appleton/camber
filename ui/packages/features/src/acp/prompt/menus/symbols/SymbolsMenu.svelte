<script lang="ts">
  import type { CodeSymbol } from "@camber/rpc";
  import type { IconName } from "@camber/components/icon";
  import * as Prompt from "@camber/components/prompt";
  import { getContextRepoContext } from "../../../../context";
  import { getFilenameFromPath } from "../../../shared/paths";
  import { rpc } from "../../../hostRpc";

  let search = $state("");

  function getIcon(kind: CodeSymbol["kind"]) {
    return `symbol-${kind}` satisfies IconName;
  }

  const contextRepo = getContextRepoContext();
  let files = $derived(contextRepo.symbolsFiles);
  let fileLabel = $derived(
    files.length === 1 ? getFilenameFromPath(files[0]?.path ?? "") : "active files",
  );
  let getAllCodeSymbols = $derived(
    Promise.all(
      files.map(async (file) => ({
        file,
        symbols: (await rpc.getCodeSymbols(file.path)).symbols,
      })),
    ),
  );
</script>

{#if contextRepo.hasSymbolsMenu}
  <Prompt.Menu.Popup.Root bind:search>
    {#if !search}
      <Prompt.Menu.Popup.Header title="Add symbols" icon="symbols">
        {#snippet subtitle()}
          <span class="truncate">
            Type to filter symbols in <span class="font-medium">{fileLabel}</span>
          </span>
        {/snippet}
      </Prompt.Menu.Popup.Header>
      <Prompt.Menu.Popup.Separator />
    {/if}
    {#await getAllCodeSymbols then fileSymbols}
      <Prompt.Menu.Popup.List class="max-h-64">
        <Prompt.Menu.Popup.Empty icon="symbols">
          <span>
            No matching symbols in <span class="text-psx-foreground-primary font-medium"
              >{fileLabel}</span
            >
          </span>
        </Prompt.Menu.Popup.Empty>

        {#each fileSymbols as { file, symbols } (file.path)}
          {#if symbols.length > 0 && file.path}
            <Prompt.Menu.Popup.Section title={getFilenameFromPath(file.path)}>
              {#each symbols as { name, kind } (`${file.path}:${name}`)}
                {@const icon = getIcon(kind)}
                <Prompt.Menu.Popup.Item title={name} {icon} class="font-mono text-xs">
                  <Prompt.Actions.Insert
                    type="chip"
                    content={{
                      label: name,
                      icon,
                      clipboard: `\`${name}\``,
                    }}
                  />
                </Prompt.Menu.Popup.Item>
              {/each}
            </Prompt.Menu.Popup.Section>
          {/if}
        {/each}
      </Prompt.Menu.Popup.List>
    {/await}
  </Prompt.Menu.Popup.Root>
{/if}
