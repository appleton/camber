import {
  init,
  MobilePanel,
  type MobileCamberQAInstance,
  type MobileThemePreference,
} from "@camber/assistant";
import { appState } from "@camber/features/acp";
import {
  adoptHandoffDeviceToken,
  deviceTokenHandoffHash,
  recoverSession,
  RemoteHost,
  type StaleSession,
} from "@camber/remote-client";
import { mount } from "svelte";

import "./app.css";
import { createConnectionPill } from "./connectionPill";
import { createHostStatus } from "./hostStatus.svelte";
import PairScreen from "./PairScreen.svelte";
import { createMobileRouter } from "./router";
import { loadMobileSettings, saveMobileSettings } from "./settings";
import { applyMobileTheme, mobileColorTheme, onSystemThemeChange } from "./theme";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app element");

// Vite's dev client force-reloads the page once its HMR websocket comes back
// ("server connection lost. Polling for restart..." -> location.reload()).
// Served through the helper's dev proxy over Tailscale, that fires on every
// network blip or helper restart and throws away the app state RemoteHost
// just resumed in place. The reload only runs after the client awaits its
// vite:ws:disconnect listeners (Promise.allSettled), so a never-resolving
// listener suppresses it. Cost: after a drop, HMR stays dead until a manual
// refresh — the right trade on a remote device. Dev-only; import.meta.hot is
// undefined in production builds.
if (import.meta.hot) {
  import.meta.hot.on("vite:ws:disconnect", () => new Promise<never>(() => {}));
}

// The service worker caches only content-hashed /assets/* files; index.html
// and /api are deliberately never cached (index.html is served no-store so
// new builds always take effect). Dev serving goes through the Vite dev
// server, which has no /assets — skip registration there.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.warn("service worker registration failed", error);
  });
}

async function authState(): Promise<"ok" | "unauthorized" | "offline"> {
  try {
    const resp = await fetch("/api/me", { credentials: "same-origin" });
    if (resp.ok) return "ok";
    if (resp.status === 401 || resp.status === 403) return "unauthorized";
    return "offline";
  } catch {
    return "offline";
  }
}

function mountPairScreen() {
  mount(PairScreen, {
    target: target!,
    props: {
      onPaired: () => {
        window.location.reload();
      },
    },
  });
}

async function mountApp() {
  let themePreference = loadMobileSettings().theme;
  const resolvedTheme = applyMobileTheme(themePreference);

  const initialState = {
    userSettings: {
      uri: "https://api.poolsi.de",
      themeOverride: null,
      wrapLines: false,
      renderScan: false,
      boolFeatures: {},
      notifyOnApproval: false,
    },
    environment: {
      assistantEnv: import.meta.env.DEV ? ("development" as const) : ("production" as const),
      assistantHost: "mobile",
      assistantHostVersion: "0.1.0",
      assistantVersion: "0.1.0",
      capabilities: {
        header: false,
        fileContext: false,
      },
    },
    colorTheme: mobileColorTheme(resolvedTheme),
    homeDirectory: "",
  };

  // Registered by MobileShell once mounted; re-syncs the conversation list
  // and force-reloads sessions whose live stream could not be resumed.
  let resyncShell: ((staleSessions?: StaleSession[]) => void) | null = null;
  // Registered by MobileShell once mounted; pushes the file viewer page when
  // the shared UI asks the host to open a file (chips, tool cards, links).
  let openFileInShell: ((path: string, line?: number) => void) | null = null;

  // Top-bar identity of the controlled desktop: the name comes from /api/me,
  // the connected flag tracks the socket (immediate, unlike the pill's
  // 10-second grace — a subtle dot can afford to be truthful about blips).
  // On camberqa worktree helpers, /api/me also carries the worktree identity
  // and live slots, shown as the worktree chip and the slot-switch action.
  const hostStatus = createHostStatus();
  void fetch("/api/me", { credentials: "same-origin" })
    .then((resp) => (resp.ok ? resp.json() : null))
    .then(
      (
        body: {
          hostName?: string;
          homeDirectory?: string;
          camberqa?: MobileCamberQAInstance;
        } | null,
      ) => {
        if (body?.hostName) hostStatus.name = body.hostName;
        if (body?.homeDirectory) {
          initialState.homeDirectory = body.homeDirectory;
          appState.update((state) => ({ ...state, homeDirectory: body.homeDirectory ?? "" }));
        }
        // getHandoffHash carries this origin's device token to slot jumps so
        // the target origin signs in without re-pairing (localStorage is
        // per-origin; the shared helper state accepts the token everywhere).
        if (body?.camberqa)
          hostStatus.camberqa = { ...body.camberqa, getHandoffHash: deviceTokenHandoffHash };
      },
    )
    .catch(() => {});

  const connectionPill = createConnectionPill();
  const host = new RemoteHost({
    onStatusChange: (status) => {
      connectionPill(status);
      hostStatus.connected = status === "open";
    },
    onOpenFile: (path, line) => {
      openFileInShell?.(path, line);
    },
    onAuthExpired: () => {
      // Only fires when the device token itself was rejected (revoked):
      // expired session cookies recover silently inside RemoteHost. Reload
      // drops us into the boot path, which lands on the pairing screen.
      window.location.reload();
    },
    onReconnected: (staleSessions) => {
      resyncShell?.(staleSessions);
    },
    onStaleSessions: (staleSessions) => {
      resyncShell?.(staleSessions);
    },
  });

  // Appearance is a mobile-local setting (see settings.ts): persist it here
  // and re-theme in place — CSS token classes for the chrome, plus a fresh
  // syntax color theme pushed into the shared runtime.
  const applyThemePreference = (preference: MobileThemePreference) => {
    themePreference = preference;
    saveMobileSettings({ ...loadMobileSettings(), theme: preference });
    host.setColorTheme(mobileColorTheme(applyMobileTheme(preference)));
  };
  onSystemThemeChange(() => {
    if (themePreference !== "system") return;
    host.setColorTheme(mobileColorTheme(applyMobileTheme("system")));
  });

  // A backgrounded phone is not reading anything: mirror page visibility into
  // the runtime's focus flag so the helper's shared unread tracking treats
  // this device as away (RemoteHost pings the connection on the same signal).
  document.addEventListener("visibilitychange", () => {
    host.setEditorFocused(document.visibilityState === "visible");
  });

  await init();
  mount(MobilePanel, {
    target: target!,
    props: {
      rpcHostRequestHandler: host.handleHostRequest,
      rpcWebViewResponseHandler: host.webviewResponseHandler,
      webviewRpcListener: host.webviewRpcListener,
      initialState,
      navigation: createMobileRouter(),
      hostStatus,
      appearance: {
        theme: themePreference,
        onThemeChange: applyThemePreference,
      },
      registerResync: (resync: (staleSessions?: StaleSession[]) => void) => {
        resyncShell = resync;
      },
      registerOpenFile: (open: (path: string, line?: number) => void) => {
        openFileInShell = open;
      },
    },
  });
}

void (async () => {
  // A slot jump from another worktree's mobile app hands its device token
  // over in the URL fragment; adopt it before the auth check so the recovery
  // path below can mint a session with it instead of showing the pair screen.
  adoptHandoffDeviceToken();
  let state = await authState();
  if (state === "unauthorized") {
    const recovery = await recoverSession();
    if (recovery.status === "recovered") {
      state = "ok";
    } else if (recovery.status === "unavailable") {
      // Network trouble mid-recovery, not a rejected device token: treat it
      // like "offline" and mount the app — RemoteHost re-attempts recovery in
      // place. Dropping to the pairing screen here would ask the user to
      // re-pair over a connection blip.
      state = "offline";
    }
  }
  if (state === "unauthorized") {
    mountPairScreen();
    return;
  }
  // "offline" mounts the app too: the cookie may be perfectly valid and the
  // socket layer owns reconnection (with its status pill). Showing the
  // pairing screen during a network blip would be wrong on both counts.
  await mountApp();
})();
