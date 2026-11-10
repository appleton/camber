<script lang="ts">
  import { onMount } from "svelte";
  import { appState } from "../../hostAdapter";
  import { rpc, type RPCClient } from "../../hostRpc";
  import DesktopOpenTargetButton, {
    type DesktopTargetOpener,
  } from "./DesktopOpenTargetButton.svelte";

  interface DesktopSettings {
    fileOpenerId: string;
    fileOpeners: DesktopTargetOpener[];
    desktopOpeners?: DesktopTargetOpener[];
  }

  type DesktopOpenRPC = RPCClient & {
    openPathWithOpener(path: string, openerId: string): Promise<void>;
    getDesktopSettings(): Promise<DesktopSettings>;
  };

  interface Props {
    compact?: boolean;
    hasDesktopInstanceColor?: boolean;
    targetKind?: "project" | "worktree";
    targetPath?: string;
  }

  let {
    compact = false,
    hasDesktopInstanceColor = false,
    targetKind = "project",
    targetPath,
  }: Props = $props();

  const desktopRpc = rpc as DesktopOpenRPC;
  const DESKTOP_SETTINGS_CHANGED_EVENT = "camber:desktop-settings-changed";
  const DESKTOP_OPEN_TARGET_OPENER_STORAGE_KEY = "camber:desktop-open-target-opener-id";
  const initialDesktopOpeners = $appState.environment.desktopOpeners;
  const normalizedInitialDesktopOpeners = Array.isArray(initialDesktopOpeners)
    ? (initialDesktopOpeners as DesktopTargetOpener[])
    : [];
  const initialDesktopFileOpenerId =
    typeof $appState.environment.desktopFileOpenerId === "string"
      ? $appState.environment.desktopFileOpenerId
      : "default";
  const initialOpenTargetOpenerId = readStoredOpenTargetOpenerId();
  let desktopOpeners = $state<DesktopTargetOpener[]>(normalizedInitialDesktopOpeners);
  let storedOpenTargetOpenerId = $state(initialOpenTargetOpenerId);
  let desktopFileOpenerId = $state(
    resolveOpenTargetOpenerId(
      initialDesktopFileOpenerId,
      normalizedInitialDesktopOpeners,
      initialOpenTargetOpenerId,
    ),
  );
  let isDesktop = $derived($appState.environment.assistantHost === "desktop");
  let disabled = $derived(!targetPath || desktopOpeners.length === 0);

  onMount(() => {
    if (!isDesktop) return;

    // The environment snapshot is captured at startup. Re-read persisted
    // settings on mount so the picker reflects changes made in preferences.
    void desktopRpc
      .getDesktopSettings()
      .then((settings) => {
        if (settings) applyDesktopSettings(settings);
      })
      .catch((error) => console.debug("Unable to load desktop settings", error));

    const onSettingsChanged = (event: Event) => {
      applyDesktopSettings((event as CustomEvent<DesktopSettings>).detail);
    };
    window.addEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => window.removeEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
  });

  function applyDesktopSettings(settings: DesktopSettings) {
    const nextOpeners = settings.desktopOpeners ?? settings.fileOpeners;
    desktopOpeners = nextOpeners;
    desktopFileOpenerId = resolveOpenTargetOpenerId(
      settings.fileOpenerId,
      nextOpeners,
      storedOpenTargetOpenerId,
    );
  }

  function openDesktopTarget(opener: DesktopTargetOpener) {
    if (!targetPath) return;
    desktopFileOpenerId = opener.id;
    storedOpenTargetOpenerId = opener.id;
    storeOpenTargetOpenerId(opener.id);
    void desktopRpc.openPathWithOpener(targetPath, opener.id).catch((error) => {
      console.debug("Unable to open desktop path", error);
    });
  }

  function resolveOpenTargetOpenerId(
    fallbackOpenerId: string,
    openers: DesktopTargetOpener[],
    storedOpenerId: string | null,
  ) {
    if (storedOpenerId && hasOpener(openers, storedOpenerId)) return storedOpenerId;
    if (storedOpenerId) {
      storedOpenTargetOpenerId = null;
      clearStoredOpenTargetOpenerId();
    }
    if (hasOpener(openers, fallbackOpenerId)) return fallbackOpenerId;
    return openers[0]?.id ?? fallbackOpenerId ?? "default";
  }

  function hasOpener(openers: DesktopTargetOpener[], openerId: string) {
    return openers.some((opener) => opener.id === openerId);
  }

  function readStoredOpenTargetOpenerId(): string | null {
    try {
      return globalThis.localStorage?.getItem(DESKTOP_OPEN_TARGET_OPENER_STORAGE_KEY) ?? null;
    } catch (error) {
      console.debug("Unable to read desktop open target opener", error);
      return null;
    }
  }

  function storeOpenTargetOpenerId(openerId: string) {
    try {
      globalThis.localStorage?.setItem(DESKTOP_OPEN_TARGET_OPENER_STORAGE_KEY, openerId);
    } catch (error) {
      console.debug("Unable to persist desktop open target opener", error);
    }
  }

  function clearStoredOpenTargetOpenerId() {
    try {
      globalThis.localStorage?.removeItem(DESKTOP_OPEN_TARGET_OPENER_STORAGE_KEY);
    } catch (error) {
      console.debug("Unable to clear desktop open target opener", error);
    }
  }
</script>

<DesktopOpenTargetButton
  {compact}
  value={desktopFileOpenerId}
  {targetKind}
  openers={desktopOpeners}
  {disabled}
  {hasDesktopInstanceColor}
  onOpen={openDesktopTarget}
/>
