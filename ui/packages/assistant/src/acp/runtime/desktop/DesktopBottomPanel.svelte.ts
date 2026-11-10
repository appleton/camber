// Owns desktop bottom-panel height persistence and resize gesture state.
const HEIGHT_STORAGE_KEY = "camber.desktop.bottomPanelHeight";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 640;

export class DesktopBottomPanel {
  readonly DESKTOP_BOTTOM_PANEL_MIN_HEIGHT = MIN_HEIGHT;
  readonly DESKTOP_BOTTOM_PANEL_MAX_HEIGHT = MAX_HEIGHT;

  #isDesktop: () => boolean;
  #isVisible: () => boolean;
  #height = $state(DEFAULT_HEIGHT);
  #resizeStartY = 0;
  #resizeStartHeight = DEFAULT_HEIGHT;
  #resizing = $state(false);

  constructor({ isDesktop, isVisible }: { isDesktop: () => boolean; isVisible: () => boolean }) {
    this.#isDesktop = isDesktop;
    this.#isVisible = isVisible;
  }

  get height() {
    return this.#height;
  }
  get resizing() {
    return this.#resizing;
  }

  loadSavedState = () => {
    this.#height = this.#getSavedHeight();
  };

  setHeight = (nextHeight: number) => {
    this.#height = this.#clampHeight(nextHeight);
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, this.#height.toString());
  };

  startResize = (event: MouseEvent) => {
    if (!this.#isDesktop() || !this.#isVisible()) return;

    this.#resizeStartY = event.clientY;
    this.#resizeStartHeight = this.#height;
    this.#resizing = true;
    document.body.classList.add("desktop-bottom-panel-resizing");
    event.preventDefault();
  };

  moveResize = (event: MouseEvent) => {
    if (!this.#resizing) return;

    // In-memory only: localStorage.setItem is synchronous I/O, and writing it
    // per mousemove during a drag causes visible jank. Persist on release.
    this.#height = this.#clampHeight(this.#resizeStartHeight + this.#resizeStartY - event.clientY);
  };

  stopResize = () => {
    if (!this.#resizing) return;

    this.#resizing = false;
    document.body.classList.remove("desktop-bottom-panel-resizing");
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, this.#height.toString());
  };

  #getSavedHeight(): number {
    const value = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
    if (!value) return DEFAULT_HEIGHT;

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return DEFAULT_HEIGHT;

    return this.#clampHeight(parsed);
  }

  #clampHeight(nextHeight: number): number {
    return Math.min(Math.max(nextHeight, MIN_HEIGHT), MAX_HEIGHT);
  }
}
