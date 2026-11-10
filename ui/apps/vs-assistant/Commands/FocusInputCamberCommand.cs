using Microsoft.VisualStudio.Shell;
using Camber.Assistant.ChatWindow;
using System.ComponentModel.Design;
using System.Threading.Tasks;
using System;

namespace Camber.Assistant.Commands
{
    /// <summary>
    ///  Command handler
    /// </summary>
    internal class FocusInputCamberCommand : BaseSignedInCamberCommand
    {
        public const int CommandId = 0x0106;

        private FocusInputCamberCommand(AsyncPackage package, OleMenuCommandService commandService)
            : base(package, commandService, CommandId)
        {
        }

        public static FocusInputCamberCommand Instance
        {
            get;
            private set;
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            OleMenuCommandService commandService = await package.GetServiceAsync((typeof(IMenuCommandService))) as OleMenuCommandService;
            Instance = new FocusInputCamberCommand(package, commandService);
        }

        protected override void Execute(object sender, EventArgs e)
        {
            FocusToolWindow();
        }
    }
}
