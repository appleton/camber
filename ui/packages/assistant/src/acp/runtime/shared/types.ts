import type {
  ACPConnectionPool as ACPConnectionPoolType,
  ACPConversationRepository,
  ACPProjectRepository,
  ACPSessionRepository,
  Notifier,
  setACPAgentRegistryContext,
  setACPAgentServersContext,
} from "@camber/features/acp";
import type { KeybindingService } from "@camber/features/keybindings";
import type { HostMessageSender } from "../../../lib/rpc/client";
import type { WebviewRPCListener, WebViewRPCResponseSender } from "../../../lib/rpc/server";
import type { CamberInitialState } from "../../../lib/store";
import type { Repositories } from "./Repositories.svelte";

export type Target = "sidebar-only" | "chat-only" | "desktop";

export interface RuntimeProps {
  target: Target;
  rpcWebViewResponseHandler: WebViewRPCResponseSender;
  rpcHostRequestHandler: HostMessageSender;
  webviewRpcListener?: WebviewRPCListener;
  initialState?: CamberInitialState;
  notifier?: Notifier;
  onACPConnectionPoolReady?: (pool: ACPConnectionPoolType) => void;
  onACPAttentionCountChange?: (count: number) => void;
  repositories?: Repositories | (() => Repositories);
  skipCoreEffects?: boolean;
}

export type TargetProps = Omit<RuntimeProps, "target">;

export interface Runtime {
  target: Target;
  acpRepo: ACPSessionRepository;
  acpRegistry: ReturnType<typeof setACPAgentRegistryContext>;
  acpAgentServers: ReturnType<typeof setACPAgentServersContext>;
  acpProjectRepo: ACPProjectRepository;
  acpConversationRepo: ACPConversationRepository;
  activeConversationId: string | null;
  isDraggingFile: boolean;
  hasFileContext: boolean;
  keybindings: KeybindingService;
  handleGlobalKeydown(event: KeyboardEvent): void;
  handleWindowFocus(): void;
  handleWindowBlur(): void;
  handleDragOver(event: DragEvent): void;
  handleDragLeave(event: DragEvent): void;
  handleDrop(): void;
  setIsDragging(value: boolean): void;
}
