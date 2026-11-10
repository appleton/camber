using Microsoft.VisualStudio.Shell;
using Camber.Assistant.ChatWindow;
using Camber.Assistant.Telemetry;
using System;
using System.Collections.Generic;
using System.ComponentModel.Design;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Commands
{
    internal abstract class BaseCamberCommand
    {
        /// <summary>
        /// VS Package that provides this command, not null.
        /// </summary>
        protected readonly AsyncPackage package;

        protected BaseCamberCommand(AsyncPackage package, OleMenuCommandService commandService, Guid commandSet, int commandId)
        {
            this.package = package ?? throw new ArgumentNullException(nameof(package));
            commandService = commandService ?? throw new ArgumentNullException(nameof(commandService));

            var menuCommandID = new CommandID(commandSet, commandId);
            var menuItem = new OleMenuCommand(this.Execute, menuCommandID);
            menuItem.BeforeQueryStatus += MenuItem_BeforeQueryStatus;
            commandService.AddCommand(menuItem);
        }

        private void MenuItem_BeforeQueryStatus(object sender, EventArgs e)
        {
            if (sender is OleMenuCommand menuCommand)
            {
                menuCommand.Visible = IsVisible();
            }
        }

        protected abstract bool IsVisible();

        protected abstract void Execute(object sender, EventArgs e);

        [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD100:Avoid async void methods", Justification = "API compatibility; has try/catch")]
        protected async void WithToolWindow(Action<ChatToolWindow> withWindow)
        {
            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var camberWindow = await ChatToolWindow.GetAndShowAsync(this.package);
                withWindow(camberWindow);
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }

        protected void FocusToolWindow()
        {
            WithToolWindow(window => {
                window.FocusBrowser();
                ChatWindowRPCClient.focusInput();
            });
        }
    }
}
