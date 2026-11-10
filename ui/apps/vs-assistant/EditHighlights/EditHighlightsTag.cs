using Microsoft.VisualStudio.Text.Tagging;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.EditHighlights
{
    internal class EditHighlightsTag : TextMarkerTag
    {
        public bool IsCharacterHighlight { get; private set; }

        public EditHighlightsTag(bool isCharacterHighlight) : base("camber.editHighlight")
        {
            this.IsCharacterHighlight = isCharacterHighlight;
        }
    }
}
