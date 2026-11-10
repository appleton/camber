<script lang="ts">
  import { CanvasAddon } from "@xterm/addon-canvas";
  import { FitAddon } from "@xterm/addon-fit";
  import { Terminal, type ITheme, type ITerminalOptions } from "@xterm/xterm";
  import { isMac } from "@camber/components";
  import { onDestroy, onMount, tick } from "svelte";
  import { getAssistantTerminalRepo } from "../features/AssistantTerminalRepository.svelte";
  import { macTerminalTextNavigationInput } from "./macTerminalTextNavigation";
  import { enqueueSettledFit } from "./terminalFitQueue";
  import { installTerminalLinks } from "./terminalLinks";
  import "@xterm/xterm/css/xterm.css";

  interface Props {
    terminalId?: string | null;
    class?: string;
    focusToken?: number;
  }

  type TerminalCursorPreference = "block" | "bar" | "underline";
  type XtermCursorStyle = NonNullable<ITerminalOptions["cursorStyle"]>;
  type XtermCursorInactiveStyle = NonNullable<ITerminalOptions["cursorInactiveStyle"]>;

  let { terminalId = null, class: className, focusToken = 0 }: Props = $props();

  let container = $state<HTMLDivElement | null>(null);
  let term = $state<Terminal | null>(null);
  let fit = $state<FitAddon | null>(null);
  let renderedTabId = $state<string | null>(null);
  let renderedBufferEndOffset = $state(0);
  let styleRevision = $state(0);
  let lastNotifiedSize: { terminalId: string; cols: number; rows: number } | null = null;
  // Number of replayed-buffer writes still being parsed; see writeReplayedBuffer.
  let replayWritesInFlight = 0;
  let resizeObserver: ResizeObserver | null = null;
  let resizeSettleTimer: number | null = null;
  // Trailing-edge debounce for container resizes. Panel open/close animations
  // resize the container every frame for ~180ms; fitting xterm per frame (full
  // glyph re-measure plus a PTY resize RPC) is a dominant animation-jank cost.
  // A single fit after the size settles is visually identical.
  const RESIZE_SETTLE_MS = 80;
  // Monotonic token guarding against overlapping renderTerminal() runs. Metadata
  // updates streaming in during setup churn the tab list, which can re-fire the
  // render effect before an in-flight (async) render finishes. Without this,
  // two renders race and `term` ends up bound to an orphaned xterm while the
  // container shows the other, so buffered output never paints.
  let renderGeneration = 0;
  // Focus owed back to this view: set when a render begins while the view
  // holds focus, paid when a render completes. Survives superseded render
  // generations — see renderTerminal.
  let returnFocusAfterRender = false;
  const assistantTerminals = getAssistantTerminalRepo();
  const tab = $derived(
    terminalId
      ? (assistantTerminals.tabs.find((candidate) => candidate.id === terminalId) ?? null)
      : null,
  );
  const buffer = $derived(tab ? (assistantTerminals.buffers[tab.id] ?? "") : "");
  const bufferStartOffset = $derived(
    tab ? (assistantTerminals.bufferStartOffsets[tab.id] ?? 0) : 0,
  );
  const bufferEndOffset = $derived(bufferStartOffset + buffer.length);

  $effect(() => {
    if (!tab) {
      // The tab is gone, not being replaced: there is nothing to hand any
      // held focus back to, and a stale debt would steal focus for whichever
      // unrelated tab renders into this view next.
      returnFocusAfterRender = false;
      disposeTerminal();
      return;
    }
    if (!container) return;
    if (renderedTabId === tab.id && term) return;
    void renderTerminal();
  });

  $effect(() => {
    if (!term || renderedTabId !== tab?.id) return;
    if (renderedBufferEndOffset < bufferStartOffset || renderedBufferEndOffset > bufferEndOffset) {
      term.reset();
      writeReplayedBuffer(term, buffer);
    } else if (bufferEndOffset > renderedBufferEndOffset) {
      term.write(buffer.slice(renderedBufferEndOffset - bufferStartOffset));
    }
    renderedBufferEndOffset = bufferEndOffset;
  });

  // Focus requests are one-shot. This effect also depends on `term` and `tab`,
  // and `tab` gets a fresh identity every time the host reports a title or cwd
  // change — so a long-running command (a worktree setup script) would keep
  // re-applying a focus request made when its terminal opened, yanking focus
  // out of whatever the user moved to in the meantime, usually the prompt.
  let appliedFocusToken = 0;

  $effect(() => {
    if (!focusToken || !term || renderedTabId !== tab?.id) return;
    if (focusToken === appliedFocusToken) return;
    appliedFocusToken = focusToken;
    focusTerminal();
  });

  $effect(() => {
    const revision = styleRevision;
    const terminal = term;
    void revision;
    if (!terminal) return;
    void applyTerminalStyles();
  });

  onMount(() => {
    const observer = new MutationObserver(() => {
      styleRevision += 1;
    });
    for (const element of [document.documentElement, document.body]) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    }
    return () => observer.disconnect();
  });

  async function renderTerminal() {
    const generation = ++renderGeneration;
    // A render is not a focus request: terminals render on their own schedule
    // (a surface being revealed, a command replacing a tab's shell, metadata
    // churn restarting an in-flight render) and taking focus then steals it
    // from wherever the user actually is. Focus arrives via `focusToken`.
    // Handing it back is only right when this view already held it — the xterm
    // about to be disposed would otherwise drop focus to the document. The
    // debt is component state, not a local: disposeTerminal() below writes
    // `term`/`renderedTabId`, which re-triggers the render effect, so the
    // generation that actually completes is a later one — started after focus
    // already fell to <body>, where a local would always read false.
    if (containerHoldsFocus()) {
      returnFocusAfterRender = true;
    }
    disposeTerminal();
    await tick();
    if (generation !== renderGeneration || !container || !tab) return;

    const terminalTab = tab;
    const { cursorInactiveStyle, cursorStyle, fontFamily, fontSize, lineHeight, theme } =
      terminalStyle();
    // Make sure the (web)font is loaded before xterm measures the cell, otherwise
    // the powerline/Nerd Font glyphs render against fallback metrics and misalign.
    await ensureTerminalFont(fontFamily, fontSize);
    if (generation !== renderGeneration || !container || tab?.id !== terminalTab.id) return;

    const initialBuffer = assistantTerminals.buffers[terminalTab.id] ?? "";
    container.replaceChildren();
    const nextTerm = new Terminal({
      allowTransparency: false,
      cursorBlink: true,
      cursorInactiveStyle,
      cursorStyle,
      fontFamily,
      fontSize,
      lineHeight,
      theme,
    });
    const nextFit = new FitAddon();
    nextTerm.loadAddon(nextFit);
    installTerminalLinks(nextTerm);
    nextTerm.attachCustomKeyEventHandler((event) => {
      const textNavigationInput = isMac() ? macTerminalTextNavigationInput(event) : undefined;
      if (textNavigationInput !== undefined) {
        // Keep mapped input on the same onData path as ordinary typing so PTY
        // delivery failures receive the normal terminal error treatment.
        nextTerm.input(textNavigationInput);
        // Returning false only tells xterm to stay out of it: that early return
        // skips the cancel() its own key path ends with, so the keydown would
        // keep bubbling to whatever surrounds the terminal — the splits
        // container reads it as a pane-focus shortcut (PE-2470).
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      return true;
    });
    // Write failures used to be discarded, leaving a terminal that looks alive
    // but silently eats keystrokes (e.g. when the host no longer has the PTY).
    let writeFailureNotified = false;
    nextTerm.onData((data) => {
      if (generation !== renderGeneration || terminalTab.exitCode !== undefined) return;
      // While a stored buffer is replaying, anything xterm emits is its answer
      // to a replayed capability query, not user input (focus arrives after the
      // replay); see writeReplayedBuffer.
      if (replayWritesInFlight > 0) return;
      assistantTerminals
        .write(terminalTab.id, data)
        .then(() => {
          // Recovered: let a later, unrelated failure surface its own notice.
          writeFailureNotified = false;
        })
        .catch((error: unknown) => {
          // A superseded render already disposed this xterm; writing into it
          // would schedule a parse against detached DOM.
          if (generation !== renderGeneration) return;
          console.error("Failed to write to assistant terminal", terminalTab.id, error);
          if (writeFailureNotified) return;
          writeFailureNotified = true;
          nextTerm.write("\r\n\x1b[2m[input not delivered]\x1b[0m\r\n");
        });
    });
    nextTerm.open(container);
    // Canvas renderer. The default DOM renderer builds an element per visible
    // row, so every resize or reparent relayouts the whole viewport; a canvas
    // makes that a single blit. Must load after open(). Canvas rather than
    // WebGL because a context is cheap here and WebGL caps how many live
    // contexts a page may hold, which a grid of terminals would exhaust.
    // loadAddon registers before activate() runs, so a failure here leaves the
    // addon registered and the renderer possibly already swapped; catching only
    // keeps the throw from aborting terminal setup.
    try {
      nextTerm.loadAddon(new CanvasAddon());
    } catch (error) {
      console.warn("Canvas renderer unavailable; using DOM renderer", error);
    }
    nextFit.fit();
    // Only clear+repaint when the shell was spawned at a size other than the
    // one just measured. The common case — terminals spawn at the repository's
    // last measured pane size — keeps the first prompt untouched and avoids
    // the `^L` that the compensating Ctrl+L briefly echoes while the shell is
    // still starting up.
    const resetStartupPrompt = assistantTerminals.consumeInitialResizeClear(
      terminalTab.id,
      nextTerm.cols,
      nextTerm.rows,
    );
    await notifySizeIfChanged(terminalTab.id, nextTerm.cols, nextTerm.rows);
    if (generation !== renderGeneration || !container || tab?.id !== terminalTab.id) {
      nextTerm.dispose();
      return;
    }
    if (resetStartupPrompt) {
      await assistantTerminals.clear(terminalTab.id);
    }
    if (generation !== renderGeneration || !container || tab?.id !== terminalTab.id) {
      nextTerm.dispose();
      return;
    }

    renderedBufferEndOffset = resetStartupPrompt
      ? 0
      : (assistantTerminals.bufferStartOffsets[terminalTab.id] ?? 0) + initialBuffer.length;
    if (!resetStartupPrompt) {
      writeReplayedBuffer(nextTerm, initialBuffer);
    }
    term = nextTerm;
    fit = nextFit;
    renderedTabId = terminalTab.id;
    installResizeObserver();
    fitAndNotify({ retries: 3, terminalId: terminalTab.id });
    if (returnFocusAfterRender) {
      returnFocusAfterRender = false;
      // Disposing the previous xterm dropped focus to <body>; unclaimed focus
      // is that drop still unrepaired. Anything else means the user moved on
      // while this render was in flight, and the debt is theirs to keep. The
      // check runs when the deferred focus lands, not now: the render's own
      // awaits are microtasks, so "in flight" includes the gap before this
      // frame, and a prompt focused in that gap must also be respected.
      requestAnimationFrame(() => {
        if (focusIsUnclaimed()) term?.focus();
      });
    }
  }

  // The stored buffer includes capability queries (DA1, DECRQM, OSC 10/11, DSR,
  // ...) that apps in the PTY sent when they started. Re-parsing the buffer into
  // a fresh xterm makes xterm answer those queries again through onData, and the
  // duplicate replies would land at whatever is reading the PTY now — usually a
  // shell prompt, which renders them as typed garbage like "2026;0$y…1;2c". The
  // querying app already got the real replies from the xterm that was live at
  // the time, so onData output during a replay is dropped. Live writes stay
  // unguarded: xterm parses its write queue in order, so a replay's completion
  // callback runs before any later live chunk is parsed.
  function writeReplayedBuffer(terminal: Terminal, data: string) {
    replayWritesInFlight += 1;
    terminal.write(data, () => {
      replayWritesInFlight = Math.max(0, replayWritesInFlight - 1);
    });
  }

  async function applyTerminalStyles() {
    const terminal = term;
    if (!terminal) return;

    const { cursorInactiveStyle, cursorStyle, fontFamily, fontSize, lineHeight, theme } =
      terminalStyle();
    await ensureTerminalFont(fontFamily, fontSize);
    if (terminal !== term) return;

    terminal.options.cursorInactiveStyle = cursorInactiveStyle;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight;
    terminal.options.theme = theme;
    fitAndNotify({ retries: 2, terminalId: renderedTabId ?? undefined });
  }

  function installResizeObserver() {
    resizeObserver?.disconnect();
    if (!container) return;
    resizeObserver = new ResizeObserver(() => scheduleSettledFit());
    resizeObserver.observe(container);
  }

  function scheduleSettledFit() {
    if (resizeSettleTimer !== null) {
      window.clearTimeout(resizeSettleTimer);
    }
    resizeSettleTimer = window.setTimeout(() => {
      resizeSettleTimer = null;
      // Panel animations resize every terminal at once, so every instance's
      // settle timer expires in the same tick. Fitting them all in one frame
      // (a full glyph re-measure each) is a single >100ms stall right as the
      // animation ends; the shared queue spreads the fits one per frame.
      enqueueSettledFit(() => fitAndNotify({ terminalId: renderedTabId ?? undefined }));
    }, RESIZE_SETTLE_MS);
  }

  function fitAndNotify({ retries = 1, terminalId: targetTerminalId = tab?.id ?? null } = {}) {
    if (!fit || !term || !targetTerminalId) return;
    requestAnimationFrame(() => {
      if (!fit || !term || renderedTabId !== targetTerminalId) return;
      if (!container || container.clientWidth < 40 || container.clientHeight < 40) {
        if (retries > 1) {
          window.setTimeout(
            () => fitAndNotify({ retries: retries - 1, terminalId: targetTerminalId }),
            50,
          );
        }
        return;
      }
      fit.fit();
      term.scrollToBottom();
      void notifySizeIfChanged(targetTerminalId, term.cols, term.rows);
      if (retries > 1) {
        window.setTimeout(
          () => fitAndNotify({ retries: retries - 1, terminalId: targetTerminalId }),
          50,
        );
      }
    });
  }

  async function notifySizeIfChanged(targetTerminalId: string, cols: number, rows: number) {
    if (
      lastNotifiedSize?.terminalId === targetTerminalId &&
      lastNotifiedSize.cols === cols &&
      lastNotifiedSize.rows === rows
    ) {
      return;
    }
    lastNotifiedSize = {
      terminalId: targetTerminalId,
      cols,
      rows,
    };
    await assistantTerminals.resize(targetTerminalId, cols, rows);
  }

  function focusTerminal() {
    requestAnimationFrame(() => term?.focus());
  }

  function containerHoldsFocus(): boolean {
    const active = typeof document === "undefined" ? null : document.activeElement;
    return Boolean(container && active && container.contains(active));
  }

  function focusIsUnclaimed(): boolean {
    if (typeof document === "undefined") return false;
    const active = document.activeElement;
    return !active || active === document.body;
  }

  // Focus synchronously within the tap gesture (not via rAF) so iOS raises the
  // on-screen keyboard — it only does so for a focus change made inside a user
  // gesture. Falls back to the deferred focus while the terminal is mounting.
  function focusTerminalFromGesture() {
    if (term) term.focus();
    else focusTerminal();
  }

  function disposeTerminal() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (resizeSettleTimer !== null) {
      window.clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }
    term?.dispose();
    term = null;
    fit = null;
    // Disposing mid-replay discards xterm's write queue without running the
    // completion callbacks; reset so the counter can't stay stuck above zero.
    replayWritesInFlight = 0;
    renderedTabId = null;
    renderedBufferEndOffset = 0;
    lastNotifiedSize = null;
    container?.replaceChildren();
  }

  function readVariable(name: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  let fontReady: Promise<unknown> | null = null;
  let fontReadyKey = "";
  function ensureTerminalFont(fontFamily: string, fontSize: number): Promise<unknown> {
    if (typeof document === "undefined" || !("fonts" in document)) return Promise.resolve();
    const key = `${fontSize}:${fontFamily}`;
    if (!fontReady || fontReadyKey !== key) {
      fontReadyKey = key;
      fontReady = Promise.all([
        document.fonts.load(`${fontSize}px ${fontFamily}`),
        document.fonts.load(`bold ${fontSize}px ${fontFamily}`),
      ]).catch(() => undefined);
    }
    return fontReady;
  }

  function terminalStyle() {
    const fontFamily = readVariable("--psx-terminal-font") || "Menlo, Monaco, Consolas, monospace";
    const fontSize = readFontSize();
    return {
      ...terminalCursorOptions(),
      fontFamily,
      fontSize,
      lineHeight: readLineHeight(),
      theme: getTheme(),
    };
  }

  function terminalCursorOptions(): {
    cursorStyle: XtermCursorStyle;
    cursorInactiveStyle: XtermCursorInactiveStyle;
  } {
    const preference = readTerminalCursorPreference();
    if (preference === "bar") return { cursorStyle: "bar", cursorInactiveStyle: "bar" };
    if (preference === "underline") {
      return { cursorStyle: "underline", cursorInactiveStyle: "underline" };
    }
    return { cursorStyle: "block", cursorInactiveStyle: "block" };
  }

  function readTerminalCursorPreference(): TerminalCursorPreference {
    const value = readVariable("--psx-terminal-cursor-style");
    if (value === "bar" || value === "underline") return value;
    return "block";
  }

  function readNumVariableWithDefault(name: string, defaultVal: number) {
    const num = parseInt(readVariable(name), 10);
    return num === 0 || Number.isNaN(num) ? defaultVal : num;
  }

  function readFontSize() {
    return readNumVariableWithDefault("--psx-terminal-font-size", 13);
  }

  function readLineHeight() {
    const value = readVariable("--psx-terminal-line-height");
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed) || parsed <= 0) return 1.25;
    if (value.endsWith("px")) return Math.max(1, parsed / readFontSize());
    return Math.min(Math.max(parsed, 1), 2);
  }

  function getTheme(): ITheme {
    return {
      foreground: readVariable("--psx-terminal-foreground"),
      background:
        readVariable("--psx-terminal-background") || readVariable("--psx-editor-background"),
      cursor: readVariable("--psx-terminal-cursor"),
      cursorAccent: readVariable("--psx-terminal-cursor-accent"),
      selectionBackground: readVariable("--psx-terminal-selection-background"),
      selectionForeground: readVariable("--psx-terminal-selection-foreground"),
      selectionInactiveBackground: readVariable("--psx-terminal-selection-inactive-background"),
      black: readVariable("--psx-terminal-black"),
      red: readVariable("--psx-terminal-red"),
      green: readVariable("--psx-terminal-green"),
      yellow: readVariable("--psx-terminal-yellow"),
      blue: readVariable("--psx-terminal-blue"),
      magenta: readVariable("--psx-terminal-magenta"),
      cyan: readVariable("--psx-terminal-cyan"),
      white: readVariable("--psx-terminal-white"),
      brightBlack: readVariable("--psx-terminal-bright-black"),
      brightRed: readVariable("--psx-terminal-bright-red"),
      brightGreen: readVariable("--psx-terminal-bright-green"),
      brightYellow: readVariable("--psx-terminal-bright-yellow"),
      brightBlue: readVariable("--psx-terminal-bright-blue"),
      brightMagenta: readVariable("--psx-terminal-bright-magenta"),
      brightCyan: readVariable("--psx-terminal-bright-cyan"),
      brightWhite: readVariable("--psx-terminal-bright-white"),
    };
  }

  onDestroy(disposeTerminal);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class={["terminal-body", className]} onpointerdown={focusTerminalFromGesture}>
  <!-- Nothing while the terminal id is still pending: the wait is short, and a
       placeholder only reads as a flash of text before the shell paints. -->
  {#if terminalId}
    <div bind:this={container} class="terminal-xterm"></div>
  {/if}
</div>

<style lang="postcss">
  .terminal-body {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    background: var(--psx-terminal-background);
  }

  .terminal-xterm {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    overflow: hidden;
  }

  .terminal-xterm :global(.xterm) {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 8px 10px 14px;
  }

  .terminal-xterm :global(.xterm-screen) {
    position: relative;
  }

  .terminal-xterm :global(.xterm-selection div) {
    background-color: var(--psx-terminal-selection-background) !important;
  }

  .terminal-xterm :global(.xterm:not(.focus) .xterm-selection div) {
    background-color: var(--psx-terminal-selection-inactive-background) !important;
  }

  .terminal-xterm :global(.xterm-viewport) {
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .terminal-xterm :global(.xterm-screen),
  .terminal-xterm :global(.xterm-rows) {
    width: 100% !important;
  }
</style>
