using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Camber.Assistant.ChatWindow;
using System;

namespace Camber.Assistant.Listeners
{
    internal class WindowFocusHandler : IVsBroadcastMessageEvents, IDisposable
    {
        private const uint WM_ACTIVATEAPP = 0x001C;

        private IVsShell vsShell;
        private uint broadcastCookie;

        public WindowFocusHandler()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            vsShell = (IVsShell)ServiceProvider.GlobalProvider.GetService(typeof(SVsShell));
            vsShell.AdviseBroadcastMessages(this, out broadcastCookie);
        }

        public int OnBroadcastMessage(uint msg, IntPtr wParam, IntPtr lParam)
        {
            if (msg == WM_ACTIVATEAPP)
            {
                bool isActivated = wParam != IntPtr.Zero;
                ChatWindowRPCClient.setEditorFocused(isActivated);
            }
            return VSConstants.S_OK;
        }

        public void Dispose()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (broadcastCookie != 0)
            {
                vsShell.UnadviseBroadcastMessages(broadcastCookie);
                broadcastCookie = 0;
            }
        }
    }
}
