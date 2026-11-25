<script lang="ts">
  import {
    camberAcpNavGetWorktreeBranchPrefix,
    camberAcpNavSetWorktreeBranchPrefix,
  } from "@camber/helperapi";
  import { formatError } from "@camber/lib/errors";
  import { onMount } from "svelte";
  import SettingsSection from "./settings/SettingsSection.svelte";

  type Status = "loading" | "idle" | "saving" | "error";

  // The helper owns the default ("camber/") and validates the prefix with git,
  // so this field only trims, saves on commit, and reports the helper's error.
  let prefix = $state("");
  let savedPrefix = $state("");
  let status = $state<Status>("loading");
  let error = $state<string | null>(null);

  onMount(() => {
    void load();
  });

  async function load() {
    try {
      const result = await camberAcpNavGetWorktreeBranchPrefix();
      prefix = result.prefix;
      savedPrefix = result.prefix;
      status = "idle";
    } catch (loadError) {
      error = formatError(loadError, { prefix: "Failed to load worktree branch prefix" });
      status = "error";
    }
  }

  // A commit made while a save is in flight is remembered and saved once the
  // current save finishes, so it is never dropped or overwritten.
  let commitQueued = false;

  async function persist() {
    prefix = prefix.trim();
    if (status === "loading") return;
    if (status === "saving") {
      commitQueued = true;
      return;
    }
    do {
      commitQueued = false;
      const next = prefix.trim();
      if (next === savedPrefix) {
        error = null;
        status = "idle";
        return;
      }
      status = "saving";
      try {
        const result = await camberAcpNavSetWorktreeBranchPrefix({ prefix: next });
        savedPrefix = result.prefix;
        // Never replace what the user typed after this save started.
        if (prefix.trim() === next) prefix = result.prefix;
        error = null;
        status = "idle";
      } catch (saveError) {
        commitQueued = false;
        error = formatError(saveError);
        status = "error";
        return;
      }
    } while (commitQueued);
  }
</script>

<SettingsSection title="Worktrees">
  <div class="flex flex-col items-start gap-2 px-3 pb-3 pt-3">
    <label class="flex w-full min-w-0 max-w-[360px] flex-col gap-1">
      <span class="text-psx-foreground-primary text-[13px]/[18px]">Worktree branch prefix</span>
      <input
        class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 rounded-[5px] border px-2 font-mono text-[13px]/[18px] outline-none"
        type="text"
        placeholder="No prefix"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        aria-invalid={error ? "true" : undefined}
        bind:value={prefix}
        disabled={status === "loading"}
        onchange={() => void persist()}
        onkeydown={(event) => {
          if (event.key === "Enter") void persist();
        }}
      />
    </label>
    <span class="text-psx-foreground-tertiary text-[11px]/[15px]">
      Prefix for branches created for new worktrees, e.g. camber/. Renaming a worktree renames its
      branch too.
    </span>
    {#if error}
      <span class="text-psx-error-foreground text-[12px]/[16px]" role="alert">{error}</span>
    {/if}
  </div>
</SettingsSection>
