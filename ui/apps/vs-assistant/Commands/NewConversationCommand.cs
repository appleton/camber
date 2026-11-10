using System;
using System.ComponentModel.Design;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;
using Camber.Assistant.ChatWindow;
using Camber.Assistant.Telemetry;

namespace Camber.Assistant.Commands
{
    /// <summary>
    ///  Command handler
    /// </summary>
    internal class NewConversationCommand : BaseSignedInCamberCommand
    {
        public const int CommandId = 0x0101;

        private NewConversationCommand(AsyncPackage package, OleMenuCommandService commandService)
            : base(package, commandService, CommandId)
        {
        }

        public static NewConversationCommand Instance
        {
            get;
            private set;
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            OleMenuCommandService commandService = await package.GetServiceAsync((typeof(IMenuCommandService))) as OleMenuCommandService;
            Instance = new NewConversationCommand(package, commandService);
        }

        protected override void Execute(object sender, EventArgs e)
        {
            // Mirror VS Code's openNewConversation -> acpChatPanels.openSession({}):
            // open a fresh chat window host-side. The webview's newConversation handler
            // only focuses the prompt in split-host (acp-sidebar) mode, so it never
            // opens a new conversation; go straight to the host instead.
            _ = OpenNewConversationAsync();
        }

        private static async Task OpenNewConversationAsync()
        {
            try
            {
                // OpenSessionAsync switches to the main thread itself; empty options
                // produce a new "pending" conversation in its own window.
                await AcpChatToolWindow.OpenSessionAsync(new OpenAcpChatOptions());
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }
    }
}
