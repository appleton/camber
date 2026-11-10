using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Camber.Assistant.ChatWindow;
using Camber.Assistant.WebViewInfrastructure;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Tasks
{
    [Guid(TasksToolWindowId)]
    public class TasksToolWindow : ToolWindowPane
    {
        private const string TasksToolWindowId = "74702467-4A68-4656-8683-B061D42408CE";

        // The task and version for the next created tool window, used, to work around the lack of way to pass a
        // constructor parameter to the tool window pane.
        private static CamberTaskDTO taskForNewToolWindow;
        private static CamberTaskVersionDTO taskVersionForNewToolWindow;

        internal string TaskId { get; set; }

        public TasksToolWindow() : base(null)
        {
            this.Caption = "Review Changes";
            var control = new TasksWindowControl(taskForNewToolWindow, taskVersionForNewToolWindow);
            this.Content = control;
            this.TaskId = taskForNewToolWindow.id;
            taskCommunicators.AddOrUpdate(taskForNewToolWindow.id, control.Communicator, (_, __) => control.Communicator);
        }

        // When we stream messages from assistant web view to task web view, there's quite a lot of them, as
        // they are sent as tokens arrive. This dictionary lets us shortcut sending the messages bewtween the
        // CefSharp instances without a visit to the UI thread, which was measured to be very time consuming
        // and caused significant lag when faced with a large volume of messages.
        private static ConcurrentDictionary<string, WebViewCommunicator> taskCommunicators = new ConcurrentDictionary<string, WebViewCommunicator>();

        private class ToolWindowWithFrame
        {
            public IVsWindowFrame frame;
            public TasksToolWindow toolWindow;
        }

        internal static async Task HandleTaskChange(CamberTaskDTO currentTask)
        {
            // If there is only a single window and it matches this task, shortcut the message
            // passing without a switch to the UI thread.
            if (taskCommunicators.Count == 1 && taskCommunicators.TryGetValue(currentTask.id, out var taskCommunicator))
            {
                await taskCommunicator.CallWebView("didChange", new object[] { currentTask });
                return;
            }

            // In other cases, consider open task windows. For this, we need to be on the UI thread.
            var package = CamberAssistantPackage.GetInstance();
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();

            var foundToolWindowForTask = FindToolWindowForTask(currentTask.id);
            if (foundToolWindowForTask != null)
            {
                await foundToolWindowForTask.toolWindow.GetCommunicator().CallWebView("didChange", new object[] { currentTask });
            }
        }

        internal static async Task ShowTaskVersion(CamberTaskDTO task, string versionId)
        {
            var package = CamberAssistantPackage.GetInstance();
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();

            // If there is a tool window for the task, the dispatch version switch message.
            // Otherwise, we need to create the tool window for the task.
            var foundToolWindowForTask = FindToolWindowForTask(task.id);
            if (foundToolWindowForTask != null)
            {
                foundToolWindowForTask.frame.Show();
                if (versionId != null)
                {
                    await foundToolWindowForTask.toolWindow.GetCommunicator().CallWebView("showTaskVersion", new object[] { task, versionId });
                }
            }
            else
            {
                await CreateTaskWindow(task, versionId);
            }
        }

        private static async Task CreateTaskWindow(CamberTaskDTO task, string versionId)
        {
            // Put options for new window in place and create it.
            var package = CamberAssistantPackage.GetInstance();
            taskForNewToolWindow = task;
            taskVersionForNewToolWindow = task.versions.FirstOrDefault(v => v.id == versionId);
            await package.ShowToolWindowAsync(typeof(TasksToolWindow), Math.Abs(task.id.GetHashCode()),
                true, package.DisposalToken);

            // Transfer focus back to chat window, for the user to type a prompt.
            await ChatToolWindow.GetAndShowAsync(package);
        }

        private static ToolWindowWithFrame FindToolWindowForTask(string taskId)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            foreach (var openTaskWindow in GetAllOpenTaskToolWindows())
            {
                if (openTaskWindow.toolWindow.TaskId == taskId)
                {
                    return openTaskWindow;
                }
            }
            return null;
        }

        internal static async Task CloseAllTaskWindows()
        {
            await CamberAssistantPackage.GetInstance().JoinableTaskFactory.SwitchToMainThreadAsync();
            foreach (var window in GetAllOpenTaskToolWindows())
            {
                window.frame?.CloseFrame((uint)__FRAMECLOSE.FRAMECLOSE_NoSave);
            }
        }

        internal static async Task CloseTaskWindow(string taskId)
        {
            await CamberAssistantPackage.GetInstance().JoinableTaskFactory.SwitchToMainThreadAsync();
            GetAllOpenTaskToolWindows().FirstOrDefault(t => t.toolWindow.TaskId == taskId)?.frame?.CloseFrame((uint)__FRAMECLOSE.FRAMECLOSE_NoSave);
        }

        internal static bool HaveOpenTaskWindow()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            return GetAllOpenTaskToolWindows().Count > 0;
        }

        internal static void OpenTaskWindowDevTools()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            foreach (var window in GetAllOpenTaskToolWindows())
            {
                (window.toolWindow.Content as TasksWindowControl)?.OpenDevTools();
            }
        }

        private static List<ToolWindowWithFrame> GetAllOpenTaskToolWindows()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var found = new List<ToolWindowWithFrame>();
            foreach (var frame in Util.GetAllWindowFrames())
            {
                frame.GetGuidProperty((int)__VSFPROPID.VSFPROPID_GuidPersistenceSlot, out Guid frameGuid);
                if (frameGuid != new Guid(TasksToolWindowId))
                    continue;
                if (frame.GetProperty((int)__VSFPROPID.VSFPROPID_DocView, out object docView) == VSConstants.S_OK && docView is TasksToolWindow tasksToolWindow)
                {
                    found.Add(new ToolWindowWithFrame
                    {
                        frame = frame,
                        toolWindow = tasksToolWindow
                    });
                }
            }
            return found;
        }

        internal TasksWebViewCommunicator GetCommunicator()
        {
            return (this.Content as TasksWindowControl)?.Communicator as TasksWebViewCommunicator;
        }

        protected override void OnClose()
        {
            taskCommunicators.TryRemove(this.TaskId, out var _);
            (this.Content as TasksWindowControl)?.Dispose();
        }
    }
}
