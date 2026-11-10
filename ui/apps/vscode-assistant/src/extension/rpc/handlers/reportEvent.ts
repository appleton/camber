import type { TelemetryEventInputEventType, TelemetryEventInputMetadata } from "@camber/rpc";
import { System } from "../../system";

export function reportEvent(
  system: System,
  event: TelemetryEventInputEventType,
  data: TelemetryEventInputMetadata = {},
) {
  system.telemetry.reportUsage(event, data);
}
