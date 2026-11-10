<script lang="ts">
  import { memoizedHighlight } from "@camber/components/assistant-ui";

  interface Props {
    text: string;
    /** Fence language for highlighting; omit to render escaped plain text. */
    lang?: string;
  }

  let { text, lang }: Props = $props();

  // Paint plain text immediately, then swap in the highlighted HTML once the
  // grammar resolves (the same escape-then-replace approach HighlightedCode
  // uses), so streaming updates never wait on shiki.
  let highlighted = $state<string>();
  $effect(() => {
    const source = text;
    const language = lang;
    highlighted = undefined;
    if (!language) return;
    void memoizedHighlight(source, language).then((html) => {
      if (source !== text || language !== lang) return;
      highlighted = html;
    });
  });
</script>

<pre
  class="whitespace-pre-wrap break-all">{#if highlighted !== undefined}{@html highlighted}{:else}{text}{/if}</pre>
