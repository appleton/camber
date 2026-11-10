using AngleSharp.Text;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Differencing;
using Microsoft.VisualStudio.Text.Tagging;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Documents;
using System.Windows.Media.Animation;

namespace Camber.Assistant.EditHighlights
{
    internal class EditHighlightsTagger : ITagger<EditHighlightsTag>
    {
        private readonly ITextBuffer buffer;
        private List<TagSpan<EditHighlightsTag>> highlights;

        internal EditHighlightsTagger(ITextBuffer buffer)
        {
            this.buffer = buffer;
            this.highlights = new List<TagSpan<EditHighlightsTag>>();
        }

        public IEnumerable<ITagSpan<EditHighlightsTag>> GetTags(NormalizedSnapshotSpanCollection spans)
        {
            return highlights;
        }

        internal void SetDiff(IHierarchicalDifferenceCollection diff)
        {
            var highlights = new List<TagSpan<EditHighlightsTag>>();
            if (diff != null)
            {
                // Go over the line level differences.
                var snapshot = this.buffer.CurrentSnapshot;
                var lines = snapshot.Lines;
                int hunkIndex = 0;
                foreach (var difference in diff)
                {
                    if (!difference.Right.IsEmpty &&
                        (difference.DifferenceType == DifferenceType.Add || difference.DifferenceType == DifferenceType.Change))
                    {
                        var startLine = lines.ElementAtOrDefault(difference.Right.Start);
                        var endLine = lines.ElementAtOrDefault(difference.Right.End - 1);
                        if (startLine != null && endLine != null)
                        {
                            // Add a snapshot span that highlights the whole lines.
                            var lineSpan = new SnapshotSpan(startLine.Start, endLine.End);
                            highlights.Add(new TagSpan<EditHighlightsTag>(lineSpan, new EditHighlightsTag(false)));
                            // TODO In the future, also add intra-line highlights when there are line level differences.
                            // This was attempted by asking for a IHierarchicalDifferenceCollection with both, but it
                            // turns out that it doesn't only look for differences within individual lines, so gets some
                            // very strange results that look stupid. Instead we'd need to get the line diff and then
                            // process those, it seems. The plumbing to show such things (pass `true` to the constructor
                            // of EditHighlightsTab) is there.
                        }
                    }
                    hunkIndex++;
                }
            }
            this.highlights = highlights;
            this.TagsChanged?.Invoke(this, new SnapshotSpanEventArgs(new SnapshotSpan(buffer.CurrentSnapshot, 0, buffer.CurrentSnapshot.Length)));
        }

        public event EventHandler<SnapshotSpanEventArgs> TagsChanged;
    }
}
