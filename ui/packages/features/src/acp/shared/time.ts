import {
  formatRelativeTime as baseFormatRelativeTime,
  sleep,
  withTimeout,
} from "@camber/components/assistant-ui";

export { sleep, withTimeout };

export function formatRelativeTimeWithoutAgo(
  timestamp: Parameters<typeof baseFormatRelativeTime>[0],
): string {
  return baseFormatRelativeTime(timestamp).replace(/\s+ago$/i, "");
}
