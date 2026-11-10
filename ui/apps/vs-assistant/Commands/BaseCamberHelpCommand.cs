using Microsoft.VisualStudio.Shell;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Commands
{
    internal abstract class BaseCamberHelpCommand : BaseCamberCommand
    {
        /// <summary>
        /// Command menu group (command set GUID).
        /// </summary>
        public static readonly Guid CommandSet = new Guid("2858B5DD-FD1D-4586-BEFA-FD8F778FA463");

        protected BaseCamberHelpCommand(AsyncPackage package, OleMenuCommandService commandService, int commandId)
            : base(package, commandService, CommandSet, commandId)
        {
        }
    }
}
