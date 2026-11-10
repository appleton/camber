/**
 * Generic interaction commands operating within the webview frame.
 */

import { handleSnapshot } from "../snapshot.js";
import type { CamberQATarget } from "../targets/types.js";
import { stripQuotes } from "../utils.js";

export async function handleGenericCommand(
  command: string,
  args: string[],
  mgr: CamberQATarget,
): Promise<string> {
  switch (command) {
    case "snapshot":
      return handleSnapshot(args, mgr);
    case "click":
      return handleClick(args, mgr);
    case "fill":
      return handleFill(args, mgr);
    case "type":
      return handleType(args, mgr);
    case "press":
      return handlePress(args, mgr);
    case "scroll":
      return handleScroll(args, mgr);
    case "wait":
      return handleWait(args, mgr);
    case "screenshot":
      return handleScreenshot(args, mgr);
    case "hover":
      return handleHover(args, mgr);
    case "screenshotElement":
      return handleScreenshotElement(args, mgr);
    default:
      throw new Error(`Unknown generic command: ${command}`);
  }
}

async function handleClick(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error("Usage: click @ref or click <selector>");

  const resolved = mgr.resolveRef(args[0]);
  if ("locator" in resolved) {
    await resolved.locator.click({ timeout: 5000 });
  } else {
    const frame = mgr.getWebviewFrame();
    await frame.locator(resolved.selector).click({ timeout: 5000 });
  }
  return `Clicked ${args[0]}`;
}

async function handleFill(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length < 2) throw new Error('Usage: fill @ref "text"');

  const value = stripQuotes(args.slice(1));
  const resolved = mgr.resolveRef(args[0]);
  if ("locator" in resolved) {
    await resolved.locator.fill(value, { timeout: 5000 });
  } else {
    const frame = mgr.getWebviewFrame();
    await frame.locator(resolved.selector).fill(value, { timeout: 5000 });
  }
  return `Filled ${args[0]} with "${value}"`;
}

async function handleType(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error('Usage: type "text"');

  const text = stripQuotes(args);
  const page = mgr.getPage();
  await page.keyboard.type(text);
  return `Typed "${text}"`;
}

async function handlePress(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error('Usage: press "Key"');

  const key = stripQuotes([args[0]]);
  const page = mgr.getPage();
  await page.keyboard.press(key);
  return `Pressed ${key}`;
}

async function handleScroll(args: string[], mgr: CamberQATarget): Promise<string> {
  const direction = args[0] || "down";
  const amount = parseInt(args[1] || "300", 10);
  const delta = direction === "up" ? -amount : amount;

  const rawFrame = mgr.getRawFrame();
  if (rawFrame) {
    await rawFrame.evaluate((dy) => {
      const scrollable = document.querySelector(".scrollView") || document.documentElement;
      scrollable.scrollBy(0, dy);
    }, delta);
  } else {
    const page = mgr.getPage();
    await page.mouse.wheel(0, delta);
  }
  return `Scrolled ${direction} ${amount}px`;
}

async function handleWait(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error('Usage: wait "selector" [timeout]');

  const selector = stripQuotes([args[0]]);
  const timeout = parseInt(args[1] || "10000", 10);

  const frame = mgr.getWebviewFrame();
  await frame.locator(selector).waitFor({ state: "visible", timeout });
  return `Element "${selector}" is visible`;
}

async function handleScreenshot(args: string[], mgr: CamberQATarget): Promise<string> {
  let outputPath = "/tmp/camberqa-screenshot.png";
  let webviewOnly = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-o":
      case "--output":
        outputPath = args[++i];
        break;
      case "--webview":
        webviewOnly = true;
        break;
      default:
        if (!args[i].startsWith("-")) outputPath = args[i];
    }
  }

  if (webviewOnly) {
    const rawFrame = mgr.getRawFrame();
    if (rawFrame) {
      const body = rawFrame.locator("body");
      await body.screenshot({ path: outputPath, timeout: 10_000 });
    } else {
      const page = mgr.getPage();
      await page.screenshot({ path: outputPath });
    }
  } else {
    const page = mgr.getPage();
    await page.screenshot({ path: outputPath });
  }

  return `Screenshot saved to ${outputPath}`;
}

async function handleHover(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error("Usage: hover @ref or hover <selector>");

  const resolved = mgr.resolveRef(args[0]);
  if ("locator" in resolved) {
    await resolved.locator.hover({ timeout: 5000 });
  } else {
    const frame = mgr.getWebviewFrame();
    await frame.locator(resolved.selector).hover({ timeout: 5000 });
  }
  return `Hovered ${args[0]}`;
}

async function handleScreenshotElement(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) throw new Error("Usage: screenshotElement @ref [-p padding] [-o path]");

  let ref = "";
  let outputPath = "/tmp/camberqa-element.png";
  let padding = 10;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-o":
      case "--output":
        outputPath = args[++i];
        break;
      case "-p":
      case "--padding":
        padding = parseInt(args[++i], 10);
        break;
      default:
        if (!args[i].startsWith("-")) ref = ref || args[i];
    }
  }

  if (!ref) throw new Error("Usage: screenshotElement @ref [-p padding] [-o path]");

  const resolved = mgr.resolveRef(ref);
  const locator =
    "locator" in resolved ? resolved.locator : mgr.getWebviewFrame().locator(resolved.selector);

  const box = await locator.boundingBox({ timeout: 5000 });
  if (!box) throw new Error(`Element ${ref} not visible or has no bounding box`);

  const page = mgr.getPage();
  const clipX = Math.max(0, box.x - padding);
  const clipY = Math.max(0, box.y - padding);
  await page.screenshot({
    path: outputPath,
    clip: {
      x: clipX,
      y: clipY,
      width: box.width + (box.x - clipX) + padding,
      height: box.height + (box.y - clipY) + padding,
    },
  });

  return `Element screenshot saved to ${outputPath}`;
}
