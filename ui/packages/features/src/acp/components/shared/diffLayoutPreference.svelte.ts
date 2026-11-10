/**
 * App-wide diff layout preference (unified vs side-by-side), shared by every
 * pierre-based diff view (chat tool diffs, the desktop Diff tab). One
 * preference rather than per-surface state: toggling it anywhere flips every
 * diff, which is what "I read diffs side by side" means as a user setting.
 */

export type DiffLayout = "unified" | "split";

const STORAGE_KEY = "camber.diffLayout";

function loadInitial(): DiffLayout {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

class DiffLayoutPreference {
  current = $state<DiffLayout>(loadInitial());

  set(layout: DiffLayout): void {
    this.current = layout;
    try {
      window.localStorage.setItem(STORAGE_KEY, layout);
    } catch {
      // Preference simply won't survive a reload.
    }
  }

  toggle(): void {
    this.set(this.current === "split" ? "unified" : "split");
  }
}

export const diffLayoutPreference = new DiffLayoutPreference();
