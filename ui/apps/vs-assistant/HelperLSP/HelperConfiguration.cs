using Microsoft.VisualStudio.Shell;
using Newtonsoft.Json;
using Camber.Assistant.Settings;
using Camber.Assistant.Telemetry;
using Camber.Assistant.WebViewInfrastructure;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.HelperLSP
{
    internal class HelperConfiguration
    {
        // A unique identifier for this sessino, that stays the same throughout the IDE instance's lifetime.
        private static readonly string CurrentSessionId = Guid.NewGuid().ToString();

        public string agentId { get; set; }
        // Enables the helper's ACP pipeline (acpproxy + acpNav store). The webview is always in
        // ACP mode (acpMode returns true), and the helper still gates its ACP init on this, so
        // it is set unconditionally - matching vscode-assistant.
        public string agentMode { get; set; }
        // User-authored ACP agent servers (name -> { command, args, env, ... }), mirroring
        // VSCode's camber.agentServers setting. The helper seeds its acpNav registry from
        // this on first run. Null when unset/invalid so the helper falls back to its defaults.
        // Values are kept opaque (not typed into per-field classes) so unknown/new fields pass
        // through to the helper verbatim rather than being silently dropped on re-serialization.
        public Dictionary<string, object> agentServers { get; set; }
        public string sessionId { get; set; }
        public string assistantHost { get; set; }
        public string assistantEnvironment { get; set; }
        public ClientCapabilities clientCapabilities { get; set; }
        public EditorSettings editorSettings { get; set; }
        public bool agentHandlerEnabled { get; set; }
        public string extensionBinaryFolderUri { get; set; }

        public class EditorSettings
        {
            public bool disableCompletionTelemetry { get; set; }
            public List<string> disabledEnrichments { get; set; }
        }

        public class ClientCapabilities
        {
            public bool taskWorkspaceEdit { get; set; }
        }

        public static HelperConfiguration Build()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var settings = CamberAssistantPackage.GetInstance().GetSettings();
            var environment = WebViewCommunicator.BuildEnvironment();
            var assemblyPath = System.IO.Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            var binaryDirectoryUri = new Uri(System.IO.Path.Combine(assemblyPath, "helper"), UriKind.Absolute).AbsoluteUri;
            return new HelperConfiguration
            {
                agentId = CurrentAgentStore.Instance.CurrentAgentId,
                agentMode = "acp",
                agentServers = ParseAgentServers(settings.AcpAgentServersJson),
                sessionId = CurrentSessionId,
                assistantHost = environment.assistantHost,
                assistantEnvironment = environment.assistantEnv,
                clientCapabilities = new ClientCapabilities
                {
                    taskWorkspaceEdit = true
                },
                editorSettings = new EditorSettings
                {
                    disableCompletionTelemetry = true,
                    disabledEnrichments = settings.DisabledEnrichments
                },
                agentHandlerEnabled = true,
                extensionBinaryFolderUri = binaryDirectoryUri
            };
        }

        // Parses the user's ACP agent-servers JSON setting into an object the helper can consume.
        // Returns null for empty or malformed input so a typo never breaks helper startup - the
        // helper then keeps its existing/default agent servers.
        private static Dictionary<string, object> ParseAgentServers(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
                return null;
            try
            {
                return JsonConvert.DeserializeObject<Dictionary<string, object>>(json);
            }
            catch (JsonException ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
                return null;
            }
        }
    }
}
