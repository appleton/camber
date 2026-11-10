using CefSharp;
using CefSharp.Wpf;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Utilities.UnifiedSettings;
using System.Linq;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Shell.TableManager;
using Camber.Assistant.ChatWindow;
using Camber.Assistant.Context;
using Camber.Assistant.Listeners;
using Camber.Assistant.Settings;
using Camber.Assistant.Tasks;
using Camber.Assistant.Telemetry;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Task = System.Threading.Tasks.Task;

namespace Camber.Assistant
{
    /// <summary>
    /// This is the class that implements the package exposed by this assembly.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The minimum requirement for a class to be considered a valid package for Visual Studio
    /// is to implement the IVsPackage interface and register itself with the shell.
    /// This package uses the helper classes defined inside the Managed Package Framework (MPF)
    /// to do it: it derives from the Package class that provides the implementation of the
    /// IVsPackage interface and uses the registration attributes defined in the framework to
    /// register itself and its components with the shell. These attributes tell the pkgdef creation
    /// utility what data to put into .pkgdef file.
    /// </para>
    /// <para>
    /// To get loaded into VS, the package must be referred by &lt;Asset Type="Microsoft.VisualStudio.VsPackage" ...&gt; in .vsixmanifest file.
    /// </para>
    /// </remarks>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [ProvideAutoLoad(UIContextGuids80.SolutionExists, PackageAutoLoadFlags.BackgroundLoad)]
    [ProvideAutoLoad(VSConstants.UICONTEXT.FolderOpened_string, PackageAutoLoadFlags.BackgroundLoad)]
    [Guid(CamberAssistantPackage.PackageGuidString)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [ProvideToolWindow(typeof(ChatToolWindow), Style = VsDockStyle.Tabbed, Window = EnvDTE.Constants.vsWindowKindSolutionExplorer)]
    [ProvideToolWindow(typeof(TasksToolWindow), MultiInstances = true, Style = VsDockStyle.MDI, Transient = true)]
    [ProvideToolWindow(typeof(RawPromptToolWindow), MultiInstances = true, Style = VsDockStyle.MDI, Transient = true)]
    [ProvideToolWindow(typeof(AcpChatToolWindow), MultiInstances = true, Style = VsDockStyle.MDI, Transient = true)]
    // TODO: Remove when minimum VS version is raised to 17.11+. On 17.11+ the VS.Extensibility
    // settings page (CamberSettingDefinitions) provides the settings UI, making this redundant.
    // Keeping it for now so 17.9/17.10 users still have a working settings dialog. The downside
    // is that VS 2026 shows a "not migrated" notice alongside the new settings page.
    [ProvideOptionPage(typeof(CamberSettings), "Camber Assistant", "General", 0, 0, true)]
    public sealed class CamberAssistantPackage : AsyncPackage
    {
        /// <summary>
        /// camber_assistantPackage GUID string.
        /// </summary>
        public const string PackageGuidString = "1dc0dcb4-146c-42bc-b922-0975daea8e56";

        private static CamberAssistantPackage instance;

        // The conversation ID hash for the current solution, so the conversation
        // reopens when reopening the solution.
        public string ConversationIDHash { get; set; }

        /// <summary>
        /// Key under which we save the conversation ID.
        /// </summary>
        private const string ConversationIDHashKey = "conversationIDHash";

        /// <summary>
        /// Base path for storing CEF cache data (over all running extension instances).
        /// </summary>
        private string cefCacheLocation = Path.Combine(Path.GetTempPath(), "camber-vs-cache");

        /// <summary>
        /// The CEF cache location for this IDE instance, since this cannot be shared over multiple
        /// instances of the IDE (if one tries, the second IDE's CEF instance fails to initialize).
        /// </summary>
        private string uniqueCefCachePath;

        private CamberWorkspaceManager solutionEventHandler;
        private RunningDocumentTableEventHandler runningDocumentHandler;
        private WindowFocusHandler windowFocusHandler;
        private ICamberWorkspace currentWorkspace;
        private ErrorTableWatcher errorTableWatcher;

        public CamberAssistantPackage()
        {
            // Conversation is persisted per solution in options (not checked in to VCS).
            AddOptionKey(ConversationIDHashKey);
        }

        /// <summary>
        /// Initialization of the package; this method is called right after the package is sited, so this is the place
        /// where you can put all the initialization code that rely on services provided by VisualStudio.
        /// </summary>
        /// <param name="cancellationToken">A cancellation token to monitor for initialization cancellation, which can occur when VS is shutting down.</param>
        /// <param name="progress">A provider for progress updates.</param>
        /// <returns>A task representing the async work of package initialization, or an already completed task if there is none. Do not return null from this method.</returns>
        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            // Store the package for lookup.
            instance = this;

            // When initialized asynchronously, the current thread may be a background thread at this point.
            // Do any initialization that requires the UI thread after switching to the UI thread.
            await this.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);

            // Initialize CEF. We use a separate directory for cache, since this cannot be shared over
            // multiple instances of CefSharp. Make absolutely sure we don't call initialize a second time
            // if it's already initialized in this process.
            if (!Cef.IsInitialized.GetValueOrDefault())
            {
                CefSharpSettings.ConcurrentTaskExecution = true;
                var extensionPath = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                this.uniqueCefCachePath = Path.Combine(cefCacheLocation, Guid.NewGuid().ToString());
                var cefSettings = new CefSettings
                {
                    BrowserSubprocessPath = Path.Combine(extensionPath, "CefSharp.BrowserSubprocess.exe"),
                    LocalesDirPath = Path.Combine(extensionPath, "locales"),
                    CachePath = this.uniqueCefCachePath,
                    ResourcesDirPath = extensionPath
                };
                cefSettings.CefCommandLineArgs.Add("disable-pinch", "1");
                // Register camber-app as a secure custom scheme. Without this, Chromium
                // treats the webview as an insecure context and hides crypto.randomUUID,
                // crypto.subtle, and the rest of the secure-context API surface that the
                // shared assistant package relies on.
                cefSettings.RegisterScheme(new CefCustomScheme
                {
                    SchemeName     = "camber-app",
                    DomainName     = "app",
                    IsSecure       = true,
                    IsStandard     = true,
                    IsCorsEnabled  = true,
                    // Required for the SPA's runtime fetch() calls (e.g. shiki loading
                    // onig.wasm) — without this, Fetch API rejects URLs on this scheme
                    // even though navigation and <script> tags load fine.
                    IsFetchEnabled = true,
                });
                // Teach System.Uri that camber-app follows standard scheme://host/path
                // syntax, so WebViewRequestHandler can read Host and AbsolutePath off it.
                if (!UriParser.IsKnownScheme("camber-app"))
                {
                    UriParser.Register(
                        new GenericUriParser(GenericUriParserOptions.GenericAuthority),
                        "camber-app",
                        -1);
                }
                Cef.Initialize(cefSettings);
            }

            // Start event handlers.
            this.solutionEventHandler = new CamberWorkspaceManager(await GetServiceAsync(typeof(SVsSolution)) as IVsSolution,
                (workspace) =>
                {
                    this.currentWorkspace = workspace;
                });
            this.runningDocumentHandler = new RunningDocumentTableEventHandler();
            this.windowFocusHandler = new WindowFocusHandler();
            var componentModel = (IComponentModel)Package.GetGlobalService(typeof(SComponentModel));
            this.errorTableWatcher = new ErrorTableWatcher(componentModel?.GetService<ITableManagerProvider>());

            // Initialize commands.
            await Commands.NewConversationCommand.InitializeAsync(this);
            await Commands.FocusInputCamberCommand.InitializeAsync(this);
            await Commands.TogglePlanModeCommand.InitializeAsync(this);
            await Commands.OpenAssistantDevToolsCommand.InitializeAsync(this);
            await Commands.OpenTaskDevToolsCommand.InitializeAsync(this);
            await Commands.HelperDebugLogCommand.InitializeAsync(this);
            await Commands.HelperProtocolLogCommand.InitializeAsync(this);
            await Commands.OpenPermissionSettingsCommand.InitializeAsync(this);
            await Commands.OpenSettingsCommand.InitializeAsync(this);
            await Commands.ResetConfigurationCommand.InitializeAsync(this);

            // Clean up cache directories from previous runs, if any, so we don't fill up the temp
            // directory.
            CleanupMarkedCacheDirectories();

            // Start sync between the legacy settings storage and the Unified Settings API, so both
            // VS 2022 (legacy dialog) and VS 2026+ (new settings page) share the same values.
            // SVsUnifiedSettingsManager is in Microsoft.Internal.VisualStudio.Shell.Interop, which
            // is an internal assembly not directly referenceable, so we locate the type at runtime.
            var svs = AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => a.GetType("Microsoft.Internal.VisualStudio.Shell.Interop.SVsUnifiedSettingsManager"))
                .FirstOrDefault(t => t != null);
            var settingsManager = svs != null ? await GetServiceAsync(svs) as ISettingsManager : null;
            if (settingsManager != null)
                CamberSettingsSync.Initialize(settingsManager);

            // Show message about local search being disabled.
            ShowLocalSearchInfoBarIfNeeded();
        }

        public static CamberAssistantPackage GetInstance()
        {
            return instance;
        }

        internal ICamberWorkspace GetWorkspace() => this.currentWorkspace;

        internal ErrorTableWatcher GetErrorTableWatcher() => this.errorTableWatcher;

        public CamberSettings GetSettings()
        {
            return GetDialogPage(typeof(CamberSettings)) as CamberSettings;
        }

        protected override void OnLoadOptions(string key, Stream stream)
        {
            if (key == ConversationIDHashKey)
            {
                using (var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: true))
                {
                    var byteLength = reader.ReadInt32();
                    if (byteLength > 0)
                    {
                        byte[] stringBytes = reader.ReadBytes(byteLength);
                        ConversationIDHash = Encoding.UTF8.GetString(stringBytes);
                    }
                }
            }
        }

        protected override void OnSaveOptions(string key, Stream stream)
        {
            if (key == ConversationIDHashKey)
            {
                using (var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true))
                {
                    byte[] stringBytes = Encoding.UTF8.GetBytes(ConversationIDHash ?? "");
                    writer.Write(stringBytes.Length);
                    writer.Write(stringBytes);
                }
            }
        }

        private void ShowLocalSearchInfoBarIfNeeded()
        {
            Func<Task> infoBarShower = async () =>
            {
                // Allow time for loading the extension.
                await Task.Delay(TimeSpan.FromSeconds(10));
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

                // Don't show the info bar if we presented it before.
                var currentSettings = GetSettings();
                if (currentSettings.DisplayedLocalSearchDisabledInfo)
                    return;
                currentSettings.DisplayedLocalSearchDisabledInfo = true;

                // Don't show the info bar if local search is already disabled.
                if (currentSettings.DisabledEnrichments.Contains("local_search"))
                    return;

                // Disable local search.
                currentSettings.DisabledEnrichments = currentSettings.DisabledEnrichments.Append("local_search").ToList();

                // Show the info bar with a link to re-enable local search.
                var content = "Camber update: codebase search is now disabled by default, in preparation for agent mode. You may re-enable it here, or via the assistant context menu.";
                var actions = new List<InfoBarActionItem>
                {
                    new InfoBarButton("Enable")
                };
                var infoBarFactory = (IVsInfoBarUIFactory)Package.GetGlobalService(typeof(SVsInfoBarUIFactory));
                var infoBarModel = new InfoBarModel(
                    content,
                    actions,
                    KnownMonikers.StatusInformation,
                    isCloseButtonVisible: true
                );
                var camberToolWindow = await ChatToolWindow.GetInstanceAsync(CamberAssistantPackage.GetInstance());
                var infoBar = infoBarFactory.CreateInfoBar(infoBarModel);
                var eventsSink = new LocalSearchEventSink();
                infoBar.Advise(eventsSink, out uint cookie);
                eventsSink.cookie = cookie;
                camberToolWindow.AddInfoBar(infoBar);
            };
            Util.HandleTaskErrors(infoBarShower());
        }

        private class LocalSearchEventSink : IVsInfoBarUIEvents
        {
            public uint cookie { get; set; }

            public void OnClosed(IVsInfoBarUIElement infoBarUIElement)
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                infoBarUIElement?.Unadvise(cookie);
            }

            [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD100:Avoid async void methods", Justification = "API compatibility; has try/catch")]
            public async void OnActionItemClicked(IVsInfoBarUIElement infoBarUIElement, IVsInfoBarActionItem actionItem)
            {
                try
                {
                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                    infoBarUIElement.Unadvise(cookie);
                    var settings = CamberAssistantPackage.GetInstance().GetSettings();
                    settings.DisabledEnrichments = settings.DisabledEnrichments.Where(e => e != "local_search").ToList();
                    infoBarUIElement.Close();
                }
                catch (Exception ex)
                {
                    CamberTelemetryLogger.Instance.reportException(ex);
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            CamberSettingsSync.Dispose();

            this.solutionEventHandler.Dispose();
            this.runningDocumentHandler.Dispose();
            this.windowFocusHandler.Dispose();
            this.errorTableWatcher.Dispose();

            Cef.Shutdown(); // Safe even if it is already shut down for some reason
            try
            {
                if (!string.IsNullOrEmpty(this.uniqueCefCachePath) && Directory.Exists(this.uniqueCefCachePath))
                {
                    Directory.Delete(this.uniqueCefCachePath, recursive: true);
                }
            }
            catch (Exception)
            {
                // Can't clean up now, usually due to file locks lingering after shutdown.
                // Leave a `.cleanup` file behind so we can do it lazily in the future.
                try
                {
                    File.WriteAllText(Path.Combine(this.uniqueCefCachePath, ".cleanup"), "");
                }
                catch (Exception ex)
                {
                    // Too late for telemetry, but can log it.
                    Debug.WriteLine($"Could not create .cleanup file for later cleanup: {ex.Message}");
                }
            }

            base.Dispose(disposing);
        }

        public void CleanupMarkedCacheDirectories()
        {
            if (!Directory.Exists(cefCacheLocation))
                return;

            foreach (var dir in Directory.EnumerateDirectories(cefCacheLocation))
            {
                var cleanupMarker = Path.Combine(dir, ".cleanup");
                if (!File.Exists(cleanupMarker))
                    continue;
                try
                {
                    Directory.Delete(dir, recursive: true);
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"Failed to delete cache dir '{dir}': {ex.Message}");
                }
            }
        }
    }
}
