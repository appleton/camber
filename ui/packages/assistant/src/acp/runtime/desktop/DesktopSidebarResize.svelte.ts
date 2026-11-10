// Owns desktop sidebar width persistence and resize gesture state.
const STORAGE_KEY = "camber.desktop.sidebarWidth";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 220;
const MAX_WIDTH = 640;

export class DesktopSidebarResize {
  readonly DESKTOP_SIDEBAR_MIN_WIDTH = MIN_WIDTH;
  readonly DESKTOP_SIDEBAR_MAX_WIDTH = MAX_WIDTH;

  #isDesktop: () => boolean;
  #width = $state(DEFAULT_WIDTH);
  #resizeStartX = 0;
  #resizeStartWidth = DEFAULT_WIDTH;
  #resizing = $state(false);

  constructor({ isDesktop }: { isDesktop: () => boolean }) {
    this.#isDesktop = isDesktop;
  }

  get width() {
    return this.#width;
  }
  get resizing() {
    return this.#resizing;
  }

  loadSavedWidth = () => {
    this.#width = this.#getSavedWidth();
  };

  setWidth = (nextWidth: number) => {
    this.#width = this.#clampWidth(nextWidth);
    window.localStorage.setItem(STORAGE_KEY, this.#width.toString());
  };

  startResize = (event: MouseEvent) => {
    if (!this.#isDesktop()) return;

    this.#resizeStartX = event.clientX;
    this.#resizeStartWidth = this.#width;
    this.#resizing = true;
    document.body.classList.add("desktop-sidebar-resizing");
    event.preventDefault();
  };

  moveResize = (event: MouseEvent) => {
    if (!this.#resizing) return;

    // In-memory only: localStorage.setItem is synchronous I/O, and writing it
    // per mousemove during a drag causes visible jank. Persist on release.
    this.#width = this.#clampWidth(this.#resizeStartWidth + event.clientX - this.#resizeStartX);
  };

  stopResize = () => {
    if (!this.#resizing) return;

    this.#resizing = false;
    document.body.classList.remove("desktop-sidebar-resizing");
    window.localStorage.setItem(STORAGE_KEY, this.#width.toString());
  };

  #getSavedWidth(): number {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (!value) return DEFAULT_WIDTH;

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return DEFAULT_WIDTH;

    return this.#clampWidth(parsed);
  }

  #clampWidth(nextWidth: number): number {
    return Math.min(Math.max(nextWidth, MIN_WIDTH), MAX_WIDTH);
  }
}
