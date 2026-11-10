using Microsoft.VisualStudio.Shell;
using Camber.Assistant.HelperLSP;
using System;
using System.Collections.Generic;
using System.ComponentModel.Design;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Commands
{
    internal class OpenPermissionSettingsCommand : BaseSignedInCamberCommand
    {
        public const int CommandId = 0x0140;

        private OpenPermissionSettingsCommand(AsyncPackage package, OleMenuCommandService commandService)
            : base(package, commandService, CommandId)
        {
        }

        public static OpenPermissionSettingsCommand Instance
        {
            get;
            private set;
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            OleMenuCommandService commandService = await package.GetServiceAsync((typeof(IMenuCommandService))) as OleMenuCommandService;
            Instance = new OpenPermissionSettingsCommand(package, commandService);
        }

        [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD100:Avoid async void methods", Justification = "API compatibility; has try/catch")]
        protected async override void Execute(object sender, EventArgs e)
        {
            try
            {
                var runtimeFilesInfo = await HelperLSPService.Instance.GetRuntimeFiles();
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                foreach (var file in runtimeFilesInfo.Files)
                {
                    if (file.FileExists)
                        Util.OpenFileInEditor(file.Path);
                    else
                        Util.OpenEphemeralFile(file.Path, file.Placeholder);
                }
            }
            catch (Exception ex)
            {
                await Util.ShowInfoMessageAsync("Could not open permission settings file: " + ex.Message, "error");
            }
        }
    }
}
