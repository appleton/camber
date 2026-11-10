/// <reference path="../global.d.ts" />

import { warmDiffWorkerPool } from "@camber/components/file-diff";
import { enableAcpTranscriptBatching } from "@camber/features/acp";
export type { MobileCamberQAInstance, MobileCamberQASlot } from "@camber/features/acp";
export { default as ChatOnlyPanel } from "./acp/ChatOnlyPanel.svelte";
export { default as DesktopPanel } from "./acp/DesktopPanel.svelte";
export type { MobileAppearance, MobileThemePreference } from "./acp/mobile/appearance";
export type { MobileHostStatus } from "./acp/mobile/hostStatus";
export type { MobileNavigation, MobileRoute, MobileView } from "./acp/mobile/navigation";
export { default as MobilePanel } from "./acp/MobilePanel.svelte";
export type { TargetProps } from "./acp/runtime/CoreRuntime.svelte";
export { default as SidebarOnlyPanel } from "./acp/SidebarOnlyPanel.svelte";
export type { WebviewRPCListener } from "./lib/rpc";

/**
 * Initialize shared runtime behavior before booting an app surface.
 */
export async function init() {
  enableAcpTranscriptBatching();
  scheduleDiffWorkerPoolWarmup();
}

/**
 * Spawn pierre's highlight workers once the surface has had a chance to
 * paint, so the first file or diff open colorizes without also paying
 * worker startup and shiki init. Idle-scheduled to stay out of the startup
 * path; WebKit lacks requestIdleCallback, hence the timeout fallback.
 */
function scheduleDiffWorkerPoolWarmup() {
  const warm = () => warmDiffWorkerPool();
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(warm);
  } else {
    setTimeout(warm, 2000);
  }
}
