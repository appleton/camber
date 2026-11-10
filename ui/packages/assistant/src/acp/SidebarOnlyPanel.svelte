<script lang="ts">
  import { AcpSidebarChrome } from "@camber/features/acp";

  import RuntimeProviders from "./RuntimeProviders.svelte";
  import { CoreRuntime, type TargetProps } from "./runtime/CoreRuntime.svelte";

  interface Props extends TargetProps {}

  let props: Props = $props();

  const core = new CoreRuntime({ target: "sidebar-only", ...props });
  core.initialize();
</script>

<RuntimeProviders runtime={core}>
  <AcpSidebarChrome />
</RuntimeProviders>
