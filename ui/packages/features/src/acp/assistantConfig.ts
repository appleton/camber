import { get } from "svelte/store";
import { appState, isSplitACPHost } from "./hostAdapter";
import { rpc, type RPCClient } from "./hostRpc";

export const ASSISTANT_CONFIG_DISPLAY_PATH = "~/.config/camber/assistant.json";

type DesktopSettings = { fileOpenerId?: string };
type DesktopConfigRPC = RPCClient & {
  getDesktopSettings(): Promise<DesktopSettings>;
  openAssistantConfigWithOpener(openerId: string): Promise<void>;
};

const desktopRpc = rpc as DesktopConfigRPC;

export function canOpenAssistantConfigFile(assistantHost: string | undefined): boolean {
  return assistantHost === "desktop" || isSplitACPHost(assistantHost);
}

export async function openAssistantConfigFile(): Promise<void> {
  const state = get(appState);
  if (isSplitACPHost(state.environment.assistantHost)) {
    if (!state.homeDirectory) {
      throw new Error("Camber could not determine the location of assistant.json");
    }
    await rpc.openFile(`${state.homeDirectory}/.config/camber/assistant.json`);
    return;
  }

  if (state.environment.assistantHost !== "desktop") {
    throw new Error("Opening assistant.json is unavailable on this device");
  }

  const settings = await desktopRpc.getDesktopSettings().catch(() => undefined);
  const openerId = settings?.fileOpenerId ?? state.environment.desktopFileOpenerId ?? "default";
  await desktopRpc.openAssistantConfigWithOpener(openerId);
}
