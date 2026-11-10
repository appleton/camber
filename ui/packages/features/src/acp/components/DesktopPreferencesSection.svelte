<script lang="ts">
  import { isAppleUser } from "@camber/components";
  import { Switch } from "@camber/components/switch";
  import { onMount } from "svelte";
  import { desktopUpdate } from "../desktopUpdate";
  import { rpc, type RPCClient } from "../hostRpc";
  import DesktopAppIconTintSelect, {
    APP_ICON_TINTS,
    type AppIconTint,
  } from "./DesktopAppIconTintSelect.svelte";
  import DesktopDefaultLayoutSection from "./DesktopDefaultLayoutSection.svelte";
  import DesktopFileOpenerSelect, {
    type DesktopFileOpener,
  } from "./DesktopFileOpenerSelect.svelte";
  import DesktopThemeToggle, { type DesktopThemePreference } from "./DesktopThemeToggle.svelte";
  import DesktopToolActivitySelect from "./DesktopToolActivitySelect.svelte";
  import SettingsSection from "./settings/SettingsSection.svelte";

  type SaveStatus = "loading" | "saved" | "saving" | "error";
  type TerminalCursorStyle = "block" | "bar" | "underline";
  type ToolActivity = "detailed" | "grouped" | "compact";
  type UpdateChannel = "stable" | "nightly";

  interface DesktopStableSwitchResult {
    status: "alreadyStable" | "noUpdate" | "cancelled" | "staged";
    currentVersion: string;
    version?: string;
  }

  interface DesktopSettings {
    themePreference: DesktopThemePreference;
    chatFontSize: number;
    codeFontFamily: string;
    codeFontFamilies?: string[];
    codeFontSize: number;
    terminalFontFamily: string;
    terminalFontFamilies?: string[];
    terminalFontSize: number;
    terminalCursorStyle: TerminalCursorStyle;
    toolActivity: ToolActivity;
    steerWithEnter: boolean;
    windowVibrancy: boolean;
    appIconTint?: AppIconTint;
    updateChannel?: UpdateChannel;
    autoInstallUpdates?: boolean;
    fileOpenerId: string;
    fileOpeners: DesktopFileOpener[];
  }

  type DesktopSettingsRPC = RPCClient & {
    getDesktopSettings(): Promise<DesktopSettings>;
    setDesktopThemePreference(themePreference: DesktopThemePreference): Promise<DesktopSettings>;
    setDesktopChatPreferences(chatFontSize: number): Promise<DesktopSettings>;
    setDesktopCodePreferences(
      codeFontFamily: string,
      codeFontSize: number,
    ): Promise<DesktopSettings>;
    setDesktopTerminalPreferences(
      terminalFontFamily: string,
      terminalFontSize: number,
      terminalCursorStyle: TerminalCursorStyle,
    ): Promise<DesktopSettings>;
    setDesktopToolActivity(toolActivity: ToolActivity): Promise<DesktopSettings>;
    setDesktopSteerWithEnter(steerWithEnter: boolean): Promise<DesktopSettings>;
    setDesktopWindowVibrancy(windowVibrancy: boolean): Promise<DesktopSettings>;
    setDesktopAppIconTint(appIconTint: AppIconTint): Promise<DesktopSettings>;
    setDesktopUpdateChannel(updateChannel: UpdateChannel): Promise<DesktopSettings>;
    setDesktopAutoInstallUpdates(autoInstallUpdates: boolean): Promise<DesktopSettings>;
    switchDesktopToStable(): Promise<DesktopStableSwitchResult>;
    setDesktopFileOpener(fileOpenerId: string): Promise<DesktopSettings>;
    getDesktopAppVersion(): Promise<string>;
    openDesktopChangelog(): Promise<void>;
  };

  const desktopRpc = rpc as DesktopSettingsRPC;
  const DESKTOP_SETTINGS_CHANGED_EVENT = "camber:desktop-settings-changed";
  const MIN_CHAT_FONT_SIZE = 10;
  const MAX_CHAT_FONT_SIZE = 24;
  const MIN_CODE_FONT_SIZE = 8;
  const MAX_CODE_FONT_SIZE = 24;
  const MIN_TERMINAL_FONT_SIZE = 8;
  const MAX_TERMINAL_FONT_SIZE = 24;
  const CHAT_PREFERENCES_SAVE_DELAY_MS = 200;
  const CHAT_PREFERENCES_STALE_SETTINGS_GUARD_MS = 1_000;
  const CODE_PREFERENCES_SAVE_DELAY_MS = 200;
  const CODE_PREFERENCES_STALE_SETTINGS_GUARD_MS = 1_000;
  const TERMINAL_PREFERENCES_SAVE_DELAY_MS = 200;
  const TERMINAL_PREFERENCES_STALE_SETTINGS_GUARD_MS = 1_000;
  const externalEditorClickHint = isAppleUser() ? "Cmd + Click" : "Ctrl + Click";

  interface ApplyLoadedSettingsOptions {
    preserveChatPreferences?: boolean;
    preserveCodePreferences?: boolean;
    preserveTerminalPreferences?: boolean;
  }

  let themePreference = $state<DesktopThemePreference>("system");
  let persistedThemePreference = $state<DesktopThemePreference>("system");
  let chatFontSize = $state(15);
  let persistedChatFontSize = $state(15);
  let codeFontFamily = $state("Menlo");
  let persistedCodeFontFamily = $state("Menlo");
  let codeFontFamilies = $state<string[]>([]);
  let codeFontSize = $state(13);
  let persistedCodeFontSize = $state(13);
  let terminalFontFamily = $state("Menlo");
  let persistedTerminalFontFamily = $state("Menlo");
  let terminalFontFamilies = $state<string[]>([]);
  let terminalFontSize = $state(12);
  let persistedTerminalFontSize = $state(12);
  let terminalCursorStyle = $state<TerminalCursorStyle>("block");
  let persistedTerminalCursorStyle = $state<TerminalCursorStyle>("block");
  let fileOpenerId = $state("default");
  let persistedFileOpenerId = $state("default");
  let fileOpeners = $state<DesktopFileOpener[]>([]);
  let toolActivity = $state<ToolActivity>("grouped");
  let persistedToolActivity = $state<ToolActivity>("grouped");
  let steerWithEnter = $state(false);
  let persistedSteerWithEnter = $state(false);
  let windowVibrancy = $state(true);
  let persistedWindowVibrancy = $state(true);
  let appIconTint = $state<AppIconTint>("default");
  let persistedAppIconTint = $state<AppIconTint>("default");
  let updateChannel = $state<UpdateChannel>("stable");
  let autoInstallUpdates = $state(true);
  let persistedAutoInstallUpdates = $state(true);
  let persistedUpdateChannel = $state<UpdateChannel>("stable");
  let appVersion = $state("");
  let appChannelLabel = $derived(persistedUpdateChannel === "nightly" ? "Preview" : "Stable");
  let themeStatus = $state<SaveStatus>("loading");
  let chatStatus = $state<SaveStatus>("loading");
  let codeStatus = $state<SaveStatus>("loading");
  let terminalStatus = $state<SaveStatus>("loading");
  let fileOpenerStatus = $state<SaveStatus>("loading");
  let toolActivityStatus = $state<SaveStatus>("loading");
  let steerWithEnterStatus = $state<SaveStatus>("loading");
  let windowVibrancyStatus = $state<SaveStatus>("loading");
  let appIconTintStatus = $state<SaveStatus>("loading");
  let updateChannelStatus = $state<SaveStatus>("loading");
  let stableSwitchInFlight = $state(false);
  let error = $state("");
  let hasLoaded = $state(false);
  let chatSaveToken = 0;
  let chatSavesInFlight = 0;
  let chatSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let preserveLocalChatPreferencesUntil = 0;
  let codeSaveToken = 0;
  let codeSavesInFlight = 0;
  let codeSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let preserveLocalCodePreferencesUntil = 0;
  let terminalSaveToken = 0;
  let terminalSavesInFlight = 0;
  let terminalSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let preserveLocalTerminalPreferencesUntil = 0;
  let steerWithEnterSaveToken = 0;
  let steerWithEnterSavesPending = 0;
  let steerWithEnterSaveQueue: Promise<void> = Promise.resolve();
  let windowVibrancySaveToken = 0;
  let windowVibrancySavesPending = 0;
  let windowVibrancySaveQueue: Promise<void> = Promise.resolve();
  let autoInstallUpdatesSaveToken = 0;
  let autoInstallUpdatesSavesPending = 0;
  let autoInstallUpdatesSaveQueue: Promise<void> = Promise.resolve();
  let loading = $derived(
    themeStatus === "loading" ||
      chatStatus === "loading" ||
      codeStatus === "loading" ||
      terminalStatus === "loading" ||
      fileOpenerStatus === "loading" ||
      toolActivityStatus === "loading" ||
      steerWithEnterStatus === "loading" ||
      windowVibrancyStatus === "loading" ||
      appIconTintStatus === "loading" ||
      updateChannelStatus === "loading",
  );
  let hasError = $derived(
    themeStatus === "error" ||
      chatStatus === "error" ||
      codeStatus === "error" ||
      terminalStatus === "error" ||
      fileOpenerStatus === "error" ||
      toolActivityStatus === "error" ||
      steerWithEnterStatus === "error" ||
      windowVibrancyStatus === "error" ||
      appIconTintStatus === "error" ||
      updateChannelStatus === "error",
  );

  onMount(() => {
    void loadSettings();
    void desktopRpc
      .getDesktopAppVersion()
      .then((version) => (appVersion = version))
      .catch(() => {
        // The About row simply omits the version if the host cannot report it.
      });

    const onSettingsChanged = (event: Event) => {
      const settings = (event as CustomEvent<DesktopSettings>).detail;
      const preserveChatPreferences = shouldPreserveLocalChatPreferences(settings);
      const preserveCodePreferences = shouldPreserveLocalCodePreferences(settings);
      const preserveTerminalPreferences = shouldPreserveLocalTerminalPreferences(settings);
      applyLoadedSettings(settings, {
        preserveChatPreferences,
        preserveCodePreferences,
        preserveTerminalPreferences,
      });
      themeStatus = "saved";
      if (!preserveChatPreferences) chatStatus = "saved";
      if (!preserveCodePreferences) codeStatus = "saved";
      if (!preserveTerminalPreferences) terminalStatus = "saved";
      fileOpenerStatus = "saved";
      toolActivityStatus = "saved";
      steerWithEnterStatus = "saved";
      windowVibrancyStatus = "saved";
      appIconTintStatus = "saved";
      updateChannelStatus = "saved";
      error = "";
    };
    window.addEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => {
      window.removeEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
      clearChatSaveTimer();
      clearCodeSaveTimer();
      clearTerminalSaveTimer();
    };
  });

  $effect(() => {
    const nextThemePreference = themePreference;
    if (!hasLoaded) return;

    if (nextThemePreference === persistedThemePreference) {
      themeStatus = "saved";
      return;
    }

    themeStatus = "saving";
    error = "";
    void persistThemePreference(nextThemePreference);
  });

  async function loadSettings() {
    try {
      const settings = await desktopRpc.getDesktopSettings();
      applyLoadedSettings(settings);
      themeStatus = "saved";
      chatStatus = "saved";
      codeStatus = "saved";
      terminalStatus = "saved";
      fileOpenerStatus = "saved";
      toolActivityStatus = "saved";
      steerWithEnterStatus = "saved";
      windowVibrancyStatus = "saved";
      appIconTintStatus = "saved";
      updateChannelStatus = "saved";
    } catch (err) {
      themeStatus = "error";
      chatStatus = "error";
      codeStatus = "error";
      terminalStatus = "error";
      fileOpenerStatus = "error";
      toolActivityStatus = "error";
      steerWithEnterStatus = "error";
      windowVibrancyStatus = "error";
      appIconTintStatus = "error";
      updateChannelStatus = "error";
      error = toErrorMessage(err);
    } finally {
      hasLoaded = true;
    }
  }

  async function persistThemePreference(value: DesktopThemePreference) {
    try {
      const settings = await desktopRpc.setDesktopThemePreference(value);
      applyLoadedSettings(settings, {
        preserveChatPreferences: shouldPreserveLocalChatPreferences(settings),
        preserveCodePreferences: shouldPreserveLocalCodePreferences(settings),
        preserveTerminalPreferences: shouldPreserveLocalTerminalPreferences(settings),
      });
      themeStatus = "saved";
      error = "";
    } catch (err) {
      themeStatus = "error";
      error = toErrorMessage(err);
    }
  }

  async function persistSteerWithEnter(value: boolean) {
    const token = ++steerWithEnterSaveToken;
    steerWithEnterSavesPending += 1;
    error = "";
    const operation = steerWithEnterSaveQueue.then(async () => {
      await desktopRpc.setDesktopSteerWithEnter(value);
    });
    steerWithEnterSaveQueue = operation.catch(() => undefined);
    try {
      await operation;
      persistedSteerWithEnter = value;
      if (token !== steerWithEnterSaveToken) return;
      steerWithEnterStatus = "saved";
      error = "";
    } catch (err) {
      if (token !== steerWithEnterSaveToken) return;
      steerWithEnter = persistedSteerWithEnter;
      steerWithEnterStatus = "error";
      error = toErrorMessage(err);
    } finally {
      steerWithEnterSavesPending = Math.max(0, steerWithEnterSavesPending - 1);
    }
  }

  async function persistChatPreferences() {
    if (!hasLoaded) return;
    clearChatSaveTimer();

    const normalizedSize = Math.round(Number(chatFontSize));
    if (!Number.isFinite(normalizedSize)) {
      chatStatus = "error";
      error = "Please enter a chat font size.";
      return;
    }

    if (normalizedSize === persistedChatFontSize) {
      chatStatus = "saved";
      return;
    }

    chatStatus = "saving";
    error = "";
    const token = ++chatSaveToken;
    chatSavesInFlight += 1;
    markPotentialStaleChatSettingsWindow();
    try {
      const settings = await desktopRpc.setDesktopChatPreferences(normalizedSize);
      if (token !== chatSaveToken) return;
      applyLoadedSettings(settings, {
        preserveCodePreferences: shouldPreserveLocalCodePreferences(settings),
        preserveTerminalPreferences: shouldPreserveLocalTerminalPreferences(settings),
      });
      chatStatus = "saved";
      error = "";
    } catch (err) {
      if (token !== chatSaveToken) return;
      chatStatus = "error";
      error = toErrorMessage(err);
    } finally {
      chatSavesInFlight = Math.max(0, chatSavesInFlight - 1);
      markPotentialStaleChatSettingsWindow();
    }
  }

  async function persistCodePreferences() {
    if (!hasLoaded) return;
    clearCodeSaveTimer();

    const normalizedFamily = codeFontFamily.trim();
    const normalizedSize = Math.round(Number(codeFontSize));
    if (!normalizedFamily || !Number.isFinite(normalizedSize)) {
      codeStatus = "error";
      error = "Please enter code font settings.";
      return;
    }

    if (normalizedFamily === persistedCodeFontFamily && normalizedSize === persistedCodeFontSize) {
      codeStatus = "saved";
      return;
    }

    codeStatus = "saving";
    error = "";
    const token = ++codeSaveToken;
    codeSavesInFlight += 1;
    markPotentialStaleCodeSettingsWindow();
    try {
      const settings = await desktopRpc.setDesktopCodePreferences(normalizedFamily, normalizedSize);
      if (token !== codeSaveToken) return;
      applyLoadedSettings(settings, {
        preserveChatPreferences: shouldPreserveLocalChatPreferences(settings),
        preserveTerminalPreferences: shouldPreserveLocalTerminalPreferences(settings),
      });
      codeStatus = "saved";
      error = "";
    } catch (err) {
      if (token !== codeSaveToken) return;
      codeStatus = "error";
      error = toErrorMessage(err);
    } finally {
      codeSavesInFlight = Math.max(0, codeSavesInFlight - 1);
      markPotentialStaleCodeSettingsWindow();
    }
  }

  async function persistTerminalPreferences() {
    if (!hasLoaded) return;
    clearTerminalSaveTimer();

    const normalizedFamily = terminalFontFamily.trim();
    const normalizedSize = Math.round(Number(terminalFontSize));
    const normalizedCursorStyle = normalizeTerminalCursorStyle(terminalCursorStyle);
    if (!normalizedFamily || !Number.isFinite(normalizedSize)) {
      terminalStatus = "error";
      error = "Please enter terminal font settings.";
      return;
    }

    if (
      normalizedFamily === persistedTerminalFontFamily &&
      normalizedSize === persistedTerminalFontSize &&
      normalizedCursorStyle === persistedTerminalCursorStyle
    ) {
      terminalStatus = "saved";
      return;
    }

    terminalStatus = "saving";
    error = "";
    const token = ++terminalSaveToken;
    terminalSavesInFlight += 1;
    markPotentialStaleTerminalSettingsWindow();
    try {
      const settings = await desktopRpc.setDesktopTerminalPreferences(
        normalizedFamily,
        normalizedSize,
        normalizedCursorStyle,
      );
      if (token !== terminalSaveToken) return;
      applyLoadedSettings(settings, {
        preserveChatPreferences: shouldPreserveLocalChatPreferences(settings),
        preserveCodePreferences: shouldPreserveLocalCodePreferences(settings),
      });
      terminalStatus = "saved";
      error = "";
    } catch (err) {
      if (token !== terminalSaveToken) return;
      terminalStatus = "error";
      error = toErrorMessage(err);
    } finally {
      terminalSavesInFlight = Math.max(0, terminalSavesInFlight - 1);
      markPotentialStaleTerminalSettingsWindow();
    }
  }

  function scheduleValidChatPreferencesPersist() {
    const normalizedSize = Math.round(Number(chatFontSize));
    if (
      !Number.isFinite(normalizedSize) ||
      normalizedSize < MIN_CHAT_FONT_SIZE ||
      normalizedSize > MAX_CHAT_FONT_SIZE
    ) {
      return;
    }

    invalidatePendingChatPreferenceSaves();
    if (normalizedSize === persistedChatFontSize) {
      chatStatus = "saved";
      clearChatSaveTimer();
      return;
    }

    chatStatus = "saving";
    error = "";
    clearChatSaveTimer();
    chatSaveTimer = setTimeout(() => {
      chatSaveTimer = undefined;
      void persistChatPreferences();
    }, CHAT_PREFERENCES_SAVE_DELAY_MS);
  }

  function scheduleValidCodePreferencesPersist() {
    const normalizedSize = Math.round(Number(codeFontSize));
    if (
      !Number.isFinite(normalizedSize) ||
      normalizedSize < MIN_CODE_FONT_SIZE ||
      normalizedSize > MAX_CODE_FONT_SIZE
    ) {
      return;
    }

    invalidatePendingCodePreferenceSaves();
    if (
      codeFontFamily.trim() === persistedCodeFontFamily &&
      normalizedSize === persistedCodeFontSize
    ) {
      codeStatus = "saved";
      clearCodeSaveTimer();
      return;
    }

    codeStatus = "saving";
    error = "";
    clearCodeSaveTimer();
    codeSaveTimer = setTimeout(() => {
      codeSaveTimer = undefined;
      void persistCodePreferences();
    }, CODE_PREFERENCES_SAVE_DELAY_MS);
  }

  function scheduleValidTerminalPreferencesPersist() {
    const normalizedSize = Math.round(Number(terminalFontSize));
    if (
      !Number.isFinite(normalizedSize) ||
      normalizedSize < MIN_TERMINAL_FONT_SIZE ||
      normalizedSize > MAX_TERMINAL_FONT_SIZE
    ) {
      return;
    }

    invalidatePendingTerminalPreferenceSaves();
    if (
      terminalFontFamily.trim() === persistedTerminalFontFamily &&
      normalizedSize === persistedTerminalFontSize &&
      terminalCursorStyle === persistedTerminalCursorStyle
    ) {
      terminalStatus = "saved";
      clearTerminalSaveTimer();
      return;
    }

    terminalStatus = "saving";
    error = "";
    clearTerminalSaveTimer();
    terminalSaveTimer = setTimeout(() => {
      terminalSaveTimer = undefined;
      void persistTerminalPreferences();
    }, TERMINAL_PREFERENCES_SAVE_DELAY_MS);
  }

  async function persistFileOpener(value: string) {
    if (!hasLoaded || value === persistedFileOpenerId) {
      fileOpenerStatus = "saved";
      return;
    }

    fileOpenerStatus = "saving";
    error = "";
    try {
      const settings = await desktopRpc.setDesktopFileOpener(value);
      applyLoadedSettings(settings, {
        preserveChatPreferences: shouldPreserveLocalChatPreferences(settings),
        preserveCodePreferences: shouldPreserveLocalCodePreferences(settings),
        preserveTerminalPreferences: shouldPreserveLocalTerminalPreferences(settings),
      });
      fileOpenerStatus = "saved";
      error = "";
    } catch (err) {
      fileOpenerStatus = "error";
      error = toErrorMessage(err);
    }
  }

  async function persistToolActivity() {
    if (!hasLoaded || toolActivity === persistedToolActivity) {
      toolActivityStatus = "saved";
      return;
    }

    toolActivityStatus = "saving";
    error = "";
    try {
      const settings = await desktopRpc.setDesktopToolActivity(toolActivity);
      applyLoadedSettings(settings, {
        preserveCodePreferences: shouldPreserveLocalCodePreferences(settings),
        preserveTerminalPreferences: shouldPreserveLocalTerminalPreferences(settings),
      });
      toolActivityStatus = "saved";
      error = "";
    } catch (err) {
      toolActivityStatus = "error";
      error = toErrorMessage(err);
    }
  }

  async function persistUpdateChannel() {
    if (!hasLoaded || stableSwitchInFlight || updateChannel === persistedUpdateChannel) {
      updateChannelStatus = "saved";
      return;
    }

    updateChannelStatus = "saving";
    error = "";
    const previousChannel = persistedUpdateChannel;
    const switchingToStable = previousChannel === "nightly" && updateChannel === "stable";
    stableSwitchInFlight = switchingToStable;
    try {
      const settings = await desktopRpc.setDesktopUpdateChannel(updateChannel);
      applyLoadedSettings(settings, {
        preserveChatPreferences: shouldPreserveLocalChatPreferences(settings),
        preserveCodePreferences: shouldPreserveLocalCodePreferences(settings),
        preserveTerminalPreferences: shouldPreserveLocalTerminalPreferences(settings),
      });
      error = "";
      if (switchingToStable) {
        await offerStableSwitch();
      }
      updateChannelStatus = "saved";
    } catch (err) {
      updateChannel = persistedUpdateChannel;
      updateChannelStatus = "error";
      error = toErrorMessage(err);
    } finally {
      stableSwitchInFlight = false;
    }
  }

  async function persistAutoInstallUpdates(value: boolean) {
    const token = ++autoInstallUpdatesSaveToken;
    autoInstallUpdatesSavesPending += 1;
    const operation = autoInstallUpdatesSaveQueue.then(async () => {
      await desktopRpc.setDesktopAutoInstallUpdates(value);
    });
    autoInstallUpdatesSaveQueue = operation.catch(() => undefined);
    try {
      await operation;
      persistedAutoInstallUpdates = value;
    } catch (err) {
      if (token !== autoInstallUpdatesSaveToken) return;
      autoInstallUpdates = persistedAutoInstallUpdates;
      error = toErrorMessage(err);
    } finally {
      autoInstallUpdatesSavesPending = Math.max(0, autoInstallUpdatesSavesPending - 1);
    }
  }

  async function offerStableSwitch() {
    let restorePreviewMessage =
      "The Stable switch did not complete, so Preview remains selected. Select Stable to try again.";
    try {
      const result = await desktopRpc.switchDesktopToStable();
      switch (result.status) {
        case "staged":
          desktopRpc.showInfoMessage(
            result.version
              ? `Stable ${result.version} is ready — use the Update button to restart.`
              : "A Stable update is ready — use the Update button to restart.",
          );
          return;
        case "alreadyStable":
          return;
        case "cancelled":
          restorePreviewMessage =
            "The Stable switch was cancelled, so Preview remains selected. Select Stable to try again.";
          break;
        case "noUpdate":
          restorePreviewMessage =
            "No Stable build is currently available, so Preview remains selected. Select Stable later to try again.";
          break;
      }
    } catch (err) {
      restorePreviewMessage = `Couldn't switch to Stable: ${toErrorMessage(err)}. Preview remains selected; select Stable to try again.`;
    }

    try {
      const settings = await desktopRpc.setDesktopUpdateChannel("nightly");
      applyLoadedSettings(settings, {
        preserveChatPreferences: shouldPreserveLocalChatPreferences(settings),
        preserveCodePreferences: shouldPreserveLocalCodePreferences(settings),
        preserveTerminalPreferences: shouldPreserveLocalTerminalPreferences(settings),
      });
      error = "";
      desktopRpc.showInfoMessage(restorePreviewMessage);
    } catch (restoreError) {
      throw new Error(
        `${restorePreviewMessage} Preview could not be restored as the selected channel: ${toErrorMessage(restoreError)}`,
      );
    }
  }

  async function persistAppIconTint() {
    if (!hasLoaded || appIconTint === persistedAppIconTint) {
      appIconTintStatus = "saved";
      return;
    }

    appIconTintStatus = "saving";
    error = "";
    try {
      const settings = await desktopRpc.setDesktopAppIconTint(appIconTint);
      applyLoadedSettings(settings, {
        preserveChatPreferences: shouldPreserveLocalChatPreferences(settings),
        preserveCodePreferences: shouldPreserveLocalCodePreferences(settings),
        preserveTerminalPreferences: shouldPreserveLocalTerminalPreferences(settings),
      });
      appIconTintStatus = "saved";
      error = "";
    } catch (err) {
      appIconTintStatus = "error";
      error = toErrorMessage(err);
    }
  }

  async function persistWindowVibrancy(value: boolean) {
    if (!hasLoaded || (value === persistedWindowVibrancy && windowVibrancySavesPending === 0)) {
      windowVibrancyStatus = "saved";
      return;
    }

    const token = ++windowVibrancySaveToken;
    windowVibrancySavesPending += 1;
    error = "";
    const operation = windowVibrancySaveQueue.then(async () => {
      await desktopRpc.setDesktopWindowVibrancy(value);
    });
    windowVibrancySaveQueue = operation.catch(() => undefined);
    try {
      await operation;
      persistedWindowVibrancy = value;
      if (token !== windowVibrancySaveToken) return;
      windowVibrancyStatus = "saved";
      error = "";
    } catch (err) {
      if (token !== windowVibrancySaveToken) return;
      windowVibrancy = persistedWindowVibrancy;
      windowVibrancyStatus = "error";
      error = toErrorMessage(err);
    } finally {
      windowVibrancySavesPending = Math.max(0, windowVibrancySavesPending - 1);
    }
  }

  function applyLoadedSettings(
    settings: DesktopSettings,
    options: ApplyLoadedSettingsOptions = {},
  ) {
    const nextCodeFontFamilies = normalizedCodeFontFamilies(
      settings.codeFontFamilies,
      settings.codeFontFamily,
    );
    const nextCodeFontFamily = selectableCodeFontFamily(
      settings.codeFontFamily,
      nextCodeFontFamilies,
    );
    const nextTerminalFontFamilies = normalizedCodeFontFamilies(
      settings.terminalFontFamilies,
      settings.terminalFontFamily,
    );
    const nextTerminalFontFamily = selectableCodeFontFamily(
      settings.terminalFontFamily,
      nextTerminalFontFamilies,
    );

    themePreference = settings.themePreference;
    persistedThemePreference = settings.themePreference;
    if (!options.preserveChatPreferences) {
      chatFontSize = settings.chatFontSize;
      persistedChatFontSize = settings.chatFontSize;
    }
    if (!options.preserveCodePreferences) {
      codeFontFamilies = nextCodeFontFamilies;
      codeFontFamily = nextCodeFontFamily;
      persistedCodeFontFamily = nextCodeFontFamily;
      codeFontSize = settings.codeFontSize;
      persistedCodeFontSize = settings.codeFontSize;
    }
    if (!options.preserveTerminalPreferences) {
      terminalFontFamilies = nextTerminalFontFamilies;
      terminalFontFamily = nextTerminalFontFamily;
      persistedTerminalFontFamily = nextTerminalFontFamily;
      terminalFontSize = settings.terminalFontSize;
      persistedTerminalFontSize = settings.terminalFontSize;
      terminalCursorStyle = normalizeTerminalCursorStyle(settings.terminalCursorStyle);
      persistedTerminalCursorStyle = normalizeTerminalCursorStyle(settings.terminalCursorStyle);
    }
    fileOpenerId = settings.fileOpenerId;
    persistedFileOpenerId = settings.fileOpenerId;
    fileOpeners = settings.fileOpeners;
    toolActivity = normalizeToolActivity(settings.toolActivity);
    persistedToolActivity = normalizeToolActivity(settings.toolActivity);
    if (steerWithEnterSavesPending === 0) {
      steerWithEnter = settings.steerWithEnter === true;
      persistedSteerWithEnter = settings.steerWithEnter === true;
    }
    if (windowVibrancySavesPending === 0) {
      windowVibrancy = normalizeWindowVibrancy(settings.windowVibrancy);
      persistedWindowVibrancy = normalizeWindowVibrancy(settings.windowVibrancy);
    }
    appIconTint = normalizeAppIconTint(settings.appIconTint);
    persistedAppIconTint = normalizeAppIconTint(settings.appIconTint);
    updateChannel = normalizeUpdateChannel(settings.updateChannel);
    persistedUpdateChannel = normalizeUpdateChannel(settings.updateChannel);
    if (autoInstallUpdatesSavesPending === 0) {
      autoInstallUpdates = settings.autoInstallUpdates ?? true;
      persistedAutoInstallUpdates = settings.autoInstallUpdates ?? true;
    }
  }

  function shouldPreserveLocalChatPreferences(settings: DesktopSettings): boolean {
    if (!hasLocalChatPreferencesToPreserve()) return false;

    const normalizedLocalSize = Math.round(Number(chatFontSize));
    if (!Number.isFinite(normalizedLocalSize)) return true;

    return settings.chatFontSize !== normalizedLocalSize;
  }

  function shouldPreserveLocalCodePreferences(settings: DesktopSettings): boolean {
    if (!hasLocalCodePreferencesToPreserve()) return false;

    const normalizedLocalFamily = codeFontFamily.trim();
    const normalizedLocalSize = Math.round(Number(codeFontSize));
    if (!normalizedLocalFamily || !Number.isFinite(normalizedLocalSize)) return true;

    const nextCodeFontFamilies = normalizedCodeFontFamilies(
      settings.codeFontFamilies,
      settings.codeFontFamily,
    );
    const nextCodeFontFamily = selectableCodeFontFamily(
      settings.codeFontFamily,
      nextCodeFontFamilies,
    );

    return (
      nextCodeFontFamily !== normalizedLocalFamily || settings.codeFontSize !== normalizedLocalSize
    );
  }

  function shouldPreserveLocalTerminalPreferences(settings: DesktopSettings): boolean {
    if (!hasLocalTerminalPreferencesToPreserve()) return false;

    const normalizedLocalFamily = terminalFontFamily.trim();
    const normalizedLocalSize = Math.round(Number(terminalFontSize));
    const normalizedLocalCursorStyle = normalizeTerminalCursorStyle(terminalCursorStyle);
    if (!normalizedLocalFamily || !Number.isFinite(normalizedLocalSize)) return true;

    const nextTerminalFontFamilies = normalizedCodeFontFamilies(
      settings.terminalFontFamilies,
      settings.terminalFontFamily,
    );
    const nextTerminalFontFamily = selectableCodeFontFamily(
      settings.terminalFontFamily,
      nextTerminalFontFamilies,
    );

    return (
      nextTerminalFontFamily !== normalizedLocalFamily ||
      settings.terminalFontSize !== normalizedLocalSize ||
      normalizeTerminalCursorStyle(settings.terminalCursorStyle) !== normalizedLocalCursorStyle
    );
  }

  function hasLocalChatPreferencesToPreserve(): boolean {
    return (
      chatStatus === "saving" ||
      chatSavesInFlight > 0 ||
      Date.now() < preserveLocalChatPreferencesUntil
    );
  }

  function hasLocalCodePreferencesToPreserve(): boolean {
    return (
      codeStatus === "saving" ||
      codeSavesInFlight > 0 ||
      Date.now() < preserveLocalCodePreferencesUntil
    );
  }

  function hasLocalTerminalPreferencesToPreserve(): boolean {
    return (
      terminalStatus === "saving" ||
      terminalSavesInFlight > 0 ||
      Date.now() < preserveLocalTerminalPreferencesUntil
    );
  }

  function invalidatePendingChatPreferenceSaves() {
    chatSaveToken += 1;
    markPotentialStaleChatSettingsWindow();
  }

  function invalidatePendingCodePreferenceSaves() {
    codeSaveToken += 1;
    markPotentialStaleCodeSettingsWindow();
  }

  function invalidatePendingTerminalPreferenceSaves() {
    terminalSaveToken += 1;
    markPotentialStaleTerminalSettingsWindow();
  }

  function markPotentialStaleChatSettingsWindow() {
    preserveLocalChatPreferencesUntil = Date.now() + CHAT_PREFERENCES_STALE_SETTINGS_GUARD_MS;
  }

  function markPotentialStaleCodeSettingsWindow() {
    preserveLocalCodePreferencesUntil = Date.now() + CODE_PREFERENCES_STALE_SETTINGS_GUARD_MS;
  }

  function markPotentialStaleTerminalSettingsWindow() {
    preserveLocalTerminalPreferencesUntil =
      Date.now() + TERMINAL_PREFERENCES_STALE_SETTINGS_GUARD_MS;
  }

  function clearChatSaveTimer() {
    if (!chatSaveTimer) return;
    clearTimeout(chatSaveTimer);
    chatSaveTimer = undefined;
  }

  function clearCodeSaveTimer() {
    if (!codeSaveTimer) return;
    clearTimeout(codeSaveTimer);
    codeSaveTimer = undefined;
  }

  function clearTerminalSaveTimer() {
    if (!terminalSaveTimer) return;
    clearTimeout(terminalSaveTimer);
    terminalSaveTimer = undefined;
  }

  function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return "Unable to update settings.";
  }

  function normalizedCodeFontFamilies(
    families: string[] | undefined,
    currentFamily: string,
  ): string[] {
    const byName = new Map<string, string>();
    for (const family of [...(families ?? []), ...splitFontFamilyList(currentFamily), "Menlo"]) {
      const normalized = normalizeFontFamily(family);
      if (!normalized || isGenericFontFamily(normalized)) continue;
      byName.set(normalized.toLocaleLowerCase(), normalized);
    }
    return [...byName.values()].sort((left, right) => left.localeCompare(right));
  }

  function selectableCodeFontFamily(currentFamily: string, families: string[]): string {
    const familySet = new Set(families.map((family) => family.toLocaleLowerCase()));
    for (const family of splitFontFamilyList(currentFamily)) {
      const normalized = normalizeFontFamily(family);
      if (familySet.has(normalized.toLocaleLowerCase())) return normalized;
    }
    return families[0] ?? normalizeFontFamily(currentFamily) ?? "Menlo";
  }

  function splitFontFamilyList(fontFamily: string): string[] {
    return fontFamily.split(",").map(normalizeFontFamily).filter(Boolean);
  }

  function normalizeFontFamily(fontFamily: string): string {
    return fontFamily.trim().replace(/^["']|["']$/g, "");
  }

  function isGenericFontFamily(fontFamily: string): boolean {
    return ["monospace", "serif", "sans-serif", "sans serif", "cursive", "fantasy"].includes(
      fontFamily.toLocaleLowerCase(),
    );
  }

  function normalizeTerminalCursorStyle(value: string): TerminalCursorStyle {
    if (value === "bar" || value === "underline") return value;
    return "block";
  }

  function normalizeToolActivity(value: string | undefined): ToolActivity {
    return value === "detailed" || value === "compact" ? value : "grouped";
  }

  function normalizeWindowVibrancy(value: boolean | undefined): boolean {
    return value !== false;
  }

  function normalizeAppIconTint(value: string | undefined): AppIconTint {
    return APP_ICON_TINTS.includes(value as AppIconTint) ? (value as AppIconTint) : "default";
  }

  function normalizeUpdateChannel(value: string | undefined): UpdateChannel {
    return value === "nightly" ? "nightly" : "stable";
  }
</script>

<SettingsSection title="Appearance">
  <div class="flex flex-col items-start gap-2 px-3 pb-3 pt-3">
    <DesktopThemeToggle bind:value={themePreference} disabled={loading} />
    {#if isAppleUser()}
      <div class="border-psx-border mt-1 w-full border-t pt-3">
        <div class="flex items-center gap-2">
          <Switch
            id="desktop-window-vibrancy-switch"
            checked={windowVibrancy}
            disabled={windowVibrancyStatus === "loading"}
            onCheckedChange={(value) => {
              windowVibrancy = value;
              void persistWindowVibrancy(value);
            }}
          />
          <label class="cursor-pointer text-[13px]/[18px]" for="desktop-window-vibrancy-switch">
            Translucent window
          </label>
        </div>
      </div>
      <div class="border-psx-border mt-1 flex w-full flex-col gap-2 border-t pt-3">
        <span class="text-psx-foreground-primary text-[13px]/[18px]">App icon</span>
        <DesktopAppIconTintSelect
          bind:value={appIconTint}
          disabled={appIconTintStatus === "loading"}
          onChange={() => void persistAppIconTint()}
        />
        <span class="text-psx-foreground-tertiary text-[11px]/[15px]">
          Tints the icon in the Dock and app switcher. Finder keeps the original.
        </span>
      </div>
    {/if}
  </div>
</SettingsSection>

<SettingsSection
  title="Prompt submission"
  subtitle="Choose which action gets the quickest shortcut while an agent is responding"
>
  <div class="flex flex-col items-start gap-2 px-3 pb-3 pt-3">
    <div class="flex items-center gap-2">
      <Switch
        id="desktop-steer-with-enter-switch"
        checked={steerWithEnter}
        disabled={steerWithEnterStatus === "loading"}
        onCheckedChange={(value) => {
          steerWithEnter = value;
          void persistSteerWithEnter(value);
        }}
      />
      <label class="cursor-pointer text-[13px]/[18px]" for="desktop-steer-with-enter-switch">
        Steer with Enter
      </label>
    </div>
    <span class="text-psx-foreground-tertiary text-[11px]/[15px]">
      When enabled, Enter steers and Cmd+Enter enqueues. Otherwise, Enter enqueues and Cmd+Enter
      steers.
    </span>
  </div>
</SettingsSection>

<SettingsSection title="Chat Font">
  <div class="px-3 pb-3 pt-3">
    <label class="flex w-[76px] min-w-0 flex-col gap-1">
      <span class="text-psx-foreground-primary text-[13px]/[18px]">Size</span>
      <input
        class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 rounded-[5px] border px-2 text-[13px]/[18px] outline-none"
        type="number"
        min={MIN_CHAT_FONT_SIZE}
        max={MAX_CHAT_FONT_SIZE}
        step="1"
        bind:value={chatFontSize}
        disabled={chatStatus === "loading"}
        oninput={scheduleValidChatPreferencesPersist}
        onchange={() => void persistChatPreferences()}
      />
    </label>
  </div>
</SettingsSection>

<SettingsSection title="Code Font">
  <div class="grid w-full max-w-[360px] grid-cols-[minmax(0,1fr)_76px] gap-2 px-3 pb-3 pt-3">
    <label class="flex min-w-0 flex-col gap-1">
      <span class="text-psx-foreground-primary text-[13px]/[18px]">Family</span>
      <select
        class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 rounded-[5px] border px-2 text-[13px]/[18px] outline-none"
        bind:value={codeFontFamily}
        disabled={codeStatus === "loading" || codeFontFamilies.length === 0}
        onchange={() => void persistCodePreferences()}
      >
        {#each codeFontFamilies as family (family)}
          <option value={family}>{family}</option>
        {/each}
      </select>
    </label>
    <label class="flex min-w-0 flex-col gap-1">
      <span class="text-psx-foreground-primary text-[13px]/[18px]">Size</span>
      <input
        class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 rounded-[5px] border px-2 text-[13px]/[18px] outline-none"
        type="number"
        min={MIN_CODE_FONT_SIZE}
        max={MAX_CODE_FONT_SIZE}
        step="1"
        bind:value={codeFontSize}
        disabled={codeStatus === "loading"}
        oninput={scheduleValidCodePreferencesPersist}
        onchange={() => void persistCodePreferences()}
      />
    </label>
  </div>
</SettingsSection>

<SettingsSection title="Terminal">
  <div class="grid w-full max-w-[360px] grid-cols-[minmax(0,1fr)_76px] gap-2 px-3 pb-3 pt-3">
    <label class="flex min-w-0 flex-col gap-1">
      <span class="text-psx-foreground-primary text-[13px]/[18px]">Family</span>
      <select
        class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 rounded-[5px] border px-2 text-[13px]/[18px] outline-none"
        bind:value={terminalFontFamily}
        disabled={terminalStatus === "loading" || terminalFontFamilies.length === 0}
        onchange={() => void persistTerminalPreferences()}
      >
        {#each terminalFontFamilies as family (family)}
          <option value={family}>{family}</option>
        {/each}
      </select>
    </label>
    <label class="flex min-w-0 flex-col gap-1">
      <span class="text-psx-foreground-primary text-[13px]/[18px]">Size</span>
      <input
        class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 rounded-[5px] border px-2 text-[13px]/[18px] outline-none"
        type="number"
        min={MIN_TERMINAL_FONT_SIZE}
        max={MAX_TERMINAL_FONT_SIZE}
        step="1"
        bind:value={terminalFontSize}
        disabled={terminalStatus === "loading"}
        oninput={scheduleValidTerminalPreferencesPersist}
        onchange={() => void persistTerminalPreferences()}
      />
    </label>
    <label class="col-span-2 flex min-w-0 flex-col gap-1">
      <span class="text-psx-foreground-primary text-[13px]/[18px]">Cursor</span>
      <select
        class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 max-w-[180px] rounded-[5px] border px-2 text-[13px]/[18px] outline-none"
        bind:value={terminalCursorStyle}
        disabled={terminalStatus === "loading"}
        onchange={() => void persistTerminalPreferences()}
      >
        <option value="block">Block</option>
        <option value="bar">Bar</option>
        <option value="underline">Underline</option>
      </select>
    </label>
  </div>
</SettingsSection>

<SettingsSection
  title="External editor"
  subtitle={`${externalEditorClickHint} on files to open in your favorite editor`}
>
  <div class="flex flex-col items-start gap-2 px-3 pb-3 pt-3">
    <DesktopFileOpenerSelect
      bind:value={fileOpenerId}
      openers={fileOpeners}
      disabled={fileOpenerStatus === "loading" || fileOpeners.length === 0}
      onChange={persistFileOpener}
    />
  </div>
</SettingsSection>

<SettingsSection
  title="Tool activity"
  subtitle="How much detail to show while the agent works. Finished replies always collapse, chat mode is always compact"
>
  <div class="px-3 pb-3 pt-3">
    <DesktopToolActivitySelect
      bind:value={toolActivity}
      disabled={toolActivityStatus === "loading"}
      onChange={() => void persistToolActivity()}
    />
  </div>
</SettingsSection>

<DesktopDefaultLayoutSection />

<SettingsSection title="Updates channel">
  <div class="flex flex-col items-start gap-2 px-3 pb-3 pt-3">
    <div class="flex items-center gap-2">
      <Switch
        id="desktop-auto-install-updates-switch"
        checked={autoInstallUpdates}
        onCheckedChange={(value: boolean) => {
          autoInstallUpdates = value;
          void persistAutoInstallUpdates(value);
        }}
      />
      <label class="cursor-pointer text-[13px]/[18px]" for="desktop-auto-install-updates-switch">
        Install updates automatically
      </label>
    </div>
    <p class="text-psx-foreground-secondary text-[12px]/[16px]">
      Camber waits for all conversations to finish, then installs and restarts automatically.
    </p>
    <div class="flex w-full max-w-[360px] items-center justify-between gap-3">
      <select
        class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 rounded-[5px] border px-2 text-[13px]/[18px] outline-none"
        aria-label="Updates channel"
        bind:value={updateChannel}
        disabled={updateChannelStatus === "loading" ||
          updateChannelStatus === "saving" ||
          stableSwitchInFlight ||
          $desktopUpdate.busy ||
          $desktopUpdate.available}
        onchange={() => void persistUpdateChannel()}
      >
        <option value="stable">Stable (recommended)</option>
        <option value="nightly">Preview</option>
      </select>
      {#if stableSwitchInFlight}
        <span class="text-psx-foreground-secondary shrink-0 text-[13px]/[18px]">Switching</span>
      {:else if updateChannelStatus === "saving"}
        <span class="text-psx-foreground-secondary shrink-0 text-[13px]/[18px]">Saving</span>
      {/if}
    </div>
    {#if $desktopUpdate.available}
      <p class="text-psx-foreground-secondary text-[12px]/[16px]">
        {$desktopUpdate.version
          ? `Update ${$desktopUpdate.version} is ready.`
          : "An update is ready."}
        Use the Update button to restart before changing release channels.
      </p>
    {:else if $desktopUpdate.busy}
      <p class="text-psx-foreground-secondary text-[12px]/[16px]">
        Checking for updates. Release channels are temporarily unavailable.
      </p>
    {:else if updateChannel === "nightly"}
      <p class="text-psx-foreground-secondary text-[12px]/[16px]">
        Preview builds ship the latest changes and may be unstable. Switching back to Stable offers
        the latest Stable build, even when its version is lower. Background checks never downgrade
        the app automatically.
      </p>
    {/if}
  </div>
</SettingsSection>

<SettingsSection title="About">
  <div class="flex items-center gap-1.5 px-3 pb-3 pt-3 text-[13px]/[18px]">
    <span class="text-psx-foreground-primary">
      Camber Assistant{appVersion ? ` ${appVersion}` : ""}
    </span>
    <span class="text-psx-foreground-secondary" aria-hidden="true">·</span>
    <span class="text-psx-foreground-secondary">{appChannelLabel}</span>
    <span class="text-psx-foreground-secondary" aria-hidden="true">·</span>
    <button
      type="button"
      class="text-psx-link underline decoration-transparent hover:decoration-current"
      onclick={() => void desktopRpc.openDesktopChangelog()}
    >
      Changelog
    </button>
  </div>
</SettingsSection>

{#if hasError}
  <SettingsSection title="Settings Error">
    <p class="text-psx-error-foreground truncate px-3 pb-3 pt-3 text-[13px]/[18px]" title={error}>
      {error}
    </p>
  </SettingsSection>
{/if}
