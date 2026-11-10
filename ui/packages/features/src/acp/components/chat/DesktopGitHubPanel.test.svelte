<script lang="ts">
  import { setACPGithubContext } from "../../features/GithubRepository.svelte";
  import DesktopGitHubPanel from "./DesktopGitHubPanel.svelte";

  interface Props {
    worktreePath: string;
    onTitleChange?: (title: string) => void;
  }

  let { worktreePath, onTitleChange }: Props = $props();

  // The real repository is wired here; its prDetail() call goes through the
  // mocked @camber/helperapi binding in the test.
  setACPGithubContext();
</script>

<DesktopGitHubPanel {worktreePath} {onTitleChange} />
