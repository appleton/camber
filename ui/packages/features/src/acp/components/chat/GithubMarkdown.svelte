<script lang="ts">
  import { MarkdownBlock } from "@camber/components/markdown";
  import { getACPGithubRepo } from "../../features/GithubRepository.svelte";
  import { markdownHost } from "../../markdownHost";

  interface Props {
    content: string;
  }

  let { content }: Props = $props();

  const github = getACPGithubRepo();

  // GitHub-hosted images in PR/issue bodies (user-attachments, *.githubusercontent.com)
  // are auth-gated for private repos. The webview has no GitHub session, so it
  // can't load them — we proxy them through the helper into data URIs.
  const IMAGE_URL_RE =
    /https:\/\/(?:github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+|[a-z0-9-]+\.githubusercontent\.com\/[^\s)"'<>]+)/g;

  let resolved = $state<Record<string, string>>({});

  $effect(() => {
    const urls = Array.from(new Set(content.match(IMAGE_URL_RE) ?? []));
    let cancelled = false;
    void (async () => {
      for (const url of urls) {
        if (resolved[url] !== undefined) continue;
        const dataUri = await github.fetchImage(url);
        if (cancelled) return;
        if (dataUri) resolved = { ...resolved, [url]: dataUri };
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  let rendered = $derived(content.replace(IMAGE_URL_RE, (url) => resolved[url] ?? url));
</script>

<MarkdownBlock content={rendered} host={markdownHost} />
