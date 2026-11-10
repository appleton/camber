using CefSharp.Wpf;
using CefSharp;
using System.Windows.Controls;
using System;
using System.Collections.Generic;
using System.Windows.Input;

namespace Camber.Assistant.WebViewInfrastructure
{
    /// <summary>
    /// Interaction logic for WebViewControl.
    /// </summary>
    public abstract partial class WebViewControl : UserControl, IDisposable
    {
        public WebViewCommunicator Communicator { get; private set; }

        public class ContextMenuItem
        {
            public string Title { get; set; }
            public Action Click { get; set; }
        }

        private class CustomContextMenuHandler : IContextMenuHandler
        {
            /// <summary>
            /// A means to get items to show on the context menu.
            /// </summary>
            private readonly Func<IContextMenuParams, ContextMenuItem[]> contextMenuItemsFactory;

            /// <summary>
            /// The items shown on the most recently opened context menu.
            /// </summary>
            private Dictionary<CefMenuCommand, ContextMenuItem> itemsById;

            public CustomContextMenuHandler(Func<IContextMenuParams, ContextMenuItem[]> contextMenuItemsFactory)
            {
                this.contextMenuItemsFactory = contextMenuItemsFactory;
                itemsById = new Dictionary<CefMenuCommand, ContextMenuItem>();
            }

            public void OnBeforeContextMenu(IWebBrowser browserControl, IBrowser browser, IFrame frame, IContextMenuParams parameters, IMenuModel model)
            {
                // Leave the default context menu in dev tools
                if (frame.Url != null && frame.Url.StartsWith("devtools://"))
                    return;

                model.Clear();
                itemsById = new Dictionary<CefMenuCommand, ContextMenuItem>();

                var editFlags = parameters.EditStateFlags;
                var hasEditItems = false;
                if (editFlags.HasFlag(ContextMenuEditState.CanCut))
                {
                    model.AddItem(CefMenuCommand.Cut, "Cut");
                    hasEditItems = true;
                }
                if (editFlags.HasFlag(ContextMenuEditState.CanCopy))
                {
                    model.AddItem(CefMenuCommand.Copy, "Copy");
                    hasEditItems = true;
                }
                if (editFlags.HasFlag(ContextMenuEditState.CanPaste))
                {
                    model.AddItem(CefMenuCommand.Paste, "Paste");
                    hasEditItems = true;
                }
                if (editFlags.HasFlag(ContextMenuEditState.CanSelectAll))
                {
                    model.AddItem(CefMenuCommand.SelectAll, "Select All");
                    hasEditItems = true;
                }

                var customItems = contextMenuItemsFactory(parameters);
                if (hasEditItems && customItems.Length > 0)
                    model.AddSeparator();

                var id = 26501;
                foreach (var item in customItems)
                {
                    var itemId = (CefMenuCommand)id++;
                    itemsById.Add(itemId, item);
                    model.AddItem(itemId, item.Title);
                }
            }

            public bool OnContextMenuCommand(IWebBrowser browserControl, IBrowser browser, IFrame frame, IContextMenuParams parameters, CefMenuCommand commandId, CefEventFlags eventFlags)
            {
                if (commandId == CefMenuCommand.SelectAll)
                {
                    frame.SelectAll();
                    return true;
                }
                if (itemsById.TryGetValue(commandId, out var item))
                {
                    item.Click();
                    return true;
                }
                return false;
            }

            public void OnContextMenuDismissed(IWebBrowser browserControl, IBrowser browser, IFrame frame)
            {
            }

            public bool RunContextMenu(IWebBrowser browserControl, IBrowser browser, IFrame frame, IContextMenuParams parameters, IMenuModel model, IRunContextMenuCallback callback)
            {
                return false;
            }
        }

        /// <summary>
        /// Initializes a new instance of the <see cref="WebViewControl"/> class.
        /// </summary>
        protected WebViewControl(string entrypoint, Func<ChromiumWebBrowser, WebViewCommunicator> communicatorFactory)
        {
            this.InitializeComponent();
            Communicator = communicatorFactory(browser);
            browser.PreviewMouseWheel += Browser_PreviewMouseWheel;
            browser.Address = "camber-app://app/" + entrypoint;
            browser.MenuHandler = new CustomContextMenuHandler(GetContextMenuItems);

            // Visual Studio tool windows can be floated and docked, and when that happens they are
            // migrated to a new window control. CefSharp by default uses the enclosing window to
            // track when it should be disposed. That would lead to it being disposed when one
            // floated or docked the tool window, even though the browser control lived on, which
            // resulted in a freeze of the content in the tool window. We can suppress that behavior
            // by assigning a different control to CleanupElement and manually handling the disposal
            // in our own Dispose method.
            browser.CleanupElement = new Control();
        }

        private void Browser_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (Keyboard.IsKeyDown(Key.LeftCtrl) || Keyboard.IsKeyDown(Key.RightCtrl))
            {
                e.Handled = true; // block zoom
            }
        }

        internal WebViewCommunicator GetCommunicator()
        {
            return Communicator;
        }

        internal void FocusBrowser()
        {
            browser.Focus();
        }

        internal void OpenDevTools()
        {
            browser.ShowDevTools();
        }

        protected virtual ContextMenuItem[] GetContextMenuItems(IContextMenuParams parameters)
        {
            return new ContextMenuItem[] { };
        }

        public void Dispose()
        {
            Communicator.Dispose();
            browser.Dispose(); // Explicitly dispose due to CleanupElement being cleared
        }
    }
}
