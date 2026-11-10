using CefSharp;
using CefSharp.Wpf;
using EnvDTE;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Newtonsoft.Json;
using Camber.Assistant.Context;
using Camber.Assistant.Settings;
using Camber.Assistant.Telemetry;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Xml;

#pragma warning disable VSTHRD200 // Use "Async" suffix for async methods

namespace Camber.Assistant.WebViewInfrastructure
{
    public class WebViewCommunicator : IDisposable
    {
        private TaskCompletionSource<Nothing> readyTaskSource;
        private Task readyTask;

        // We keep track of oustanding requests to the web view, with a task completion
        // source for each.
        public class Nothing { }
        internal interface WebViewResponseHandler
        {
            void HandleResponse(string responseJson);
            void HandleError(string message);
        }
        internal class OutstandingWebViewRequest : WebViewResponseHandler
        {
            private TaskCompletionSource<Nothing> completionSource;

            internal OutstandingWebViewRequest(TaskCompletionSource<Nothing> completionSource)
            {
                this.completionSource = completionSource;
            }

            public void HandleResponse(string responseJson)
            {
                completionSource.SetResult(new Nothing());
            }

            public void HandleError(string message)
            {
                completionSource.SetException(new Exception(message));
            }
        }
        internal class OutstandingWebViewRequest<TResult> : WebViewResponseHandler
        {
            private TaskCompletionSource<TResult> completionSource;

            internal OutstandingWebViewRequest(TaskCompletionSource<TResult> completionSource)
            {
                this.completionSource = completionSource;
            }

            public void HandleResponse(string responseJson)
            {
                completionSource.SetResult(JsonConvert.DeserializeObject<TResult>(responseJson));
            }

            public void HandleError(string message)
            {
                completionSource.SetException(new Exception(message));
            }
        }
        private ConcurrentDictionary<int, WebViewResponseHandler> outstandingRequests = new ConcurrentDictionary<int, WebViewResponseHandler>();

        // Request ID to associate web view request and response.
        private int nextRequestId = 1;

        // The means for the web view to return a result of a call to it is via
        // a method call; we subclass the HostRPCServer class and add those methods
        // here, so they have access to the outstanding requests object, and to keep
        // the HostRPCServer class just containing the methods for that rather than
        // this bit of infrastructure.
        internal class HostRPCServerWithResponseMethods : HostRPCServer
        {
            private ConcurrentDictionary<int, WebViewResponseHandler> outstandingRequests;
            private WebViewCommunicator communicator;

            internal HostRPCServerWithResponseMethods(ConcurrentDictionary<int, WebViewResponseHandler> outstandingRequests, WebViewCommunicator webViewCommunicator)
            {
                this.outstandingRequests = outstandingRequests;
                this.communicator = webViewCommunicator;
            }

            protected override WebViewCommunicator HostCommunicator => communicator;

            public override Task ready()
            {
                communicator.markReady();
                return Task.CompletedTask;
            }

            public Task webViewRPCSuccess(int requestId, string responseJson)
            {
                if (outstandingRequests.TryRemove(requestId, out var outstadning))
                {
                    try
                    {
                        outstadning.HandleResponse(responseJson);
                        return Task.CompletedTask;
                    }
                    catch (Exception ex)
                    {
                        return Task.FromException(ex);
                    }
                }
                else
                {
                    return Task.FromException(new ArgumentException("No such outstanding request"));
                }
            }

            public Task webViewRPCError(int requestId, string error)
            {
                if (outstandingRequests.TryRemove(requestId, out var outstadning))
                {
                    outstadning.HandleError(error);
                    return Task.CompletedTask;
                }
                else
                {
                    return Task.FromException(new ArgumentException("No such outstanding request"));
                }
            }
        }

        private void markReady()
        {
            readyTaskSource.TrySetResult(new Nothing());
        }

        // The browser instance we're communicating with.
        private ChromiumWebBrowser browser;

        protected virtual string ColorThemeChangedMethod => "setTheme";

        public WebViewCommunicator(ChromiumWebBrowser browser, string extraInitialization = null)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            this.browser = browser;
            browser.RequestHandler = new WebViewRequestHandler(CommunicatorSetupCode(extraInitialization));
            browser.JavascriptObjectRepository.Settings.LegacyBindingEnabled = true;
            browser.JavascriptObjectRepository.Register("extensionOperations",
                new HostRPCServerWithResponseMethods(outstandingRequests, this), isAsync: true,
                new BindingOptions { Binder = new NewtonsoftJsonBinder() });
            VSColorTheme.ThemeChanged += OnThemeChanged;
            CamberAssistantPackage.GetInstance().GetSettings().PropertyChanged += OnSettingsChanged;
            readyTaskSource = new TaskCompletionSource<Nothing>();
            readyTask = readyTaskSource.Task;
        }

        [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD100:Avoid async void methods", Justification = "API compatibility; has try/catch")]
        private async void OnThemeChanged(ThemeChangedEventArgs e)
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (browser != null && browser.IsBrowserInitialized)
                    browser.ExecuteScriptAsync(WebViewTheme.GetThemeUpdateJavaScript());
                await CallWebView(ColorThemeChangedMethod, new object[] { WebViewTheme.BuildColorTheme() });
            }
            catch (Exception ex)
            {
                Telemetry.CamberTelemetryLogger.Instance.reportException(ex);
            }
        }

        [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD100:Avoid async void methods", Justification = "API compatibility; has try/catch")]
        private async void OnSettingsChanged(object sender, PropertyChangedEventArgs e)
        {
            try
            {
                var configuration = CamberAssistantPackage.GetInstance().GetSettings().GetWebViewConfiguration();
                await this.CallWebView("setConfiguration", new object[] { configuration });
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }

        public class MessageToWebView
        {
            public string command { get; set; }
            public object[] payload { get; set; }
            public int requestId { get; set; }
        }

        public async Task<Nothing> CallWebView(string method, object[] arguments)
        {
            await readyTask;
            var requestId = nextRequestId++;
            var completionSource = new TaskCompletionSource<Nothing>();
            outstandingRequests.TryAdd(requestId, new OutstandingWebViewRequest(completionSource));
            SendMessageToWebView(method, arguments, requestId);
            return await completionSource.Task;
        }

        public async Task<TResult> CallWebView<TResult>(string method, object[] arguments)
        {
            await readyTask;
            var requestId = nextRequestId++;
            var completionSource = new TaskCompletionSource<TResult>();
            outstandingRequests.TryAdd(requestId, new OutstandingWebViewRequest<TResult>(completionSource));
            SendMessageToWebView(method, arguments, requestId);
            return await completionSource.Task;
        }

        private void SendMessageToWebView(string method, object[] arguments, int requestId)
        {
            var message = JsonConvert.SerializeObject(new MessageToWebView
            {
                command = method,
                payload = arguments,
                requestId = requestId
            });
            browser.ExecuteScriptAsync($"window.postMessage({message}, '*')");
        }

        private string CommunicatorSetupCode(string extraInitialization)
        {
            // This is called from the construction of the communicator, which is done as
            // part of the browser setup, which is part of UI control setup, and thus on the
            // UI thread.
            ThreadHelper.ThrowIfNotOnUIThread();

            // This code is injected into the HTML file of the plugin app, which ensures that
            // it is executed before the app loads, which simplifies setup ordering.
            return $@"
                <script>
                (function() {{
                    this.CAMBER_INITIAL_STATE = {InitialStateJson()};
                    {extraInitialization ?? ""}
                }}).call(this);
                document.addEventListener(""DOMContentLoaded"", function() {{
                    document.body.classList.add('psx-vs');
                    document.body.classList.add('psx-{(WebViewTheme.IsDark() ? "dark" : "light")}');
                }});
                window.riveUri = ""/roundel-spinner.riv"";
                window.riveThinUri = ""/roundel-spinner-thin.riv"";
                </script>
                <style>
                    {WebViewTheme.GetThemeInitializationCSS()}
                </style>
            ";
        }

        internal class InitialState
        {
            public WebViewConfiguration userSettings { get; set; }
            public Workspace[] workspaces { get; set; }
            public string homeDirectory { get; set; }
            public string defaultCwd { get; set; }
            public string currentAgentId { get; set; }
            public Dictionary<string, string> keybindings { get; set; }
            public Environment environment { get; set; }
            public List<string> availableEnrichments { get; set; }
            public List<string> disabledEnrichments { get; set; }
            public bool isAgenticMode { get; set; }
            public bool isHelperSupported { get; set; }
            public bool isEditorFocused { get; set; }
            public WebViewTheme.ColorTheme colorTheme { get; set; }
        }

        public class Environment
        {
            public string assistantEnv { get; set; }
            public string assistantHost { get; set; }
            public string assistantProduct { get; set; }
            public string assistantHostVersion { get; set; }
            public string assistantVersion { get; set; }
            public string operatingSystem { get; set; }
            public Dictionary<string, Boolean> capabilities { get; set; }
        }

        private string InitialStateJson()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var settings = CamberAssistantPackage.GetInstance().GetSettings();
            return JsonConvert.SerializeObject(new InitialState
            {
                userSettings = settings.GetWebViewConfiguration(),
                workspaces = ContextBuilder.BuildProjectsList(),
                homeDirectory = ContextBuilder.BuildHomeDirectory(),
                defaultCwd = ContextBuilder.BuildDefaultCwd(),
                currentAgentId = CurrentAgentStore.Instance.CurrentAgentId,
                keybindings = GetKeybindings(),
                environment = BuildEnvironment(),
                availableEnrichments = PromptContextBuilder.GetAvailableEnrichments(),
                disabledEnrichments = settings.DisabledEnrichments,
                isAgenticMode = true,
                isHelperSupported = true,
                isEditorFocused = System.Windows.Application.Current?.MainWindow?.IsActive ?? true,
                colorTheme = WebViewTheme.BuildColorTheme()
            });
        }

        private static readonly string CommandSetGuid = "{08c5ffe7-6ce9-4f03-afc5-39cf2c5cba53}";
        private static readonly (string webViewName, int commandId)[] KeyboundCommands = new[]
        {
            ("camber.focusInput", 0x0106), // FocusInputCamberCommandId
            ("camber.togglePlanMode", 0x0150), // TogglePlanModeCamberCommandId
        };

        private static Dictionary<string, string> GetKeybindings()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var result = new Dictionary<string, string>();
            try
            {
                var dte = (DTE)ServiceProvider.GlobalProvider.GetService(typeof(DTE));
                if (dte == null) return result;
                foreach (var (webViewName, commandId) in KeyboundCommands)
                {
                    var formatted = GetCommandKeybinding(dte, commandId);
                    if (formatted != null)
                        result[webViewName] = formatted;
                }
            }
            catch (Exception)
            {
                // Non-critical; return whatever we have
            }
            return result;
        }

        private static string GetCommandKeybinding(DTE dte, int commandId)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                var command = dte.Commands.Item(CommandSetGuid, commandId);
                var bindings = command?.Bindings as object[];
                if (bindings == null || bindings.Length == 0)
                    return null;
                // Bindings are strings like "Global::Ctrl+Shift+P"
                var binding = bindings[0] as string;
                if (binding == null)
                    return null;
                var scopeSeparator = binding.IndexOf("::");
                if (scopeSeparator >= 0)
                    binding = binding.Substring(scopeSeparator + 2);
                // Format to match web view expectations: "Ctrl Shift P"
                return string.Join(" ", binding.Split('+').Select(k => k.Trim()));
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static Environment BuildEnvironment()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var (ideProductName, ideVersion) = GetIDENameAndVersion();
            var (extensionVersion, _) = GetExtensionVersion();
            return new Environment()
            {
                // The webview contract allows only "development" | "test" | "production",
                // and error boundaries rethrow (crashing the webview) for anything except
                // "production" — so installed preview builds must report "production",
                // like VS Code's Marketplace pre-releases do. Preview-ness travels in the
                // version's odd minor, not here.
                assistantEnv = Util.IsExperimentalInstance() ? "development" : "production",
                assistantHost = "vs",
                assistantProduct = ideProductName,
                assistantHostVersion = ideVersion,
                assistantVersion = extensionVersion,
                operatingSystem = "win32", // VS only runs on Windows; this is how it's represented in the Node.js platform enum, to match VSCode
                // Only capabilities the shared webview actually reads. Flags for features VS
                // does not back (runTerminalCommands, terminalPanel, openWorkspace,
                // addFolderToWorkspace, customUI) are intentionally absent so their UI stays
                // hidden rather than calling host methods VS lacks. See store.ts Capabilities.
                capabilities = new Dictionary<string, bool>
                {
                    { "header", true },
                    { "fileContext", true },
                    { "hostClipboardWrite", true },
                }
            };
        }

        private static (string, string) GetIDENameAndVersion()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dte = CamberAssistantPackage.GetGlobalService(typeof(DTE)) as DTE;
            var devenvInfo = FileVersionInfo.GetVersionInfo(dte.FullName);
            return (devenvInfo.FileDescription, devenvInfo.ProductVersion);
        }

        public static (string, bool) GetExtensionVersion()
        {
            var manifestPath = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "extension.vsixmanifest");
            var version = "unknown";
            var inPreview = false;
            if (File.Exists(manifestPath))
            {
                var doc = new XmlDocument();
                doc.Load(manifestPath);

                var metaData = doc.DocumentElement.ChildNodes.Cast<XmlElement>().First(x => x.Name == "Metadata");
                var identity = metaData.ChildNodes.Cast<XmlElement>().First(x => x.Name == "Identity");
                version = identity.GetAttribute("Version");

                var previewNode = metaData.ChildNodes.Cast<XmlElement>().FirstOrDefault(x => x.Name == "Preview");
                inPreview = previewNode?.InnerText == "true";
            }
            return (version, inPreview);
        }

        public void Dispose()
        {
            VSColorTheme.ThemeChanged -= OnThemeChanged;
            CamberAssistantPackage.GetInstance().GetSettings().PropertyChanged -= OnSettingsChanged;
        }
    }
}
