import { TelemetryEventInputEventType } from "@camber/rpc";
import { get } from "svelte/store";
import { getLastMessage, isCurrentConversationAgentic } from "../ConversationManager";
import { rpc } from "../rpc/client";
import type { TelemetryClickEventTarget, TelemetryEventData } from "./events";

export const InteractionType = {
  click: "click",
  keypress: "keypress",
  input: "input",
} as const;

export type InteractionType = (typeof InteractionType)[keyof typeof InteractionType];

export interface InteractionMetadata {
  interaction_type: InteractionType;
  target: string;
  [key: string]: unknown;
}

export interface TrackClickOptions<
  T extends TelemetryClickEventTarget = TelemetryClickEventTarget,
> {
  target: T;
  data?: TelemetryEventData<T> | (() => TelemetryEventData<T>);
}

function reportInteraction(
  type: InteractionType,
  metadata: Omit<InteractionMetadata, "interaction_type">,
): void {
  try {
    const lastMessage = getLastMessage();

    const detailedMetadata = {
      interaction_type: type,
      ...metadata,
      conversation_id: lastMessage?.conversation_id,
      message_id: lastMessage?.id,
      is_agent_mode: get(isCurrentConversationAgentic),
    };

    // non-blocking reporting
    queueMicrotask(() => {
      try {
        rpc.reportEvent(TelemetryEventInputEventType.user_interaction, detailedMetadata);
      } catch (error) {
        console.debug("Failed to report interaction:", error);
      }
    });
  } catch (error) {
    console.debug("Failed to prepare interaction report:", error);
  }
}

export function trackClick<T extends TelemetryClickEventTarget = TelemetryClickEventTarget>(
  node: HTMLElement,
  options: TrackClickOptions<T> | undefined,
) {
  const handleClick = () => {
    if (!options) {
      return;
    }

    const data = typeof options.data === "function" ? options.data() : options.data;

    reportInteraction(InteractionType.click, {
      target: options.target,
      ...data,
    });
  };

  if (options?.target) {
    node.dataset.telemetryTarget = options.target;
  }

  node.addEventListener("click", handleClick);

  return {
    destroy() {
      delete node.dataset.telemetryTarget;
      node.removeEventListener("click", handleClick);
    },
  };
}
