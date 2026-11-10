/**
 * Accessibility tree snapshot with ref-based element selection.
 *
 * Uses Playwright's ariaSnapshot() API to extract the accessibility tree,
 * assigns @e1, @e2... refs to elements for subsequent interaction.
 */

import * as Diff from "diff";
import type { Locator } from "playwright";
import type { CamberQATarget } from "./targets/types.js";

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

export interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  diff?: boolean;
}

interface ParsedNode {
  indent: number;
  role: string;
  name: string | null;
  props: string;
  children: string;
  rawLine: string;
}

export function parseSnapshotArgs(args: string[]): SnapshotOptions {
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
        opts.depth = parseInt(args[++i], 10);
        if (isNaN(opts.depth!)) throw new Error("Usage: snapshot -d <number>");
        break;
      case "-s":
      case "--selector":
        opts.selector = args[++i];
        if (!opts.selector) throw new Error("Usage: snapshot -s <selector>");
        break;
      case "-D":
      case "--diff":
        opts.diff = true;
        break;
      default:
        throw new Error(`Unknown snapshot flag: ${args[i]}`);
    }
  }
  return opts;
}

function parseLine(line: string): ParsedNode | null {
  const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+(\[.*?\]))?\s*(?::\s*(.*))?$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    role: match[2],
    name: match[3] ?? null,
    props: match[4] || "",
    children: match[5]?.trim() || "",
    rawLine: line,
  };
}

export async function handleSnapshot(args: string[], mgr: CamberQATarget): Promise<string> {
  const opts = parseSnapshotArgs(args);

  let ariaText: string | null = null;
  const rawFrame = mgr.getRawFrame();

  if (rawFrame) {
    try {
      const rootLocator = opts.selector
        ? rawFrame.locator(opts.selector)
        : rawFrame.locator("body");
      ariaText = await rootLocator.ariaSnapshot({ timeout: 10_000 });
    } catch (err: any) {
      console.warn(`[camberqa] ariaSnapshot failed on raw frame: ${err.message}`);
    }
  }

  if (!ariaText) {
    try {
      const webviewFrame = mgr.getWebviewFrame();
      const rootLocator = opts.selector
        ? webviewFrame.locator(opts.selector)
        : webviewFrame.locator("body");
      ariaText = await rootLocator.ariaSnapshot({ timeout: 10_000 });
    } catch (err: any) {
      console.warn(`[camberqa] ariaSnapshot fallback also failed: ${err.message}`);
    }
  }

  if (!ariaText || ariaText.trim().length === 0) {
    mgr.setRefMap(new Map());
    return "(no accessible elements found)";
  }

  const lines = ariaText.split("\n");
  const refMap = new Map<string, Locator>();
  const output: string[] = [];
  let refCounter = 1;

  const roleNameCounts = new Map<string, number>();
  const roleNameSeen = new Map<string, number>();

  for (const line of lines) {
    const node = parseLine(line);
    if (!node) continue;
    const key = `${node.role}:${node.name || ""}`;
    roleNameCounts.set(key, (roleNameCounts.get(key) || 0) + 1);
  }

  const locatorSource = rawFrame || mgr.getWebviewFrame();

  for (const line of lines) {
    const node = parseLine(line);
    if (!node) continue;

    const depth = Math.floor(node.indent / 2);
    const isInteractive = INTERACTIVE_ROLES.has(node.role);

    if (opts.depth !== undefined && depth > opts.depth) {
      const key = `${node.role}:${node.name || ""}`;
      roleNameSeen.set(key, (roleNameSeen.get(key) || 0) + 1);
      continue;
    }

    if (opts.interactive && !isInteractive) {
      const key = `${node.role}:${node.name || ""}`;
      roleNameSeen.set(key, (roleNameSeen.get(key) || 0) + 1);
      continue;
    }

    if (opts.compact && !isInteractive && !node.name && !node.children) {
      const key = `${node.role}:${node.name || ""}`;
      roleNameSeen.set(key, (roleNameSeen.get(key) || 0) + 1);
      continue;
    }

    const ref = `e${refCounter++}`;
    const indent = "  ".repeat(depth);

    const key = `${node.role}:${node.name || ""}`;
    const seenIndex = roleNameSeen.get(key) || 0;
    roleNameSeen.set(key, seenIndex + 1);
    const totalCount = roleNameCounts.get(key) || 1;

    const base = opts.selector ? locatorSource.locator(opts.selector) : locatorSource;
    let locator = base.getByRole(node.role as any, { name: node.name || undefined });

    if (totalCount > 1) {
      locator = locator.nth(seenIndex);
    }

    refMap.set(ref, locator);

    let outputLine = `${indent}@${ref} [${node.role}]`;
    if (node.name) outputLine += ` "${node.name}"`;
    if (node.props) outputLine += ` ${node.props}`;
    if (node.children) outputLine += `: ${node.children}`;

    output.push(outputLine);
  }

  mgr.setRefMap(refMap);

  if (output.length === 0) {
    return "(no interactive elements found)";
  }

  const snapshotText = output.join("\n");

  if (opts.diff) {
    const lastSnapshot = mgr.getLastSnapshot();
    if (!lastSnapshot) {
      mgr.setLastSnapshot(snapshotText);
      return (
        snapshotText +
        "\n\n(no previous snapshot to diff against — this snapshot stored as baseline)"
      );
    }

    const changes = Diff.diffLines(lastSnapshot, snapshotText);
    const diffOutput: string[] = ["--- previous snapshot", "+++ current snapshot", ""];

    for (const part of changes) {
      const prefix = part.added ? "+" : part.removed ? "-" : " ";
      const diffLines = part.value.split("\n").filter((l) => l.length > 0);
      for (const line of diffLines) {
        diffOutput.push(`${prefix} ${line}`);
      }
    }

    mgr.setLastSnapshot(snapshotText);
    return diffOutput.join("\n");
  }

  mgr.setLastSnapshot(snapshotText);
  return snapshotText;
}
