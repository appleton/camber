using System.Collections.Generic;
using System.ComponentModel.Composition;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Text.Tagging;
using Microsoft.VisualStudio.Utilities;

namespace Camber.Assistant.EditHighlights
{
    [Export(typeof(IWpfTextViewCreationListener))]
    [ContentType("text")]
    [TextViewRole(PredefinedTextViewRoles.Document)]
    internal class EditHighlightsAdornmentFactory : IWpfTextViewCreationListener
    {
        // Register the adornment layer.
        [Export(typeof(AdornmentLayerDefinition))]
        [Name("CamberEditHighlightLayer")]
        [Order(Before = PredefinedAdornmentLayers.Selection, After = PredefinedAdornmentLayers.TextMarker)]
        private AdornmentLayerDefinition editHighlightsAdornmentLayer;

        [Import]
        internal IViewTagAggregatorFactoryService TagAggregatorFactory = null;

        public void TextViewCreated(IWpfTextView textView)
        {
            // Create the adornment layer to render the highlights.
            var tagAggregator = TagAggregatorFactory.CreateTagAggregator<EditHighlightsTag>(textView);
            new EditHighlightsAdornment(textView, tagAggregator);

            // Make sure we clear highlights on edit.
            textView.TextBuffer.Changed += (sender, args) => EditHighlightsTaggerProvider.ClearEditHighlights();
        }
    }
}
