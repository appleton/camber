/**
 * Camber domain-specific commands.
 *
 * Always target the Camber sidebar regardless of the current panel selection
 * (set via selectPanel). Use `getCamberRawFrame` / `getCamberWebviewFrame`
 * for that — never the panel-aware `getRawFrame` / `getWebviewFrame`. Commands
 * that interact with VS Code chrome (command palette, quick-input) use `page`.
 */

import { DEBUG_RPC_EVENTS, requestDebugRPCInWindow } from "@camber/assistant/debug-rpc";
import { ACP_DEBUG_RPC_METHODS } from "@camber/assistant/debug-rpc/acp";
import type { CamberQATarget } from "../targets/types.js";
import { commandPalette, sleep, stripQuotes } from "../utils.js";

export const CAMBER_COMMANDS = new Set([
  "sendMessage",
  "openCommandMenu",
  "assertMessage",
  "waitForMessageCount",
  "getLastResponse",
  "newConversation",
  "archiveConversation",
  "isStreaming",
  "stopGeneration",
  "approveAction",
  "waitForApproval",
  "getApprovalInfo",
  "listConversations",
  "selectConversation",
  "getMessageCount",
  "selectCommand",
  "getCurrentConversation",
  "getACPDump",
  "loadACPDump",
  "restartACPServer",
  "restartHelper",
  "helperLogs",
  "getConfigs",
  "setConfig",
  "openHistory",
  "closeHistory",
  "deleteConversation",
  "restoreConversation",
  "listProjects",
  "listWorktrees",
  "openProject",
  "closeProject",
  "removeProject",
  "createWorktree",
  "removeWorktree",
  "openWorktree",
  "openChat",
  "focusChat",
  "toggleSidebar",
]);

export async function handleCamberCommand(
  command: string,
  args: string[],
  mgr: CamberQATarget,
): Promise<string> {
  switch (command) {
    case "sendMessage":
      return handleSendMessage(args, mgr);
    case "openCommandMenu":
      return handleOpenCommandMenu(mgr);
    case "assertMessage":
      return handleAssertMessage(args, mgr);
    case "waitForMessageCount":
      return handleWaitForMessageCount(args, mgr);
    case "getLastResponse":
      return handleGetLastResponse(mgr);
    case "newConversation":
      return handleNewConversation(args, mgr);
    case "archiveConversation":
      return handleArchiveConversation(args, mgr);
    case "isStreaming":
      return handleIsStreaming(mgr);
    case "stopGeneration":
      return handleStopGeneration(mgr);
    case "approveAction":
      return handleApproveAction(args, mgr);
    case "waitForApproval":
      return handleWaitForApproval(args, mgr);
    case "getApprovalInfo":
      return handleGetApprovalInfo(mgr);
    case "listConversations":
      return handleListConversations(mgr);
    case "selectConversation":
      return handleSelectConversation(args, mgr);
    case "getMessageCount":
      return handleGetMessageCount(mgr);
    case "selectCommand":
      return handleSelectCommand(args, mgr);
    case "getCurrentConversation":
      return handleGetCurrentConversation(mgr);
    case "getACPDump":
      return handleGetACPDump(args, mgr);
    case "loadACPDump":
      return handleLoadACPDump(args, mgr);
    case "restartACPServer":
      return handleRestartACPServer(args, mgr);
    case "restartHelper":
      return handleRestartHelper(args, mgr);
    case "helperLogs":
      return handleHelperLogs(args, mgr);
    case "getConfigs":
      return handleGetConfigs(mgr);
    case "setConfig":
      return handleSetConfig(args, mgr);
    case "openHistory":
      return handleOpenHistory(mgr);
    case "closeHistory":
      return handleCloseHistory(mgr);
    case "deleteConversation":
      return handleDeleteConversation(args, mgr);
    case "restoreConversation":
      return handleRestoreConversation(args, mgr);
    case "listProjects":
      return handleListProjects(mgr);
    case "listWorktrees":
      return handleListWorktrees(args, mgr);
    case "openProject":
      return handleOpenProject(args, mgr);
    case "closeProject":
      return handleCloseProject(args, mgr);
    case "removeProject":
      return handleRemoveProject(args, mgr);
    case "createWorktree":
      return handleCreateWorktree(args, mgr);
    case "removeWorktree":
      return handleRemoveWorktree(args, mgr);
    case "openWorktree":
      return handleOpenWorktree(args, mgr);
    case "openChat":
      return handleOpenChat(mgr);
    case "focusChat":
      return handleFocusChat(mgr);
    case "toggleSidebar":
      return handleToggleSidebar(mgr);
    default:
      throw new Error(`Unknown camber command: ${command}`);
  }
}

async function handleSendMessage(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error('Usage: sendMessage "text"');

  const text = stripQuotes(args);
  const frame = mgr.getCamberWebviewFrame();

  const input = frame.locator("#prompt-editor");
  await input.fill(text, { timeout: 5000 });
  await input.focus();
  await sleep(300);

  const submitButton = frame.locator('button[data-testid="prompt-submit-button"]');

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const enabled = await submitButton.isEnabled();
      if (enabled) break;
    } catch {
      // Button may not exist yet
    }
    await sleep(200);
  }

  await submitButton.click({ timeout: 5000 });
  return `Sent: "${text}"`;
}

async function handleOpenCommandMenu(mgr: CamberQATarget): Promise<string> {
  const frame = mgr.getCamberWebviewFrame();
  const promptMenuButton = frame.locator("[data-prompt-trigger]").first();
  await promptMenuButton.click({ timeout: 5000 });
  await sleep(400);
  return "Command menu opened";
}

async function handleAssertMessage(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error('Usage: assertMessage "text"');

  const text = stripQuotes(args);
  const frame = mgr.getCamberWebviewFrame();

  const message = frame.getByText(text, { exact: false });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const visible = await message.first().isVisible();
      if (visible) return `Message found: "${text}"`;
    } catch {
      // Not found yet
    }
    await sleep(500);
  }

  throw new Error(`Message "${text}" not found within 10s`);
}

async function handleWaitForMessageCount(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error("Usage: waitForMessageCount <count> [timeout]");

  const expectedCount = parseInt(args[0], 10);
  const timeout = parseInt(args[1] || "30000", 10);
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const count = await rawFrame.evaluate(() => {
      return document.querySelectorAll(".messagePair").length;
    });
    if (count >= expectedCount) {
      // Wait for streaming to finish before returning
      const frame = mgr.getCamberWebviewFrame();
      const stopButton = frame.locator('[data-testid="prompt-submit-button"][aria-label="Stop"]');
      while (Date.now() < deadline) {
        const streaming = await stopButton.isVisible().catch(() => false);
        if (!streaming) return `Message count: ${count}`;
        await sleep(500);
      }
      return `Message count: ${count} (still streaming)`;
    }
    await sleep(500);
  }

  const finalCount = await rawFrame.evaluate(() => {
    return document.querySelectorAll(".messagePair").length;
  });
  throw new Error(
    `Timed out: expected ${expectedCount} messagePairs, got ${finalCount} after ${timeout}ms`,
  );
}

async function handleGetLastResponse(mgr: CamberQATarget): Promise<string> {
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const text = await rawFrame.evaluate(() => {
    const pairs = document.querySelectorAll(".messagePair");
    if (pairs.length === 0) return "(no messages found)";
    const last = pairs[pairs.length - 1];
    const botBlocks = last.querySelector('[data-testid="bot-response-blocks"]');
    if (botBlocks) return (botBlocks as HTMLElement).innerText || "";
    const markdown = last.querySelector(".markdown");
    if (markdown) return (markdown as HTMLElement).innerText || "";
    return (last as HTMLElement).innerText || "";
  });
  return text;
}

async function handleNewConversation(args: string[], mgr: CamberQATarget): Promise<string> {
  const frame = mgr.getCamberWebviewFrame();

  if (mgr.kind === "vscode") {
    const button = frame.getByRole("button", { name: "New conversation", exact: true }).first();
    await button.click({ timeout: 5000 });
    await sleep(500);
    return "Started new conversation";
  }

  // Desktop: the chat-header "New conversation" button only renders when the
  // sidebar is collapsed. The user-driven path is the project- or worktree-
  // scoped button in the sidebar (aria-label="New conversation in {name}").
  const projectArgIdx = args.indexOf("--project");
  const worktreeArgIdx = args.indexOf("--worktree");

  let scopeName: string;
  let kind: "project" | "worktree";
  if (worktreeArgIdx >= 0 && worktreeArgIdx + 1 < args.length) {
    const wt = findWorktree(await collectProjects(mgr), args[worktreeArgIdx + 1]);
    if (!wt.project.expanded) {
      await frame
        .getByRole("button", { name: `Expand ${wt.project.name}`, exact: true })
        .click({ timeout: 5000 });
      await sleep(200);
    }
    scopeName = wt.name;
    kind = "worktree";
  } else if (projectArgIdx >= 0 && projectArgIdx + 1 < args.length) {
    scopeName = findProject(await collectProjects(mgr), args[projectArgIdx + 1]).name;
    kind = "project";
  } else {
    const projects = await collectProjects(mgr);
    if (projects.length === 0) throw new Error("No projects in the sidebar");
    scopeName = projects[0].name;
    kind = "project";
  }

  await frame
    .getByRole("button", { name: `New conversation in ${scopeName}`, exact: true })
    .click({ timeout: 5000 });
  await sleep(500);
  return `Started new conversation in ${kind}: ${scopeName}`;
}

async function handleArchiveConversation(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) {
    throw new Error('Usage: archiveConversation "title-substring"');
  }
  const target = stripQuotes(args);
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const archiveAriaLabel = await rawFrame.evaluate((target) => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('button[aria-label^="Archive "]'),
    );
    const needle = target.toLowerCase();
    const matches = buttons.filter((btn) =>
      (btn.getAttribute("aria-label") ?? "")
        .slice("Archive ".length)
        .toLowerCase()
        .includes(needle),
    );
    if (matches.length === 0) return null;
    if (matches.length > 1) return "ambiguous";
    return matches[0].getAttribute("aria-label");
  }, target);

  if (archiveAriaLabel === null) {
    throw new Error(`No conversation matching "${target}" in the sidebar`);
  }
  if (archiveAriaLabel === "ambiguous") {
    throw new Error(
      `"${target}" matches multiple conversations — narrow the title to a unique substring`,
    );
  }

  const frame = mgr.getCamberWebviewFrame();
  const archiveButton = frame.getByRole("button", { name: archiveAriaLabel, exact: true });
  await archiveButton.scrollIntoViewIfNeeded({ timeout: 5000 });
  await archiveButton.hover({ timeout: 5000, force: true });
  await archiveButton.click({ timeout: 5000, force: true });
  await sleep(500);

  const archivedTitle = archiveAriaLabel.slice("Archive ".length);
  return `Archived: ${archivedTitle}`;
}

async function handleIsStreaming(mgr: CamberQATarget): Promise<string> {
  const frame = mgr.getCamberWebviewFrame();
  const visible = await frame
    .locator('[data-testid="prompt-submit-button"][aria-label="Stop"]')
    .isVisible()
    .catch(() => false);
  return visible ? "true" : "false";
}

async function handleStopGeneration(mgr: CamberQATarget): Promise<string> {
  const frame = mgr.getCamberWebviewFrame();
  const stop = frame.locator('[data-testid="prompt-submit-button"][aria-label="Stop"]');
  if (!(await stop.isVisible().catch(() => false))) {
    throw new Error("Not currently streaming");
  }
  await stop.click({ timeout: 5000 });
  return "Generation stopped";
}

async function handleApproveAction(args: string[], mgr: CamberQATarget): Promise<string> {
  const mode = (args[0] || "once").replace(/^"(.*)"$/, "$1");
  const frame = mgr.getCamberWebviewFrame();

  switch (mode) {
    case "once":
      await frame.locator('[aria-label="Allow action"]').first().click({ timeout: 5000 });
      return "Action approved (once)";
    case "always":
      await frame
        .locator('[aria-label^="Auto-allow"], [aria-label^="Always allow"]')
        .first()
        .click({ timeout: 5000 });
      return "Action approved (always)";
    case "deny":
      await frame.locator('[aria-label="Deny action"]').first().click({ timeout: 5000 });
      return "Action denied";
    default:
      throw new Error("Usage: approveAction [once|always|deny]");
  }
}

async function handleWaitForApproval(args: string[], mgr: CamberQATarget): Promise<string> {
  const timeout = parseInt(args[0] || "30000", 10);
  const frame = mgr.getCamberWebviewFrame();
  await frame
    .locator('[data-testid="approve-tool-button"]')
    .first()
    .waitFor({ state: "visible", timeout });
  return "Approval dialog visible";
}

async function handleGetApprovalInfo(mgr: CamberQATarget): Promise<string> {
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const info = await rawFrame.evaluate(() => {
    const pending = document.querySelectorAll('[data-approval="pending"]');
    if (pending.length === 0) return "(no pending approvals)";
    const results: string[] = [];
    pending.forEach((el, i) => {
      results.push(`[${i + 1}] ${(el as HTMLElement).innerText.trim().slice(0, 200)}`);
    });
    return results.join("\n---\n");
  });
  return info;
}

interface ConversationEntry {
  index: number;
  title: string;
  agent: string;
  selected: boolean;
  project?: string;
  worktree?: string;
}

async function collectConversationEntries(mgr: CamberQATarget): Promise<ConversationEntry[]> {
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");
  const kind = mgr.kind;

  return await rawFrame.evaluate((kind) => {
    function rowSelected(button: HTMLElement): boolean {
      let el: HTMLElement | null = button.parentElement;
      while (el) {
        if (el.className && el.className.includes("text-psx-menu-active-foreground")) {
          return true;
        }
        el = el.parentElement;
      }
      return false;
    }

    function readRow(button: HTMLButtonElement): { title: string; agent: string } {
      const title = button.querySelector<HTMLElement>("span.truncate")?.textContent?.trim() ?? "";
      const label = button.getAttribute("aria-label") ?? "";
      // aria-label is `${title} - ${agentName}`; derive agent from the suffix
      // to avoid splitting on " - " (which can appear inside the title).
      const agent = title && label.startsWith(`${title} - `) ? label.slice(title.length + 3) : "";
      return { title, agent };
    }

    const entries: Array<{
      index: number;
      title: string;
      agent: string;
      selected: boolean;
      project?: string;
      worktree?: string;
    }> = [];

    if (kind === "desktop") {
      const sections = Array.from(document.querySelectorAll<HTMLElement>("section"));
      for (const section of sections) {
        const rows = section.querySelectorAll<HTMLButtonElement>(
          'button[data-testid="acp-conversation-row"]',
        );
        if (rows.length === 0) continue;
        const projectName =
          section
            .querySelector<HTMLElement>("button[aria-label] span.truncate")
            ?.textContent?.trim() ?? "(unnamed project)";

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
            if (
              el.tagName === "BUTTON" &&
              el.getAttribute("data-testid") === "acp-conversation-row"
            ) {
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
          const row = readRow(el as HTMLButtonElement);
          entries.push({
            index: entries.length,
            title: row.title,
            agent: row.agent,
            selected: rowSelected(el),
            project: projectName,
            worktree: currentWorktree,
          });
        }
      }
    } else {
      const aside =
        document.querySelector<HTMLElement>('aside[aria-label="ACP conversations"]') ??
        document.body;
      const rows = aside.querySelectorAll<HTMLButtonElement>(
        'button[data-testid="acp-conversation-row"]',
      );
      for (const button of Array.from(rows)) {
        const row = readRow(button);
        entries.push({
          index: entries.length,
          title: row.title,
          agent: row.agent,
          selected: rowSelected(button),
        });
      }
    }
    return entries;
  }, kind);
}

function formatConversationList(entries: ConversationEntry[], kind: "vscode" | "desktop"): string {
  if (entries.length === 0) return "(no conversations)";
  if (kind === "vscode") {
    return entries
      .map(
        (e) => `${e.selected ? "*" : " "} [${e.index}] ${e.title}${e.agent ? ` (${e.agent})` : ""}`,
      )
      .join("\n");
  }

  // desktop tree
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

async function handleListConversations(mgr: CamberQATarget): Promise<string> {
  const entries = await collectConversationEntries(mgr);
  return formatConversationList(entries, mgr.kind);
}

async function handleSelectConversation(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) {
    throw new Error('Usage: selectConversation "title-substring" or selectConversation --index N');
  }

  const entries = await collectConversationEntries(mgr);
  if (entries.length === 0) {
    throw new Error("No conversations in the sidebar");
  }

  let target: ConversationEntry | undefined;
  if (args[0] === "--index") {
    const n = parseInt(args[1] ?? "", 10);
    if (Number.isNaN(n) || n < 0 || n >= entries.length) {
      throw new Error(`Index ${args[1]} out of range (0-${entries.length - 1})`);
    }
    target = entries[n];
  } else {
    const needle = stripQuotes(args).toLowerCase();
    const matches = entries.filter((e) => e.title.toLowerCase().includes(needle));
    if (matches.length === 0) {
      throw new Error(`No conversation matching "${stripQuotes(args)}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `"${stripQuotes(args)}" matches multiple conversations — narrow the title or use --index N`,
      );
    }
    target = matches[0];
  }

  const frame = mgr.getCamberWebviewFrame();
  const ariaLabel = `${target.title} - ${target.agent}`;
  const button = frame.getByRole("button", { name: ariaLabel, exact: true });
  await button.click({ timeout: 5000 });
  await sleep(500);
  return `Switched to conversation: ${target.title}`;
}

async function handleGetMessageCount(mgr: CamberQATarget): Promise<string> {
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const count = await rawFrame.evaluate(() => {
    return document.querySelectorAll(".messagePair").length;
  });
  return String(count);
}

async function handleSelectCommand(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error('Usage: selectCommand "name"');

  const name = stripQuotes(args);
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  // Open command menu
  await handleOpenCommandMenu(mgr);
  await sleep(200);

  const result = await rawFrame.evaluate((targetName) => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
    for (let i = 0; i < items.length; i++) {
      const text = (items[i] as HTMLElement).textContent?.trim() || "";
      if (text.toLowerCase().includes(targetName.toLowerCase())) {
        (items[i] as HTMLElement).click();
        return `ok:${text}`;
      }
    }
    return "error:not_found";
  }, name);

  if (result === "error:not_found") {
    await rawFrame.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    throw new Error(`Command "${name}" not found in menu`);
  }

  await sleep(500);

  // Dismiss any lingering suggestions overlay
  const editor = mgr.getCamberWebviewFrame().locator("#prompt-editor");
  const expanded = await editor.getAttribute("aria-expanded").catch(() => null);
  if (expanded === "true") {
    await editor.press("Escape");
    await sleep(200);
  }

  return `Selected command: ${result.slice(3)}`;
}

async function handleGetCurrentConversation(mgr: CamberQATarget): Promise<string> {
  const entries = await collectConversationEntries(mgr);
  const current = entries.find((e) => e.selected);
  if (!current) return "(no conversation is currently selected)";
  return current.agent ? `${current.title} (${current.agent})` : current.title;
}

async function handleGetACPDump(args: string[], mgr: CamberQATarget): Promise<string> {
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const json = await rawFrame.evaluate(requestDebugRPCInWindow<string>, {
    events: DEBUG_RPC_EVENTS,
    method: ACP_DEBUG_RPC_METHODS.dumpJSON,
  });

  if (args[0]) {
    const { writeFileSync } = await import("node:fs");
    const output = stripQuotes(args);
    writeFileSync(output, json);
    return `ACP dump written to ${output}`;
  }

  return json;
}

async function handleLoadACPDump(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error('Usage: loadACPDump "path-or-json"');

  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const source = stripQuotes(args);
  let json = source;
  if (!source.trim().startsWith("[") && !source.trim().startsWith("{")) {
    const { readFileSync } = await import("node:fs");
    json = readFileSync(source, "utf-8");
  }

  await rawFrame.evaluate(requestDebugRPCInWindow, {
    events: DEBUG_RPC_EVENTS,
    method: ACP_DEBUG_RPC_METHODS.loadDump,
    params: { entries: json },
  });
  return "ACP dump loaded";
}

async function handleRestartACPServer(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error('Usage: restartACPServer "agent-server"');
  const agentServer = stripQuotes(args);
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  await rawFrame.evaluate(requestDebugRPCInWindow, {
    events: DEBUG_RPC_EVENTS,
    method: ACP_DEBUG_RPC_METHODS.restartServer,
    params: { agentServer },
  });
  return `ACP server restarted: ${agentServer}`;
}

async function handleRestartHelper(_args: string[], mgr: CamberQATarget): Promise<string> {
  const page = mgr.getPage();
  await commandPalette(page, "Developer: Reload Window");

  // The window reload destroys all frames — wait for VS Code to come back
  await sleep(3000);

  // Re-acquire the webview frames after reload
  await mgr.reacquireAfterReload();

  return "camber-helper restarted (window reloaded)";
}

function historyBackButton(mgr: CamberQATarget) {
  const frame = mgr.getCamberWebviewFrame();
  if (mgr.kind === "desktop") {
    return frame
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Back", exact: true });
  }
  return frame.getByRole("button", { name: /^Back to (projects|conversations)$/ });
}

async function isHistoryOpen(mgr: CamberQATarget): Promise<boolean> {
  const frame = mgr.getCamberWebviewFrame();
  const marker =
    mgr.kind === "desktop"
      ? frame.getByRole("textbox", { name: "Search archived chats", exact: true })
      : historyBackButton(mgr);
  return await marker
    .first()
    .isVisible()
    .catch(() => false);
}

async function ensureHistoryOpen(mgr: CamberQATarget): Promise<boolean> {
  const frame = mgr.getCamberWebviewFrame();
  if (await isHistoryOpen(mgr)) return false;
  if (mgr.kind === "desktop") {
    const settingsNav = frame.getByRole("navigation", { name: "Settings sections" });
    if (!(await settingsNav.isVisible().catch(() => false))) {
      await frame.getByRole("button", { name: "Settings", exact: true }).click({ timeout: 5000 });
      await settingsNav.waitFor({ state: "visible", timeout: 5000 });
    }
    await settingsNav
      .getByRole("button", { name: "Archived Chats", exact: true })
      .click({ timeout: 5000 });
    await frame
      .getByRole("textbox", { name: "Search archived chats", exact: true })
      .waitFor({ state: "visible", timeout: 5000 });
    return true;
  }
  const openButton = frame.getByRole("button", { name: /archived conversations/i }).first();
  await openButton.click({ timeout: 5000 });
  await historyBackButton(mgr).first().waitFor({ state: "visible", timeout: 5000 });
  return true;
}

async function handleOpenHistory(mgr: CamberQATarget): Promise<string> {
  const opened = await ensureHistoryOpen(mgr);
  return opened ? "History opened" : "History already open";
}

async function handleCloseHistory(mgr: CamberQATarget): Promise<string> {
  if (!(await isHistoryOpen(mgr))) {
    return "History was not open";
  }
  await historyBackButton(mgr).first().click({ timeout: 5000 });
  await sleep(300);
  return "History closed";
}

async function clickHistoryAction(
  args: string[],
  mgr: CamberQATarget,
  action: "Delete" | "Restore",
): Promise<string> {
  if (args.length === 0) {
    throw new Error(`Usage: ${action.toLowerCase()}Conversation "title-substring"`);
  }
  const target = stripQuotes(args);
  await ensureHistoryOpen(mgr);

  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const prefix = `${action} `;
  const lookup = await rawFrame.evaluate(
    ({ prefix, needle }) => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(`button[aria-label^="${prefix}"]`),
      );
      const lower = needle.toLowerCase();
      const matches = buttons.filter((btn) =>
        (btn.getAttribute("aria-label") ?? "").slice(prefix.length).toLowerCase().includes(lower),
      );
      if (matches.length === 0) return { result: "none" as const };
      if (matches.length > 1) return { result: "ambiguous" as const };
      const btn = matches[0];
      return {
        result: "ok" as const,
        ariaLabel: btn.getAttribute("aria-label") ?? "",
        disabled: btn.hasAttribute("disabled"),
        disabledReason: btn.getAttribute("title") ?? "",
      };
    },
    { prefix, needle: target },
  );

  if (lookup.result === "none") {
    if (action === "Restore") {
      throw new Error(
        `No archived conversation matching "${target}". (Restore is only available for archived sessions — for live conversations, use archiveConversation.)`,
      );
    }
    throw new Error(`No conversation matching "${target}" in archived chats`);
  }
  if (lookup.result === "ambiguous") {
    throw new Error(
      `"${target}" matches multiple conversations — narrow the title to a unique substring`,
    );
  }
  if (lookup.disabled) {
    throw new Error(
      lookup.disabledReason
        ? `Cannot ${action.toLowerCase()}: ${lookup.disabledReason}`
        : `Cannot ${action.toLowerCase()} — the button is disabled for this conversation`,
    );
  }

  const frame = mgr.getCamberWebviewFrame();
  const button = frame.getByRole("button", { name: lookup.ariaLabel, exact: true });
  await button.click({ timeout: 5000 });
  await sleep(500);
  const conversationTitle = lookup.ariaLabel.slice(prefix.length);
  return `${action === "Delete" ? "Deleted" : "Restored"}: ${conversationTitle}`;
}

async function handleDeleteConversation(args: string[], mgr: CamberQATarget): Promise<string> {
  return clickHistoryAction(args, mgr, "Delete");
}

async function handleRestoreConversation(args: string[], mgr: CamberQATarget): Promise<string> {
  return clickHistoryAction(args, mgr, "Restore");
}

function requireDesktop(mgr: CamberQATarget, command: string): void {
  if (mgr.kind !== "desktop") {
    throw new Error(`${command} is desktop-only (current target is ${mgr.kind})`);
  }
}

function requireVscode(mgr: CamberQATarget, command: string): void {
  if (mgr.kind !== "vscode") {
    throw new Error(`${command} is VS Code-only (current target is ${mgr.kind})`);
  }
}

async function handleOpenChat(mgr: CamberQATarget): Promise<string> {
  requireVscode(mgr, "openChat");
  const page = mgr.getPage();
  const activityIcon = page.locator('[aria-label*="Camber"]').first();
  if (await activityIcon.isVisible().catch(() => false)) {
    await activityIcon.click({ timeout: 5000 });
    await sleep(400);
    return "Opened Camber view (activity bar)";
  }
  // Fall back to the auto-generated "Focus on Camber View" command
  await commandPalette(page, "Focus on Camber View");
  return "Opened Camber view (command palette)";
}

async function handleFocusChat(mgr: CamberQATarget): Promise<string> {
  requireVscode(mgr, "focusChat");
  const page = mgr.getPage();
  await commandPalette(page, "Focus on Prompt Input");
  await sleep(200);
  return "Focused chat input";
}

async function handleToggleSidebar(mgr: CamberQATarget): Promise<string> {
  requireVscode(mgr, "toggleSidebar");
  const page = mgr.getPage();
  await commandPalette(page, "Toggle Primary Side Bar Visibility");
  await sleep(200);
  return "Toggled sidebar";
}

interface ProjectInfo {
  name: string;
  path: string;
  expanded: boolean;
  worktrees: Array<{ name: string; path: string }>;
}

async function collectProjects(mgr: CamberQATarget): Promise<ProjectInfo[]> {
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");
  return await rawFrame.evaluate(() => {
    const projects: Array<{
      name: string;
      path: string;
      expanded: boolean;
      worktrees: Array<{ name: string; path: string }>;
    }> = [];
    const sections = Array.from(document.querySelectorAll<HTMLElement>("section"));
    for (const section of sections) {
      const header = section.querySelector<HTMLButtonElement>("button[aria-label]");
      if (!header) continue;
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
      // Skip sections that don't look like project sections (no "Add worktree for ...")
      const addWorktreeBtn = section.querySelector<HTMLButtonElement>(
        `button[aria-label^="Add worktree for "]`,
      );
      if (!addWorktreeBtn) continue;

      const worktrees: Array<{ name: string; path: string }> = [];
      const worktreeHeaders = section.querySelectorAll<HTMLElement>('[class*="group/wthead"]');
      for (const wt of Array.from(worktreeHeaders)) {
        const mainBtn = wt.querySelector<HTMLButtonElement>("button[title]");
        const wtName = wt.querySelector<HTMLElement>("span.truncate")?.textContent?.trim();
        const wtPath = mainBtn?.getAttribute("title") ?? "";
        if (wtName) worktrees.push({ name: wtName, path: wtPath });
      }

      projects.push({ name, path, expanded, worktrees });
    }
    return projects;
  });
}

function findProject(projects: ProjectInfo[], needle: string): ProjectInfo {
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

async function handleListProjects(mgr: CamberQATarget): Promise<string> {
  requireDesktop(mgr, "listProjects");
  const projects = await collectProjects(mgr);
  if (projects.length === 0) return "(no projects)";
  return projects
    .map(
      (p) =>
        `${p.expanded ? "▼" : "▶"} ${p.name}  (${p.worktrees.length} worktree${p.worktrees.length === 1 ? "" : "s"})`,
    )
    .join("\n");
}

async function handleListWorktrees(args: string[], mgr: CamberQATarget): Promise<string> {
  requireDesktop(mgr, "listWorktrees");
  const projects = await collectProjects(mgr);
  let filtered = projects;
  const projectArgIdx = args.indexOf("--project");
  if (projectArgIdx >= 0 && projectArgIdx + 1 < args.length) {
    const target = findProject(projects, args[projectArgIdx + 1]);
    filtered = [target];
  }
  const lines: string[] = [];
  for (const p of filtered) {
    lines.push(p.name);
    if (p.worktrees.length === 0) {
      lines.push("  (no worktrees)");
    } else {
      for (const wt of p.worktrees) lines.push(`  ${wt.name}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no projects)";
}

async function handleOpenProject(args: string[], mgr: CamberQATarget): Promise<string> {
  requireDesktop(mgr, "openProject");
  if (args.length === 0) throw new Error('Usage: openProject "name-substring"');
  const target = findProject(await collectProjects(mgr), stripQuotes(args));
  if (target.expanded) return `Project already expanded: ${target.name}`;
  const frame = mgr.getCamberWebviewFrame();
  await frame
    .getByRole("button", { name: `Expand ${target.name}`, exact: true })
    .click({ timeout: 5000 });
  await sleep(300);
  return `Expanded project: ${target.name}`;
}

async function handleCloseProject(args: string[], mgr: CamberQATarget): Promise<string> {
  requireDesktop(mgr, "closeProject");
  if (args.length === 0) throw new Error('Usage: closeProject "name-substring"');
  const target = findProject(await collectProjects(mgr), stripQuotes(args));
  if (!target.expanded) return `Project already collapsed: ${target.name}`;
  // When expanded, the header button label is just the project name.
  // Clicking it again does nothing (the template wires onclick to undefined when expanded).
  // The actual collapse is via the kebab "Collapse" — but there isn't one. Reading the
  // template, the only way to collapse is via setProjectCollapsed which the project
  // header doesn't directly call. To stay UI-driven, click the project header — if it
  // doesn't collapse, surface the limitation.
  const frame = mgr.getCamberWebviewFrame();
  await frame
    .getByRole("button", { name: target.name, exact: true })
    .first()
    .click({ timeout: 5000 });
  await sleep(300);
  const after = await collectProjects(mgr);
  const refreshed = after.find((p) => p.name === target.name);
  if (refreshed?.expanded) {
    throw new Error(
      `closeProject is not supported in the current UI — the project header doesn't toggle collapse on click when expanded.`,
    );
  }
  return `Collapsed project: ${target.name}`;
}

async function handleRemoveProject(args: string[], mgr: CamberQATarget): Promise<string> {
  requireDesktop(mgr, "removeProject");
  if (args.length === 0) throw new Error('Usage: removeProject "name-substring"');
  const target = findProject(await collectProjects(mgr), stripQuotes(args));
  const frame = mgr.getCamberWebviewFrame();
  // Make sure the kebab is visible. When project collapsed it's hover-only — expand first.
  if (!target.expanded) {
    await frame
      .getByRole("button", { name: `Expand ${target.name}`, exact: true })
      .click({ timeout: 5000 });
    await sleep(200);
  }
  await frame
    .getByRole("button", { name: `More actions for ${target.name}`, exact: true })
    .click({ timeout: 5000 });
  const menu = frame.locator('[role="menu"]').last();
  await menu.waitFor({ state: "visible", timeout: 5000 });
  await menu
    .getByRole("menuitem", { name: "Remove project", exact: true })
    .click({ timeout: 5000 });
  await sleep(500);
  return `Removed project: ${target.name}`;
}

async function handleCreateWorktree(args: string[], mgr: CamberQATarget): Promise<string> {
  requireDesktop(mgr, "createWorktree");
  const projects = await collectProjects(mgr);
  let target: ProjectInfo;
  const projectArgIdx = args.indexOf("--project");
  if (projectArgIdx >= 0 && projectArgIdx + 1 < args.length) {
    target = findProject(projects, args[projectArgIdx + 1]);
  } else if (projects.length === 1) {
    target = projects[0];
  } else if (projects.length === 0) {
    throw new Error("No projects in the sidebar");
  } else {
    throw new Error(
      `Multiple projects available — specify --project NAME. Available: ${projects.map((p) => p.name).join(", ")}`,
    );
  }
  const frame = mgr.getCamberWebviewFrame();
  if (!target.expanded) {
    await frame
      .getByRole("button", { name: `Expand ${target.name}`, exact: true })
      .click({ timeout: 5000 });
    await sleep(300);
  }
  const before = new Set(
    (await collectProjects(mgr))
      .find((p) => p.name === target.name)
      ?.worktrees.map((w) => w.name) ?? [],
  );
  await frame
    .getByRole("button", { name: `Add worktree for ${target.name}`, exact: true })
    .click({ timeout: 5000 });

  // The worktree name is server-assigned. Wait for it to appear in the project's worktree list.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const fresh = await collectProjects(mgr);
    const refreshed = fresh.find((p) => p.name === target.name);
    if (refreshed) {
      const newWorktree = refreshed.worktrees.find((w) => !before.has(w.name));
      if (newWorktree) {
        return `Created worktree: ${newWorktree.name} (project: ${target.name})`;
      }
    }
    await sleep(300);
  }
  throw new Error(
    `createWorktree clicked but no new worktree appeared in "${target.name}" within 15s`,
  );
}

interface WorktreeMatch {
  project: ProjectInfo;
  name: string;
  path: string;
}

function findWorktree(projects: ProjectInfo[], needle: string): WorktreeMatch {
  const lower = needle.toLowerCase();
  const matches: WorktreeMatch[] = [];
  for (const p of projects) {
    for (const wt of p.worktrees) {
      if (wt.name.toLowerCase().includes(lower)) {
        matches.push({ project: p, name: wt.name, path: wt.path });
      }
    }
  }
  if (matches.length === 0) {
    throw new Error(`No worktree matching "${needle}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `"${needle}" matches multiple worktrees: ${matches.map((m) => `${m.project.name}/${m.name}`).join(", ")}`,
    );
  }
  return matches[0];
}

async function handleRemoveWorktree(args: string[], mgr: CamberQATarget): Promise<string> {
  requireDesktop(mgr, "removeWorktree");
  if (args.length === 0) throw new Error('Usage: removeWorktree "name-substring"');
  const target = findWorktree(await collectProjects(mgr), stripQuotes(args));
  const frame = mgr.getCamberWebviewFrame();
  if (!target.project.expanded) {
    await frame
      .getByRole("button", { name: `Expand ${target.project.name}`, exact: true })
      .click({ timeout: 5000 });
    await sleep(200);
  }
  const deleteButton = frame.getByRole("button", {
    name: `Delete worktree ${target.name}`,
    exact: true,
  });
  await deleteButton.scrollIntoViewIfNeeded({ timeout: 5000 });
  await deleteButton.hover({ timeout: 5000, force: true });
  await deleteButton.click({ timeout: 5000, force: true });
  await sleep(5500);
  return `Removed worktree: ${target.name} (project: ${target.project.name})`;
}

async function handleOpenWorktree(args: string[], mgr: CamberQATarget): Promise<string> {
  requireDesktop(mgr, "openWorktree");
  if (args.length === 0) throw new Error('Usage: openWorktree "name-substring"');
  const target = findWorktree(await collectProjects(mgr), stripQuotes(args));
  const frame = mgr.getCamberWebviewFrame();
  if (!target.project.expanded) {
    await frame
      .getByRole("button", { name: `Expand ${target.project.name}`, exact: true })
      .click({ timeout: 5000 });
    await sleep(200);
  }
  // Worktree main button has no aria-label, only title={path}. Match by exact title.
  const button = frame.locator(`button[title="${target.path}"]`).first();
  await button.click({ timeout: 5000 });
  await sleep(500);
  return `Opened worktree: ${target.name} (project: ${target.project.name})`;
}

async function handleGetConfigs(mgr: CamberQATarget): Promise<string> {
  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const rows = await rawFrame.evaluate(() => {
    const labels = Array.from(document.querySelectorAll<HTMLSpanElement>("span")).filter((span) =>
      /^[A-Za-z][\w ]*:$/.test(span.textContent?.trim() ?? ""),
    );
    const seen = new Set<string>();
    const results: Array<{ name: string; value: string }> = [];
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
      results.push({ name, value: (valueSpan.textContent ?? "").trim() });
    }
    return results;
  });

  if (rows.length === 0) {
    return "(no session config options found — is a conversation open?)";
  }
  return rows.map((r) => `${r.name}: ${r.value}`).join("\n");
}

async function handleSetConfig(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length < 2) {
    throw new Error("Usage: setConfig <name> <value>   e.g. setConfig mode plan");
  }
  const [rawName, ...rest] = args;
  const name = rawName.replace(/^"(.*)"$/, "$1");
  const value = stripQuotes(rest);

  const rawFrame = mgr.getCamberRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const triggerIndex = await rawFrame.evaluate((nameNeedle) => {
    const labels = Array.from(document.querySelectorAll<HTMLSpanElement>("span")).filter((span) =>
      /^[A-Za-z][\w ]*:$/.test(span.textContent?.trim() ?? ""),
    );
    const needle = nameNeedle.toLowerCase();
    const matchIndexes: number[] = [];
    labels.forEach((span, i) => {
      const text = (span.textContent ?? "").trim().replace(/:$/, "").toLowerCase();
      if (text.includes(needle)) matchIndexes.push(i);
    });
    if (matchIndexes.length === 0) return -1;
    if (matchIndexes.length > 1) return -2;
    return matchIndexes[0];
  }, name);

  if (triggerIndex === -1) {
    throw new Error(`No session config option matching "${name}"`);
  }
  if (triggerIndex === -2) {
    throw new Error(`"${name}" matches multiple config options — be more specific`);
  }

  const frame = mgr.getCamberWebviewFrame();
  await rawFrame.evaluate((idx) => {
    const labels = Array.from(document.querySelectorAll<HTMLSpanElement>("span")).filter((span) =>
      /^[A-Za-z][\w ]*:$/.test(span.textContent?.trim() ?? ""),
    );
    const trigger = labels[idx].parentElement?.querySelector<HTMLButtonElement>("button");
    trigger?.click();
  }, triggerIndex);

  const menu = frame.locator('[role="menu"]').last();
  await menu.waitFor({ state: "visible", timeout: 5000 });

  const items = menu.locator('[role="menuitem"]');
  const itemTexts = await items.allTextContents();
  const needle = value.toLowerCase();
  const matches = itemTexts
    .map((text, i) => ({ text: text.trim(), i }))
    .filter((entry) => entry.text.toLowerCase().includes(needle));

  if (matches.length === 0) {
    await mgr.getPage().keyboard.press("Escape");
    throw new Error(
      `No "${name}" option matching "${value}". Available: ${itemTexts.map((t) => t.trim()).join(", ")}`,
    );
  }
  if (matches.length > 1) {
    await mgr.getPage().keyboard.press("Escape");
    throw new Error(
      `"${value}" matches multiple "${name}" options: ${matches.map((m) => m.text).join(", ")}`,
    );
  }

  await items.nth(matches[0].i).click({ timeout: 5000 });
  await sleep(500);
  return `Set ${name} → ${matches[0].text}`;
}

async function handleHelperLogs(args: string[], mgr: CamberQATarget): Promise<string> {
  const tailLines = parseInt(args[0] || "500", 10);

  const logFile = mgr.findLatestHelperLog();
  if (!logFile) {
    return "(no helper log files found)";
  }

  const { readFileSync } = await import("node:fs");
  const content = readFileSync(logFile, "utf-8");
  const lines = content.split("\n");
  const tail = lines.slice(-tailLines);
  return tail.join("\n");
}
