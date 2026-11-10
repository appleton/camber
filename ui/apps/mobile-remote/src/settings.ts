// Mobile-app-local settings, persisted in the phone browser's localStorage so
// they stay independent from the desktop app's settings: the phone can run a
// light theme while the desktop stays dark.

import type { MobileThemePreference } from "@camber/assistant";

export interface MobileSettings {
  theme: MobileThemePreference;
}

const STORAGE_KEY = "camber.mobile.settings.v1";

const DEFAULT_SETTINGS: MobileSettings = { theme: "system" };

export function loadMobileSettings(): MobileSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<MobileSettings>;
    return {
      theme: parsed.theme === "light" || parsed.theme === "dark" ? parsed.theme : "system",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveMobileSettings(settings: MobileSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private-mode browsers can reject writes; the setting still applies for
    // the current visit.
  }
}
