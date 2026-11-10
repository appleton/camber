<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "@camber/components/button";
  import { Spinner } from "@camber/components/spinner";
  import type { GitHubAuthStatusOutput } from "@camber/helperapi";
  import { getACPGithubRepo } from "../features/GithubRepository.svelte";
  import { GITHUB_COLOR_MODES, type GitHubColorMode } from "../github/githubStatus";
  import SettingsSection from "./settings/SettingsSection.svelte";

  interface Props {
    showHeading?: boolean;
  }

  let { showHeading = true }: Props = $props();

  const github = getACPGithubRepo();

  let status = $state<GitHubAuthStatusOutput | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let tokenInput = $state("");
  let error = $state("");

  async function refresh(): Promise<void> {
    loading = true;
    error = "";
    try {
      status = await github.authStatus();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load GitHub status";
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  async function saveToken(): Promise<void> {
    const token = tokenInput.trim();
    if (!token) return;
    saving = true;
    error = "";
    try {
      await github.setToken(token);
      tokenInput = "";
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save token";
    } finally {
      saving = false;
    }
  }

  async function clearToken(): Promise<void> {
    saving = true;
    error = "";
    try {
      await github.setToken("");
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to remove token";
    } finally {
      saving = false;
    }
  }

  let connected = $derived(status?.source === "cli" || status?.source === "token");

  function selectColorMode(mode: GitHubColorMode): void {
    github.setColorMode(mode);
  }
</script>

{#if showHeading}
  <h2 class="text-psx-foreground-primary px-1 text-sm font-medium">GitHub</h2>
{/if}

<SettingsSection
  title="GitHub Awareness"
  subtitle="Surfaces pull-request status, checks, and comments for your worktrees. Uses the GitHub CLI when available, otherwise a personal access token."
>
  <div class="px-3 pb-3 pt-3">
    <div class="flex items-start gap-2.5">
      <div class="min-w-0 flex-1">
        {#if loading}
          <div class="text-psx-foreground-secondary flex items-center gap-2 text-[13px]/[18px]">
            <span class="flex size-3 shrink-0 items-center justify-center"
              ><Spinner size={12} /></span
            >
            <span>Checking GitHub access…</span>
          </div>
        {:else if status}
          <div class="flex items-center gap-2 text-[13px]/[18px]">
            <span class="flex size-3 shrink-0 items-center justify-center">
              <span
                class={[
                  "size-2 rounded-full",
                  connected ? "bg-psx-diff-insert-foreground" : "bg-psx-foreground-tertiary",
                ]}
                aria-hidden="true"
              ></span>
            </span>
            {#if status.source === "cli"}
              <span>Connected via GitHub CLI{status.login ? ` as ${status.login}` : ""}</span>
            {:else if status.source === "token"}
              <span>Connected with token{status.login ? ` as ${status.login}` : ""}</span>
            {:else}
              <span class="text-psx-foreground-secondary">Not connected</span>
            {/if}
          </div>

          {#if status.source !== "cli"}
            <div class="mt-3">
              {#if status.ghInstalled}
                <p class="text-psx-foreground-secondary text-[13px]/[18px]">
                  Tip: run <code class="bg-psx-menu-hover-background rounded px-1 py-0.5"
                    >gh auth login</code
                  > to use the GitHub CLI instead of a token.
                </p>
              {/if}
              <label class="mt-2 block">
                <span class="text-psx-foreground-primary text-[13px]/[18px] font-medium">
                  Personal access token
                </span>
                <input
                  type="password"
                  bind:value={tokenInput}
                  placeholder={status.hasStoredToken ? "•••••••• (saved)" : "ghp_…"}
                  spellcheck="false"
                  autocorrect="off"
                  autocapitalize="off"
                  autocomplete="off"
                  class="border-psx-input-border bg-psx-input-background text-psx-input-foreground placeholder:text-psx-input-placeholder-foreground focus-visible:outline-psx-focus mt-1 w-full rounded-[6px] border px-2 py-1.5 text-[13px]/[18px] focus-visible:outline-2"
                />
              </label>
              <div class="mt-2 flex items-center gap-2">
                <Button
                  type="button"
                  prominence="increased"
                  size="sm"
                  disabled={saving || !tokenInput.trim()}
                  onclick={saveToken}
                >
                  {saving ? "Saving…" : "Save token"}
                </Button>
                {#if status.hasStoredToken}
                  <Button
                    type="button"
                    appearance="outline"
                    size="sm"
                    disabled={saving}
                    onclick={clearToken}
                  >
                    Remove token
                  </Button>
                {/if}
              </div>
            </div>
          {/if}
        {/if}

        {#if error}
          <p class="text-psx-error-foreground mt-2 text-[13px]/[18px]">{error}</p>
        {/if}
      </div>
    </div>
  </div>
</SettingsSection>

<SettingsSection
  title="Worktree Status Color"
  subtitle="When a worktree's branch icon should turn green."
>
  <div class="flex flex-col gap-1.5 px-3 pb-3 pt-3">
    {#each GITHUB_COLOR_MODES as mode (mode.value)}
      <label class="flex cursor-pointer items-start gap-2 text-[13px]/[18px]">
        <input
          type="radio"
          name="github-color-mode"
          value={mode.value}
          checked={github.colorMode === mode.value}
          onchange={() => selectColorMode(mode.value)}
          class="accent-psx-focus mt-0.5"
        />
        <span class="min-w-0">
          <span class="text-psx-foreground-primary">{mode.label}</span>
          <span class="text-psx-foreground-secondary block">{mode.detail}</span>
        </span>
      </label>
    {/each}
  </div>
</SettingsSection>
