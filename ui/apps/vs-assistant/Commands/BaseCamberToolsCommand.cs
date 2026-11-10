using Microsoft.VisualStudio.Shell;
using Camber.Assistant.ChatWindow;
using System;
using System.Collections.Generic;
using System.ComponentModel.Design;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Commands
{
    internal abstract class BaseCamberToolsCommand : BaseCamberCommand
    {
        /// <summary>
        /// Command menu group (command set GUID).
        /// </summary>
        public static readonly Guid CommandSet = new Guid("08c5ffe7-6ce9-4f03-afc5-39cf2c5cba53");

        protected BaseCamberToolsCommand(AsyncPackage package, OleMenuCommandService commandService, int commandId)
            : base(package, commandService, CommandSet, commandId)
        {
        }
    }
}
