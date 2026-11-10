using Microsoft.VisualStudio.Shell;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Commands
{
    // Base for the Camber tools-menu commands. In the ACP world authentication happens in
    // the chat panel (the agent's terminal login), not in the host, so these commands are
    // always shown; invoking one when unauthenticated simply surfaces the login panel.
    // (Name kept to avoid churning the ~10 subclasses; it no longer implies a sign-in check.)
    internal abstract class BaseSignedInCamberCommand : BaseCamberToolsCommand
    {
        protected BaseSignedInCamberCommand(AsyncPackage package, OleMenuCommandService commandService, int commandId) : base(package, commandService, commandId)
        {
        }

        protected override bool IsVisible()
        {
            return true;
        }
    }
}
