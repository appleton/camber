import { isLocalVisualizationPath, type MarkdownHostAdapter } from "@camber/components/markdown";
import { normalize, relative } from "@camber/lib/path";
import { InfoMessageType } from "@camber/rpc";
import { get } from "svelte/store";
import { requestDesktopFilePromptChip } from "./components/chat/desktopFilePromptChip";
import {
  performDesktopFilesTreeAction,
  type DesktopFileTreeContextMenuActionPayload,
  type DesktopFilesTreeActionRPC,
} from "./components/chat/desktopFilesTreeActions";
import type {
  DesktopFileTreeContextMenuOpener,
  DesktopFileTreeContextMenuRequest,
} from "./components/chat/desktopFilesTreeContextMenu";
import { slashCommandIcon } from "./components/chat/goalPresentation";
import { installedSkills } from "./components/chat/menus/command/InstalledSkillsRepository.svelte";
import { resolvedSlashCommandNames } from "./components/chat/menus/command/serverCommands";
import { getACPChatSessionScope } from "./features/ChatSessionScope.svelte";
import { appState, trackClick } from "./hostAdapter";
import { rpc, type RPCClient } from "./hostRpc";

interface DesktopSettings {
  fileOpenerId: string;
  fileOpeners: DesktopFileOpener[];
  desktopOpeners: DesktopFileOpener[];
}

interface DesktopFileOpener {
  id: string;
  label: string;
}

type DesktopMarkdownRPC = RPCClient & {
  getDesktopSettings(): Promise<DesktopSettings>;
  openPathWithOpener(path: string, openerId: string, line?: number, column?: number): Promise<void>;
  showDesktopFileTreeContextMenu(request: DesktopFileTreeContextMenuRequest): Promise<void>;
  revealPathInFinder(path: string): Promise<void>;
  writeFileUrlToPasteboard(path: string, operation: "copy" | "cut"): Promise<void>;
  pasteFilesIntoDirectory(destination: string): Promise<unknown>;
  trashPath(path: string): Promise<void>;
} & DesktopFilesTreeActionRPC;

const desktopRpc = rpc as DesktopMarkdownRPC;
const DESKTOP_OPEN_FILE_TAB_EVENT = "camber:desktop-open-file-tab";
const DESKTOP_FILE_TREE_CONTEXT_MENU_ACTION_EVENT = "camber:desktop-file-tree-context-menu-action";

export const markdownHost: MarkdownHostAdapter = {
  state: appState,
  checkFileExists(path) {
    return rpc.checkFileExists(path);
  },
  async openFile(path, line, column, options) {
    if (!isDesktopHost()) {
      return rpc.openFile(path, line, column);
    }

    if (options?.preferredEditor) {
      const settings = await desktopRpc.getDesktopSettings();
      return desktopRpc.openPathWithOpener(path, settings.fileOpenerId || "default", line, column);
    }

    // The built-in viewer handles text and images. Let the system PDF viewer
    // open document citations instead of trying to read a PDF as UTF-8 text.
    if (/\.pdf$/i.test(path)) {
      return desktopRpc.openPathWithOpener(path, "default", line, column);
    }

    window.dispatchEvent(
      new CustomEvent(DESKTOP_OPEN_FILE_TAB_EVENT, {
        detail: { path, line, column },
        cancelable: true,
      }),
    );
  },
  async showFileContextMenu({ path, position }) {
    if (!isDesktopHost()) return;

    const settings = await desktopRpc.getDesktopSettings();
    const requestId = crypto.randomUUID();
    const entry = {
      path,
      relativePath: relativePathForFile(path),
      kind: "file" as const,
    };

    const onContextMenuAction = (event: Event) => {
      const payload = (event as CustomEvent<DesktopFileTreeContextMenuActionPayload>).detail;
      if (payload.requestId !== requestId) return;
      cleanup();

      void performDesktopFilesTreeAction({
        payload,
        entry,
        currentFileOpenerId: settings.fileOpenerId || "default",
        rpc: desktopRpc,
        openTerminal: (cwd) => desktopRpc.openTerminal(undefined, cwd),
        insertFileChip: requestDesktopFilePromptChip,
      });
    };

    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener(DESKTOP_FILE_TREE_CONTEXT_MENU_ACTION_EVENT, onContextMenuAction);
    };

    const timeout = window.setTimeout(cleanup, 30_000);
    window.addEventListener(DESKTOP_FILE_TREE_CONTEXT_MENU_ACTION_EVENT, onContextMenuAction);

    try {
      await desktopRpc.showDesktopFileTreeContextMenu({
        requestId,
        item: { kind: "file" },
        position,
        currentOpenerId: settings.fileOpenerId || "default",
        fileOpeners: contextMenuOpeners(settings.fileOpeners),
        desktopOpeners: contextMenuOpeners(settings.desktopOpeners),
      });
    } catch (error) {
      cleanup();
      return rpc.showInfoMessage(
        `Unable to show file menu: ${error instanceof Error ? error.message : String(error)}`,
        InfoMessageType.error,
      );
    }
  },
  openImageFile(svgContent, filename) {
    return rpc.openImageFile(svgContent, filename);
  },
  getImageFileData(path) {
    return rpc.getImageFileData(path);
  },
  get readVisualizationFile() {
    // IDE native bridges and their read limits need separate verification
    // before executing untrusted scripts in those hosts.
    if (!isDesktopHost()) return undefined;
    return async (path: string) => {
      if (!isLocalVisualizationPath(path)) throw new Error("Invalid visualization file path.");
      return (await rpc.getFileContents(path))?.content;
    };
  },
  openTerminal(command) {
    return rpc.openTerminal(command);
  },
  writeToClipboard(text) {
    return rpc.writeToClipboard?.(text);
  },
  onCopyError(error) {
    return rpc.showInfoMessage(
      `Error copying to clipboard: ${error.message}`,
      InfoMessageType.error,
    );
  },
  getSlashCommands() {
    let chatSession;
    try {
      chatSession = getACPChatSessionScope();
    } catch {
      return { skills: [], commands: [] };
    }
    return resolvedSlashCommandNames(chatSession.availableCommands, installedSkills.commands);
  },
  getSlashCommandIcon: slashCommandIcon,
  trackClick,
};

function isDesktopHost(): boolean {
  return get(appState).environment.assistantHost === "desktop";
}

function contextMenuOpeners(openers: DesktopFileOpener[] = []): DesktopFileTreeContextMenuOpener[] {
  return openers.map(({ id, label }) => ({ id, label }));
}

function relativePathForFile(path: string): string {
  const normalizedPath = normalize(path);
  const workspace = get(appState).workspaces.find((candidate) => {
    const workspacePath = normalize(candidate.path);
    return normalizedPath === workspacePath || normalizedPath.startsWith(`${workspacePath}/`);
  });

  if (!workspace) return path;

  const nextRelativePath = normalize(relative(normalize(workspace.path), normalizedPath));
  if (!nextRelativePath || nextRelativePath === "." || nextRelativePath.startsWith("../")) {
    return path;
  }
  return nextRelativePath;
}
