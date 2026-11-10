import type { Configuration } from "@camber/rpc";
import { getCamberConfigurationSection } from "./api/configuration";

/**
 * Gets the camber configuration from VSCode and normalizes it.
 */
export function getCamberConfig() {
  const workspaceConfig = getCamberConfigurationSection();
  const config: Configuration = JSON.parse(JSON.stringify(workspaceConfig));

  // The `camber.uri` (Camber API) setting was removed (ACP-chat-only), but
  // the shared `Configuration` type still requires `uri`. Emit a fixed empty
  // value to satisfy the type and downstream consumers.
  config.uri = "";

  return config;
}
