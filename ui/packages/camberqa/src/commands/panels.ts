/**
 * Panel commands — discover and switch between webview panels.
 *
 * The Camber sidebar is one panel; editor-area webview panels (e.g. the
 * "Review Changes" diff view shown when the agent edits files in the
 * disk-access-limited sandbox) are also addressable. Generic commands
 * (snapshot, screenshot, click, fill, etc.) operate on the currently
 * selected panel; Camber-specific commands always target the sidebar.
 */

import type { CamberQATarget } from "../targets/types.js";
import { stripQuotes } from "../utils.js";

export async function handlePanelCommand(
  command: string,
  args: string[],
  mgr: CamberQATarget,
): Promise<string> {
  switch (command) {
    case "listPanels":
      return handleListPanels(mgr);
    case "selectPanel":
      return handleSelectPanel(args, mgr);
    case "getCurrentPanel":
      return handleGetCurrentPanel(mgr);
    default:
      throw new Error(`Unknown panel command: ${command}`);
  }
}

async function handleListPanels(mgr: CamberQATarget): Promise<string> {
  const panels = await mgr.discoverPanels();
  if (panels.length === 0) return "(no webview panels found)";
  const current = mgr.getCurrentPanelName();
  return panels.map((p) => `${p.name === current ? "*" : " "} ${p.name}`).join("\n");
}

async function handleSelectPanel(args: string[], mgr: CamberQATarget): Promise<string> {
  if (args.length === 0) {
    throw new Error('Usage: selectPanel "name"');
  }
  const name = stripQuotes(args);
  await mgr.selectPanel(name);
  return `Selected panel: "${mgr.getCurrentPanelName()}"`;
}

async function handleGetCurrentPanel(mgr: CamberQATarget): Promise<string> {
  return mgr.getCurrentPanelName();
}
