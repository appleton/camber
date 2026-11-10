using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Forms;
using System.Windows.Media;
using System.Windows.Shapes;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Text.Formatting;
using Microsoft.VisualStudio.Text.Tagging;
using Camber.Assistant.WebViewInfrastructure;

namespace Camber.Assistant.EditHighlights
{
    internal class EditHighlightsAdornment
    {
        private readonly IWpfTextView view;
        private readonly IAdornmentLayer adornmentLayer;
        private readonly Brush lineHighlightBrush;
        private readonly Brush wordHighlightBrush;
        private readonly ITagAggregator<EditHighlightsTag> tagAggregator;

        internal EditHighlightsAdornment(IWpfTextView view, ITagAggregator<EditHighlightsTag> tagAggregator)
        {
            this.view = view ?? throw new ArgumentNullException(nameof(view));
            this.tagAggregator = tagAggregator ?? throw new ArgumentNullException(nameof(tagAggregator));
            adornmentLayer = view.GetAdornmentLayer("CamberEditHighlightLayer");

            // Create the brush for highlighting
            ThreadHelper.ThrowIfNotOnUIThread();
            var baseColor = WebViewTheme.GetEditorColors(WebViewTheme.IsDark()).diffInsert;
            lineHighlightBrush = new SolidColorBrush(baseColor.ToWindowsMediaColor());
            lineHighlightBrush.Freeze();
            wordHighlightBrush = new SolidColorBrush(ControlPaint.Light(baseColor, 0.2f).ToWindowsMediaColor());
            wordHighlightBrush.Freeze();

            // Subscribe to layout and tag changes
            this.view.LayoutChanged += OnLayoutChanged;
            this.tagAggregator.TagsChanged += OnTagsChanged;
        }

        private void OnTagsChanged(object sender, TagsChangedEventArgs e)
        {
            view.VisualElement.Dispatcher.Invoke(() =>
            {
                adornmentLayer.RemoveAllAdornments(); // Clear existing highlights
                foreach (var line in view.TextViewLines)
                {
                    HighlightLineIfTagged(line);
                }
            });
        }

        private void OnLayoutChanged(object sender, TextViewLayoutChangedEventArgs e)
        {
            adornmentLayer.RemoveAllAdornments(); // Clear existing highlights
            foreach (var line in view.TextViewLines)
            {
                HighlightLineIfTagged(line);
            }
        }

        private void HighlightLineIfTagged(ITextViewLine line)
        {
            // Check if any tag spans cover this line
            var snapshotSpan = line.Extent;
            foreach (var tagSpan in tagAggregator.GetTags(snapshotSpan).OrderBy(t => t.Tag.IsCharacterHighlight))
            {
                if (tagSpan.Tag.IsCharacterHighlight)
                    HighlightChars(line, tagSpan.Span);
                else
                    HighlightLine(line);
            }
        }

        private void HighlightLine(ITextViewLine line)
        {
            // Create a rectangle that spans the entire width of the viewport
            var rect = new Rectangle
            {
                Fill = lineHighlightBrush,
                Width = view.ViewportWidth,
                Height = (line.Bottom - line.Top) + 1
            };

            // Position it behind the text
            Canvas.SetLeft(rect, 0);
            Canvas.SetTop(rect, line.Top);

            // Add it to the adornment layer
            adornmentLayer.AddAdornment(AdornmentPositioningBehavior.TextRelative, line.Extent, null, rect, null);
        }

        private void HighlightChars(ITextViewLine line, IMappingSpan span)
        {
            // Work out the character bounds.
            var startPoint = span.Start.GetPoint(span.Start.AnchorBuffer, PositionAffinity.Predecessor);
            var endPoint = span.End.GetPoint(span.End.AnchorBuffer, PositionAffinity.Predecessor);
            if (startPoint == null || endPoint == null)
                return;
            var startBounds = line.GetCharacterBounds(startPoint.Value);
            var endBounds = line.GetCharacterBounds(endPoint.Value);

            // Create a rectangle that spans the changed text.
            var rect = new Rectangle
            {
                Fill = wordHighlightBrush,
                Width = endBounds.Right - startBounds.Left,
                Height = (line.TextBottom - line.TextTop) + 1
            };

            // Position it behind the text
            Canvas.SetLeft(rect, startBounds.Left);
            Canvas.SetTop(rect, line.TextTop);

            // Add it to the adornment layer
            adornmentLayer.AddAdornment(AdornmentPositioningBehavior.TextRelative, line.Extent, null, rect, null);
        }
    }
}
