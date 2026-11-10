using Camber.Assistant.Telemetry;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace Camber.Assistant.WebViewInfrastructure
{
    // Wire shape the webview expects back from the assistant-terminal RPC methods.
    public class AssistantTerminalTab
    {
        public string id { get; set; }
        public string title { get; set; }
        public string cwd { get; set; }
        public string worktreePath { get; set; }
        public string createdAt { get; set; }
        public int? exitCode { get; set; }
        public string buffer { get; set; }
    }

    // Backs the assistant-terminal RPC methods with external console windows.
    //
    // Visual Studio has no embedded-terminal API, so we cannot mirror the VSCode /
    // desktop terminal panel. Instead each terminal is a separate `cmd.exe /k <command>`
    // console window. This is enough for the only flow that reaches these methods in VS:
    // ACP agent "terminal" authentication (e.g. the Camber agent advertising `pool login`).
    //
    // The webview drives this as create-then-write: createAssistantTerminal(worktree, env)
    // returns a tab with no process yet, then writeAssistantTerminal(id, "<command>\n") sends
    // the command. An external console can't be fed via stdin (interactive CLIs like pool
    // login's huh forms need a real TTY), so we defer spawning until that first write and
    // launch the console with the command already in place. No assistantTerminalDid* events
    // are emitted (there is no embedded panel to stream into); the auth flow confirms via its
    // own "I am logged in" button.
    internal class AssistantTerminalManager
    {
        internal static readonly AssistantTerminalManager Instance = new AssistantTerminalManager();

        private class Entry
        {
            public AssistantTerminalTab Tab;
            // WorktreePath groups terminals (List/CloseForWorktree key on it); Cwd is where the
            // console actually starts. They differ when the caller passes an explicit cwd.
            public string WorktreePath;
            public string Cwd;
            public Dictionary<string, string> Env;
            public Process Process;
        }

        private readonly ConcurrentDictionary<string, Entry> terminals =
            new ConcurrentDictionary<string, Entry>();

        public AssistantTerminalTab Create(
            string worktreePath, string command, Dictionary<string, string> env, string cwd = null)
        {
            worktreePath = worktreePath ?? "";
            // Spawn can only start the console in a directory that exists, so an explicit cwd
            // that does not resolve must not reach the tab: cwd is reported back to the webview,
            // and it would name a directory the console never ran in.
            var workingDirectory = !string.IsNullOrWhiteSpace(cwd) && Directory.Exists(cwd)
                ? cwd
                : worktreePath;
            var entry = new Entry
            {
                WorktreePath = worktreePath,
                Cwd = workingDirectory,
                Env = env,
                Tab = new AssistantTerminalTab
                {
                    id = Guid.NewGuid().ToString(),
                    title = "Camber",
                    cwd = workingDirectory,
                    worktreePath = worktreePath,
                    createdAt = DateTime.UtcNow.ToString("o"),
                },
            };
            terminals[entry.Tab.id] = entry;
            // Some callers (e.g. worktree setup scripts) pass the command up front; the auth
            // flow does not and sends it via the first write instead.
            if (!string.IsNullOrWhiteSpace(command))
            {
                Spawn(entry, command);
            }
            return entry.Tab;
        }

        public void Write(string terminalId, string data)
        {
            if (!terminals.TryGetValue(terminalId, out var entry))
                return;
            // First write carries the command to run; an already-spawned external console
            // can't be driven further from here, so later writes are ignored.
            if (entry.Process == null && !string.IsNullOrWhiteSpace(data))
            {
                Spawn(entry, data.Trim());
            }
        }

        public List<AssistantTerminalTab> List(string worktreePath)
        {
            worktreePath = worktreePath ?? "";
            return terminals.Values
                .Where(e => e.WorktreePath == worktreePath)
                .Select(e => e.Tab)
                .ToList();
        }

        public void Delete(string terminalId)
        {
            if (terminals.TryRemove(terminalId, out var entry))
                Kill(entry);
        }

        public void CloseForWorktree(string worktreePath)
        {
            worktreePath = worktreePath ?? "";
            CloseMatching(e => e.WorktreePath == worktreePath);
        }

        public void CloseForProject(string projectPath)
        {
            projectPath = projectPath ?? "";
            var prefix = projectPath.EndsWith("/") || projectPath.EndsWith("\\")
                ? projectPath
                : projectPath + Path.DirectorySeparatorChar;
            CloseMatching(e => e.WorktreePath == projectPath || e.WorktreePath.StartsWith(prefix));
        }

        private void CloseMatching(Func<Entry, bool> predicate)
        {
            foreach (var pair in terminals.Where(kv => predicate(kv.Value)).ToList())
            {
                if (terminals.TryRemove(pair.Key, out var entry))
                    Kill(entry);
            }
        }

        private void Spawn(Entry entry, string command)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    // /c closes the console once the command exits, so a completed `pool login`
                    // doesn't leave a stray window behind (unlike /k, which stays open). The
                    // trailing `|| pause` keeps the window open only when the command fails
                    // (non-zero exit) so the user can read the error instead of a flash-and-close.
                    Arguments = "/c " + command + " || pause",
                    // UseShellExecute=false lets us set EnvironmentVariables; CreateNoWindow=false
                    // means the console-subsystem child gets its own visible window since the VS
                    // host process is windowless.
                    UseShellExecute = false,
                    CreateNoWindow = false,
                };
                if (!string.IsNullOrEmpty(entry.Cwd) && Directory.Exists(entry.Cwd))
                {
                    psi.WorkingDirectory = entry.Cwd;
                }
                if (entry.Env != null)
                {
                    foreach (var kv in entry.Env)
                    {
                        psi.EnvironmentVariables[kv.Key] = kv.Value;
                    }
                }
                entry.Process = Process.Start(psi);
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }

        private void Kill(Entry entry)
        {
            try
            {
                if (entry.Process != null && !entry.Process.HasExited)
                    entry.Process.Kill();
            }
            catch (Exception)
            {
                // Best effort - the user may have already closed the window.
            }
        }
    }
}
