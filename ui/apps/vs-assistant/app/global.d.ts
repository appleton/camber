import type { EnrichedContextSource } from "@camber/rpc";

export default {};

/**
 * global adds a type definition for the window.CAMBER_APP_STATE variable
 * which is injected into the global scope of the webview window on start up.
 */
declare global {
  var CAMBER_INITIAL_STATE: {
    accessToken?: string | undefined;
    keybindings?: Keybindings;
    disabledEnrichments?: EnrichedContextSource[];
    homeDirectory?: string;
  };
}
