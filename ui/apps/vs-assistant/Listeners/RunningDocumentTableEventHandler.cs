using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Camber.Assistant.ChatWindow;
using Camber.Assistant.Context;
using Camber.Assistant.HelperLSP;

namespace Camber.Assistant.Listeners
{
    class RunningDocumentTableEventHandler : IVsRunningDocTableEvents, IDisposable
    {
        private readonly IVsRunningDocumentTable runningDocTable;
        private uint cookie;

        public RunningDocumentTableEventHandler()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            runningDocTable = (IVsRunningDocumentTable)ServiceProvider.GlobalProvider.GetService(typeof(SVsRunningDocumentTable));
            runningDocTable.AdviseRunningDocTableEvents(this, out cookie);
        }

        public int OnBeforeDocumentWindowShow(uint docCookie, int fFirstShow, IVsWindowFrame pFrame)
        {
            // Opening a document or switching to a document; this is fired before the document change has actually
            // taken place, and oddly the OnAfterDocumentWindowShow never fires, so we need a short delay before we
            // sync. Sometimes during initial load it can be really slow, so if we don't get an active file in the
            // context, retry some times.
            ThreadHelper.ThrowIfNotOnUIThread();
            var scheduler = TaskScheduler.FromCurrentSynchronizationContext();
            var retries = 10;
            Func<Task> buildAndPropagateContext = null;
            buildAndPropagateContext = async () =>
            {
                await Task.Delay(100);
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

                // Build and send context so long as it is ready, otherwise retry.
                var context = ContextBuilder.BuildContext();
                if (context.recentFile == null)
                {
                    if (retries-- > 0)
                        Util.HandleTaskErrors(buildAndPropagateContext());
                    return;
                }
                ChatWindowRPCClient.setContext(context);
            };
            Util.HandleTaskErrors(buildAndPropagateContext());
            return VSConstants.S_OK;
        }

        public int OnAfterDocumentWindowShow(uint docCookie, int fFirstShow, IVsWindowFrame pFrame)
        {
            return VSConstants.S_OK;
        }

        public int OnAfterDocumentWindowHide(uint docCookie, IVsWindowFrame pFrame)
        {
            // Closing a document; this is fired before the editor is destroyed, so we introduce a small
            // delay for doing the context update.
            ThreadHelper.ThrowIfNotOnUIThread();
            Func<Task> handleClose = async () =>
            {
                await Task.Delay(100);
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                ContextBuilder.SendLatestContext();
            };
            Util.HandleTaskErrors(handleClose());
            return VSConstants.S_OK;
        }

        public int OnAfterFirstDocumentLock(uint docCookie, uint dwRDTLockType, uint dwReadLocksRemaining, uint dwEditLocksRemaining)
        {
            return VSConstants.S_OK;
        }

        public int OnBeforeLastDocumentUnlock(uint docCookie, uint dwRDTLockType, uint dwReadLocksRemaining, uint dwEditLocksRemaining)
        {
            return VSConstants.S_OK;
        }

        public int OnAfterSave(uint docCookie)
        {
            return VSConstants.S_OK;
        }

        public int OnAfterAttributeChange(uint docCookie, uint grfAttribs)
        {
            return VSConstants.S_OK;
        }

        public void Dispose()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (cookie != 0)
            {
                runningDocTable.UnadviseRunningDocTableEvents(cookie);
                cookie = 0;
            }
        }
    }
}
