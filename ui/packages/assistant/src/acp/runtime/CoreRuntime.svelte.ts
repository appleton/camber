import { isAppleUser } from "@camber/components";
import { createHelperApiClient } from "@camber/features/acp";
import {
  type HydratableOverrideStore,
  type KeybindingService,
  type Platform,
  createAcpDbKeybindingStore,
  createDelegatedKeybindingService,
  createDesktopKeybindingService,
  setKeybindingService,
} from "@camber/features/keybindings";
import {
  provideVSCodeDesignSystem,
  vsCodeButton,
  vsCodeCheckbox,
} from "@vscode/webview-ui-toolkit";
import { onDestroy } from "svelte";
import { get } from "svelte/store";

import { rpc } from "../../lib/rpc/client";
import { appState, appStateUpdates } from "../../lib/store";
import { DragDrop } from "./shared/DragDrop.svelte";
import { registerAgentEffects } from "./shared/registerAgentEffects.svelte";
import { registerAttentionBadgeEffect } from "./shared/registerAttentionBadgeEffect.svelte";
import { registerHostEffects } from "./shared/registerHostEffects.svelte";
import { registerRpcServer } from "./shared/registerRpcServer.svelte";
import { registerSyncEffects } from "./shared/registerSyncEffects.svelte";
import { Repositories } from "./shared/Repositories.svelte";
import type { Runtime, RuntimeProps, Target } from "./shared/types";

export type { Runtime, RuntimeProps, Target, TargetProps } from "./shared/types";

provideVSCodeDesignSystem().register(vsCodeButton());
provideVSCodeDesignSystem().register(vsCodeCheckbox());

// The shared runtime every target builds on: it owns the repositories, host/backend RPC,
// history/session sync, drag/drop, and the single activeConversationId spine.
//
// The constructor only builds state and provides contexts. All effect/onMount wiring lives in
// initialize(), which the panel must call once during component init.
export class CoreRuntime implements Runtime {
  readonly target: Target;
  readonly acpRepo: Runtime["acpRepo"];
  readonly acpRegistry: Runtime["acpRegistry"];
  readonly acpAgentServers: Runtime["acpAgentServers"];
  readonly acpProjectRepo: Runtime["acpProjectRepo"];
  readonly acpConversationRepo: Runtime["acpConversationRepo"];

  activeConversationId = $state<string | null>(null);

  #props: RuntimeProps;
  #appStateSnapshot = $state(get(appState));
  #dragDrop = new DragDrop();
  #repositories: Repositories;
  #keybindings: KeybindingService;
  #keybindingStore?: HydratableOverrideStore;

  constructor(props: RuntimeProps) {
    const initialState = props.initialState ?? window.CAMBER_INITIAL_STATE;
    appState.update(appStateUpdates.setInitialState(initialState));

    this.target = props.target;
    this.#props = { ...props, initialState };
    this.#keybindings = this.#createKeybindingService(props.target);
    this.#repositories =
      typeof props.repositories === "function"
        ? props.repositories()
        : (props.repositories ??
          new Repositories({
            notifier: props.notifier,
            onACPConnectionPoolReady: props.onACPConnectionPoolReady,
          }));

    this.acpRepo = this.#repositories.acpRepo;
    this.acpRegistry = this.#repositories.acpRegistry;
    this.acpAgentServers = this.#repositories.acpAgentServers;
    this.acpProjectRepo = this.#repositories.acpProjectRepo;
    this.acpConversationRepo = this.#repositories.acpConversationRepo;
  }

  // Registers every effect/onMount this runtime owns. Reads as a manifest of the wiring.
  initialize() {
    onDestroy(appState.subscribe((value) => (this.#appStateSnapshot = value)));
    if (this.#props.skipCoreEffects) return;
    this.#repositories.initialize();
    registerAgentEffects(this.#repositories);
    registerHostEffects();
    registerSyncEffects({ repositories: this.#repositories });
    registerRpcServer({
      props: this.#props,
      repositories: this.#repositories,
      getActiveConversationId: () => this.activeConversationId,
    });
    registerAttentionBadgeEffect(this.#repositories, this.#props.onACPAttentionCountChange);
    this.#initializeKeybindings();
  }

  // CoreRuntime owns the keybinding service lifecycle: it creates the host-appropriate
  // service, provides it via context, and (desktop) hydrates persisted overrides.
  // Command *behavior* is attached by the target runtime that owns those actions —
  // e.g. DesktopRuntime registers newConversation/focusInput/togglePlanMode.
  #initializeKeybindings() {
    setKeybindingService(this.#keybindings);
    if (this.target !== "desktop") return;

    // Load persisted overrides from the ACP DB; reads serve from memory until then.
    void this.#keybindingStore?.hydrate();
  }

  #createKeybindingService(target: Target): KeybindingService {
    const platform: Platform = isAppleUser() ? "mac" : "other";
    if (target === "desktop") {
      this.#keybindingStore = createAcpDbKeybindingStore(createHelperApiClient());
      return createDesktopKeybindingService({ platform, overrides: this.#keybindingStore });
    }
    return createDelegatedKeybindingService({
      platform,
      getHostHints: () => get(appState).keybindings,
    });
  }

  get isDraggingFile() {
    return this.#dragDrop.isDraggingFile;
  }

  get hasFileContext() {
    return this.#appStateSnapshot.environment.capabilities.fileContext;
  }

  get keybindings(): KeybindingService {
    return this.#keybindings;
  }

  handleGlobalKeydown = (event: KeyboardEvent) => this.#keybindings.handleKeydown(event);
  handleWindowFocus = () => rpc.setWebviewFocus(true);
  handleWindowBlur = () => rpc.setWebviewFocus(false);
  handleDragOver = (event: DragEvent) => this.#dragDrop.handleDragOver(event);
  handleDragLeave = (event: DragEvent) => this.#dragDrop.handleDragLeave(event);
  handleDrop = () => this.#dragDrop.handleDrop();
  setIsDragging = (value: boolean) => this.#dragDrop.setIsDragging(value);
}
