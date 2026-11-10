<script lang="ts">
  import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
  import { onDestroy, untrack } from "svelte";
  import { get } from "svelte/store";
  import { getACPContext } from "../../features/SessionRepository.svelte";
  import { setACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import { setACPHandoffConfirmationContext } from "../../features/HandoffConfirmationContext";
  import { buildSessionInfo } from "../../sessionInfo";
  import { appState } from "../../hostAdapter";
  import type { ACPGoalState } from "../../goals";
  import Prompt from "./Prompt.svelte";

  interface Props {
    goal: ACPGoalState | null;
    width?: string;
    mobile?: boolean;
    visualViewportHeight?: string;
  }

  let { goal, width = "560px", mobile = false, visualViewportHeight = undefined }: Props = $props();

  const initialAppState = get(appState);
  const mobileStory = untrack(() => mobile);
  if (mobileStory) {
    appState.set({
      ...initialAppState,
      environment: { ...initialAppState.environment, assistantHost: "mobile" },
    });
  }
  onDestroy(() => {
    if (mobileStory) appState.set(initialAppState);
  });

  const repo = getACPContext();
  initializeHelperApi({
    jsonrpcCall: async () => ({ entry: null }),
    jsonrpcNotify: async () => {},
  });
  setACPHandoffConfirmationContext({ request: () => {} });
  const conversationId = `storybook-goal-${Math.random().toString(36).slice(2)}`;
  const agentServer = untrack(() => (goal?.source === "claude" ? "claude-acp" : "codex-acp"));
  const session = repo.createSession("/workspace", agentServer, conversationId);
  session.sessionId = "storybook-goal-session";
  session.sessionInfo = buildSessionInfo(session.sessionId, "/workspace", "native_session");
  session.availableCommands = [
    {
      name: "goal",
      description: "Set a goal to keep pursuing",
      input: { hint: "[<objective>|clear|pause|resume]" },
    },
  ];
  setACPChatSessionScope(repo, () => conversationId);

  $effect(() => {
    session.setGoal(goal);
  });
</script>

<div
  class="flex min-h-48 items-end justify-center p-8"
  style:--visual-viewport-height={visualViewportHeight}
>
  <div class="max-w-full" style:width>
    <Prompt desktopFilePromptChipTarget={false} />
  </div>
</div>
