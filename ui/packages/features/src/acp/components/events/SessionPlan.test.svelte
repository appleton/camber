<script lang="ts">
  import type { Plan } from "@agentclientprotocol/sdk";
  import { DisplayProvider } from "@camber/components/providers";
  import SessionPlan from "./SessionPlan.svelte";

  interface Props {
    plan: Plan;
    isPrompting?: boolean;
    desktop?: boolean;
  }

  let { plan, isPrompting = false, desktop = false }: Props = $props();
</script>

<DisplayProvider>
  <SessionPlan {plan} {isPrompting} {desktop} />
</DisplayProvider>
