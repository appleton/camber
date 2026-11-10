using CefSharp.Wpf;
using Newtonsoft.Json;
using Camber.Assistant.WebViewInfrastructure;

namespace Camber.Assistant.ChatWindow
{
    // RPC bridge for a single ACP chat window. Injects the window's initial chat
    // state so the acp-chat webview renders the right conversation on load.
    internal class AcpChatWebViewCommunicator : WebViewCommunicator
    {
        private static readonly JsonSerializerSettings serializerSettings = new JsonSerializerSettings
        {
            NullValueHandling = NullValueHandling.Ignore,
        };

        // The conversation this window renders, so the host RPC server can attach
        // the helper-assigned sessionId back to the right window on session/new.
        internal string ConversationId { get; }

        internal AcpChatWebViewCommunicator(ChromiumWebBrowser browser, AcpChatInitialState initial)
            : base(browser,
                $"this.CAMBER_INITIAL_ACP_CHAT_STATE = {JsonConvert.SerializeObject(initial, serializerSettings)};\n")
        {
            ConversationId = initial.conversationId;
        }
    }
}
