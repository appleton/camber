import type { SecretSummary } from "@camber/helperapi/schemas";

type SecretsMenuState = {
  /** The secret being edited, or null when creating a new secret */
  editingSecret: SecretSummary | null;
  /** All secret names currently known, used for uniqueness validation */
  allSecretNames: string[];
};

const state = $state<SecretsMenuState>({
  editingSecret: null,
  allSecretNames: [],
});

export function selectSecretForEdit(secret: SecretSummary, allNames: string[]) {
  state.editingSecret = secret;
  state.allSecretNames = allNames;
}

export function selectNewSecret(allNames: string[]) {
  state.editingSecret = null;
  state.allSecretNames = allNames;
}

export function getSecretsMenuState() {
  return state;
}
