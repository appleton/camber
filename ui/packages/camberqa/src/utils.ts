/**
 * Shared utilities for camberqa commands.
 */

import type { Page } from "playwright";

export const CAMBER_DEV_PORT = parseInt(process.env.VITE_DEV_PORT || "5173", 10);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Join args and strip surrounding quotes: `["hello", "world"]` → `hello world` */
export function stripQuotes(args: string[]): string {
  return args.join(" ").replace(/^"(.*)"$/, "$1");
}

/**
 * Open VS Code command palette, type a command, and press Enter.
 * Waits for the quick-input widget to appear and disappear.
 */
export async function commandPalette(page: Page, command: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");
  await page.locator(".quick-input-widget").waitFor({ state: "visible", timeout: 5000 });
  await page.keyboard.type(command);
  await sleep(300);
  await page.keyboard.press("Enter");
  await page.locator(".quick-input-widget").waitFor({ state: "hidden", timeout: 5000 });
}
