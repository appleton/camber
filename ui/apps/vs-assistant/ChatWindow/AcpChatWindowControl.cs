using CefSharp;
using Camber.Assistant.WebViewInfrastructure;

namespace Camber.Assistant.ChatWindow
{
    // CefSharp control hosting the acp-chat webview entry (the single-chat
    // AcpChatApp), one per ACP conversation.
    internal class AcpChatWindowControl : WebViewControl
    {
        internal AcpChatWindowControl(AcpChatInitialState initial)
            : base("acp-chat.html", browser => new AcpChatWebViewCommunicator(browser, initial))
        {
        }

        protected override ContextMenuItem[] GetContextMenuItems(IContextMenuParams parameters)
        {
            return new[]
            {
                new ContextMenuItem
                {
                    Title = "Open Dev Tools",
                    Click = () => OpenDevTools()
                }
            };
        }
    }
}
