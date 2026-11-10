using Microsoft.VisualStudio.Shell;
using System;
using System.Collections.Generic;
using System.ComponentModel.Design;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Commands
{
    internal class OpenAssistantDevToolsCommand : BaseCamberHelpCommand
    {
        public const int CommandId = 0x0100;

        private OpenAssistantDevToolsCommand(AsyncPackage package, OleMenuCommandService commandService)
            : base(package, commandService, CommandId)
        {
        }

        public static OpenAssistantDevToolsCommand Instance
        {
            get;
            private set;
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            OleMenuCommandService commandService = await package.GetServiceAsync((typeof(IMenuCommandService))) as OleMenuCommandService;
            Instance = new OpenAssistantDevToolsCommand(package, commandService);
        }

        protected override bool IsVisible()
        {
            return true;
        }

        protected override void Execute(object sender, EventArgs e)
        {
            WithToolWindow(window => window.OpenDevTools());
        }
    }
}
