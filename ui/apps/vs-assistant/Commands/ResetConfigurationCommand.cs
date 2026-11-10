using Microsoft.VisualStudio.Shell;
using Camber.Assistant.Telemetry;
using System;
using System.ComponentModel.Design;
using System.Threading.Tasks;
using System.Windows;

namespace Camber.Assistant.Commands
{
    /// <summary>
    /// Resets all Camber Assistant settings to their defaults. Mirrors VS Code's
    /// camber.resetConfiguration command. Unlike VS Code it first asks for confirmation,
    /// since here it is a destructive, non-undoable menu action.
    /// </summary>
    internal class ResetConfigurationCommand : BaseSignedInCamberCommand
    {
        public const int CommandId = 0x0170;

        private ResetConfigurationCommand(AsyncPackage package, OleMenuCommandService commandService)
            : base(package, commandService, CommandId)
        {
        }

        public static ResetConfigurationCommand Instance
        {
            get;
            private set;
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            OleMenuCommandService commandService = await package.GetServiceAsync((typeof(IMenuCommandService))) as OleMenuCommandService;
            Instance = new ResetConfigurationCommand(package, commandService);
        }

        protected override void Execute(object sender, EventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                var confirm = MessageBox.Show(
                    "Reset all Camber Assistant settings to their defaults?",
                    "Camber Assistant",
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning);
                if (confirm != MessageBoxResult.Yes)
                    return;

                var settings = CamberAssistantPackage.GetInstance()?.GetSettings();
                if (settings == null)
                    return;

                settings.ResetToDefaults();
                settings.SaveSettingsToStorage();
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }
    }
}
