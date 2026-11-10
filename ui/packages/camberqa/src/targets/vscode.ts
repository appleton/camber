/**
 * VS Code Electron target.
 *
 * Launches VS Code via Playwright's Electron API and navigates to the
 * webview frame chain: page → iframe.webview → iframe[title="<panel title>"].
 *
 * The Camber sidebar (title="Camber") is the default panel. Additional
 * editor-area webview panels (e.g. "Review Changes" diff view) are discovered
 * on demand via discoverPanels() and selectable via selectPanel().
 *
 * The extension dev server (Vite) must be started separately by the user
 * before running camberqa (e.g. `pnpm turbo dev -F camber-assistant`).
 */

import { parse as parseJsonc } from "jsonc-parser";
import { execFileSync, execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  type Frame,
  type FrameLocator,
  type Locator,
  type Page,
} from "playwright";
import { sleep } from "../utils.js";
import { slotColor } from "../worktree/shared.js";
import type { PanelInfo, WebIssue, WindowBounds, WindowInfo } from "./types.js";

export interface LaunchOptions {
  project?: string;
  dev?: boolean;
  extensionDir?: string;
  useProfile?: boolean;
  colorTheme?: string;
  worktreeSlot?: number;
  worktreeId?: string;
  agentMode?: "acp" | "classic";
}

export const CAMBER_PANEL_NAME = "Camber";
export const CAMBER_HELPER_LOG_NAME = "camber Helper";

export function outputLogChannelName(fileName: string): string | null {
  if (!fileName.endsWith(".log")) return null;

  return fileName.replace(/^\d+-/, "").slice(0, -".log".length);
}

// macOS Unix sockets are limited to 103 chars (sun_path is 104 bytes incl. null).
// VS Code's IPC socket lives at `<userDir>/<version>-main.sock`. For long worktree
// paths the socket name gets silently truncated by the kernel, then VS Code's
// stale-handle cleanup unlinks the untruncated name, gets ENOENT, and aborts the
// launch. Putting the data dirs under /tmp keeps the socket path short and unique
// per worktree (hashed from packageDir).
export function camberqaDataDirs(packageDir: string): {
  userDir: string;
  extensionsDir: string;
} {
  const hash = crypto.createHash("sha256").update(packageDir).digest("hex").slice(0, 8);
  return {
    userDir: `/tmp/camberqa-data-${hash}`,
    extensionsDir: `/tmp/camberqa-ext-${hash}`,
  };
}

export class VscodeTarget {
  readonly kind = "vscode" as const;

  private app: ElectronApplication | null = null;
  private page: Page | null = null;
  private camberWebviewFrame: FrameLocator | null = null;
  private camberRawFrame: Frame | null = null;

  private panels: Map<string, PanelInfo> = new Map();
  private camberPanelName: string = CAMBER_PANEL_NAME;
  private currentPanelName: string = CAMBER_PANEL_NAME;
  private helperLogName: string = CAMBER_HELPER_LOG_NAME;

  private refMap: Map<string, Locator> = new Map();
  private lastSnapshot: string | null = null;
  private webIssues: WebIssue[] = [];

  async launch(opts: LaunchOptions = {}): Promise<void> {
    const repoRoot = await this.findRepoRoot();
    if (!repoRoot) {
      throw new Error("Cannot find repo root.");
    }

    const extensionDir = opts.extensionDir || path.join(repoRoot, "ui/apps/vscode-assistant");
    if (!fs.existsSync(path.join(extensionDir, "package.json"))) {
      throw new Error(`Extension directory not found: ${extensionDir}`);
    }

    if (opts.dev) {
      const distDir = path.join(extensionDir, "dist");
      if (!fs.existsSync(distDir)) {
        console.log(
          "[camberqa] Extension not built — running pnpm turbo build -F camber-assistant...",
        );
        execFileSync("pnpm", ["turbo", "build", "-F", "camber-assistant"], {
          cwd: repoRoot,
          stdio: "inherit",
        });
        if (!fs.existsSync(distDir)) {
          throw new Error(`Build completed but ${distDir} still missing.`);
        }
        console.log("[camberqa] Extension built successfully.");
      }
    }

    const executablePath = process.env.VSCODE_EXECUTABLE_PATH || this.findInstalledVSCode();
    if (!executablePath) {
      throw new Error(
        "Cannot find VS Code. Set VSCODE_EXECUTABLE_PATH or install VS Code to /Applications/.",
      );
    }

    const packageDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
    const { userDir, extensionsDir } = camberqaDataDirs(packageDir);
    const userSubdir = path.join(userDir, "User");
    fs.mkdirSync(userSubdir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });

    if (opts.useProfile) {
      const vscodeUserDir = path.join(os.homedir(), "Library/Application Support/Code/User");

      const settingsDst = path.join(userSubdir, "settings.json");
      const settingsSrc = path.join(vscodeUserDir, "settings.json");
      let settings: Record<string, unknown> = {};
      if (fs.existsSync(settingsSrc)) {
        try {
          const raw = fs.readFileSync(settingsSrc, "utf-8");
          settings = parseJsonc(raw) ?? {};
        } catch {
          // Malformed settings.json — start fresh
        }
      }

      // Suppress recommendation popups and notifications
      const overrides: Record<string, unknown> = {
        "extensions.ignoreRecommendations": true,
        "extensions.showRecommendationsOnlyOnDemand": true,
        "workbench.enableExperiments": false,
        "update.showReleaseNotes": false,
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
      };
      if (opts.colorTheme) {
        overrides["workbench.colorTheme"] = opts.colorTheme;
      }
      if (opts.agentMode) {
        overrides["camber.agentMode"] = opts.agentMode;
      }
      if (opts.worktreeSlot) {
        const bg = slotColor(opts.worktreeSlot);
        overrides["workbench.colorCustomizations"] = {
          "titleBar.activeBackground": bg,
          "titleBar.activeForeground": "#1f2937",
          "statusBar.background": bg,
          "statusBar.foreground": "#1f2937",
          "activityBar.background": bg,
        };
        overrides["window.title"] =
          `[slot ${opts.worktreeSlot}] ${opts.worktreeId ?? "worktree"} — \${activeEditorShort}`;
      }
      Object.assign(settings, overrides);

      fs.writeFileSync(settingsDst, JSON.stringify(settings, null, "\t"));
      console.log("[camberqa] Wrote user settings.json (with popups suppressed)");

      // Copy globalStorage (extensions state, etc.) but skip the workspace
      // state DB so each camberqa run starts from a clean per-workspace state.
      const globalStorageSrc = path.join(vscodeUserDir, "globalStorage");
      const globalStorageDst = path.join(userSubdir, "globalStorage");
      if (fs.existsSync(globalStorageSrc)) {
        fs.cpSync(globalStorageSrc, globalStorageDst, {
          recursive: true,
          force: true,
          filter: (src) => !src.endsWith("state.vscdb") && !src.endsWith("state.vscdb-journal"),
        });
        console.log("[camberqa] Copied user globalStorage");
      }
    }

    const args: string[] = [
      "--disable-updates",
      "--disable-workspace-trust",
      "--new-window",
      `--user-data-dir=${userDir}`,
      `--extensions-dir=${extensionsDir}`,
      "--skip-release-notes",
      "--skip-welcome",
      "--disable-telemetry",
      "--sync",
      "off",
      "--enable-proposed-api=appleton.camber-assistant",
    ];

    if (opts.dev) {
      args.push(`--extensionDevelopmentPath=${extensionDir}`);
      args.push("--disable-extension=appleton.camber-assistant");
    }

    // Use a stable .code-workspace file so VS Code reuses the same workspace
    // storage hash across launches, preserving sidebar state and other prefs.
    const workspaceFolders: { path: string }[] = [];
    if (opts.project) {
      workspaceFolders.push({ path: path.resolve(opts.project) });
    } else if (opts.useProfile) {
      const demoDir = path.resolve(repoRoot, "..", "camber-books-api-demo");
      if (fs.existsSync(demoDir)) {
        workspaceFolders.push({ path: demoDir });
      }
      workspaceFolders.push({ path: repoRoot });
    }

    if (workspaceFolders.length > 0) {
      const workspaceFile = path.join(userDir, "camberqa.code-workspace");
      fs.writeFileSync(workspaceFile, JSON.stringify({ folders: workspaceFolders }, null, "\t"));
      args.push(workspaceFile);
    }

    console.log(`[camberqa] Launching VS Code: ${executablePath}`);
    console.log(`[camberqa] Extension dir: ${extensionDir}`);
    this.app = await electron.launch({
      executablePath,
      args,
      env: {
        ...process.env,
        NODE_ENV: "development",
      },
    });

    this.page = await this.app.firstWindow();
    this.observePage(this.page);

    console.log("[camberqa] Waiting for webview frame...");
    await this.acquireFrames();

    console.log("[camberqa] Waiting for webview readiness...");
    try {
      await this.waitForWebviewReady();
    } catch (err: any) {
      console.warn(`[camberqa] Webview readiness check failed: ${err.message}`);
    }

    console.log("[camberqa] VS Code launched and webview ready.");
  }

  async close(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
      this.page = null;
      this.camberWebviewFrame = null;
      this.camberRawFrame = null;
      this.panels.clear();
      this.camberPanelName = CAMBER_PANEL_NAME;
      this.currentPanelName = CAMBER_PANEL_NAME;
      this.helperLogName = CAMBER_HELPER_LOG_NAME;
      this.refMap.clear();
      this.lastSnapshot = null;
      this.webIssues = [];
    }
  }

  async getWindowInfo(): Promise<WindowInfo> {
    if (!this.app) {
      throw new Error("VS Code not launched");
    }

    return this.app.evaluate(({ BrowserWindow, screen }) => {
      const focused = BrowserWindow.getFocusedWindow();
      const fallback = BrowserWindow.getAllWindows()[0];
      const win = focused || fallback;
      if (!win) {
        throw new Error("No VS Code window available");
      }

      const displays = screen.getAllDisplays().map((display: any) => ({
        id: display.id,
        label: display.label,
        isPrimary: display.id === screen.getPrimaryDisplay().id,
        bounds: display.bounds,
        workArea: display.workArea,
      }));

      const bounds = win.getBounds();
      const displayForWindow = screen.getDisplayMatching(bounds);
      return {
        displays,
        window: {
          title: win.getTitle(),
          bounds,
          displayId: displayForWindow ? displayForWindow.id : null,
        },
      };
    });
  }

  async setWindowBounds(bounds: WindowBounds): Promise<void> {
    if (!this.app) {
      throw new Error("VS Code not launched");
    }

    await this.app.evaluate(({ BrowserWindow }, nextBounds) => {
      const focused = BrowserWindow.getFocusedWindow();
      const fallback = BrowserWindow.getAllWindows()[0];
      const win = focused || fallback;
      if (!win) {
        throw new Error("No VS Code window available");
      }
      win.setBounds(nextBounds);
    }, bounds);
  }

  /**
   * Verify the Camber sidebar webview frame is visible and usable.
   * Detects detached frames and hidden iframes (closed sidebar).
   */
  async ensureReady(): Promise<boolean> {
    if (!this.app || !this.page || !this.camberRawFrame) return false;
    if (this.camberRawFrame.isDetached()) {
      this.invalidateFrames();
      return false;
    }
    try {
      const visible = await this.camberRawFrame.evaluate(
        () => window.innerWidth > 0 && window.innerHeight > 0,
      );
      if (!visible) {
        this.invalidateFrames();
        return false;
      }
      return true;
    } catch {
      this.invalidateFrames();
      return false;
    }
  }

  async checkAlive(): Promise<boolean> {
    if (!this.app || !this.page) return false;
    try {
      await this.page.evaluate(() => true);
      return true;
    } catch {
      this.app = null;
      this.page = null;
      this.invalidateFrames();
      return false;
    }
  }

  private invalidateFrames(): void {
    this.camberWebviewFrame = null;
    this.camberRawFrame = null;
    this.panels.clear();
    this.refMap.clear();
    this.lastSnapshot = null;
  }

  /**
   * Re-acquire page and frames after a window reload (e.g. Developer: Reload Window).
   * The Electron app survives but all pages and frames are replaced.
   */
  async reacquireAfterReload(): Promise<void> {
    if (!this.app) throw new Error("VS Code not launched");
    this.invalidateFrames();

    // After reload, the old page is gone — get the new first window
    this.page = await this.app.firstWindow();
    this.observePage(this.page);

    await this.acquireFrames();
    try {
      await this.waitForWebviewReady();
    } catch (err: any) {
      console.warn(`[camberqa] Webview readiness check failed after reload: ${err.message}`);
    }
  }

  async focusWebview(): Promise<void> {
    if (!this.page) throw new Error("VS Code not launched");

    // Try re-acquiring frames first — the sidebar may still be open but
    // our frame references were simply invalidated.
    await this.acquireFrames();
    if (await this.ensureReady()) {
      this.currentPanelName = this.camberPanelName;
      return;
    }

    await this.page.keyboard.press("Meta+Shift+KeyP");
    await this.page.locator(".quick-input-widget").waitFor({ state: "visible", timeout: 5000 });
    await this.page.keyboard.type(`View: Show ${this.camberPanelName}`, { delay: 30 });
    await sleep(500);
    await this.page.keyboard.press("Enter");
    await this.page.locator(".quick-input-widget").waitFor({ state: "hidden", timeout: 5000 });

    await this.acquireFrames();
    this.currentPanelName = this.camberPanelName;
  }

  getPage(): Page {
    if (!this.page) throw new Error("VS Code not launched");
    return this.page;
  }

  /**
   * Frame locator for the Camber sidebar specifically.
   * Always targets the sidebar regardless of selectPanel state — used by
   * Camber-specific commands (sendMessage, listConversations, etc.).
   */
  getCamberWebviewFrame(): FrameLocator {
    if (!this.camberWebviewFrame) throw new Error("Camber webview not available");
    return this.camberWebviewFrame;
  }

  /** Raw Camber sidebar frame. Always targets the sidebar. */
  getCamberRawFrame(): Frame | null {
    return this.camberRawFrame;
  }

  /**
   * Frame locator for the currently selected panel (Camber by default).
   * Used by generic commands (snapshot, screenshot, click, fill, etc.) so
   * they automatically operate on whichever panel the user has selected.
   */
  getWebviewFrame(): FrameLocator {
    if (!this.page) throw new Error("VS Code not launched");
    if (this.currentPanelName === this.camberPanelName) {
      return this.getCamberWebviewFrame();
    }
    return this.page
      .frameLocator("iframe.webview")
      .frameLocator(`iframe[title="${this.currentPanelName}"]`);
  }

  /** Raw frame for the currently selected panel. */
  getRawFrame(): Frame | null {
    if (this.currentPanelName === this.camberPanelName) {
      return this.camberRawFrame;
    }
    const panel = this.panels.get(this.currentPanelName);
    return panel?.rawFrame ?? null;
  }

  getCurrentPanelName(): string {
    return this.currentPanelName;
  }

  /**
   * Discover all live webview panels in the VS Code window. Each panel is
   * keyed by its iframe title (e.g. "Camber", "Review Changes").
   *
   * Walks page.frames(), keeping any frame whose URL ends with fake.html
   * and whose parent is a vscode-webview iframe. The panel name is read
   * from the iframe[title] attribute on the parent's DOM.
   */
  async discoverPanels(): Promise<PanelInfo[]> {
    if (!this.page) throw new Error("VS Code not launched");

    const next = new Map<string, PanelInfo>();
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      if (!frame.url().includes("fake.html")) continue;
      const parent = frame.parentFrame();
      if (!parent || !parent.url().includes("webview")) continue;

      let title: string | null = null;
      try {
        title = await parent.evaluate(() => {
          const iframe = document.querySelector("iframe[title]") as HTMLIFrameElement | null;
          return iframe ? iframe.getAttribute("title") : null;
        });
      } catch {
        continue;
      }
      if (!title) continue;
      if (next.has(title)) continue;
      next.set(title, { name: title, rawFrame: frame });
    }

    this.panels = next;
    return Array.from(next.values());
  }

  async selectPanel(name: string): Promise<void> {
    const panels = await this.discoverPanels();
    const exact = panels.find((p) => p.name === name);
    const fuzzy = exact ?? panels.find((p) => p.name.toLowerCase().includes(name.toLowerCase()));
    if (!fuzzy) {
      const available = panels.map((p) => `"${p.name}"`).join(", ") || "(none)";
      throw new Error(`Panel "${name}" not found. Available: ${available}`);
    }
    this.currentPanelName = fuzzy.name;
    this.refMap.clear();
    this.lastSnapshot = null;
  }

  setRefMap(refs: Map<string, Locator>) {
    this.refMap = refs;
  }

  resolveRef(selector: string): { locator: Locator } | { selector: string } {
    if (selector.startsWith("@e")) {
      const ref = selector.slice(1);
      const locator = this.refMap.get(ref);
      if (!locator) {
        throw new Error(`Ref ${selector} not found. Run 'snapshot' to get fresh refs.`);
      }
      return { locator };
    }
    return { selector };
  }

  setLastSnapshot(text: string | null) {
    this.lastSnapshot = text;
  }

  getLastSnapshot(): string | null {
    return this.lastSnapshot;
  }

  getWebIssues(opts: { includeAll?: boolean; limit?: number; clear?: boolean } = {}): WebIssue[] {
    const limit = opts.limit ?? 50;
    const entries = opts.includeAll
      ? this.webIssues
      : this.webIssues.filter((entry) => entry.kind === "pageerror" || entry.level === "error");
    const selected = entries.slice(-limit);
    if (opts.clear) {
      this.webIssues = [];
    }
    return selected;
  }

  findLatestHelperLog(): string | null {
    return this.findLatestHelperLogByName(this.helperLogName);
  }

  /**
   * Find the most recent helper log file from the camberqa user-data-dir on disk.
   */
  findLatestHelperLogByName(helperLogName: string): string | null {
    const packageDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
    const { userDir } = camberqaDataDirs(packageDir);
    const logsRoot = path.join(userDir, "logs");
    if (!fs.existsSync(logsRoot)) return null;

    let bestPath: string | null = null;
    let bestMtime = 0;

    const sessionDirs = fs.readdirSync(logsRoot).sort().reverse();
    for (const session of sessionDirs) {
      const exthostDir = path.join(logsRoot, session, "window1", "exthost");
      if (!fs.existsSync(exthostDir)) continue;

      const outputDirs = fs
        .readdirSync(exthostDir)
        .filter((d) => d.startsWith("output_logging_"))
        .sort()
        .reverse();

      for (const outputDir of outputDirs) {
        const dir = path.join(exthostDir, outputDir);
        const files = fs
          .readdirSync(dir)
          .filter((f) => outputLogChannelName(f)?.toLowerCase() === helperLogName.toLowerCase());
        for (const file of files) {
          const filePath = path.join(dir, file);
          const mtime = fs.statSync(filePath).mtimeMs;
          if (mtime > bestMtime) {
            bestPath = filePath;
            bestMtime = mtime;
          }
        }
      }

      if (bestPath) return bestPath;
    }

    return null;
  }

  // ─── Private ───────────────────────────────────────────────

  private observePage(page: Page): void {
    page.on("console", (message) => {
      this.pushWebIssue({
        kind: "console",
        level: message.type(),
        text: message.text(),
        timestamp: new Date().toISOString(),
        location: message.location(),
      });
    });
    page.on("pageerror", (error) => {
      this.pushWebIssue({
        kind: "pageerror",
        level: "error",
        text: error.stack || error.message,
        timestamp: new Date().toISOString(),
      });
    });
  }

  private pushWebIssue(issue: WebIssue): void {
    this.webIssues.push(issue);
    if (this.webIssues.length > 500) {
      this.webIssues = this.webIssues.slice(-500);
    }
  }

  /**
   * Single source of truth for Camber sidebar frame discovery.
   * Polls for the Camber frame, then sets camberRawFrame and
   * camberWebviewFrame.
   */
  private async acquireFrames(): Promise<void> {
    if (!this.page) return;

    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      const frames = this.page.frames();
      // The Camber sidebar is the first webview to appear at launch and is
      // identified by the iframe[title="Camber"] in its parent's DOM.
      for (const frame of frames) {
        if (!frame.url().includes("fake.html")) continue;
        const parent = frame.parentFrame();
        if (!parent || !parent.url().includes("webview")) continue;
        let title: string | null = null;
        try {
          title = await parent.evaluate(() => {
            const iframe = document.querySelector("iframe[title]") as HTMLIFrameElement | null;
            return iframe ? iframe.getAttribute("title") : null;
          });
        } catch {
          continue;
        }
        if (title === this.camberPanelName) {
          this.camberRawFrame = frame;
          this.camberWebviewFrame = this.page
            .frameLocator("iframe.webview")
            .frameLocator(`iframe[title="${this.camberPanelName}"]`);
          return;
        }
      }
      await sleep(500);
    }
    console.warn(
      "[camberqa] Could not find raw Camber frame — snapshot may fall back to innerHTML",
    );
  }

  private findInstalledVSCode(): string | null {
    const candidates = [
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      path.join(os.homedir(), "Applications/Visual Studio Code.app/Contents/MacOS/Electron"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  private async findRepoRoot(): Promise<string | null> {
    // Derive from this package's location: ui/packages/camberqa/src/targets/ → repo root
    const packageDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
    const fromPackage = path.resolve(packageDir, "../../..");
    if (fs.existsSync(path.join(fromPackage, "ui/apps/vscode-assistant/package.json"))) {
      return fromPackage;
    }

    // Fallback: git root from cwd
    try {
      const root = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
        cwd: process.cwd(),
      }).trim();
      if (fs.existsSync(path.join(root, "ui/apps/vscode-assistant/package.json"))) {
        return root;
      }
    } catch {
      // Not in a git repo
    }

    return null;
  }

  private async waitForWebviewReady(): Promise<void> {
    if (!this.camberWebviewFrame) throw new Error("Webview frame not set");

    const loadingText = this.camberWebviewFrame.getByText("Grabbing a deckchair…");
    try {
      await loadingText.waitFor({ state: "hidden", timeout: 20_000 });
    } catch {
      // Loading text may never appear if already loaded
    }

    const emptyState = this.camberWebviewFrame.locator('[data-testid="empty-state-container"]');
    const chatMessages = this.camberWebviewFrame.locator(".scrollView");

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const emptyVisible = await emptyState.isVisible().catch(() => false);
        const chatVisible = await chatMessages.isVisible().catch(() => false);
        if (emptyVisible || chatVisible) return;
      } catch {
        // Frame may not be ready yet
      }
      await sleep(500);
    }

    console.warn("[camberqa] Webview readiness check timed out — proceeding anyway");
  }
}
