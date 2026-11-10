using Microsoft.VisualStudio.OLE.Interop;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Context.Prompt
{
    public class PromptContextFacet
    {
        public string description { get; set; }
        public List<ContextItem> items { get; set; }
        public string kind { get; set; }
        public string mime_type { get; set; }
        public string source { get; set; }
    }

    public class ContextItem
    {
        public string content { get; set; }
        public string path { get; set; }
    }
}
