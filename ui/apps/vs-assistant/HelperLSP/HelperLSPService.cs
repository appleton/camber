using Microsoft.VisualStudio.Shell;
using OmniSharp.Extensions.LanguageServer.Client;
using OmniSharp.Extensions.LanguageServer.Protocol;
using Camber.Assistant.Context;
using Camber.Assistant.Settings;
using Camber.Assistant.Telemetry;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

#pragma warning disable VSTHRD100 // Avoid async void methods

namespace Camber.Assistant.HelperLSP
{
    internal class HelperLSPService
    {
        // Indicates if we currently should be running.
        private bool shouldBeRunning = false;

        // State associated with the current running helper process, if nay.
        private HelperProcess currentProcess = null;

        // The settings object, retained primarily so we don't attempt to resolve it again during shutdown of
        // the IDE when we're cleaning up handlers, which causes exceptions.
        private CamberSettings currentSettings = null;

        // Since starting the client is async, it may not be available yet when we have messages to send to it.
        // Thus we have a Task that message sends can be chained onto. We might also get some document open
        // messages before the solution is fully loaded, so we set the task up at object construction time,
        // creationg a fresh source/task when a solution is unloaded.
        private TaskCompletionSource<LanguageClient> clientWhenStartedSource;
        private Task<LanguageClient> clientWhenStarted;

        // Log where we're write helper debug output.
        private HelperLog helperLog = new HelperLog();

        // We need version numbers for open documents. It's possible that there are multiple buffers with
        // the same document, so also keep a reference count.
        private class OpenDocument
        {
            internal int references = 1;
            internal int version = 1;
            internal string langaugeId = "";
            internal string content = "";
        }
        private Dictionary<string, OpenDocument> currentDocuments = new Dictionary<string, OpenDocument>();

        private HelperLSPService()
        {
            FreshWorkspaceState();
        }

        public static readonly HelperLSPService Instance = new HelperLSPService();

        internal Task StartWithoutWorkspaceAsync()
        {
            return StartInternalAsync(null);
        }

        internal Task StartForWorkspaceAsync(ICamberWorkspace workspace)
        {
            return StartInternalAsync(workspace);
        }

        private async Task StartInternalAsync(ICamberWorkspace maybeWorkspace)
        {
            try
            {
                // Stop any existing process (should not happen, but just in case).
                await EnsureStoppedAsync();

                // Subscribe to events that indicate configuration changes.
                CurrentAgentStore.Instance.OnCurrentAgentChange += SendUpdatedConfiguration;
                currentSettings = CamberAssistantPackage.GetInstance().GetSettings();
                currentSettings.PropertyChanged += OnSettingsChanged;

                // Set flag indicating we should be running, try to start helper, and also set up restart handler.
                shouldBeRunning = true;
                var workspacePaths = GetWorkspacePaths(maybeWorkspace);
                Action restartHandler = null;
                restartHandler = () =>
                {
                    if (shouldBeRunning)
                    {
                        Debug.WriteLine($"Restarting Camber helper");
                        FreshProcessState();
                        Util.HandleTaskErrors(HelperProcess.StartAsync(workspacePaths, restartHandler, helperLog).ContinueWith(restartResult =>
                        {
                            if (restartResult.IsFaulted)
                            {
                                this.currentProcess = null;
                                CamberTelemetryLogger.Instance.reportException(restartResult.Exception);
                            }
                            else
                            {
                                // Sync visible files to the restarted helper on UI thread.
                                this.currentProcess = restartResult.Result;
                                var client = restartResult.Result.Client;
                                Util.HandleTaskErrors(ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
                                {
                                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                                    SyncVisibleFilesToHelper(client);
                                    this.clientWhenStartedSource.SetResult(client);
                                }).Task);
                            }
                        }, TaskScheduler.Default));
                    }
                };
                this.currentProcess = await HelperProcess.StartAsync(workspacePaths, restartHandler, helperLog);
                var package = CamberAssistantPackage.GetInstance();
                await package.JoinableTaskFactory.SwitchToMainThreadAsync();
                SyncVisibleFilesToHelper(this.currentProcess.Client);
                this.clientWhenStartedSource.SetResult(this.currentProcess.Client);
            }
            catch (Exception ex)
            {
                this.clientWhenStartedSource.TrySetException(ex);
                await Util.ShowInfoMessageAsync("Failed to start Camber helper process; some functionality will be unavailable. " + ex.Message, "error");
            }
        }

        private static List<string> GetWorkspacePaths(ICamberWorkspace maybeWorkspace)
        {
            var paths = new List<string>();
            if (maybeWorkspace == null) return paths;
            if (!string.IsNullOrEmpty(maybeWorkspace.RootPath))
                paths.Add(maybeWorkspace.RootPath);
            foreach (var additional in maybeWorkspace.AdditionalWorkspaces)
            {
                if (!string.IsNullOrEmpty(additional.Path))
                    paths.Add(additional.Path);
            }
            return paths;
        }

        private void OnSettingsChanged(object sender, System.ComponentModel.PropertyChangedEventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            SendUpdatedConfiguration();
        }

        internal async void EnsureStopped()
        {
            try
            {
                await EnsureStoppedAsync();
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }

        internal async Task EnsureStoppedAsync()
        {
            shouldBeRunning = false;

            var currentProcess = this.currentProcess;
            if (currentProcess != null)
            {
                this.currentProcess = null;
                await currentProcess.StopAsync(helperLog);
            }

            CurrentAgentStore.Instance.OnCurrentAgentChange -= SendUpdatedConfiguration;
            if (currentSettings != null)
            {
                currentSettings.PropertyChanged -= OnSettingsChanged;
                currentSettings = null;
            }

            FreshWorkspaceState();
        }

        // Clears state associated with the current workspace. This is state that should change when
        // we open a new project/solution.
        private void FreshWorkspaceState()
        {
            FreshProcessState();
            currentDocuments = new Dictionary<string, OpenDocument>();
        }

        // Clears state associated with the curent helper process. This is reset when we restart it
        // due to a crash. Leaves everything that should survive process to process intact.
        private void FreshProcessState()
        {
            clientWhenStartedSource = new TaskCompletionSource<LanguageClient>();
            clientWhenStarted = clientWhenStartedSource.Task;
        }

        // Shows the helper debug log output pane.
        internal void ShowDebugLog()
        {
            helperLog.Show();
        }

        internal string GetLatestDebugLogMessages()
        {
            return helperLog.GetLatestMessages();
        }

        internal string GetProtocolLog()
        {
            return this.currentProcess?.GetProtocolLog() ?? "No currently running helper process.";
        }

        // Sends a request. If the LSP client isn't yet available, waits for it to be.
        internal async Task<object> SendRequest(string method, object parameters)
        {
            var client = await clientWhenStarted;
            return await (parameters != null ? client.SendRequest(method, parameters) : client.SendRequest(method))
                .Returning<object>(CancellationToken.None);
        }

        // Sends a request and deserializes the response per type parameter. If the LSP client isn't
        // yet available, waits for it to be.
        internal async Task<TResponse> SendRequest<TResponse>(string method, object parameters)
        {
            var client = await clientWhenStarted;
            return await (parameters != null ? client.SendRequest(method, parameters) : client.SendRequest(method))
                .Returning<TResponse>(CancellationToken.None);
        }

        // Sends a notification. If the LSP client isn't yet available, waits for it to be.
        internal async Task SendNotificationAsync(string method, object parameters)
        {
            var client = await clientWhenStarted;
            client.SendNotification(method, parameters);
        }

        // Runs the action if there is an LSP client available, otherwise drops it.
        private void WithClientIfAvailable(Action<LanguageClient> action)
        {
            var client = this.currentProcess?.Client;
            if (client != null)
                action(client);
        }

        private void SendUpdatedConfiguration()
        {
            WithClientIfAvailable(client => client.SendNotification("workspace/didChangeConfiguration", new { settings = HelperConfiguration.Build() }));
        }

        internal void NotifyFileOpened(string path, string content)
        {
            // If there's no client yet, do nothing. The helper start will sync visible files.
            if (this.currentProcess?.Client == null)
                return;

            // If the document is really newly opened, send a notification, otherwise just bump the refernce count.
            if (currentDocuments.TryGetValue(path, out var openDocument))
            {
                openDocument.references++;
            }
            else
            {
                var languageId = GetLanguageIdForPath(path);
                openDocument = new OpenDocument()
                {
                    langaugeId = languageId,
                    content = content
                };
                currentDocuments.Add(path, openDocument);
                SendNotification("textDocument/didOpen", new DidOpenTextDocumentParams
                {
                    TextDocument = new TextDocumentItem
                    {
                        Uri = TranslatePathToUri(path),
                        LanguageId = languageId,
                        Version = openDocument.version,
                        Text = content
                    }
                });
            }
        }

        internal void NotifyFileChanged(string path, string content, List<TextDocumentContentChangePartial> changes)
        {
            // If there's no client yet, do nothing.
            if (this.currentProcess?.Client == null)
                return;

            if (currentDocuments.TryGetValue(path, out var openDocument))
            {
                openDocument.version++;
                openDocument.content = content;
                SendNotification("textDocument/didChange", new DidChangeTextDocumentParams
                {
                    TextDocument = new VersionedTextDocumentIdentifier
                    {
                        Uri = TranslatePathToUri(path),
                        Version = openDocument.version
                    },
                    ContentChanges = changes
                });
            }
        }

        internal void NotifyFileClosed(string path)
        {
            // If there's no client yet, do nothing.
            if (this.currentProcess?.Client == null)
                return;

            if (currentDocuments.TryGetValue(path, out var openDocument))
            {
                openDocument.references--;
                if (openDocument.references < 1)
                {
                    currentDocuments.Remove(path);
                    SendNotification("textDocument/didClose", new DidCloseTextDocumentParams
                    {
                        TextDocument = new TextDocumentIdentifier
                        {
                            Uri = TranslatePathToUri(path)
                        }
                    });
                }
            }
        }

        internal class Command
        {
            public string command { get; set; }
            public List<object> arguments { get; set; }
        }

        internal async Task HandleCommand(Command command)
        {
            if (command?.command == "camber.invokeLSP")
            {
                if (command.arguments == null || command.arguments.Count == 0)
                    throw new Exception("Malformed camber.invokeLSP command arguments");
                var client = await clientWhenStarted;
                await client.SendRequest(command.arguments[0] as string, command.arguments.ElementAtOrDefault(1))
                    .Returning<object>(CancellationToken.None);
            }
            else
            {
                CamberTelemetryLogger.Instance.reportError(new Exception("Unknown command"), new Dictionary<string, object>
                {
                    { "command", command }
                });
            }
        }

        internal Task<object> Abort(object abort)
        {
            return SendRequest<object>("camber/abort", abort);
        }

        internal Task<RuntimeFilesOutput> GetRuntimeFiles()
        {
            return SendRequest<RuntimeFilesOutput>("camber/runtimeFiles", new RuntimeFilesParams());
        }

        internal Task<object> UpsertSecret(object parameters)
        {
            return SendRequest<object>("camber/upsertSecret", parameters);
        }

        internal Task<object> DeleteSecret(object parameters)
        {
            return SendRequest<object>("camber/deleteSecret", parameters);
        }

        internal Task<object> ListSecrets(object parameters)
        {
            return SendRequest<object>("camber/listSecrets", parameters);
        }

        internal Task<object> GetSecret(object parameters)
        {
            return SendRequest<object>("camber/getSecret", parameters);
        }

        internal Task<object> DeleteMcpSecrets(object parameters)
        {
            return SendRequest<object>("camber/deleteMcpSecrets", parameters);
        }

        private void SendNotification(string method, object payload)
        {
            WithClientIfAvailable(client => client.SendNotification(method, payload));
        }

        private static string GetLanguageIdForPath(string path) => System.IO.Path.GetExtension(path) switch
        {
            ".aspx" or ".ascx" => "aspnet",
            ".cs" => "csharp",
            ".cpp" or ".hpp" or ".h" => "cpp",
            ".fs" or ".fsi" => "fsharp",
            ".js" => "javascript",
            ".razor" or ".cshtml" or ".vbhtml" => "razor",
            ".vb" => "vb",
            ".xaml" => "xaml",
            _ => "plaintext",
        };

        /// <summary>
        /// Syncs all currently visible files in VS to the helper. Must be called on UI thread.
        /// </summary>
        // Best-effort: a failure here must never propagate into StartInternalAsync's
        // catch, where it would poison clientWhenStarted and fail every later
        // request even though the helper itself is healthy.
        private void SyncVisibleFilesToHelper(LanguageClient client)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            currentDocuments = new Dictionary<string, OpenDocument>();

            try
            {
                foreach (var doc in WebViewInfrastructure.FileOperations.GetVisibleFiles())
                {
                    // Skip if we've already seen this path (can happen with split views)
                    if (currentDocuments.ContainsKey(doc.path))
                        continue;

                    var languageId = GetLanguageIdForPath(doc.path);
                    var openDocument = new OpenDocument
                    {
                        langaugeId = languageId,
                        content = doc.contents
                    };
                    currentDocuments.Add(doc.path, openDocument);
                    client.SendNotification("textDocument/didOpen", new DidOpenTextDocumentParams
                    {
                        TextDocument = new TextDocumentItem
                        {
                            Uri = TranslatePathToUri(doc.path),
                            LanguageId = languageId,
                            Version = openDocument.version,
                            Text = doc.contents
                        }
                    });
                }
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }

        private static string TranslatePathToUri(string path)
        {
            return DocumentUri.FromFileSystemPath(path).ToString();
        }
    }
}
