/**
 * Read commands — extract content from the webview frame.
 */

import type { CamberQATarget, WebIssue } from "../targets/types.js";

export async function handleReadCommand(
  command: string,
  args: string[],
  mgr: CamberQATarget,
): Promise<string> {
  switch (command) {
    case "text":
      return handleText(args, mgr);
    case "html":
      return handleHtml(args, mgr);
    case "js":
      return handleJs(args, mgr);
    case "component":
      return handleComponent(args, mgr);
    case "webErrors":
      return handleWebErrors(args, mgr);
    default:
      throw new Error(`Unknown read command: ${command}`);
  }
}

async function handleText(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length > 0 && args[0].startsWith("@")) {
    const resolved = mgr.resolveRef(args[0]);
    if ("locator" in resolved) {
      const text = await resolved.locator.innerText({ timeout: 5000 });
      return text || "(empty)";
    }
  }

  const rawFrame = mgr.getRawFrame();
  if (rawFrame) {
    const selector = args[0] || "body";
    const text = await rawFrame.locator(selector).innerText({ timeout: 5000 });
    return text || "(empty)";
  }

  const frame = mgr.getWebviewFrame();
  const selector = args[0] || "body";
  const text = await frame.locator(selector).innerText({ timeout: 5000 });
  return text || "(empty)";
}

async function handleHtml(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length > 0 && args[0].startsWith("@")) {
    const resolved = mgr.resolveRef(args[0]);
    if ("locator" in resolved) {
      return await resolved.locator.innerHTML({ timeout: 5000 });
    }
  }

  const rawFrame = mgr.getRawFrame();
  if (rawFrame) {
    const selector = args[0] || "body";
    return await rawFrame.locator(selector).innerHTML({ timeout: 5000 });
  }

  const frame = mgr.getWebviewFrame();
  const selector = args[0] || "body";
  return await frame.locator(selector).innerHTML({ timeout: 5000 });
}

async function handleComponent(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error("Usage: component @ref [--components-only] [-d depth]");

  let ref = "";
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
        maxDepth = parseInt(args[++i], 10);
        break;
      default:
        if (!ref) ref = args[i];
    }
  }
  if (!ref) throw new Error("Usage: component @ref [--components-only] [-d depth]");

  const resolved = mgr.resolveRef(ref);
  const rawFrame = mgr.getRawFrame();
  if (!rawFrame) throw new Error("Raw frame not available");

  const locator = "locator" in resolved ? resolved.locator : rawFrame.locator(resolved.selector);
  const handle = await locator.elementHandle({ timeout: 5000 });
  if (!handle) throw new Error(`Element ${args[0]} not found`);

  const tree = await rawFrame.evaluate((el: Element) => {
    interface MetaNode {
      type: string;
      file: string;
      line: number;
      column: number;
      componentTag?: string;
      parent: MetaNode | null;
    }

    // Walk up the DOM tree to find the nearest element with __svelte_meta
    let target: Element | null = el;
    let meta: { loc: MetaNode; parent: MetaNode } | undefined;
    let domStepsUp = 0;
    while (target) {
      meta = (target as any).__svelte_meta;
      if (meta) break;
      target = target.parentElement;
      domStepsUp++;
    }
    if (!meta) return null;

    const entries: { type: string; file: string; line: number; componentTag?: string }[] = [];

    // The element's own source location
    if (meta.loc?.file) {
      entries.push({
        type: "element",
        file: meta.loc.file,
        line: meta.loc.line,
      });
    }

    // Walk up the component/render parent chain
    let cursor: MetaNode | null = meta.parent ?? null;
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
  }, handle);

  await handle.dispose();

  if (!tree || tree.entries.length === 0) {
    return "(no Svelte component metadata found — is the extension running in dev mode?)";
  }

  const prefix =
    tree.domStepsUp > 0
      ? `(no metadata on element — found nearest Svelte ancestor ${tree.domStepsUp} level${tree.domStepsUp > 1 ? "s" : ""} up)\n`
      : "";

  let filtered = tree.entries;
  if (componentsOnly) {
    // Keep the first entry (the element itself) and only component nodes
    filtered = tree.entries.filter((entry, i) => i === 0 || entry.type === "component");
  } else {
    // Deduplicate consecutive entries from the same file (e.g. nested if blocks)
    filtered = tree.entries.filter(
      (entry, i) =>
        i === 0 || entry.file !== tree.entries[i - 1].file || entry.type === "component",
    );
  }

  if (maxDepth < Infinity) {
    filtered = filtered.slice(0, maxDepth + 1);
  }

  const lines = filtered.map((entry, i) => {
    const indent = "  ".repeat(i);
    const label = entry.componentTag ? `<${entry.componentTag}>` : `[${entry.type}]`;
    return `${indent}${label} ${entry.file}:${entry.line}`;
  });

  return prefix + lines.join("\n");
}

async function handleJs(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error('Usage: js "expression"');

  const expression = args.join(" ").replace(/^"(.*)"$/, "$1");

  const rawFrame = mgr.getRawFrame();
  if (rawFrame) {
    const result = await rawFrame.evaluate(expression);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  throw new Error(
    "Cannot evaluate JS — raw frame not available. Try 'snapshot' first to ensure frame discovery.",
  );
}

function handleWebErrors(args: string[], mgr: CamberQATarget): string {
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

  const issues = mgr.getWebIssues({ includeAll, clear, limit });
  if (issues.length === 0) {
    return includeAll ? "(no web console entries captured)" : "(no web errors captured)";
  }
  return issues.map(formatWebIssue).join("\n\n");
}

function formatWebIssue(issue: WebIssue): string {
  const location = formatLocation(issue);
  const prefix = `[${issue.timestamp}] ${issue.kind}:${issue.level}${location}`;
  return `${prefix}\n${issue.text}`;
}

function formatLocation(issue: WebIssue): string {
  if (!issue.location?.url) return "";
  const { url, lineNumber, columnNumber } = issue.location;
  const line = lineNumber !== undefined && lineNumber > 0 ? `:${lineNumber}` : "";
  const column = columnNumber !== undefined && columnNumber > 0 ? `:${columnNumber}` : "";
  return ` ${url}${line}${column}`;
}
