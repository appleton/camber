using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Camber.Assistant.ChatWindow;
using Camber.Assistant.HelperLSP;
using Camber.Assistant.Tasks;
using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;

namespace Camber.Assistant.Context
{
    /// <summary>
    /// This class monitors what solution or folder we have open and makes sure we have an appropriate workspace object
    /// in place and that the helper is running or stopped.
    ///
    /// Unfortunately, it works via polling. It would be nice to rely on solution events. Alas, they don't get fired
    /// in a reliable way when you have a fake project representing an opened folder (which is the way that opening
    /// folders was hacked into Visual Studio). As an example of the problems, the fake project created when you open a
    /// folder is only lazily opened when you first open a file, so if somebody was to open a folder and immediately try
    /// to do an agentic query, we'd fail because the event wasn't fired yet to say we've got a new workspace folder.
    /// While we could use solution events for solutions, it'd only lead to more state and potential races between the
    /// two approaches. So, we just give up and poll.
    /// </summary>
    internal class CamberWorkspaceManager : IDisposable
    {
        private readonly IVsSolution solution;
        private readonly Action<ICamberWorkspace> setWorkspace;
        private string lastFolderPath;
        private ICamberWorkspace currentWorkspace;
        private readonly DispatcherTimer idleTimer;

        public CamberWorkspaceManager(IVsSolution solution, Action<ICamberWorkspace> setWorkspace)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            this.solution = solution ?? throw new ArgumentNullException(nameof(solution));
            this.setWorkspace = setWorkspace ?? throw new ArgumentNullException(nameof(setWorkspace));

            // Start a lightweight idle timer (runs on UI thread)
            idleTimer = new DispatcherTimer
            {
                Interval = TimeSpan.FromMilliseconds(250)
            };
            idleTimer.Tick += (s, e) => CheckFolderChange();
            idleTimer.Start();
        }

        private void CheckFolderChange()
        {
            ThreadHelper.ThrowIfNotOnUIThread();

            // Get current soluiton path; turn null into empty string to represent no workspace, so we
            // can differentiate that from the startup situation whwere we never initialized yet.
            solution.GetSolutionInfo(out var folderPath, out var solutionFile, out _);
            folderPath = folderPath ?? "";

            if (folderPath == lastFolderPath)
                return; // no change, do nothing

            lastFolderPath = folderPath;

            // Clear old workspace and any current task windows. (We leave the starting of a
            // new helper to tear down an existing one if present, since it can properly await
            // the shutdown.)
            if (currentWorkspace != null)
            {
                setWorkspace(null);
                currentWorkspace = null;
            }
            Util.HandleTaskErrors(CloseTaskToolWindowAsync());

            if (folderPath != "")
            {
                // Decide workspace type
                if (!string.IsNullOrEmpty(solutionFile) &&
                    solutionFile.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
                {
                    currentWorkspace = new SolutionBasedCamberWorkspace(solution);
                }
                else
                {
                    currentWorkspace = new FolderBasedCamberWorkspace(folderPath);
                }

                setWorkspace(currentWorkspace);
                Func<Task> start = async () =>
                {
                    await HelperLSPService.Instance.StartForWorkspaceAsync(currentWorkspace);
                    await ReloadChatWindowAsync();
                };
                Util.HandleTaskErrors(start());
            }
            else
            {
                // No current workspace, but we still want to have the helper running so you can do login
                // or use chat without a solution open.
                Func<Task> start = async () =>
                {
                    await HelperLSPService.Instance.StartWithoutWorkspaceAsync();
                    await ReloadChatWindowAsync();
                };
                Util.HandleTaskErrors(start());
            }
        }

        private async Task ReloadChatWindowAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var chatToolWindow = await ChatToolWindow.GetInstanceAsync(CamberAssistantPackage.GetInstance());
            chatToolWindow?.Reload();
        }

        private async Task CloseTaskToolWindowAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            await TasksToolWindow.CloseAllTaskWindows();
        }

        public void Dispose()
        {
            idleTimer.Stop();
            idleTimer.Tick -= (s, e) => CheckFolderChange();

            if (currentWorkspace != null)
            {
                // Use JoinableTaskFactory.Run to synchronously wait for async shutdown
                // during VS exit, otherwise the async void EnsureStopped returns immediately
                // and VS may terminate before the helper process is properly stopped.
                ThreadHelper.JoinableTaskFactory.Run(async () =>
                {
                    await HelperLSPService.Instance.EnsureStoppedAsync();
                });
                setWorkspace(null);
                currentWorkspace = null;
            }
        }
    }
}
