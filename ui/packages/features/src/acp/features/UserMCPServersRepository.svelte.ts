import {
  camberMcpServersAuthenticate,
  camberMcpServersDelete,
  camberMcpServersList,
  camberMcpServersSetEnabled,
  camberMcpServersSignOut,
  camberMcpServersTestConfig,
  camberMcpServersTestConnection,
  camberMcpServersUpsert,
} from "@camber/helperapi";
import type { MCPServerEntry, MCPServersTestConnectionOutput } from "@camber/helperapi/schemas";
import { extractErrorMessage, isMethodNotFoundError } from "../errors";

export type { MCPServerEntry };

export class UserMCPServersRepository {
  private readonly changeListeners = new Set<() => void>();
  private readonly enabledSaveQueues = new Map<string, Promise<void>>();
  private readonly enabledSaveTokens = new Map<string, number>();
  private readonly persistedEnabled = new Map<string, boolean>();

  isLoading = $state(false);
  isSaving = $state(false);
  isAuthenticating = $state<string | null>(null);
  isTesting = $state<string | null>(null);
  error = $state<string | null>(null);
  servers = $state<MCPServerEntry[]>([]);
  testResults = $state<Record<string, MCPServersTestConnectionOutput>>({});
  oauthState = $state<Record<string, boolean>>({});

  isSupported = $state<boolean | null>(null);

  onDidChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async load(): Promise<void> {
    this.isLoading = true;
    this.error = null;
    try {
      const result = await camberMcpServersList({});
      this.isSupported = true;
      const servers = result.servers ?? [];
      const nextOAuthState = { ...this.oauthState };
      for (const server of servers) {
        if (server.oauthAuthenticated !== undefined) {
          nextOAuthState[server.name] = server.oauthAuthenticated;
        }
      }
      this.oauthState = nextOAuthState;
      this.servers = servers;
    } catch (e) {
      if (isMethodNotFoundError(e)) {
        this.isSupported = false;
        return;
      }
      this.isSupported = true;
      this.error = extractErrorMessage(e, "Failed to load MCP servers");
    } finally {
      this.isLoading = false;
    }
  }

  async upsert(entry: MCPServerEntry): Promise<void> {
    this.isSaving = true;
    this.error = null;
    try {
      await camberMcpServersUpsert({ server: entry });
      await this.load();
      this.notifyChanged();
    } catch (e) {
      this.error = extractErrorMessage(e, "Failed to save MCP server");
      throw e;
    } finally {
      this.isSaving = false;
    }
  }

  async delete(name: string): Promise<void> {
    this.isSaving = true;
    this.error = null;
    try {
      await camberMcpServersDelete({ name });
      this.servers = this.servers.filter((s) => s.name !== name);
      const next = { ...this.testResults };
      delete next[name];
      this.testResults = next;
      this.notifyChanged();
    } catch (e) {
      this.error = extractErrorMessage(e, "Failed to delete MCP server");
      throw e;
    } finally {
      this.isSaving = false;
    }
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (!this.persistedEnabled.has(name)) {
      const current = this.servers.find((server) => server.name === name)?.enabled;
      if (current !== undefined) this.persistedEnabled.set(name, current);
    }
    const token = (this.enabledSaveTokens.get(name) ?? 0) + 1;
    this.enabledSaveTokens.set(name, token);
    this.servers = this.servers.map((s) => (s.name === name ? { ...s, enabled } : s));
    const operation = (this.enabledSaveQueues.get(name) ?? Promise.resolve()).then(async () => {
      await camberMcpServersSetEnabled({ name, enabled });
      this.persistedEnabled.set(name, enabled);
      this.notifyChanged();
    });
    this.enabledSaveQueues.set(
      name,
      operation.catch(() => undefined),
    );
    try {
      await operation;
    } catch (e) {
      if (this.enabledSaveTokens.get(name) === token) {
        const persisted = this.persistedEnabled.get(name);
        if (persisted !== undefined) {
          this.servers = this.servers.map((server) =>
            server.name === name ? { ...server, enabled: persisted } : server,
          );
        }
        this.error = extractErrorMessage(e, "Failed to toggle server");
      }
      throw e;
    } finally {
      if (this.enabledSaveTokens.get(name) === token) {
        this.enabledSaveQueues.delete(name);
        this.enabledSaveTokens.delete(name);
        this.persistedEnabled.delete(name);
      }
    }
  }

  async authenticate(name: string): Promise<void> {
    this.isAuthenticating = name;
    this.error = null;
    try {
      await camberMcpServersAuthenticate({ name });
      this.oauthState = { ...this.oauthState, [name]: true };
      this.notifyChanged();
    } catch (e) {
      // A failed sign-in leaves the server unauthenticated — unless a stored
      // token is already known to exist (a failed re-auth doesn't revoke it).
      const entry = this.servers.find((s) => s.name === name);
      if (this.oauthState[name] !== true && entry?.oauthAuthenticated !== true) {
        this.oauthState = { ...this.oauthState, [name]: false };
      }
      this.error = extractErrorMessage(e, "Authentication failed");
      throw e;
    } finally {
      this.isAuthenticating = null;
    }
  }

  async signOut(name: string): Promise<void> {
    this.isSaving = true;
    this.error = null;
    try {
      await camberMcpServersSignOut({ name });
      this.oauthState = { ...this.oauthState, [name]: false };
      this.notifyChanged();
    } catch (e) {
      this.error = extractErrorMessage(e, "Sign out failed");
      throw e;
    } finally {
      this.isSaving = false;
    }
  }

  // Probe an unsaved config so the UI can validate a connector before adding.
  async testConfig(entry: MCPServerEntry): Promise<MCPServersTestConnectionOutput> {
    return await camberMcpServersTestConfig({ server: entry });
  }

  // Record a probe result (e.g. from the add flow) so a freshly added connector
  // shows as ready without requiring a second, manual test.
  recordTestResult(name: string, result: MCPServersTestConnectionOutput): void {
    this.testResults = { ...this.testResults, [name]: result };
  }

  async testConnection(name: string): Promise<void> {
    this.isTesting = name;
    this.error = null;
    try {
      const result = await camberMcpServersTestConnection({ name });
      this.testResults = { ...this.testResults, [name]: result };
    } catch (e) {
      this.testResults = {
        ...this.testResults,
        [name]: { ok: false, toolCount: 0, error: extractErrorMessage(e, "Test failed") },
      };
    } finally {
      this.isTesting = null;
    }
  }

  // In-session sign-ins/sign-outs (oauthState) take precedence over the
  // token-presence snapshot the helper computed at list time.
  isOAuthAuthenticated(server: MCPServerEntry): boolean {
    const local = this.oauthState[server.name];
    return local ?? server.oauthAuthenticated ?? false;
  }

  // True only when the server is positively known to lack a sign-in. Helpers
  // that predate the oauthAuthenticated field leave this false, so old-helper
  // rows don't all flip to "needs sign-in".
  needsOAuthSignIn(server: MCPServerEntry): boolean {
    const local = this.oauthState[server.name];
    if (local !== undefined) return !local;
    return server.oauthAuthenticated === false;
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.error("Failed to refresh an ACP session after connector changes", error);
      }
    }
  }
}

let singleton: UserMCPServersRepository | null = null;

// The user's custom MCP servers are a single global list (not per-session), so a
// module singleton is the source of truth. Components read it via this getter
// instead of constructing it or prop-drilling it (see the acp/* lint rules).
export function getUserMCPServersRepo(): UserMCPServersRepository {
  return (singleton ??= new UserMCPServersRepository());
}
