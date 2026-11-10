import { InfoMessageType } from "@camber/rpc";
import type { ACPDumpEntry } from "./debugDump";
import { rpc } from "./hostRpc";

export async function saveACPConversationDump(data: string, assistantHost: string): Promise<void> {
  await saveJsonFile(`acp-dump-${timestampForFilename()}.json`, data, assistantHost, "ACP dump");
}

/** Save a (typically conversation-scoped) ACP trajectory as a JSON file. */
export async function saveACPTrajectory(
  entries: ACPDumpEntry[],
  sessionId: string | null,
  assistantHost: string,
): Promise<void> {
  const stem = sessionId && sessionId.length > 0 ? sanitizeFileStem(sessionId) : "current";
  const filename = `acp-trajectory-${stem}-${timestampForFilename()}.json`;
  await saveJsonFile(filename, JSON.stringify(entries, null, 2), assistantHost, "ACP trajectory");
}

async function saveJsonFile(
  filename: string,
  data: string,
  assistantHost: string,
  label: string,
): Promise<void> {
  try {
    const savedPath = await rpc.saveTextFile({
      title: `Save ${label}`,
      defaultFileName: filename,
      contents: data,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (savedPath) {
      rpc.showInfoMessage(`${label} saved to ${savedPath}`, InfoMessageType.info);
    }
    return;
  } catch (error) {
    if (assistantHost === "desktop") {
      console.error(`Failed to save ${label}`, error);
      rpc.showInfoMessage(`Failed to save ${label}`, InfoMessageType.error);
      return;
    }
    console.debug("Host saveTextFile unavailable; falling back to browser download", error);
  }

  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  rpc.showInfoMessage(`${label} saved`, InfoMessageType.info);
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}
