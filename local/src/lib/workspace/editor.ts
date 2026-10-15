import { setConfigDraftEphemeral, useConfigStore } from "@subboost/ui/store/config-store";
import { initialState } from "@subboost/ui/store/config-store/definitions";
import { computeGeneratedYamlResult } from "@subboost/ui/store/config-store/generated-yaml";
import { useUIStore } from "@subboost/ui/store/ui-store";
import { validateWorkspaceSnapshot, type WorkspaceSnapshot } from "./snapshot";

export function replaceWorkspaceEditor(snapshot: WorkspaceSnapshot): void {
  const state = { ...structuredClone(initialState), ...validateWorkspaceSnapshot(snapshot) };
  const { yaml, error } = computeGeneratedYamlResult(state);
  setConfigDraftEphemeral(true);
  useConfigStore.setState((current) => ({ ...state, draftRevision: current.draftRevision + 1, generatedYaml: yaml, generatedYamlError: error }));
  // Local database subscription IDs/tokens belong to this PC, not to the portable workspace.
  useUIStore.getState().clearEditingSubscription();
}

export function clearWorkspaceEditor(): void {
  useConfigStore.setState((current) => ({ ...structuredClone(initialState), draftRevision: current.draftRevision + 1 }));
  useUIStore.getState().clearEditingSubscription();
  setConfigDraftEphemeral(false);
}
