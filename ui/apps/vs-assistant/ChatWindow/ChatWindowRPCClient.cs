using Microsoft.VisualStudio.Shell;
using Camber.Assistant.Context;
using Camber.Assistant.HelperLSP;
using Camber.Assistant.Settings;
using Camber.Assistant.Telemetry;
using Camber.Assistant.WebViewInfrastructure;
using System;
using System.Threading;
using System.Threading.Tasks;

// Disable some C# style warnings, since we're following naming of the web view RPC interface,
// and also don't care to make everything handle tasks when there's no result.
#pragma warning disable VSTHRD200 // Use "Async" suffix for async methods
#pragma warning disable IDE1006 // Naming Styles
#pragma warning disable VSTHRD110 // Observe result of async calls
#pragma warning disable CS4014 // Lack of await

namespace Camber.Assistant.ChatWindow
{
    internal static class ChatWindowRPCClient
    {
        internal static void setContext(ActiveFileContext context)
        {
            CallWebView("setContext", context);
            // The chat lives in per-conversation windows now, so they need the context too.
            AcpChatToolWindow.Broadcast("setContext", context);
        }

        internal static void focusInput()
        {
            CallWebView("focusInput");
        }

        internal static Task<ACPElicitationOutput> elicitation(object parameters)
        {
            return CallWebView<ACPElicitationOutput>("elicitation", parameters);
        }

        // Helper-owned pending approvals (permission prompts, elicitations) as a
        // reconciled state push; webviews render and clear approval cards from it.
        internal static Task acpApprovalsDidChange(object parameters)
        {
            AcpChatToolWindow.Broadcast("acpApprovalsDidChange", parameters);
            return CallWebView("acpApprovalsDidChange", parameters);
        }

        // The user's MCP connector store changed; webviews re-list it and re-inject
        // connectors into their live agent sessions.
        internal static Task mcpServersDidChange()
        {
            AcpChatToolWindow.Broadcast("mcpServersDidChange");
            return CallWebView("mcpServersDidChange");
        }

        internal static Task<object> jsonrpcRequest(object parameters)
        {
            return CallWebView<object>("jsonrpcRequest", parameters);
        }

        internal static Task jsonrpcNotify(object parameters)
        {
            return CallWebView("jsonrpcNotify", parameters);
        }

        internal static Task acpAgentServerDidExit(object parameters)
        {
            return CallWebView("acpAgentServerDidExit", parameters);
        }

        // The ACP nav (conversation list) is owned by the sidebar webview, so nav
        // updates always go there rather than to a per-conversation chat window.
        internal static Task acpNavDidChange(object parameters)
        {
            return CallWebView("acpNavDidChange", parameters);
        }

        // Active-agent state for the sidebar (split-host): which ACP agent is active and
        // its MCP capabilities. The sidebar has no session of its own, so it relies on
        // this push to render its connectors UI. Always goes to the sidebar webview.
        internal static Task acpActiveAgentDidChange(object parameters)
        {
            return CallWebView("acpActiveAgentDidChange", parameters);
        }

        internal static Task setEditorFocused(bool focused)
        {
            // The session-bearing chat windows gate notifications on editor focus, so
            // broadcast to them (not only the sidebar) — see #84/#106.
            AcpChatToolWindow.Broadcast("setEditorFocused", focused);
            return CallWebView("setEditorFocused", focused);
        }

        private static async Task CallWebView(string method, params object[] arguments)
        {
            bool gotCommunicator = false;
            try
            {
                var communicator = await GetCommunicator();
                if (communicator == null)
                    return;
                gotCommunicator = true;
                await communicator.CallWebView(method, arguments);
            }
            catch (Exception ex)
            {
                // If we failed to get the communicator, that typically means we're during shutdown, so don't ingest an error.
                if (!gotCommunicator)
                    return;
                CamberTelemetryLogger.Instance.reportError(ex, new System.Collections.Generic.Dictionary<string, object>
                {
                    { "method", method }
                });
            }
        }

        private static async Task<TResult> CallWebView<TResult>(string method, params object[] arguments)
        {
            var communicator = await GetCommunicator();
            if (communicator == null)
                return default;
            return await communicator.CallWebView<TResult>(method, arguments);
        }

        // We only have one web view communicator for the lifetime of the extension, so we can cache it here.
        // The caching means that we typically don't need a trip via the UI thread, which is not only important
        // so far as performance goes, but also removes an opportunity for messages to get dis-ordered in streaming
        // responses.
        private static WebViewCommunicator cachedCommunicator;

        private static async Task<WebViewCommunicator> GetCommunicator()
        {
            if (cachedCommunicator == null)
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var package = CamberAssistantPackage.GetInstance();
                if (package == null)
                    return null;
                var camberToolWindow = await ChatToolWindow.GetInstanceAsync(CamberAssistantPackage.GetInstance());
                cachedCommunicator = camberToolWindow.GetCommunicator();
            }
            return cachedCommunicator;
        }

        internal static void ClearCachedCommunicator() => cachedCommunicator = null;
    }
}
