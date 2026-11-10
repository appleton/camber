import type { VSCodeMcpServer } from "@camber/rpc";
import * as path from "path";
import * as vscode from "vscode";
import type { System } from "../../system";

/**
 * Reads MCP servers the user has configured in VS Code so they can be imported
 * into Camber connectors without retyping. VS Code stores these in mcp.json:
 *   - workspace: <folder>/.vscode/mcp.json
 *   - user:      <userData>/User/mcp.json
 * Both use a `{ "servers": { name: def } }` shape (we also accept the
 * `mcpServers` key other tools use). There is no public API to enumerate them,
 * so we read the files directly.
 */
export async function listVSCodeMcpServers(system: System): Promise<VSCodeMcpServer[]> {
  const out: VSCodeMcpServer[] = [];
  const seen = new Set<string>();

  const addFromFile = async (uri: vscode.Uri, source: "workspace" | "user") => {
    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(uri);
    } catch {
      return; // file missing — fine
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return; // invalid JSON — skip
    }
    const servers = readServersMap(parsed);
    for (const [name, def] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      const server = normalizeServer(name, def, source);
      if (server) {
        out.push(server);
        seen.add(name);
      }
    }
  };

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    await addFromFile(vscode.Uri.joinPath(folder.uri, ".vscode", "mcp.json"), "workspace");
  }

  // globalStorageUri = <userData>/User/globalStorage/<ext>; mcp.json sits in <userData>/User.
  try {
    const userDir = path.dirname(path.dirname(system.context.globalStorageUri.fsPath));
    await addFromFile(vscode.Uri.file(path.join(userDir, "mcp.json")), "user");
  } catch {
    // best effort
  }

  return out;
}

function readServersMap(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const servers = obj.servers ?? obj.mcpServers;
  if (!servers || typeof servers !== "object") return {};
  return servers as Record<string, unknown>;
}

function normalizeServer(
  name: string,
  def: unknown,
  source: "workspace" | "user",
): VSCodeMcpServer | null {
  if (!def || typeof def !== "object") return null;
  const d = def as Record<string, unknown>;

  if (typeof d.command === "string" && d.command) {
    return {
      name,
      source,
      command: d.command,
      args: Array.isArray(d.args) ? d.args.map(String) : undefined,
      env: asStringMap(d.env),
    };
  }
  if (typeof d.url === "string" && d.url) {
    return {
      name,
      source,
      url: d.url,
      headers: asStringMap(d.headers),
    };
  }
  return null;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
