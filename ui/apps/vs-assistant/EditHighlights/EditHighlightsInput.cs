using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.EditHighlights
{
    internal class EditHighlightsInput
    {
        public string Path { get; set; }
        public string Before { get; set; }
        public string After { get; set; }

        public EditHighlightsInput WithNewAfter(string after) => new EditHighlightsInput { Path = Path, Before = Before, After = after };
    }
}
