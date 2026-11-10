<script lang="ts">
  import * as Prompt from "@camber/components/prompt";
  import { _setSecretsContextForTests, type SecretsRepository } from "../../../../secrets";
  import type { SecretSummary } from "@camber/helperapi/schemas";
  import type { RPCError } from "@camber/rpc/generics";
  import type { Snippet } from "svelte";

  interface Props {
    children?: Snippet;
    secrets?: SecretSummary[];
    loading?: boolean;
    shouldFail?: boolean;
    errorMessage?: string;
  }

  let {
    children,
    secrets = [],
    loading = false,
    shouldFail = false,
    errorMessage = "ERROR_READING_SECRET: keyring access denied",
  }: Props = $props();

  const secretsContext = {
    getSandboxMenuSecrets: async () => {
      if (loading) {
        return new Promise<{
          suggested: SecretSummary[];
          custom: SecretSummary[];
          allNames: string[];
        }>(() => {});
      }
      if (shouldFail) {
        throw { message: errorMessage } satisfies RPCError;
      }
      return {
        suggested: secrets.filter((secret) => secret.isRequired),
        custom: secrets.filter((secret) => !secret.isRequired),
        allNames: secrets.map((secret) => secret.name),
      };
    },
    getSecret: async (name: string) => {
      const secret = secrets.find((item) => item.name === name);
      return {
        name,
        description: secret?.description ?? "",
        value: "",
      };
    },
    upsertSecret: async () => {},
    deleteSecret: async () => {},
  } as unknown as SecretsRepository;

  _setSecretsContextForTests(secretsContext);
</script>

<Prompt.Root>
  {#if children}
    {@render children()}
  {/if}

  <Prompt.Menu.Root value="secret-edit">
    <div data-testid="secret-edit-panel">Secret edit panel</div>
  </Prompt.Menu.Root>
</Prompt.Root>
