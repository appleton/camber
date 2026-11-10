using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Camber.Assistant.ChatWindow
{
    [Guid("1EF23B54-595F-4DEC-A664-C217CB051CB9")]
    public class RawPromptToolWindow : ToolWindowPane
    {
        public RawPromptToolWindow() : base(null)
        {
            this.Caption = "Raw Prompt";
            this.Content = new RawPromptToolWindowControl();
        }

        public static async Task ShowRawPromptToolWindowAsync(string raw)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var package = CamberAssistantPackage.GetInstance();
            var window = await package.FindToolWindowAsync(typeof(RawPromptToolWindow), Math.Abs(raw.GetHashCode()), true, CancellationToken.None);
            if ((null == window) || (null == window.Frame))
            {
                throw new NotSupportedException("Cannot create tool window");
            }
            var control = (RawPromptToolWindowControl)((RawPromptToolWindow)window).Content;
            control.SetContent(raw);
            var windowFrame = (IVsWindowFrame)window.Frame;
            ErrorHandler.ThrowOnFailure(windowFrame.Show());
        }
    }
}
