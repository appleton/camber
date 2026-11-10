<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { UserMessageBubble } from "@camber/components/assistant-ui";

  const { Story } = defineMeta({
    title: "Components/UserMessageBubble",
    component: UserMessageBubble,
  });
</script>

<Story name="LongMessage">
  This is a very long message that will be truncated when the collapsible prop is enabled. The user
  can click to expand and see the full content. Lorem ipsum dolor sit amet, consectetur adipiscing
  elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,
  quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure
  dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur
  sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est
  laborum. Second paragraph to make it even longer. Sed ut perspiciatis unde omnis iste natus error
  sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo
  inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo
</Story>

<Story
  name="LongMessage: Collapsible"
  args={{
    collapsible: true,
  }}
>
  This is a very long message that will be truncated when the collapsible prop is enabled. The user
  can click to expand and see the full content. Lorem ipsum dolor sit amet, consectetur adipiscing
  elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,
  quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure
  dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur
  sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est
  laborum. Second paragraph to make it even longer. Sed ut perspiciatis unde omnis iste natus error
  sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo
  inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo
</Story>

<!--
  The enqueued (pending-prompt) bubble truncates the same way, but its surface is
  a translucent hover colour composited over the chat background. Painting that
  translucent colour again as the fade darkened the cropped strip instead of
  fading into it, and the darkened strip stopped at the content box, leaving a
  seam against the nubbin (PE-2449).
-->
<Story
  name="LongMessage: Collapsible, enqueued"
  args={{
    collapsible: true,
    variant: "enqueued",
    nubbinPosition: "bottom-right",
  }}
>
  This is a very long message that will be truncated when the collapsible prop is enabled. The user
  can click to expand and see the full content. Lorem ipsum dolor sit amet, consectetur adipiscing
  elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,
  quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure
  dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur
  sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est
  laborum. Second paragraph to make it even longer. Sed ut perspiciatis unde omnis iste natus error
  sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo
  inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo
</Story>

<Story name="ShortMessage">This is a short message</Story>

<Story
  name="Nubbin bottom right"
  args={{
    nubbinPosition: "bottom-right",
  }}
>
  This is a short message
</Story>
