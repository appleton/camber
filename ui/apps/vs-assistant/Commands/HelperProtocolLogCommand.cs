using Microsoft.VisualStudio.Shell;
using Camber.Assistant.HelperLSP;
using System;
using System.Collections.Generic;
using System.ComponentModel.Design;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;

namespace Camber.Assistant.Commands
{
    internal class HelperProtocolLogCommand : BaseCamberHelpCommand
    {
        public const int CommandId = 0x0130;

        private HelperProtocolLogCommand(AsyncPackage package, OleMenuCommandService commandService)
            : base(package, commandService, CommandId)
        {
        }

        public static HelperProtocolLogCommand Instance
        {
            get;
            private set;
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            OleMenuCommandService commandService = await package.GetServiceAsync((typeof(IMenuCommandService))) as OleMenuCommandService;
            Instance = new HelperProtocolLogCommand(package, commandService);
        }

        protected override bool IsVisible()
        {
            return true;
        }

        protected override void Execute(object sender, EventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dataObject = new DataObject();
            dataObject.SetData(DataFormats.Text, HelperLSPService.Instance.GetProtocolLog());
            Clipboard.SetDataObject(dataObject, true);
        }
    }
}
