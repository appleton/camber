using CefSharp;
using Microsoft.VisualStudio.Shell;
using Camber.Assistant.WebViewInfrastructure;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Controls;

namespace Camber.Assistant.ChatWindow
{
    public class ChatWindowControl : WebViewControl
    {
        public class VSCodeContextElementData
        {
            public string sectionPsx { get; set; }
            public string messageIdPsx { get; set; }
            public string conversationIdPsx { get; set; }
            public string trajectoryLinkPsx { get; set; }
            public string requestIdPsx { get; set; }
        }

        public class VSCodeContextElementBounds
        {
            public VSCodeContextElementData context { get; set; }
            public BoundsData bounds { get; set; }
            public class BoundsData
            {
                public double top { get; set; }
                public double left { get; set; }
                public double width { get; set; }
                public double height { get; set; }
                public double right { get; set; }
                public double bottom { get; set; }
            }
        }

        public static List<VSCodeContextElementBounds> contextElementBounds = new List<VSCodeContextElementBounds>();

        // The Visual Studio assistant window hosts the ACP nav sidebar; the webview
        // mounts SidebarOnlyPanel (assistant.main.ts), and chats open in their own
        // AcpChatToolWindow documents (acp-chat.html / ChatOnlyPanel).
        public ChatWindowControl() : base("assistant.html", browser => new WebViewCommunicator(browser))
        {
        }

        protected override ContextMenuItem[] GetContextMenuItems(IContextMenuParams parameters)
        {
            // The assistant window is now the nav sidebar (no inline conversation), so the
            // legacy "Copy Conversation" item is gone; chat-message context items below still
            // apply when the webview reports userMessage bounds.
            var items = new List<ContextMenuItem>();

            var x = parameters.XCoord;
            var y = parameters.YCoord;
            var match = contextElementBounds.FirstOrDefault(e =>
                x >= e.bounds.left &&
                x <= e.bounds.right &&
                y >= e.bounds.top &&
                y <= e.bounds.bottom);
            if (match != null && match.context.sectionPsx == "userMessage")
            {
                var ctx = match.context;

                if (!string.IsNullOrEmpty(ctx.trajectoryLinkPsx))
                {
                    items.Add(new ContextMenuItem
                    {
                        Title = "Open Trajectory",
                        Click = () => Util.OpenUrlInBrowser(ctx.trajectoryLinkPsx)
                    });
                }

                items.Add(new ContextMenuItem
                {
                    Title = "Copy Conversation ID",
                    Click = () => Util.HandleTaskErrors(WriteItToClipboardAsync(ctx.conversationIdPsx, "No conversation ID found"))
                });

                items.Add(new ContextMenuItem
                {
                    Title = "Copy Request ID",
                    Click = () => Util.HandleTaskErrors(WriteItToClipboardAsync(ctx.requestIdPsx, "No request ID found"))
                });
            }

            return items.ToArray();
        }

        static async Task WriteItToClipboardAsync(string id, string error)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (!string.IsNullOrEmpty(id))
            {
                System.Windows.Clipboard.SetText(id);
            }
            else
            {
                System.Windows.MessageBox.Show(error, "Warning", System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning);
            }
        }
    }
}
