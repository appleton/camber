using Microsoft.VisualStudio.OLE.Interop;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Settings
{
    public class WebViewConfiguration
    {
        public string uri { get; set; }
        public bool wrapLines { get; set; }
        public bool notifyOnApproval { get; set; }
        public bool showMermaidDiagrams { get; set; }
        // How much of the agent's activity to show while it works: "detailed", "grouped",
        // or "compact". A stored string (not an enum) so future modes are new values, not a
        // settings migration; the webview falls back to "grouped" for anything else.
        public string toolActivity { get; set; }
    }
}
