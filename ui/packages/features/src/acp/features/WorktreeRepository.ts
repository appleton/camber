import {
  camberAcpNavCreateWorktree,
  camberAcpNavGetProjectSettings,
  camberAcpNavList,
  camberAcpNavPrepareWorktree,
  camberAcpNavReleasePreparedWorktree,
  camberAcpNavRemoveWorktree,
} from "@camber/helperapi";
import { createContext } from "svelte";
import type { ACPNavProject, WorktreeBusyKind } from "../navTypes";
import type {
  AssistantTerminalPlacement,
  AssistantTerminalRepository,
} from "./AssistantTerminalRepository.svelte";
import type { AcpSetupScriptOutputRepository } from "./SetupScriptOutputRepository.svelte";

export interface ACPWorktreeCommandRunner {
  createTab(path: string, command: string): Promise<void>;
  closeProject(path: string): Promise<void>;
  closeWorktree(path: string): Promise<void>;
  runSetup(
    path: string,
    command: string,
    signal?: AbortSignal,
    options?: { terminalLayoutKey?: string | null },
  ): Promise<void>;
  runTeardown(path: string, command: string, signal?: AbortSignal): Promise<void>;
}

export interface AssistantTerminalCommandRunnerOptions {
  setupInVisibleTerminal?: boolean;
  /** Where the visible setup terminal opens; read per run so setting changes apply immediately. */
  setupPlacement?: () => AssistantTerminalPlacement;
}

const TEARDOWN_OUTPUT_TAIL_LENGTH = 2000;
const TEARDOWN_OUTPUT_TAIL_LINES = 5;

export function createAssistantTerminalCommandRunner(
  assistantTerminals: AssistantTerminalRepository,
  setupScriptOutputs?: AcpSetupScriptOutputRepository,
  options: AssistantTerminalCommandRunnerOptions = {},
): ACPWorktreeCommandRunner {
  return {
    createTab: async (path, command) => {
      await assistantTerminals.createTab(path, command);
    },
    closeProject: async (path) => {
      setupScriptOutputs?.clear(path);
      await assistantTerminals.closeProject(path);
    },
    closeWorktree: async (path) => {
      setupScriptOutputs?.clear(path);
      await assistantTerminals.closeWorktree(path);
    },
    runSetup: async (path, command, signal, runOptions) => {
      const setupInVisibleTerminal = options.setupInVisibleTerminal === true;
      setupScriptOutputs?.start(path, command, {
        surface: setupInVisibleTerminal ? "terminal" : "inline",
      });
      try {
        const exitCode = await assistantTerminals.runCommandAndWait(
          path,
          command,
          signal,
          setupInVisibleTerminal
            ? {
                visible: true,
                placement: options.setupPlacement?.() ?? "splitRight",
                reuseExisting: true,
                keepAliveAfterCommand: true,
                layoutKey: runOptions?.terminalLayoutKey ?? undefined,
                // Creating a worktree is a prelude to typing a prompt, not to
                // using a terminal. The setup output is worth showing, never
                // worth taking the keyboard for.
                focus: false,
              }
            : {
                onOutput: (output) => setupScriptOutputs?.append(path, output),
              },
        );
        setupScriptOutputs?.complete(path, exitCode);
      } catch (error) {
        setupScriptOutputs?.fail(path, error);
        throw error;
      }
    },
    runTeardown: async (path, command, signal) => {
      let outputTail = "";
      const exitCode = await assistantTerminals.runCommandAndWait(path, command, signal, {
        onOutput: (output) => {
          outputTail = `${outputTail}${output}`.slice(-TEARDOWN_OUTPUT_TAIL_LENGTH);
        },
      });
      if (signal?.aborted || exitCode === 0) return;
      // A failed teardown must block worktree removal — deleting anyway leaks
      // whatever the script was meant to stop (dev servers, managed processes).
      const detail =
        exitCode === undefined
          ? `Teardown script did not run: ${command}`
          : `Teardown script exited with code ${exitCode}: ${command}`;
      const tail = outputTail.trim().split("\n").slice(-TEARDOWN_OUTPUT_TAIL_LINES).join("\n");
      throw new Error(tail ? `${detail}\n${tail}` : detail);
    },
  };
}

const noopWorktreeCommandRunner: ACPWorktreeCommandRunner = {
  createTab: async () => {},
  closeProject: async () => {},
  closeWorktree: async () => {},
  runSetup: async () => {},
  runTeardown: async () => {},
};

export type WorktreeStatusCallback = (kind: WorktreeBusyKind) => void;

export interface ACPWorktreeRepository {
  prepareWorktree(projectPath: string): Promise<ACPNavProject | undefined>;
  createWorktree(
    projectPath: string,
    prepared: ACPNavProject,
    onStatus?: WorktreeStatusCallback,
    deleteSignal?: AbortSignal,
    options?: { terminalLayoutKey?: string | null },
  ): Promise<ACPNavProject | undefined>;
  closeProject(path: string): Promise<void>;
  discardPreparedWorktree(path: string): Promise<void>;
  removeWorktree(path: string, onStatus?: WorktreeStatusCallback): Promise<void>;
}

export class ACPWorktreeRepositoryWriter implements ACPWorktreeRepository {
  constructor(
    private readonly commandRunner: ACPWorktreeCommandRunner = noopWorktreeCommandRunner,
  ) {}

  async prepareWorktree(projectPath: string): Promise<ACPNavProject | undefined> {
    return await camberAcpNavPrepareWorktree({ projectPath });
  }

  async createWorktree(
    projectPath: string,
    prepared: ACPNavProject,
    onStatus?: WorktreeStatusCallback,
    deleteSignal?: AbortSignal,
    options?: { terminalLayoutKey?: string | null },
  ): Promise<ACPNavProject | undefined> {
    if (deleteSignal?.aborted) return undefined;

    const created = await camberAcpNavCreateWorktree({
      projectPath,
      worktreeName: prepared.name,
    });
    if (deleteSignal?.aborted) {
      if (created) await this.removeWorktree(created.path, onStatus);
      return undefined;
    }

    const setupScript = created ? await projectSetupScript(projectPath) : "";
    if (deleteSignal?.aborted) {
      if (created) await this.removeWorktree(created.path, onStatus);
      return undefined;
    }

    if (created && setupScript) {
      onStatus?.("running_setup");
      const setupOptions = options?.terminalLayoutKey
        ? { terminalLayoutKey: options.terminalLayoutKey }
        : undefined;
      if (setupOptions) {
        await this.commandRunner.runSetup(created.path, setupScript, deleteSignal, setupOptions);
      } else {
        await this.commandRunner.runSetup(created.path, setupScript, deleteSignal);
      }
      if (deleteSignal?.aborted) {
        await this.removeWorktree(created.path, onStatus);
        return undefined;
      }
    }
    return created;
  }

  async removeWorktree(path: string, onStatus?: WorktreeStatusCallback): Promise<void> {
    onStatus?.("tearing_down");
    await this.commandRunner.closeWorktree(path);
    const teardownScript = await worktreeTeardownScript(path);
    if (teardownScript) {
      await this.commandRunner.runTeardown(path, teardownScript);
    }
    onStatus?.("deleting");
    await camberAcpNavRemoveWorktree({ path });
    await this.commandRunner.closeWorktree(path);
  }

  // Releases a reservation from prepareWorktree without invoking the
  // (non-idempotent) removeWorktree path — used when the user-facing create
  // flow fails before git worktree add ran.
  async discardPreparedWorktree(path: string): Promise<void> {
    await camberAcpNavReleasePreparedWorktree({ path });
    await this.commandRunner.closeWorktree(path);
  }

  closeProject(path: string): Promise<void> {
    return this.commandRunner.closeProject(path);
  }
}

export function createACPWorktreeRepository(
  commandRunner?: ACPWorktreeCommandRunner,
): ACPWorktreeRepositoryWriter {
  return new ACPWorktreeRepositoryWriter(commandRunner);
}

const [getACPWorktreeContext, setACPWorktreeRepositoryContext] =
  createContext<ACPWorktreeRepository>();

export { getACPWorktreeContext };

export function setACPWorktreeContext(
  repo: ACPWorktreeRepositoryWriter = createACPWorktreeRepository(),
): ACPWorktreeRepositoryWriter {
  setACPWorktreeRepositoryContext(repo);
  return repo;
}

export { setACPWorktreeRepositoryContext as _setACPWorktreeContextForTests };

export function getACPWorktreeRepo(): ACPWorktreeRepository {
  return getACPWorktreeContext();
}

async function projectSetupScript(path: string): Promise<string> {
  return (await camberAcpNavGetProjectSettings({ path })).settings?.setupScript?.trim() ?? "";
}

async function worktreeTeardownScript(path: string): Promise<string> {
  const projects = (await camberAcpNavList({})).projects ?? [];
  const worktree = projects.find((project) => project.path === path);
  return worktree?.parentPath
    ? (projects.find((project) => project.path === worktree.parentPath)?.teardownScript?.trim() ??
        "")
    : "";
}
