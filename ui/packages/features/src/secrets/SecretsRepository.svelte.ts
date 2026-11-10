import { camberGetUserConfig } from "@camber/helperapi";
import type {
  GetSecretOutput,
  ListSecretsOutput,
  SecretSummary,
  UpsertSecretParams,
} from "@camber/helperapi/schemas";
import type { HostClient } from "@camber/rpc";
import { PersistedState } from "runed";

type SecretsRPCClient = Pick<
  HostClient,
  "deleteSecret" | "getSecret" | "listSecrets" | "upsertSecret"
>;

export type SecretsRepositoryDependencies = {
  rpc: SecretsRPCClient;
};

export type SandboxMenuSecrets = {
  suggested: SecretSummary[];
  custom: SecretSummary[];
  allNames: string[];
};

export class SecretsRepository {
  #dismissedSecretBannerSandboxes = new PersistedState<string[]>(
    "dismissed-secret-banner-sandboxes",
    [],
    { syncTabs: false },
  );

  constructor(private readonly deps: SecretsRepositoryDependencies) {}

  isSecretBannerDismissed(sandboxId: string): boolean {
    return this.#dismissedSecretBannerSandboxes.current.includes(sandboxId);
  }

  dismissSecretBanner(sandboxId: string): void {
    if (this.isSecretBannerDismissed(sandboxId)) return;
    this.#dismissedSecretBannerSandboxes.current = [
      ...this.#dismissedSecretBannerSandboxes.current,
      sandboxId,
    ];
  }

  async listSecrets(requiredSecrets: string[]): Promise<ListSecretsOutput> {
    return this.deps.rpc.listSecrets({ requiredSecrets });
  }

  async getSecret(name: string): Promise<GetSecretOutput> {
    return this.deps.rpc.getSecret({ name });
  }

  async getSandboxMenuSecrets(): Promise<SandboxMenuSecrets> {
    const requiredSecrets = await this.requiredSecrets();
    const status = await this.listSecrets(requiredSecrets);
    const allNames = status.secrets.map((secret) => secret.name);
    return {
      suggested: status.secrets.filter((secret) => secret.isRequired),
      custom: status.secrets.filter((secret) => !secret.isRequired),
      allNames,
    };
  }

  async upsertSecret(params: UpsertSecretParams): Promise<void> {
    await this.deps.rpc.upsertSecret(params);
  }

  async deleteSecret(name: string): Promise<void> {
    await this.deps.rpc.deleteSecret({ name });
  }

  /**
   * Returns true if the current sandbox has required secrets that are not yet configured.
   */
  async needsSecretConfiguration(): Promise<boolean> {
    const requiredSecrets = await this.requiredSecrets();
    if (requiredSecrets.length === 0) return false;

    try {
      const status = await this.listSecrets(requiredSecrets);
      return status.secrets.some((s) => s.isRequired && !s.isConfigured);
    } catch (error) {
      console.error("failed to list secrets", { error });
      return false;
    }
  }

  private async requiredSecrets(): Promise<string[]> {
    const config = await camberGetUserConfig({});
    const secrets = config.sandboxConfig?.secrets;
    return Array.isArray(secrets)
      ? secrets.filter((secret): secret is string => typeof secret === "string")
      : [];
  }
}
