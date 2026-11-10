using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Shell;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Diagnostics;
using Microsoft.VisualStudio;

namespace Camber.Assistant.HelperLSP
{
    internal class HelperLog
    {
        private const string paneName = "Camber Helper Logs";
        private static Guid paneGuid = new Guid("A18ECD82-DBA2-4CC4-887C-C70B572536BF");

        private readonly IVsOutputWindowPane outputPane;

        /// <summary>
        /// The latest messages that were logged, used when we want to include recent helper output in errors.
        /// </summary>
        private Queue<string> latestMesages = new Queue<string>();

        /// <summary>
        /// The number of messages that count as latest ones.
        /// </summary>
        private const int LatestMessagesLimit = 10;

        public HelperLog()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var outputWindow = Package.GetGlobalService(typeof(SVsOutputWindow)) as IVsOutputWindow;
            outputWindow.CreatePane(ref paneGuid, paneName, 1, 1); // visible and clearWithSolution = true
            outputWindow.GetPane(ref paneGuid, out outputPane);
        }

        public void Log(string message)
        {
            Debug.WriteLine($"camber-helper: {message}");
            lock (latestMesages)
            {
                latestMesages.Enqueue(message);
                if (latestMesages.Count > LatestMessagesLimit)
                    latestMesages.Dequeue();
            }
            _ = ThreadHelper.JoinableTaskFactory.StartOnIdle(() =>
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                outputPane.OutputStringThreadSafe($"{message}\n");
            });
        }

        public void Show()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            outputPane.Activate();
            if (Package.GetGlobalService(typeof(SVsUIShell)) is IVsUIShell uiShell)
            {
                var outputWindowGuid = VSConstants.StandardToolWindows.Output;
                uiShell.FindToolWindow((uint)__VSFINDTOOLWIN.FTW_fForceCreate, ref outputWindowGuid, out IVsWindowFrame windowFrame);
                windowFrame?.Show();
            }
        }

        public string GetLatestMessages()
        {
            lock (latestMesages)
                return string.Join("\n", latestMesages);
        }
    }
}
