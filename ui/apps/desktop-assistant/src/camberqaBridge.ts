import { appState, type ACPDebugAPI } from "@camber/features/acp";
import { invoke } from "@tauri-apps/api/core";
import { computeAccessibleName, getRole } from "dom-accessibility-api";
import { toPng } from "html-to-image";
import {
  getScreenshotableWindows,
  getWindowScreenshot,
  type ScreenshotableWindow,
} from "tauri-plugin-screenshots-api";

interface BridgeCommand {
  id: string;
  command: string;
  args: string[];
}

interface SnapshotNode {
  role: string;
  name: string;
  depth: number;
  ref?: string;
}

interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
}

interface ScreenshotOptions {
  output: string;
  webviewOnly: boolean;
}

type WebIssueKind = "console" | "pageerror";

interface WebIssue {
  kind: WebIssueKind;
  level: string;
  text: string;
  timestamp: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

const refs = new Map<string, Element>();
const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const webIssues: WebIssue[] = [];
let webIssueCaptureStarted = false;
let getACPDebugAPI: (() => ACPDebugAPI | undefined) | undefined;

export function startCamberQABridge(getDebugAPI?: () => ACPDebugAPI | undefined) {
  getACPDebugAPI = getDebugAPI;
  const params = new URLSearchParams(window.location.search);
  const bridgeUrl =
    params.get("camberqaBridgeUrl") ??
    (import.meta.env.VITE_CAMBERQA_BRIDGE_URL as string | undefined);
  const token =
    params.get("camberqaBridgeToken") ??
    (import.meta.env.VITE_CAMBERQA_BRIDGE_TOKEN as string | undefined);
  if (!bridgeUrl || !token) return;

  startWebIssueCapture();
  void poll(bridgeUrl, token);
}

/**
 * Runs a bridge flow with native OS confirmation dialogs disabled so any
 * confirmation renders as a DOM dialog the bridge can see and click. Native
 * dialogs are invisible to the bridge and would wedge the flow.
 */
async function withDomConfirmationDialogs<T>(run: () => Promise<T>): Promise<T> {
  let previous: boolean | undefined;
  const setNativeConfirmDialog = (value: boolean | undefined) => {
    appState.update((state) => {
      previous = state.environment.capabilities.nativeConfirmDialog;
      return {
        ...state,
        environment: {
          ...state.environment,
          capabilities: { ...state.environment.capabilities, nativeConfirmDialog: value },
        },
      };
    });
  };
  setNativeConfirmDialog(false);
  const restore = previous;
  try {
    return await run();
  } finally {
    setNativeConfirmDialog(restore);
  }
}

async function poll(bridgeUrl: string, token: string): Promise<void> {
  while (true) {
    try {
      const resp = await fetch(`${bridgeUrl}/next`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.status === 204) {
        await sleep(250);
        continue;
      }
      if (!resp.ok) throw new Error(`bridge poll failed: ${resp.status}`);
      const item = (await resp.json()) as BridgeCommand;
      void executeAndReport(bridgeUrl, token, item);
    } catch (error) {
      console.debug("camberqa bridge polling failed", error);
      await sleep(1000);
    }
  }
}

async function executeAndReport(bridgeUrl: string, token: string, item: BridgeCommand) {
  let result: { ok: true; body: string } | { ok: false; error: string };
  try {
    result = { ok: true, body: await executeCommand(item.command, item.args) };
  } catch (error) {
    result = { ok: false, error: describeError(error) };
  }
  await fetch(`${bridgeUrl}/result`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: item.id, ...result }),
  }).catch((error) => console.debug("camberqa bridge result failed", error));
}

async function executeCommand(command: string, args: string[]): Promise<string> {
  switch (command) {
    case "snapshot":
      return snapshot(args);
    case "click":
      return click(args);
    case "fill":
      return fill(args);
    case "type":
      return typeText(args);
    case "press":
      return pressKey(args);
    case "scroll":
      return scroll(args);
    case "wait":
      return waitForSelector(args);
    case "hover":
      return hover(args);
    case "text":
      return text(args);
    case "html":
      return html(args);
    case "js":
      return js(args);
    case "webErrors":
      return webErrors(args);
    case "screenshot":
      return screenshot(args);
    case "screenshotElement":
      return screenshotElement(args);
    case "component":
      return component(args);
    case "sendMessage":
      return sendMessage(args);
    case "openCommandMenu":
      return openCommandMenu();
    case "assertMessage":
      return assertMessage(args);
    case "waitForMessageCount":
      return waitForMessageCount(args);
    case "getLastResponse":
      return getLastResponse();
    case "newConversation":
      return newConversation(args);
    case "archiveConversation":
      return archiveConversation(args);
    case "getConfigs":
      return getConfigs();
    case "setConfig":
      return setConfig(args);
    case "openHistory":
      return openHistory();
    case "closeHistory":
      return closeHistory();
    case "deleteConversation":
      return deleteConversation(args);
    case "restoreConversation":
      return restoreConversation(args);
    case "listConversations":
      return listConversations();
    case "selectConversation":
      return selectConversation(args);
    case "getCurrentConversation":
      return getCurrentConversation();
    case "listProjects":
      return listProjects();
    case "listWorktrees":
      return listWorktrees(args);
    case "openProject":
      return openProject(args);
    case "closeProject":
      return closeProject(args);
    case "removeProject":
      return removeProject(args);
    case "createWorktree":
      return createWorktree(args);
    case "removeWorktree":
      return removeWorktree(args);
    case "openWorktree":
      return openWorktree(args);
    case "isStreaming":
      return String(isStreaming());
    case "stopGeneration":
      return stopGeneration();
    case "getMessageCount":
      return String(messageCount());
    case "helperLogs":
      return helperLogs(args);
    case "restartHelper":
      return restartHelper();
    case "restartACPServer":
      return restartACPServer(args);
    case "getACPDump":
      return getACPDump();
    case "loadACPDump":
      return loadACPDump(args);
    case "camberqaDebugGo":
      return camberqaDebugGo(args);
    default:
      throw new Error(`Desktop bridge command not supported yet: ${command}`);
  }
}

function startWebIssueCapture(): void {
  if (webIssueCaptureStarted) return;
  webIssueCaptureStarted = true;

  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      pushWebIssue({
        kind: "console",
        level,
        text: args.map(formatConsoleArg).join(" "),
        timestamp: new Date().toISOString(),
        location: { url: window.location.href },
      });
      original(...args);
    };
  }

  window.addEventListener("error", (event) => {
    pushWebIssue({
      kind: "pageerror",
      level: "error",
      text: event.error?.stack || event.message,
      timestamp: new Date().toISOString(),
      location: {
        url: event.filename || window.location.href,
        lineNumber: event.lineno,
        columnNumber: event.colno,
      },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    pushWebIssue({
      kind: "pageerror",
      level: "error",
      text: describeError(event.reason),
      timestamp: new Date().toISOString(),
      location: { url: window.location.href },
    });
  });
}

function pushWebIssue(issue: WebIssue): void {
  webIssues.push(issue);
  if (webIssues.length > 500) {
    webIssues.splice(0, webIssues.length - 500);
  }
}

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function acpDebugBridge(): {
  dumpJSON: () => string;
  load: (entries: string) => Promise<void>;
} {
  const bridge = getACPDebugAPI?.();
  if (!bridge) {
    throw new Error("ACP debug bridge is not available");
  }
  return bridge;
}

function getACPDump(): string {
  return acpDebugBridge().dumpJSON();
}

async function loadACPDump(args: string[]): Promise<string> {
  if (args.length === 0) {
    throw new Error('Usage: loadACPDump "json"');
  }
  await acpDebugBridge().load(args.join(" "));
  return "ACP dump loaded";
}

function snapshot(args: string[]): string {
  refs.clear();
  const opts = parseSnapshotArgs(args);
  const root = opts.selector
    ? resolveElement(opts.selector)
    : (document.querySelector("#app") ?? document.body);
  const nodes: SnapshotNode[] = [];
  let refCounter = 1;

  const visit = (element: Element, depth: number) => {
    if (!(element instanceof HTMLElement) || isHiddenSubtree(element)) return;

    const role = computedRole(element);
    const name = role ? computedName(element, role) : "";
    const interactive = role ? INTERACTIVE_ROLES.has(role) : false;
    const include =
      hasVisibleBox(element) &&
      role &&
      role !== "none" &&
      role !== "presentation" &&
      (!opts.interactive || interactive) &&
      (!opts.compact || interactive || name);

    let childDepth = depth;
    if (include) {
      if (opts.depth === undefined || depth <= opts.depth) {
        const ref = `e${refCounter++}`;
        refs.set(ref, element);
        nodes.push({ role, name, depth, ref });
      }
      childDepth = depth + 1;
    }

    for (const child of element.children) {
      visit(child, childDepth);
    }
  };

  visit(root, 0);

  if (nodes.length === 0) return "(no accessible elements found)";
  return nodes
    .map((node) => {
      const indent = "  ".repeat(node.depth);
      return `${indent}@${node.ref} [${node.role}]${node.name ? ` "${node.name}"` : ""}`;
    })
    .join("\n");
}

async function click(args: string[]): Promise<string> {
  const element = resolveElement(args[0]);
  (element as HTMLElement).click();
  return `Clicked ${args[0]}`;
}

async function fill(args: string[]): Promise<string> {
  const element = resolveFillElement(args[0]);
  const value = args.slice(1).join(" ");
  setElementText(element, value);
  return `Filled ${args[0]} with "${value}"`;
}

async function typeText(args: string[]): Promise<string> {
  const value = args.join(" ");
  const active =
    document.activeElement instanceof HTMLElement && isFillable(document.activeElement)
      ? document.activeElement
      : resolvePromptEditor();
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    active.focus();
    active.value += value;
    active.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  } else {
    active.focus();
    document.execCommand("insertText", false, value);
    active.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  }
  return `Typed "${value}"`;
}

async function pressKey(args: string[]): Promise<string> {
  const key = args[0];
  if (!key) throw new Error('Usage: press "Key"');
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  return `Pressed ${key}`;
}

async function scroll(args: string[]): Promise<string> {
  const direction = args[0] || "down";
  const amount = parseInt(args[1] || "300", 10);
  const delta = direction === "up" ? -amount : amount;
  const scrollable = document.querySelector(".scrollView") ?? document.scrollingElement;
  scrollable?.scrollBy(0, delta);
  return `Scrolled ${direction} ${amount}px`;
}

async function waitForSelector(args: string[]): Promise<string> {
  const selector = args[0];
  if (!selector) throw new Error('Usage: wait "selector" [timeout]');
  const timeout = parseInt(args[1] || "10000", 10);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const element = document.querySelector(selector);
    if (element instanceof HTMLElement && isVisible(element)) {
      return `Element "${selector}" is visible`;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for selector: ${selector}`);
}

async function hover(args: string[]): Promise<string> {
  const element = resolveElement(args[0]);
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  return `Hovered ${args[0]}`;
}

function text(args: string[]): string {
  return (args[0] ? resolveElement(args[0]) : document.body).textContent?.trim() || "(empty)";
}

function html(args: string[]): string {
  return (args[0] ? resolveElement(args[0]) : document.body).innerHTML;
}

function js(args: string[]): string {
  const result = globalThis.eval(args.join(" "));
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function webErrors(args: string[]): string {
  let includeAll = false;
  let clear = false;
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--all":
        includeAll = true;
        break;
      case "--clear":
        clear = true;
        break;
      case "--limit":
      case "-n":
        limit = parseInt(args[++i] || "", 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new Error("Usage: webErrors [--all] [--clear] [--limit N]");
        }
        break;
      default:
        throw new Error("Usage: webErrors [--all] [--clear] [--limit N]");
    }
  }

  const entries = includeAll
    ? webIssues
    : webIssues.filter((entry) => entry.kind === "pageerror" || entry.level === "error");
  const selected = entries.slice(-limit);
  if (clear) {
    webIssues.length = 0;
  }
  if (selected.length === 0) {
    return includeAll ? "(no web console entries captured)" : "(no web errors captured)";
  }
  return selected.map(formatWebIssue).join("\n\n");
}

function formatWebIssue(issue: WebIssue): string {
  const location = formatWebIssueLocation(issue);
  return `[${issue.timestamp}] ${issue.kind}:${issue.level}${location}\n${issue.text}`;
}

function formatWebIssueLocation(issue: WebIssue): string {
  if (!issue.location?.url) return "";
  const { url, lineNumber, columnNumber } = issue.location;
  const line = lineNumber !== undefined && lineNumber > 0 ? `:${lineNumber}` : "";
  const column = columnNumber !== undefined && columnNumber > 0 ? `:${columnNumber}` : "";
  return ` ${url}${line}${column}`;
}

async function screenshot(args: string[]): Promise<string> {
  const { output, webviewOnly } = parseScreenshotArgs(args);
  if (!webviewOnly) {
    const sourcePath = await nativeWindowScreenshot();
    return JSON.stringify({ output, sourcePath });
  }

  const dataUrl = await toPngWithTimeout(document.body);
  return JSON.stringify({ output, dataUrl });
}

async function screenshotElement(args: string[]): Promise<string> {
  const { refOrSelector, output, padding } = parseElementScreenshotArgs(args);
  const element = resolveElement(refOrSelector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Element ${refOrSelector} is not an HTMLElement`);
  }

  const sourcePath = await nativeWindowScreenshot();
  return JSON.stringify({ output, sourcePath, crop: elementCrop(element, padding) });
}

function component(args: string[]): string {
  const { refOrSelector, componentsOnly, maxDepth } = parseComponentArgs(args);
  const element = resolveElement(refOrSelector);
  const tree = componentTreeFor(element);

  if (!tree || tree.entries.length === 0) {
    return "(no Svelte component metadata found — is the app running in dev mode?)";
  }

  const prefix =
    tree.domStepsUp > 0
      ? `(no metadata on element — found nearest Svelte ancestor ${tree.domStepsUp} level${tree.domStepsUp > 1 ? "s" : ""} up)\n`
      : "";

  let filtered = tree.entries;
  if (componentsOnly) {
    filtered = tree.entries.filter((entry, i) => i === 0 || entry.type === "component");
  } else {
    filtered = tree.entries.filter(
      (entry, i) =>
        i === 0 || entry.file !== tree.entries[i - 1].file || entry.type === "component",
    );
  }

  if (maxDepth < Infinity) {
    filtered = filtered.slice(0, maxDepth + 1);
  }

  return (
    prefix +
    filtered
      .map((entry, i) => {
        const indent = "  ".repeat(i);
        const label = entry.componentTag ? `<${entry.componentTag}>` : `[${entry.type}]`;
        return `${indent}${label} ${entry.file}:${entry.line}`;
      })
      .join("\n")
  );
}

async function sendMessage(args: string[]): Promise<string> {
  if (args.length === 0) throw new Error('Usage: sendMessage "text"');
  const value = args.join(" ");
  setElementText(resolvePromptEditor(), value);

  const submit = document.querySelector(
    'button[data-testid="prompt-submit-button"]',
  ) as HTMLButtonElement | null;
  if (!submit) throw new Error("Prompt submit button not found");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!submit.disabled && submit.getAttribute("aria-disabled") !== "true") break;
    await sleep(100);
  }
  if (submit.disabled || submit.getAttribute("aria-disabled") === "true") {
    throw new Error("Prompt submit button did not become enabled");
  }
  submit.click();
  return `Sent: "${value}"`;
}

async function openCommandMenu(): Promise<string> {
  const trigger = document.querySelector("[data-prompt-trigger]") as HTMLElement | null;
  if (!trigger) throw new Error("Command menu trigger not found");
  trigger.click();
  return "Command menu opened";
}

async function assertMessage(args: string[]): Promise<string> {
  if (args.length === 0) throw new Error('Usage: assertMessage "text"');
  const value = args.join(" ");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((document.body.textContent ?? "").includes(value)) return `Message found: "${value}"`;
    await sleep(250);
  }
  throw new Error(`Message "${value}" not found within 10s`);
}

async function waitForMessageCount(args: string[]): Promise<string> {
  const expectedCount = parseInt(args[0], 10);
  const timeout = parseInt(args[1] || "30000", 10);
  if (!Number.isFinite(expectedCount))
    throw new Error("Usage: waitForMessageCount <count> [timeout]");

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = messageCount();
    if (count >= expectedCount) {
      while (Date.now() < deadline) {
        if (!isStreaming()) return `Message count: ${count}`;
        await sleep(250);
      }
      return `Message count: ${count} (still streaming)`;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out: expected ${expectedCount} messagePairs, got ${messageCount()} after ${timeout}ms`,
  );
}

function getLastResponse(): string {
  const pairs = document.querySelectorAll(".messagePair");
  if (pairs.length > 0) {
    const last = pairs[pairs.length - 1];
    const botBlocks = last.querySelector('[data-testid="bot-response-blocks"]');
    if (botBlocks instanceof HTMLElement) return botBlocks.innerText || "";
    const markdown = last.querySelector(".markdown");
    if (markdown instanceof HTMLElement) return markdown.innerText || "";
    return last instanceof HTMLElement ? last.innerText || "" : "";
  }

  const markdownBlocks = Array.from(document.querySelectorAll(".markdown")).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.innerText.trim().length > 0,
  );
  const lastMarkdown = markdownBlocks.at(-1);
  if (lastMarkdown) return lastMarkdown.innerText || "";
  return "(no messages found)";
}

async function newConversation(args: string[]): Promise<string> {
  // Desktop has no header-level "New conversation" button when the sidebar is
  // expanded (the user-driven affordance is the project- or worktree-scoped
  // button in the sidebar: aria-label="New conversation in {name}").
  const projects = collectBridgeProjects();
  const projectArgIdx = args.indexOf("--project");
  const worktreeArgIdx = args.indexOf("--worktree");

  let scopeName: string;
  let kind: "project" | "worktree";
  if (worktreeArgIdx >= 0 && worktreeArgIdx + 1 < args.length) {
    const wt = findBridgeWorktree(projects, args[worktreeArgIdx + 1]);
    if (!wt.project.expanded) {
      wt.project.headerButton.click();
      await sleep(200);
    }
    scopeName = wt.name;
    kind = "worktree";
  } else if (projectArgIdx >= 0 && projectArgIdx + 1 < args.length) {
    scopeName = findBridgeProject(projects, args[projectArgIdx + 1]).name;
    kind = "project";
  } else {
    if (projects.length === 0) throw new Error("No projects in the sidebar");
    scopeName = projects[0].name;
    kind = "project";
  }

  const button = document.querySelector(
    `button[aria-label="New conversation in ${scopeName}"]`,
  ) as HTMLButtonElement | null;
  if (!button) {
    throw new Error(`"New conversation in ${scopeName}" button not found`);
  }
  button.click();
  await sleep(500);
  return `Started new conversation in ${kind}: ${scopeName}`;
}

interface ConfigRow {
  name: string;
  trigger: HTMLButtonElement;
  value: string;
}

function findConfigRows(): ConfigRow[] {
  const labels = Array.from(document.querySelectorAll<HTMLSpanElement>("span")).filter((span) =>
    /^[A-Za-z][\w ]*:$/.test(span.textContent?.trim() ?? ""),
  );
  const seen = new Set<string>();
  const rows: ConfigRow[] = [];
  for (const span of labels) {
    const container = span.parentElement;
    if (!container) continue;
    const trigger = container.querySelector<HTMLButtonElement>("button");
    if (!trigger) continue;
    const valueSpan = trigger.querySelector<HTMLSpanElement>("span.truncate");
    if (!valueSpan) continue;
    const name = (span.textContent ?? "").trim().replace(/:$/, "");
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ name, trigger, value: (valueSpan.textContent ?? "").trim() });
  }
  return rows;
}

async function getConfigs(): Promise<string> {
  const rows = findConfigRows();
  if (rows.length === 0) {
    return "(no session config options found — is a conversation open?)";
  }
  return rows.map((row) => `${row.name}: ${row.value}`).join("\n");
}

async function setConfig(args: string[]): Promise<string> {
  if (args.length < 2) {
    throw new Error("Usage: setConfig <name> <value>");
  }
  const name = args[0];
  const value = args.slice(1).join(" ");

  const rows = findConfigRows();
  const nameNeedle = name.toLowerCase();
  const nameMatches = rows.filter((row) => row.name.toLowerCase().includes(nameNeedle));
  if (nameMatches.length === 0) {
    throw new Error(`No session config option matching "${name}"`);
  }
  if (nameMatches.length > 1) {
    throw new Error(`"${name}" matches multiple config options — be more specific`);
  }
  const row = nameMatches[0];

  row.trigger.click();
  await sleep(150);

  const menu = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).pop();
  if (!menu) {
    throw new Error(`Dropdown menu for "${row.name}" did not appear`);
  }

  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const valueNeedle = value.toLowerCase();
  const valueMatches = items
    .map((el) => ({ el, text: (el.textContent ?? "").trim() }))
    .filter((entry) => entry.text.toLowerCase().includes(valueNeedle));

  if (valueMatches.length === 0) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const available = items.map((el) => (el.textContent ?? "").trim()).join(", ");
    throw new Error(`No "${row.name}" option matching "${value}". Available: ${available}`);
  }
  if (valueMatches.length > 1) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    throw new Error(
      `"${value}" matches multiple "${row.name}" options: ${valueMatches.map((m) => m.text).join(", ")}`,
    );
  }

  valueMatches[0].el.click();
  await sleep(300);
  return `Set ${row.name} → ${valueMatches[0].text}`;
}

function historyBackButtonEl(): HTMLButtonElement | null {
  const settingsSearch = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search archived chats"]',
  );
  if (settingsSearch && settingsSearch.offsetParent !== null) {
    const settingsNav = document.querySelector<HTMLElement>('nav[aria-label="Settings sections"]');
    return (
      Array.from(settingsNav?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (button) => button.textContent?.trim() === "Back",
      ) ?? null
    );
  }
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]"));
  return (
    buttons.find((btn) =>
      /^Back to (projects|conversations)$/.test(btn.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

function historyIsOpen(): boolean {
  const settingsSearch = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search archived chats"]',
  );
  if (settingsSearch && settingsSearch.offsetParent !== null) return true;
  const back = historyBackButtonEl();
  return Boolean(back && back.offsetParent !== null);
}

async function ensureHistoryOpen(): Promise<boolean> {
  if (historyIsOpen()) return false;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]"));
  const openBtn = buttons.find((btn) =>
    /archived conversations/i.test(btn.getAttribute("aria-label") ?? ""),
  );
  if (openBtn) {
    openBtn.click();
  } else {
    let settingsNav = document.querySelector<HTMLElement>('nav[aria-label="Settings sections"]');
    if (!settingsNav) {
      const settingsButton = buttons.find(
        (button) => button.getAttribute("aria-label") === "Settings" && !button.closest("[inert]"),
      );
      if (!settingsButton) throw new Error('No "Settings" button found in the sidebar');
      settingsButton.click();
      const settingsDeadline = Date.now() + 5000;
      while (Date.now() < settingsDeadline) {
        settingsNav = document.querySelector<HTMLElement>('nav[aria-label="Settings sections"]');
        if (settingsNav) break;
        await sleep(100);
      }
    }
    const archivedButton = Array.from(
      settingsNav?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent?.trim() === "Archived Chats");
    if (!archivedButton) throw new Error('No "Archived Chats" button found in Settings');
    archivedButton.click();
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (historyIsOpen()) return true;
    await sleep(100);
  }
  throw new Error("Archived chats did not open within 5s");
}

async function openHistory(): Promise<string> {
  const opened = await ensureHistoryOpen();
  return opened ? "History opened" : "History already open";
}

async function closeHistory(): Promise<string> {
  if (!historyIsOpen()) return "History was not open";
  const back = historyBackButtonEl();
  if (!back) throw new Error("History back button not found");
  back.click();
  await sleep(300);
  return "History closed";
}

async function clickHistoryAction(args: string[], action: "Delete" | "Restore"): Promise<string> {
  if (args.length === 0) {
    throw new Error(`Usage: ${action.toLowerCase()}Conversation "title-substring"`);
  }
  const raw = args.join(" ");
  const target = raw.toLowerCase();
  await ensureHistoryOpen();

  const prefix = `${action} `;
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`button[aria-label^="${prefix}"]`),
  );
  const matches = buttons.filter((btn) =>
    (btn.getAttribute("aria-label") ?? "").slice(prefix.length).toLowerCase().includes(target),
  );
  if (matches.length === 0) {
    if (action === "Restore") {
      throw new Error(
        `No archived conversation matching "${raw}". (Restore is only available for archived sessions — for live conversations, use archiveConversation.)`,
      );
    }
    throw new Error(`No conversation matching "${raw}" in archived chats`);
  }
  if (matches.length > 1) {
    throw new Error(
      `"${raw}" matches multiple conversations — narrow the title to a unique substring`,
    );
  }
  const btn = matches[0];
  if (btn.hasAttribute("disabled")) {
    const reason = btn.getAttribute("title") ?? "";
    throw new Error(
      reason
        ? `Cannot ${action.toLowerCase()}: ${reason}`
        : `Cannot ${action.toLowerCase()} — the button is disabled for this conversation`,
    );
  }
  btn.click();
  if (action === "Delete") {
    // Deleting mounts a confirmation dialog; the withDomConfirmationDialogs
    // wrapper in deleteConversation keeps it in the DOM so it can be clicked.
    await sleep(200);
    const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
      isVisible,
    );
    if (!dialog) throw new Error("Delete conversation confirmation dialog did not open");
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => (button.textContent ?? "").trim() === "Delete Conversation",
    );
    if (!confirm) throw new Error("Delete Conversation confirmation button not found");
    confirm.click();
  }
  await sleep(500);
  const conversationTitle = (btn.getAttribute("aria-label") ?? "").slice(prefix.length);
  return `${action === "Delete" ? "Deleted" : "Restored"}: ${conversationTitle}`;
}

async function deleteConversation(args: string[]): Promise<string> {
  return withDomConfirmationDialogs(() => clickHistoryAction(args, "Delete"));
}

async function restoreConversation(args: string[]): Promise<string> {
  return clickHistoryAction(args, "Restore");
}

interface BridgeConversationEntry {
  index: number;
  title: string;
  agent: string;
  selected: boolean;
  button: HTMLButtonElement;
  project?: string;
  worktree?: string;
}

function rowIsSelected(button: HTMLElement): boolean {
  let el: HTMLElement | null = button.parentElement;
  while (el) {
    if (
      el.className &&
      typeof el.className === "string" &&
      el.className.includes("text-psx-menu-active-foreground")
    ) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

function readBridgeRow(button: HTMLButtonElement): { title: string; agent: string } {
  const title = button.querySelector<HTMLElement>("span.truncate")?.textContent?.trim() ?? "";
  const label = button.getAttribute("aria-label") ?? "";
  // aria-label is `${title} - ${agentName}`; derive agent from the suffix to
  // avoid splitting on " - " (which can appear inside the title).
  const agent = title && label.startsWith(`${title} - `) ? label.slice(title.length + 3) : "";
  return { title, agent };
}

function collectDesktopEntries(): BridgeConversationEntry[] {
  const entries: BridgeConversationEntry[] = [];
  const sections = Array.from(document.querySelectorAll<HTMLElement>("section"));
  for (const section of sections) {
    const rows = section.querySelectorAll<HTMLButtonElement>(
      'button[data-testid="acp-conversation-row"]',
    );
    if (rows.length === 0) continue;
    const projectName =
      section.querySelector<HTMLElement>("button[aria-label] span.truncate")?.textContent?.trim() ??
      "(unnamed project)";

    let currentWorktree: string | undefined;
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const el = node as HTMLElement;
        if (
          el.className &&
          typeof el.className === "string" &&
          el.className.includes("group/wthead")
        ) {
          return NodeFilter.FILTER_ACCEPT;
        }
        if (el.tagName === "BUTTON" && el.getAttribute("data-testid") === "acp-conversation-row") {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node as HTMLElement;
      if (
        el.className &&
        typeof el.className === "string" &&
        el.className.includes("group/wthead")
      ) {
        currentWorktree =
          el.querySelector<HTMLElement>("span.truncate")?.textContent?.trim() ?? "(unnamed)";
        continue;
      }
      const button = el as HTMLButtonElement;
      const row = readBridgeRow(button);
      entries.push({
        index: entries.length,
        title: row.title,
        agent: row.agent,
        selected: rowIsSelected(button),
        button,
        project: projectName,
        worktree: currentWorktree,
      });
    }
  }
  return entries;
}

async function listConversations(): Promise<string> {
  const entries = collectDesktopEntries();
  if (entries.length === 0) return "(no conversations)";

  const lines: string[] = [];
  let currentProject: string | undefined;
  let currentWorktree: string | undefined | null = undefined;
  for (const e of entries) {
    if (e.project !== currentProject) {
      currentProject = e.project;
      currentWorktree = undefined;
      lines.push(currentProject ?? "(unnamed project)");
    }
    if (e.worktree !== currentWorktree) {
      currentWorktree = e.worktree;
      if (e.worktree) lines.push(`  ${e.worktree}`);
    }
    const indent = e.worktree ? "    " : "  ";
    lines.push(
      `${indent}${e.selected ? "*" : " "} [${e.index}] ${e.title}${e.agent ? ` (${e.agent})` : ""}`,
    );
  }
  return lines.join("\n");
}

async function selectConversation(args: string[]): Promise<string> {
  if (args.length === 0) {
    throw new Error('Usage: selectConversation "title-substring" or selectConversation --index N');
  }

  const entries = collectDesktopEntries();
  if (entries.length === 0) throw new Error("No conversations in the sidebar");

  let target: BridgeConversationEntry | undefined;
  if (args[0] === "--index") {
    const n = parseInt(args[1] ?? "", 10);
    if (Number.isNaN(n) || n < 0 || n >= entries.length) {
      throw new Error(`Index ${args[1]} out of range (0-${entries.length - 1})`);
    }
    target = entries[n];
  } else {
    const raw = args.join(" ");
    const needle = raw.toLowerCase();
    const matches = entries.filter((e) => e.title.toLowerCase().includes(needle));
    if (matches.length === 0) throw new Error(`No conversation matching "${raw}"`);
    if (matches.length > 1) {
      throw new Error(
        `"${raw}" matches multiple conversations — narrow the title or use --index N`,
      );
    }
    target = matches[0];
  }

  target.button.click();
  await sleep(500);
  return `Switched to conversation: ${target.title}`;
}

async function getCurrentConversation(): Promise<string> {
  const entries = collectDesktopEntries();
  const current = entries.find((e) => e.selected);
  if (!current) return "(no conversation is currently selected)";
  return current.agent ? `${current.title} (${current.agent})` : current.title;
}

interface BridgeProjectInfo {
  name: string;
  path: string;
  expanded: boolean;
  worktrees: Array<{ name: string; path: string; mainButton: HTMLButtonElement | null }>;
  headerButton: HTMLButtonElement;
  section: HTMLElement;
}

function collectBridgeProjects(): BridgeProjectInfo[] {
  const projects: BridgeProjectInfo[] = [];
  const sections = Array.from(document.querySelectorAll<HTMLElement>("section"));
  for (const section of sections) {
    const header = section.querySelector<HTMLButtonElement>("button[aria-label]");
    if (!header) continue;
    const addWorktreeBtn = section.querySelector<HTMLButtonElement>(
      `button[aria-label^="Add worktree for "]`,
    );
    if (!addWorktreeBtn) continue;
    const label = header.getAttribute("aria-label") ?? "";
    let name: string;
    let expanded: boolean;
    if (label.startsWith("Expand ")) {
      name = label.slice("Expand ".length);
      expanded = false;
    } else {
      name = label;
      expanded = true;
    }
    const path = header.getAttribute("title") ?? "";

    const worktrees: Array<{
      name: string;
      path: string;
      mainButton: HTMLButtonElement | null;
    }> = [];
    const worktreeHeaders = section.querySelectorAll<HTMLElement>('[class*="group/wthead"]');
    for (const wt of Array.from(worktreeHeaders)) {
      const mainBtn = wt.querySelector<HTMLButtonElement>("button[title]");
      const wtName = wt.querySelector<HTMLElement>("span.truncate")?.textContent?.trim();
      const wtPath = mainBtn?.getAttribute("title") ?? "";
      if (wtName) worktrees.push({ name: wtName, path: wtPath, mainButton: mainBtn });
    }

    projects.push({ name, path, expanded, worktrees, headerButton: header, section });
  }
  return projects;
}

function findBridgeProject(projects: BridgeProjectInfo[], needle: string): BridgeProjectInfo {
  const lower = needle.toLowerCase();
  const matches = projects.filter((p) => p.name.toLowerCase().includes(lower));
  if (matches.length === 0) {
    throw new Error(
      `No project matching "${needle}". Available: ${projects.map((p) => p.name).join(", ") || "(none)"}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `"${needle}" matches multiple projects: ${matches.map((p) => p.name).join(", ")}`,
    );
  }
  return matches[0];
}

async function listProjects(): Promise<string> {
  const projects = collectBridgeProjects();
  if (projects.length === 0) return "(no projects)";
  return projects
    .map(
      (p) =>
        `${p.expanded ? "▼" : "▶"} ${p.name}  (${p.worktrees.length} worktree${p.worktrees.length === 1 ? "" : "s"})`,
    )
    .join("\n");
}

async function listWorktrees(args: string[]): Promise<string> {
  const projects = collectBridgeProjects();
  let filtered = projects;
  const projectArgIdx = args.indexOf("--project");
  if (projectArgIdx >= 0 && projectArgIdx + 1 < args.length) {
    filtered = [findBridgeProject(projects, args[projectArgIdx + 1])];
  }
  const lines: string[] = [];
  for (const p of filtered) {
    lines.push(p.name);
    if (p.worktrees.length === 0) lines.push("  (no worktrees)");
    else for (const wt of p.worktrees) lines.push(`  ${wt.name}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(no projects)";
}

async function openProject(args: string[]): Promise<string> {
  if (args.length === 0) throw new Error('Usage: openProject "name-substring"');
  const target = findBridgeProject(collectBridgeProjects(), args.join(" "));
  if (target.expanded) return `Project already expanded: ${target.name}`;
  target.headerButton.click();
  await sleep(300);
  return `Expanded project: ${target.name}`;
}

async function closeProject(args: string[]): Promise<string> {
  if (args.length === 0) throw new Error('Usage: closeProject "name-substring"');
  const target = findBridgeProject(collectBridgeProjects(), args.join(" "));
  if (!target.expanded) return `Project already collapsed: ${target.name}`;
  target.headerButton.click();
  await sleep(300);
  const after = collectBridgeProjects().find((p) => p.name === target.name);
  if (after?.expanded) {
    throw new Error(
      `closeProject is not supported in the current UI — the project header doesn't toggle collapse on click when expanded.`,
    );
  }
  return `Collapsed project: ${target.name}`;
}

async function removeProject(args: string[]): Promise<string> {
  if (args.length === 0) throw new Error('Usage: removeProject "name-substring"');
  return await withDomConfirmationDialogs(() => removeProjectViaSettings(args.join(" ")));
}

async function removeProjectViaSettings(nameSubstring: string): Promise<string> {
  const target = findBridgeProject(collectBridgeProjects(), nameSubstring);
  const settingsButton = findVisibleButton(
    (button) => button.getAttribute("aria-label") === "Settings",
  );
  settingsButton?.click();
  await sleep(250);

  findVisibleButton((button) => (button.textContent ?? "").trim() === "Projects")?.click();
  await sleep(250);

  const showSettings = findVisibleButton(
    (button) => button.getAttribute("aria-label") === `Show settings for ${target.name}`,
  );
  showSettings?.click();
  await sleep(200);

  const deleteButton = findVisibleButton(
    (button) => (button.textContent ?? "").trim() === "Delete Project",
  );
  if (!deleteButton) throw new Error(`Delete Project button for "${target.name}" not found`);
  deleteButton.click();
  await sleep(200);

  const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
    isVisible,
  );
  if (!dialog) throw new Error("Delete project confirmation dialog did not open");
  const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => (button.textContent ?? "").trim() === "Delete Project",
  );
  if (!confirm) throw new Error("Delete Project confirmation button not found");
  confirm.click();
  await sleep(500);
  return `Deleted project: ${target.name}`;
}

function findVisibleButton(
  predicate: (button: HTMLButtonElement) => boolean,
): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => isVisible(button) && predicate(button),
  );
}

async function createWorktree(args: string[]): Promise<string> {
  const projects = collectBridgeProjects();
  let target: BridgeProjectInfo;
  const projectArgIdx = args.indexOf("--project");
  if (projectArgIdx >= 0 && projectArgIdx + 1 < args.length) {
    target = findBridgeProject(projects, args[projectArgIdx + 1]);
  } else if (projects.length === 1) {
    target = projects[0];
  } else if (projects.length === 0) {
    throw new Error("No projects in the sidebar");
  } else {
    throw new Error(
      `Multiple projects available — specify --project NAME. Available: ${projects.map((p) => p.name).join(", ")}`,
    );
  }
  if (!target.expanded) {
    target.headerButton.click();
    await sleep(300);
    target = findBridgeProject(collectBridgeProjects(), target.name);
  }
  const before = new Set(target.worktrees.map((w) => w.name));
  const addBtn = target.section.querySelector<HTMLButtonElement>(
    `button[aria-label="Add worktree for ${target.name}"]`,
  );
  if (!addBtn) throw new Error(`"Add worktree for ${target.name}" button not found`);
  addBtn.click();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const fresh = collectBridgeProjects().find((p) => p.name === target.name);
    if (fresh) {
      const created = fresh.worktrees.find((w) => !before.has(w.name));
      if (created) {
        return `Created worktree: ${created.name} (project: ${target.name})`;
      }
    }
    await sleep(300);
  }
  throw new Error(
    `createWorktree clicked but no new worktree appeared in "${target.name}" within 15s`,
  );
}

interface BridgeWorktreeMatch {
  project: BridgeProjectInfo;
  name: string;
  path: string;
  mainButton: HTMLButtonElement | null;
}

function findBridgeWorktree(projects: BridgeProjectInfo[], needle: string): BridgeWorktreeMatch {
  const lower = needle.toLowerCase();
  const matches: BridgeWorktreeMatch[] = [];
  for (const p of projects) {
    for (const wt of p.worktrees) {
      if (wt.name.toLowerCase().includes(lower)) {
        matches.push({ project: p, name: wt.name, path: wt.path, mainButton: wt.mainButton });
      }
    }
  }
  if (matches.length === 0) throw new Error(`No worktree matching "${needle}"`);
  if (matches.length > 1) {
    throw new Error(
      `"${needle}" matches multiple worktrees: ${matches.map((m) => `${m.project.name}/${m.name}`).join(", ")}`,
    );
  }
  return matches[0];
}

async function removeWorktree(args: string[]): Promise<string> {
  if (args.length === 0) throw new Error('Usage: removeWorktree "name-substring"');
  const target = findBridgeWorktree(collectBridgeProjects(), args.join(" "));
  if (!target.project.expanded) {
    target.project.headerButton.click();
    await sleep(200);
  }
  const deleteBtn = target.project.section.querySelector<HTMLButtonElement>(
    `button[aria-label="Delete worktree ${target.name}"]`,
  );
  if (!deleteBtn) throw new Error(`"Delete worktree ${target.name}" button not found`);
  deleteBtn.click();
  await sleep(5500);
  return `Removed worktree: ${target.name} (project: ${target.project.name})`;
}

async function openWorktree(args: string[]): Promise<string> {
  if (args.length === 0) throw new Error('Usage: openWorktree "name-substring"');
  const target = findBridgeWorktree(collectBridgeProjects(), args.join(" "));
  if (!target.project.expanded) {
    target.project.headerButton.click();
    await sleep(200);
  }
  if (!target.mainButton) throw new Error(`Worktree row button for "${target.name}" not found`);
  target.mainButton.click();
  await sleep(500);
  return `Opened worktree: ${target.name} (project: ${target.project.name})`;
}

async function archiveConversation(args: string[]): Promise<string> {
  if (args.length === 0) {
    throw new Error('Usage: archiveConversation "title-substring"');
  }
  const raw = args.join(" ");
  const target = raw.toLowerCase();
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Archive "]'),
  );
  const matches = buttons.filter((btn) =>
    (btn.getAttribute("aria-label") ?? "").slice("Archive ".length).toLowerCase().includes(target),
  );
  if (matches.length === 0) {
    throw new Error(`No conversation matching "${raw}" in the sidebar`);
  }
  if (matches.length > 1) {
    throw new Error(
      `"${raw}" matches multiple conversations — narrow the title to a unique substring`,
    );
  }
  matches[0].click();
  await sleep(500);
  const archivedTitle = (matches[0].getAttribute("aria-label") ?? "").slice("Archive ".length);
  return `Archived: ${archivedTitle}`;
}

function isStreaming(): boolean {
  return Boolean(document.querySelector('[data-testid="prompt-submit-button"][aria-label="Stop"]'));
}

function stopGeneration(): string {
  const stop = document.querySelector(
    '[data-testid="prompt-submit-button"][aria-label="Stop"]',
  ) as HTMLElement | null;
  if (!stop) throw new Error("Not currently streaming");
  stop.click();
  return "Generation stopped";
}

function messageCount(): number {
  const pairs = document.querySelectorAll(".messagePair");
  if (pairs.length > 0) return pairs.length;
  return document.querySelectorAll(".user-bubble").length;
}

async function helperLogs(args: string[]): Promise<string> {
  const lines = Number.parseInt(args[0] || "500", 10);
  return await invoke<string>("helper_logs", { lines });
}

async function restartHelper(): Promise<string> {
  await invoke("restart_helper");
  return "camber-helper restarted";
}

async function camberqaDebugGo(args: string[]): Promise<string> {
  const port = Number.parseInt(args[0] || "", 10);
  const dlvBinary = args[1] || "dlv";
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Usage: debug go [--port PORT]");
  }
  await invoke("restart_helper_debug", { port, dlvBinary });
  return `camber-helper restarted under Delve on port ${port}`;
}

async function restartACPServer(args: string[]): Promise<string> {
  const agentServer = args[0]?.trim();
  if (!agentServer) throw new Error('Usage: restartACPServer "agent-server"');
  const debug = getACPDebugAPI?.();
  if (!debug) throw new Error("ACP debug API is not available");
  await debug.restartServer(agentServer);
  return `ACP server restarted: ${agentServer}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error instanceof Event) {
    const target = error.target as HTMLElement | null;
    const targetLabel = target
      ? `${target.tagName.toLowerCase()}${"src" in target ? ` src=${String((target as HTMLImageElement).src)}` : ""}`
      : "unknown target";
    return `${error.type} event from ${targetLabel}`;
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

function resolveElement(refOrSelector: string): Element {
  if (!refOrSelector) throw new Error("Missing selector or @ref");
  if (refOrSelector.startsWith("@")) {
    const element = refs.get(refOrSelector.slice(1));
    if (!element) throw new Error(`Ref ${refOrSelector} not found. Run 'snapshot' first.`);
    return element;
  }
  const element = document.querySelector(refOrSelector);
  if (!element) throw new Error(`Selector not found: ${refOrSelector}`);
  return element;
}

function resolveFillElement(
  refOrSelector: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (refOrSelector?.startsWith("@")) {
    const element = resolveElement(refOrSelector);
    if (isFillable(element)) return element;
    throw new Error(`Ref ${refOrSelector} is not fillable`);
  }

  const candidates = Array.from(document.querySelectorAll(refOrSelector)).filter(
    (element): element is HTMLInputElement | HTMLTextAreaElement | HTMLElement =>
      element instanceof HTMLElement && isVisible(element) && isFillable(element),
  );
  const promptCandidate =
    candidates.find((element) => element.id === "prompt-editor") ??
    candidates.find((element) => element.closest("[data-testid*='prompt'], [class*='prompt']")) ??
    candidates.at(-1);
  if (!promptCandidate) throw new Error(`No visible fillable element found for: ${refOrSelector}`);
  return promptCandidate;
}

function resolvePromptEditor(): HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  const element =
    document.querySelector("#prompt-editor") ??
    document.querySelector("[contenteditable='true']") ??
    document.querySelector("[role='combobox']");
  if (!(element instanceof HTMLElement) || !isFillable(element)) {
    throw new Error("Prompt editor not found");
  }
  return element;
}

function setElementText(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
  value: string,
): void {
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.value = value;
  } else if (element.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.deleteContents();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: "insertText",
      }),
    );
    document.execCommand("insertText", false, value);
  } else {
    element.textContent = value;
  }
  element.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function isFillable(
  element: Element,
): element is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function isHiddenSubtree(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return style.visibility === "hidden" || style.display === "none";
}

function hasVisibleBox(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isVisible(element: HTMLElement): boolean {
  return !isHiddenSubtree(element) && hasVisibleBox(element);
}

function computedRole(element: HTMLElement): string {
  return getRole(element) || explicitRole(element) || implicitRole(element);
}

function explicitRole(element: HTMLElement): string {
  return element.getAttribute("role")?.trim().split(/\s+/, 1)[0] ?? "";
}

function implicitRole(element: HTMLElement): string {
  const tagName = element.tagName.toLowerCase();
  switch (tagName) {
    case "a":
    case "area":
      return element.hasAttribute("href") ? "link" : "";
    case "button":
      return "button";
    case "input":
      return inputRole(element as HTMLInputElement);
    case "select":
      return (element as HTMLSelectElement).multiple || (element as HTMLSelectElement).size > 1
        ? "listbox"
        : "combobox";
    case "textarea":
      return "textbox";
    default:
      return "";
  }
}

function inputRole(element: HTMLInputElement): string {
  switch (element.type) {
    case "button":
    case "image":
    case "reset":
    case "submit":
      return "button";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "range":
      return "slider";
    case "number":
      return "spinbutton";
    case "search":
      return "searchbox";
    case "email":
    case "password":
    case "tel":
    case "text":
    case "url":
    case "":
      return "textbox";
    default:
      return "";
  }
}

function computedName(element: HTMLElement, role: string): string {
  const name =
    computeAccessibleName(element) ||
    (role === "textbox" || role === "combobox"
      ? element.getAttribute("placeholder") || element.getAttribute("aria-placeholder") || ""
      : "");
  return name.trim().replace(/\s+/g, " ").slice(0, 100);
}

function parseSnapshotArgs(args: string[]): SnapshotOptions {
  const opts: SnapshotOptions = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-i":
      case "--interactive":
        opts.interactive = true;
        break;
      case "-c":
      case "--compact":
        opts.compact = true;
        break;
      case "-d":
      case "--depth":
        opts.depth = Number.parseInt(args[++i], 10);
        break;
      case "-s":
      case "--selector":
        opts.selector = args[++i];
        break;
      case "-D":
      case "--diff":
        break;
      default:
        throw new Error(`Unknown snapshot flag: ${args[i]}`);
    }
  }
  return opts;
}

function parseScreenshotArgs(args: string[]): ScreenshotOptions {
  let output = "/tmp/camberqa-desktop.png";
  let webviewOnly = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-o":
      case "--output":
        output = args[++i] ?? "";
        if (!output) throw new Error("Usage: screenshot [-o path] [--webview]");
        break;
      case "--webview":
        webviewOnly = true;
        break;
      default:
        if (!args[i].startsWith("-")) output = args[i];
    }
  }

  return { output, webviewOnly };
}

async function nativeWindowScreenshot(): Promise<string> {
  const windows = await getScreenshotableWindows();
  const currentWindow = resolveCurrentWindow(windows, getCurrentWindowIdentity());
  if (!currentWindow) {
    const available = windows
      .map((window) => `${window.id}: ${window.appName} - ${window.title || window.name}`)
      .join("\n");
    throw new Error(
      `Camber window not found in screenshotable windows${available ? `:\n${available}` : ""}`,
    );
  }

  return getWindowScreenshot(currentWindow.id);
}

interface CurrentWindowIdentity {
  title: string;
  worktreeName?: string;
}

function getCurrentWindowIdentity(): CurrentWindowIdentity {
  const params = new URLSearchParams(window.location.search);
  return {
    title: document.title.trim(),
    worktreeName: params.get("camberqaWorktreeName")?.trim() || undefined,
  };
}

export function resolveCurrentWindow(
  windows: ScreenshotableWindow[],
  identity: CurrentWindowIdentity,
): ScreenshotableWindow | undefined {
  const title = identity.title.trim();
  const camberWindows = windows.filter((window) =>
    [window.appName, window.title, window.name].some((value) =>
      /^camber(?: assistant|\s+s\d+\b)/i.test(value.trim()),
    ),
  );

  if (identity.worktreeName) {
    const worktreeName = identity.worktreeName.toLowerCase();
    const worktreeWindow = camberWindows.find((window) =>
      [window.appName, window.title, window.name].some((value) =>
        value.toLowerCase().includes(worktreeName),
      ),
    );
    if (worktreeWindow) return worktreeWindow;
  }

  return (
    windows.find((window) => window.title === title) ??
    camberWindows.find((window) => window.title.includes(title) || title.includes(window.title)) ??
    camberWindows[0]
  );
}

function toPngWithTimeout(
  element: HTMLElement,
  opts: Parameters<typeof toPng>[1] = {},
): Promise<string> {
  return withTimeout(
    toPng(element, {
      cacheBust: true,
      imagePlaceholder: TRANSPARENT_PIXEL,
      pixelRatio: window.devicePixelRatio || 1,
      skipFonts: true,
      ...opts,
    }),
    10_000,
    "Timed out rendering element screenshot",
  );
}

function elementCrop(
  element: HTMLElement,
  padding: number,
): {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
} {
  const elementRect = element.getBoundingClientRect();
  if (elementRect.width <= 0 || elementRect.height <= 0) {
    throw new Error("Element is not visible or has no bounding box");
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const x = Math.max(0, elementRect.left - padding);
  const y = Math.max(0, elementRect.top - padding);
  return {
    x,
    y,
    width: Math.min(viewportWidth - x, elementRect.width + padding * 2),
    height: Math.min(viewportHeight - y, elementRect.height + padding * 2),
    viewportWidth,
    viewportHeight,
  };
}

function parseElementScreenshotArgs(args: string[]): {
  refOrSelector: string;
  output: string;
  padding: number;
} {
  let refOrSelector = "";
  let output = "/tmp/camberqa-element.png";
  let padding = 10;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-o":
      case "--output":
        output = args[++i];
        break;
      case "-p":
      case "--padding":
        padding = Number.parseInt(args[++i], 10);
        break;
      default:
        if (!args[i].startsWith("-")) refOrSelector = refOrSelector || args[i];
    }
  }

  if (!refOrSelector) throw new Error("Usage: screenshotElement @ref [-p padding] [-o path]");
  return { refOrSelector, output, padding: Number.isFinite(padding) ? padding : 10 };
}

function parseComponentArgs(args: string[]): {
  refOrSelector: string;
  componentsOnly: boolean;
  maxDepth: number;
} {
  let refOrSelector = "";
  let componentsOnly = false;
  let maxDepth = Infinity;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--components-only":
      case "-c":
        componentsOnly = true;
        break;
      case "-d":
      case "--depth":
        maxDepth = Number.parseInt(args[++i], 10);
        break;
      default:
        if (!refOrSelector) refOrSelector = args[i];
    }
  }

  if (!refOrSelector) throw new Error("Usage: component @ref [--components-only] [-d depth]");
  return {
    refOrSelector,
    componentsOnly,
    maxDepth: Number.isFinite(maxDepth) ? maxDepth : Infinity,
  };
}

interface ComponentMetaNode {
  type: string;
  file: string;
  line: number;
  column: number;
  componentTag?: string;
  parent: ComponentMetaNode | null;
}

function componentTreeFor(element: Element): {
  entries: Array<{ type: string; file: string; line: number; componentTag?: string }>;
  domStepsUp: number;
} | null {
  let target: Element | null = element;
  let meta: { loc?: ComponentMetaNode; parent?: ComponentMetaNode } | undefined;
  let domStepsUp = 0;

  while (target) {
    meta = (target as Element & { __svelte_meta?: typeof meta }).__svelte_meta;
    if (meta) break;
    target = target.parentElement;
    domStepsUp++;
  }

  if (!meta) return null;

  const entries: Array<{ type: string; file: string; line: number; componentTag?: string }> = [];
  if (meta.loc?.file) {
    entries.push({
      type: "element",
      file: meta.loc.file,
      line: meta.loc.line,
    });
  }

  let cursor = meta.parent ?? null;
  while (cursor) {
    if (cursor.file) {
      entries.push({
        type: cursor.type,
        file: cursor.file,
        line: cursor.line,
        componentTag: cursor.componentTag,
      });
    }
    cursor = cursor.parent;
  }

  return { entries, domStepsUp };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
