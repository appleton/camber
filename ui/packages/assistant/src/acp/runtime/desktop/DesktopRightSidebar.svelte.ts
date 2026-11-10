// Owns desktop right-sidebar width persistence and resize gesture state.
const WIDTH_STORAGE_KEY = "camber.desktop.rightSidebarWidth";
const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;

export class DesktopRightSidebar {
  readonly DESKTOP_RIGHT_SIDEBAR_MIN_WIDTH = MIN_WIDTH;
  readonly DESKTOP_RIGHT_SIDEBAR_MAX_WIDTH = MAX_WIDTH;

  #isDesktop: () => boolean;
  #isVisible: () => boolean;
  #width = $state(DEFAULT_WIDTH);
  #resizeStartX = 0;
  #resizeStartWidth = DEFAULT_WIDTH;
  #resizing = $state(false);

  constructor({ isDesktop, isVisible }: { isDesktop: () => boolean; isVisible: () => boolean }) {
    this.#isDesktop = isDesktop;
    this.#isVisible = isVisible;
  }

  get width() {
    return this.#width;
  }
  get resizing() {
    return this.#resizing;
  }

  loadSavedState = () => {
    this.#width = this.#getSavedWidth();
  };

  setWidth = (nextWidth: number) => {
    this.#width = this.#clampWidth(nextWidth);
    window.localStorage.setItem(WIDTH_STORAGE_KEY, this.#width.toString());
  };

  startResize = (event: MouseEvent) => {
    if (!this.#isDesktop() || !this.#isVisible()) return;

    this.#resizeStartX = event.clientX;
    this.#resizeStartWidth = this.#width;
    this.#resizing = true;
    document.body.classList.add("desktop-right-sidebar-resizing");
    event.preventDefault();
  };

  moveResize = (event: MouseEvent) => {
    if (!this.#resizing) return;

    // In-memory only: localStorage.setItem is synchronous I/O, and writing it
    // per mousemove during a drag causes visible jank. Persist on release.
    this.#width = this.#clampWidth(this.#resizeStartWidth + this.#resizeStartX - event.clientX);
  };

  stopResize = () => {
    if (!this.#resizing) return;

    this.#resizing = false;
    document.body.classList.remove("desktop-right-sidebar-resizing");
    window.localStorage.setItem(WIDTH_STORAGE_KEY, this.#width.toString());
  };

  #getSavedWidth(): number {
    const value = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!value) return DEFAULT_WIDTH;

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return DEFAULT_WIDTH;

    return this.#clampWidth(parsed);
  }

  #clampWidth(nextWidth: number): number {
    return Math.min(Math.max(nextWidth, MIN_WIDTH), MAX_WIDTH);
  }
}
