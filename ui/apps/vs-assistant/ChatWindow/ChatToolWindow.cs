using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Camber.Assistant.Commands;
using Camber.Assistant.EditHighlights;
using Camber.Assistant.WebViewInfrastructure;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Controls;

namespace Camber.Assistant.ChatWindow
{
    /// <summary>
    /// This class implements the tool window exposed by this package and hosts a user control.
    /// </summary>
    /// <remarks>
    /// In Visual Studio tool windows are composed of a frame (implemented by the shell) and a pane,
    /// usually implemented by the package implementer.
    /// <para>
    /// This class derives from the ToolWindowPane class provided from the MPF in order to use its
    /// implementation of the IVsUIElementPane interface.
    /// </para>
    /// </remarks>
    [Guid("d141842f-823d-4a5f-be8d-bdb5e5ba1241")]
    public class ChatToolWindow : ToolWindowPane
    {
        private class ToolWindowVisibilityTracker : IVsWindowFrameNotify3
        {
            public event Action<bool> VisibilityChanged;

            public int OnShow(int fShow)
            {
                // We are only interested in cases where the window is hidden within
                // Visual Studio, not when the whole IDE is hidden.
                bool isHidden = fShow == (int)__FRAMESHOW.FRAMESHOW_Hidden;
                VisibilityChanged?.Invoke(isHidden);
                return VSConstants.S_OK;
            }

            public int OnSize(int x, int y, int w, int h) => VSConstants.S_OK;
            public int OnDockableChange(int fDockable, int x, int y, int w, int h) => VSConstants.S_OK;
            public int OnMove(int x, int y, int w, int h) => VSConstants.S_OK;
            public int OnClose(ref uint pgrfSaveOptions) => VSConstants.S_OK;
        }

        // We want to attach the tracker exactly once; keep some state for that.
        private bool visibilityTrackerAttached = false;

        /// <summary>
        /// We want to reinitialize the web app as we go between solutions/opened folders. One cannot simpply reassign
        /// the Content properly of a tool window and have the change picked up; instead we need to wrap it up in a
        /// ContentControl to make sure that happens.
        /// </summary>
        private readonly ContentControl holder;

        // Mirrors IDSymbol "CamberSidebarToolbar" in CamberAssistantPackage.vsct.
        private const int SidebarToolbarId = 0x0030;

        /// <summary>
        /// Initializes a new instance of the <see cref="ChatToolWindow"/> class.
        /// </summary>
        public ChatToolWindow() : base(null)
        {
            this.Caption = "Camber Assistant";

            // Attach the sidebar toolbar declared in the .vsct; this surfaces the
            // New Conversation "+" action at the top of the tool window (mirroring
            // VS Code's native view-title new-conversation button).
            this.ToolBar = new CommandID(BaseCamberToolsCommand.CommandSet, SidebarToolbarId);

            // This is the user control hosted by the tool window; Note that, even if this class implements IDisposable,
            // we are not calling Dispose on this object. This is because ToolWindowPane calls Dispose on
            // the object returned by the Content property.
            this.holder = new ContentControl();
            this.Content = holder;
            holder.Content = new ChatWindowControl();
        }

        private void EnsureVisibilityTracker()
        {
            if (visibilityTrackerAttached)
                return;
            ThreadHelper.ThrowIfNotOnUIThread();
            base.Initialize();
            var tracker = new ToolWindowVisibilityTracker();
            tracker.VisibilityChanged += isHidden =>
            {
                if (isHidden)
                    EditHighlightsTaggerProvider.ClearEditHighlights();
            };
            ((IVsWindowFrame)Frame).SetProperty((int)__VSFPROPID.VSFPROPID_ViewHelper, tracker);
            visibilityTrackerAttached = true;
        }

        public static async Task<ChatToolWindow> GetInstanceAsync(AsyncPackage package)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var window = await package.FindToolWindowAsync(typeof(ChatToolWindow), 0, true, package.DisposalToken);
            if ((null == window) || (null == window.Frame))
            {
                throw new NotSupportedException("Cannot create tool window");
            }
            if (!(window is ChatToolWindow camberWindow))
            {
                throw new InvalidOperationException("Wrong tool window type encountered");
            }
            camberWindow.EnsureVisibilityTracker();
            return camberWindow;
        }

        public static async Task<ChatToolWindow> GetAndShowAsync(AsyncPackage package)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var window = await package.ShowToolWindowAsync(typeof(ChatToolWindow), 0, true, package.DisposalToken);
            if ((null == window) || (null == window.Frame))
            {
                throw new NotSupportedException("Cannot create tool window");
            }
            if (!(window is ChatToolWindow camberWindow))
            {
                throw new InvalidOperationException("Wrong tool window type encountered");
            }
            camberWindow.EnsureVisibilityTracker();
            return camberWindow;
        }

        protected override void OnClose()
        {
            base.OnClose();
            (holder.Content as ChatWindowControl)?.Dispose();
        }

        internal void Reload()
        {
            var old = holder.Content as ChatWindowControl;
            holder.Content = new ChatWindowControl();
            old.Dispose();
            ChatWindowRPCClient.ClearCachedCommunicator();
        }

        internal WebViewCommunicator GetCommunicator()
        {
            return (holder.Content as WebViewControl).GetCommunicator();
        }

        internal void FocusBrowser()
        {
            (holder.Content as WebViewControl)?.FocusBrowser();
        }

        internal void OpenDevTools()
        {
            (holder.Content as WebViewControl).OpenDevTools();
        }

        public static bool WebViewHasFocus { get; set; }
    }
}
