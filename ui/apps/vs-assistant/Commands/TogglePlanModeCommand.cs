using Microsoft.VisualStudio.Shell;
using Camber.Assistant.ChatWindow;
using System.ComponentModel.Design;
using System.Threading.Tasks;
using System;

namespace Camber.Assistant.Commands
{
    internal class TogglePlanModeCommand : BaseSignedInCamberCommand
    {
        public const int CommandId = 0x0150;

        private TogglePlanModeCommand(AsyncPackage package, OleMenuCommandService commandService)
            : base(package, commandService, CommandId)
        {
        }

        public static TogglePlanModeCommand Instance
        {
            get;
            private set;
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            OleMenuCommandService commandService = await package.GetServiceAsync((typeof(IMenuCommandService))) as OleMenuCommandService;
            Instance = new TogglePlanModeCommand(package, commandService);
        }

        protected override void Execute(object sender, EventArgs e)
        {
            // The chord is bound globally, so only act while a Camber webview has focus;
            // otherwise it would toggle plan mode while the user is typing in the editor.
            if (!AcpChatToolWindow.AnyWebViewHasFocus() && !ChatToolWindow.WebViewHasFocus)
                return;
            // Plan mode lives in the per-conversation chat webview, so route the toggle
            // there. No sidebar fallback: a split host's sidebar never has a local
            // session, so its togglePlanMode handler is a no-op.
            AcpChatToolWindow.TogglePlanModeOnActiveWindow();
        }
    }
}
