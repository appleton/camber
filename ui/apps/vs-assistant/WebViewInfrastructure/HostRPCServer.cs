using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Camber.Assistant.Context;
using Camber.Assistant.Settings;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using SmartReader;
using System.Net.Http;
using Camber.Assistant.Context.Prompt;
using Camber.Assistant.Telemetry;
using Camber.Assistant.ChatWindow;
using Camber.Assistant.Tasks;
using Camber.Assistant.HelperLSP;
using OmniSharp.Extensions.JsonRpc.Server;
using CefSharp.Web;
using Newtonsoft.Json;
using Camber.Assistant.EditHighlights;
using static Camber.Assistant.ChatWindow.ChatWindowControl;
using System.IO;
using System.Text.RegularExpressions;

// Disable some C# style warnings, since we're following naming of the web view RPC interface.
#pragma warning disable VSTHRD200 // Use "Async" suffix for async methods
#pragma warning disable IDE1006 // Naming Styles

namespace Camber.Assistant.WebViewInfrastructure
{

    // Rule: always declare methods here to return a Task. That way, they will be async from
    // the web view side, as expected. Without that they will be blocking calls from the web
    // view, and could cause UI freezes.
    //
    // Rule: mirror every parameter of the webview's Host contract (ui/packages/rpc/src/host.ts),
    // including the ones VS ignores. CefSharp binds by argument count, so a signature shorter
    // than the caller stops binding at runtime — where the TypeScript hosts simply drop the
    // surplus arguments and keep working.
    public class HostRPCServer
    {
        // The webview communicator backing this RPC server, when known (set by the
        // per-webview subclass). Lets jsonrpc attach ACP sessions to chat windows.
        protected virtual WebViewCommunicator HostCommunicator => null;

        public virtual Task ready()
        {
            return Task.CompletedTask;
        }

        // The webview calls this with no arguments now (host.ts dropped the request
        // parameter); mirror VS Code, which serves only the git branch facets here.
        public Task<List<PromptContextFacet>> getPromptContext()
        {
            return PromptContextBuilder.GetContextAsync(new List<string> { "branch" }, false);
        }

        public async Task openSettings(string setting = null)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            CamberAssistantPackage.GetInstance().ShowOptionPage(typeof(CamberSettings));
        }

        public async Task<CodeSymbolResponse> getCodeSymbols(string path = null)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            return path == null
                 ? CodeSymbolBuilder.BuildCodeSymbolsForActiveFile()
                 : CodeSymbolBuilder.BuildCodeSymbolsForPath(path);
        }

        public Task<bool> checkFileExists(string path)
        {
            return Task.FromResult(File.Exists(Util.TransformPathFromWebView(path)));
        }

        public async Task openFile(string webViewPath, int? line = null, int? column = null)
        {
            var path = Util.TransformPathFromWebView(webViewPath);
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            Util.OpenFileInEditor(path, line, column);
        }

        public Task openExternalURL(string url)
        {
            Util.OpenUrlInBrowser(url);
            return Task.CompletedTask;
        }

        public async Task<List<Document>> getVisibleFiles()
        {
            await CamberAssistantPackage.GetInstance().JoinableTaskFactory.SwitchToMainThreadAsync();
            return FileOperations.GetVisibleFiles();
        }

        public async Task<string> getWorkspaceConversation()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            return CamberAssistantPackage.GetInstance().ConversationIDHash;
        }

        public async Task setWorkspaceConversation(string conversationID)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            CamberAssistantPackage.GetInstance().ConversationIDHash = conversationID;
        }

        public Task openNewConversation()
        {
            return Task.CompletedTask;
        }

        // Split-host (acp-sidebar) only: the sidebar calls this to reveal or open
        // the chat window for a conversation. See AcpChatToolWindow.
        public async Task openAcpChat(OpenAcpChatOptions opts)
        {
            await AcpChatToolWindow.OpenSessionAsync(opts);
        }

        // Split-host only: the sidebar calls this to close a conversation's chat window
        // (e.g. when the conversation is archived or deleted). Pairs with openAcpChat.
        public async Task closeAcpChat(CloseAcpChatOptions opts)
        {
            await AcpChatToolWindow.CloseSessionAsync(opts);
        }

        // Open a chat-rendered image (e.g. an exported SVG diagram) in the OS default
        // viewer: write it to a temp file and shell-open it.
        public void openImageFile(string svgContent, string filename = null)
        {
            try
            {
                var name = string.IsNullOrEmpty(filename) ? "camber-image.svg" : System.IO.Path.GetFileName(filename);
                var path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), name);
                System.IO.File.WriteAllText(path, svgContent);
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }

        public class SaveTextFileFilter
        {
            public string name { get; set; }
            public List<string> extensions { get; set; }
        }

        public class SaveTextFileOptions
        {
            public string contents { get; set; }
            public string defaultFileName { get; set; }
            public string title { get; set; }
            public List<SaveTextFileFilter> filters { get; set; }
        }

        // Native "save as" for e.g. dumping an ACP conversation. Returns the written
        // path, or null if the user cancels (the webview then falls back to a download).
        public async Task<string> saveTextFile(SaveTextFileOptions options)
        {
            if (options == null) return null;
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var dialog = new Microsoft.Win32.SaveFileDialog
            {
                FileName = options.defaultFileName ?? "",
                Title = options.title,
            };
            if (options.filters != null && options.filters.Count > 0)
            {
                dialog.Filter = string.Join("|", options.filters.Select(
                    f => $"{f.name}|*.{string.Join(";*.", f.extensions ?? new List<string>())}"));
            }
            if (dialog.ShowDialog() == true)
            {
                System.IO.File.WriteAllText(dialog.FileName, options.contents ?? "");
                return dialog.FileName;
            }
            return null;
        }

        public class ProjectFolder
        {
            public string path { get; set; }
            public string name { get; set; }
        }

        // Backs the chat window's "add project" affordance: pick a folder to start a
        // conversation in. Returns null when the user cancels, which the webview reads as
        // "nothing chosen" and leaves the empty state alone.
        public async Task<ProjectFolder> selectProjectFolder()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            using (var dialog = new System.Windows.Forms.FolderBrowserDialog
            {
                Description = "Add Project",
                ShowNewFolderButton = true,
            })
            {
                if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK)
                    return null;
                var selected = dialog.SelectedPath;
                if (string.IsNullOrWhiteSpace(selected))
                    return null;
                // Trim the trailing separator so the path matches the shape the rest of the
                // host reports, but keep a bare drive root intact: "C:\" trimmed to "C:" would
                // name the drive's current directory rather than its root.
                var trimmed = Util.TrimTrailingPathSlash(selected);
                var path = trimmed.Length >= 3 ? trimmed : selected;
                var name = Path.GetFileName(path);
                return new ProjectFolder
                {
                    path = path,
                    name = string.IsNullOrEmpty(name) ? path : name,
                };
            }
        }

        // Backs the conversation "Review" bar: reveals Visual Studio's native Git
        // Changes window, the counterpart of VS Code's workbench.view.scm.
        public async Task revealSourceControl()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            try
            {
                var dte = (EnvDTE.DTE)CamberAssistantPackage.GetGlobalService(typeof(EnvDTE.DTE));
                dte?.ExecuteCommand("View.GitWindow");
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }

        // A chat window reports its current agent so routing metadata stays in sync.
        public Task updateAcpChatPanelMetadata(AcpChatPanelMetadata metadata)
        {
            if (HostCommunicator is AcpChatWebViewCommunicator chatComm)
            {
                AcpChatToolWindow.UpdateMetadata(chatComm.ConversationId, metadata);
            }
            return Task.CompletedTask;
        }

        public class AttachedUrl
        {
            public string Url { get; set; }
            public string Title { get; set; }
            public string Content { get; set; }

            public AttachedUrl(string url, string title, string content)
            {
                Url = url;
                Title = title;
                Content = content;
            }
        }

        public async Task<AttachedUrl> getUrlContents(string url)
        {
            try
            {
                using (HttpClient client = new HttpClient())
                {
                    var response = await client.GetAsync(url);
                    response.EnsureSuccessStatusCode();
                    var contentType = response.Content.Headers?.ContentType?.MediaType;
                    var body = await response.Content.ReadAsStringAsync();
                    if (contentType.Equals("application/json") || contentType.Equals("text/plain"))
                    {
                        return new AttachedUrl(url, null, await response.Content.ReadAsStringAsync());
                    }
                    else
                    {
                        Reader reader = new Reader(url, body);
                        Article article = await reader.GetArticleAsync();
                        if (article.IsReadable)
                        {
                            return new AttachedUrl(url, article.Title, article.Content);
                        }
                    }
                }
            }
            catch (HttpRequestException)
            {
            }
            return null;
        }

        public void reportError(IDictionary<string, object> error)
        {
            try
            {
                CamberTelemetryLogger.Instance.reportError(error, null);
            }
            catch (Exception ex)
            {
                // Reporting the error failed; handle this exception otherwise we will
                // end up with an infinite set of calls to this method.
                System.Diagnostics.Debug.WriteLine(ex.ToString());
            }
        }

        public async Task showInfoMessage(string message, string type = null)
        {
            await Util.ShowInfoMessageAsync(message, type);
        }

        public async Task writeToClipboard(string text)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            Clipboard.SetText(text);
        }

        public async Task<AttachedFile> getFileContents(string webViewPath)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var path = Util.TransformPathFromWebView(webViewPath);
            var workspace = CamberAssistantPackage.GetInstance().GetWorkspace();
            return workspace.IsPathInWorkspace(path)
                ? ContextBuilder.BuildSingleFileContext(path)
                : null;
        }

        // Image MIME types the webview can render inline. Mirrors the VSCode host
        // (rpc/handlers/getImageFileData.ts); an unlisted extension yields null.
        private static readonly Dictionary<string, string> ImageMimeTypes = new Dictionary<string, string>
        {
            [".bmp"] = "image/bmp",
            [".gif"] = "image/gif",
            [".jpeg"] = "image/jpeg",
            [".jpg"] = "image/jpeg",
            [".png"] = "image/png",
            [".svg"] = "image/svg+xml",
            [".webp"] = "image/webp",
        };

        public class ImageFileData
        {
            public string data { get; set; }
            public string mimeType { get; set; }
            public string path { get; set; }
        }

        // Reads an image the agent generated/read so the webview can render it inline
        // (it can't fetch local files itself). Like VSCode, the path is read as-is and
        // not restricted to the workspace - generated images often live in temp/worktree
        // dirs. Returns null (not an error) for non-images or unreadable files.
        public async Task<ImageFileData> getImageFileData(string filePath)
        {
            if (string.IsNullOrEmpty(filePath))
                return null;
            var path = Util.TransformPathFromWebView(filePath);
            if (!ImageMimeTypes.TryGetValue(Path.GetExtension(path).ToLowerInvariant(), out var mimeType))
                return null;
            try
            {
                var bytes = await Task.Run(() => File.Exists(path) ? File.ReadAllBytes(path) : null);
                if (bytes == null)
                    return null;
                return new ImageFileData
                {
                    data = Convert.ToBase64String(bytes),
                    mimeType = mimeType,
                    path = filePath,
                };
            }
            catch (Exception)
            {
                // Best-effort read; surface "missing" to the webview rather than throwing.
                return null;
            }
        }

        public async Task taskDidChange(CamberTaskDTO task)
        {
            await TasksToolWindow.HandleTaskChange(task);
        }

        public async Task showTaskVersion(CamberTaskDTO task, string versionId = null)
        {
            await TasksToolWindow.ShowTaskVersion(task, versionId);
        }

        public async Task closeTask(string taskId)
        {
            await TasksToolWindow.CloseTaskWindow(taskId);
        }

        public async Task clearHighlights()
        {
            await CamberAssistantPackage.GetInstance().JoinableTaskFactory.SwitchToMainThreadAsync();
            EditHighlightsTaggerProvider.ClearEditHighlights();
        }

        public async Task abort(object abort)
        {
            await HelperLSPService.Instance.Abort(abort);
        }

        public async Task openRawPrompt(string raw, string language = null)
        {
            await RawPromptToolWindow.ShowRawPromptToolWindowAsync(raw);
        }

        public class AgentRef
        {
            public string id { get; set; }
        }

        public class ContextConfigUpdate
        {
            public AgentRef agent { get; set; }
            public List<string> disabledEnrichments { get; set; }
        }

        public async Task updateContextConfig(ContextConfigUpdate conf)
        {
            var package = CamberAssistantPackage.GetInstance();
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var settings = package.GetSettings();
            if (conf.agent != null)
            {
                CurrentAgentStore.Instance.CurrentAgentId = conf.agent.id;
            }
            if (conf.disabledEnrichments != null)
            {
                settings.DisabledEnrichments = conf.disabledEnrichments;
            }
        }

        public async Task<JsonString> jsonrpc(string method, object parameters = null)
        {
            try
            {
                // Ensure serialization via Newtonsoft for consistency.
                var result = await HelperLSPService.Instance.SendRequest(method, parameters);
                MaybeAttachAcpSession(method, parameters, result);
                return new JsonString(JsonConvert.SerializeObject(result));
            }
            catch (RequestException ex)
            {
                // The CefSharp C#->JS bridge only carries Exception.Message across to the web
                // view, so a JSON-RPC error's code/data are otherwise lost and every failure
                // looks like a generic internal error (-32603). The ACP layer needs the real
                // code - e.g. auth-required (-32000) must render the login panel rather than an
                // "agent erroring" state. The OmniSharp client surfaces helper error responses
                // as RequestException (typically JsonRpcException) carrying ErrorCode, so we
                // re-throw with the structured error encoded as a JSON envelope in the message;
                // vs-handlers.ts decodes it back on the JS side.
                var data = (ex as JsonRpcException)?.Error;
                throw new Exception(EncodeRpcErrorEnvelope(ex.ErrorCode, ex.Message, data));
            }
        }

        // When a chat window's webview successfully creates an ACP session, remember
        // which conversation owns the new sessionId so inbound frames route back to it.
        // No-op for non-chat webviews (HostCommunicator is not an AcpChatWebViewCommunicator).
        private void MaybeAttachAcpSession(string method, object parameters, object result)
        {
            if (method != "camber/acp/session/new") return;
            if (!(HostCommunicator is AcpChatWebViewCommunicator chatComm)) return;
            var sessionId = AcpChatToolWindow.SessionIdOf(result);
            if (string.IsNullOrEmpty(sessionId)) return;
            AcpChatToolWindow.AttachSession(chatComm.ConversationId, AcpChatToolWindow.AgentServerOf(parameters), sessionId);
        }

        // Serializes a JSON-RPC error into the envelope vs-handlers.ts looks for. The marker
        // key lets the JS side distinguish a deliberately-encoded transport error from an
        // ordinary exception message that merely happens to be JSON.
        private static string EncodeRpcErrorEnvelope(int code, string message, string data)
        {
            return JsonConvert.SerializeObject(new
            {
                __acpRpcError = true,
                code,
                message,
                data = ParseErrorData(data),
            });
        }

        // The helper packs error-specific data as a JSON string. Parse it back into an object so
        // the envelope carries structured data rather than a doubly-encoded string; fall back to
        // the raw string (or null) when it is absent or not valid JSON.
        private static object ParseErrorData(string data)
        {
            if (string.IsNullOrEmpty(data))
                return null;
            try
            {
                return JsonConvert.DeserializeObject(data);
            }
            catch (JsonException)
            {
                return data;
            }
        }

        public async Task jsonrpcNotify(string method, object parameters = null)
        {
            await HelperLSPService.Instance.SendNotificationAsync(method, parameters);
        }

        // Pushes the user's enabled ACP agent servers to the helper, which records them in
        // its acpNav registry and uses them to resolve/launch agents. This writes the helper
        // store directly - the authoritative runtime path when the user toggles servers in the
        // UI. It is distinct from the agentServers config setting (HelperConfiguration), which
        // only seeds the store on first run; a UI toggle doesn't change that setting, so no
        // workspace/didChangeConfiguration re-push is needed here.
        public async Task setACPAgentServers(object agentServers, string defaultAgentServer = null)
        {
            await HelperLSPService.Instance.SendRequest(
                "camber/acpNav/setAgentServers",
                new { agentServers, defaultAgentServer });
        }

        // Assistant terminals. VS has no embedded terminal, so these are backed by external
        // cmd.exe console windows (AssistantTerminalManager). The reachable use in VS is ACP
        // agent "terminal" authentication (e.g. pool login); the worktree/panel uses that drive
        // these on desktop/vscode are dormant here.
        public Task<AssistantTerminalTab[]> listAssistantTerminals(string worktreePath)
        {
            return Task.FromResult(AssistantTerminalManager.Instance.List(worktreePath).ToArray());
        }

        public Task<AssistantTerminalTab> createAssistantTerminal(
            string worktreePath,
            string command = null,
            Dictionary<string, string> env = null,
            string commandMode = null,
            string cwd = null,
            int? cols = null,
            int? rows = null)
        {
            return Task.FromResult(AssistantTerminalManager.Instance.Create(worktreePath, command, env, cwd));
        }

        public Task deleteAssistantTerminal(string terminalId)
        {
            AssistantTerminalManager.Instance.Delete(terminalId);
            return Task.CompletedTask;
        }

        public Task writeAssistantTerminal(string terminalId, string data)
        {
            AssistantTerminalManager.Instance.Write(terminalId, data);
            return Task.CompletedTask;
        }

        public Task clearAssistantTerminal(string terminalId)
        {
            // External console windows own their scrollback; there's nothing to clear from
            // here. The webview already dropped its replayable buffer before calling, so its
            // view is cleared regardless. No-op, like resizeAssistantTerminal.
            return Task.CompletedTask;
        }

        public Task resizeAssistantTerminal(string terminalId, int cols, int rows)
        {
            // External console windows manage their own size; nothing to do.
            return Task.CompletedTask;
        }

        public Task closeAssistantTerminalsForWorktree(string worktreePath)
        {
            AssistantTerminalManager.Instance.CloseForWorktree(worktreePath);
            return Task.CompletedTask;
        }

        public Task closeAssistantTerminalsForProject(string projectPath)
        {
            AssistantTerminalManager.Instance.CloseForProject(projectPath);
            return Task.CompletedTask;
        }

        public Task setWebviewFocus(bool focused)
        {
            // Each ACP chat window is its own webview, so its focus belongs to that window
            // rather than to the single sidebar static - otherwise the last webview to report
            // focus wins and window-targeted commands go to the wrong place.
            if (HostCommunicator is AcpChatWebViewCommunicator chatComm)
            {
                AcpChatToolWindow.SetWebViewFocus(chatComm.ConversationId, focused);
                return Task.CompletedTask;
            }
            ChatToolWindow.WebViewHasFocus = focused;
            return Task.CompletedTask;
        }

        public Task updateVSCodeContextElements(List<VSCodeContextElementBounds> contextElementBounds)
        {
            ChatWindowControl.contextElementBounds = contextElementBounds;
            return Task.CompletedTask;
        }

        private static bool toastNotificationsInitialized = false;

        public Task showNotification(string title, string body)
        {
            if (!toastNotificationsInitialized)
            {
                Microsoft.Toolkit.Uwp.Notifications.ToastNotificationManagerCompat.OnActivated += async args =>
                {
                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                    Util.FocusMainWindow();
                };
                toastNotificationsInitialized = true;
            }

            var assemblyPath = System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            var iconPath = System.IO.Path.Combine(assemblyPath, "extension-icon.png");

            var builder = new Microsoft.Toolkit.Uwp.Notifications.ToastContentBuilder()
                .AddText(title)
                .AddText(body);

            if (File.Exists(iconPath))
            {
                builder.AddAppLogoOverride(new Uri(iconPath), Microsoft.Toolkit.Uwp.Notifications.ToastGenericAppLogoCrop.None);
            }

            builder.Show();
            return Task.CompletedTask;
        }

        public async Task<JsonString> upsertSecret(object parameters)
        {
            return new JsonString(JsonConvert.SerializeObject(await HelperLSPService.Instance.UpsertSecret(parameters)));
        }

        public async Task<JsonString> deleteSecret(object parameters)
        {
            return new JsonString(JsonConvert.SerializeObject(await HelperLSPService.Instance.DeleteSecret(parameters)));
        }

        public async Task<JsonString> listSecrets(object parameters)
        {
            return new JsonString(JsonConvert.SerializeObject(await HelperLSPService.Instance.ListSecrets(parameters)));
        }

        public async Task<JsonString> getSecret(object parameters)
        {
            return new JsonString(JsonConvert.SerializeObject(await HelperLSPService.Instance.GetSecret(parameters)));
        }

        public async Task<JsonString> deleteMCPSecrets(string serverId, string serverUrl)
        {
            return new JsonString(JsonConvert.SerializeObject(await HelperLSPService.Instance.DeleteMcpSecrets(new
            {
                serverID = serverId,
                serverURL = serverUrl
            })));
        }

        // The webview's theme layer asks the host to resolve a file-icon SVG when the icon
        // isn't inlined in the initial fileIconTheme. VS ships no fileIconTheme, so there is
        // nothing to resolve; return null (an unknown icon), matching the VSCode host's own
        // default. Without this the awaited call would reject and surface as console noise.
        public Task<string> getFileIconDefinition(string iconName)
        {
            return Task.FromResult<string>(null);
        }

        public Task mcpOAuthInitiate(string serverId, string serverUrl, string serverName)
        {
            return this.jsonrpc("camber/mcpOAuthInitiate", new
            {
                serverID = serverId,
                serverURL = serverUrl,
                serverName
            });
        }
    }
}
