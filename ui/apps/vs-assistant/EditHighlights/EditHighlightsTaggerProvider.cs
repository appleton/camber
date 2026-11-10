using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Differencing;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Text.Tagging;
using Microsoft.VisualStudio.Utilities;
using Camber.Assistant.Context;
using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.EditHighlights
{
    [Export(typeof(IViewTaggerProvider))]
    [ContentType("text")]
    [TagType(typeof(EditHighlightsTag))]
    public class EditHighlightsTaggerProvider : IViewTaggerProvider
    {
        /* Keep track of the taggers for open editors, so that we can update the highlights in them.
         * Using a weak table means we won't leak their memory. */
        private static WeakKeyDictionary<ITextBuffer, EditHighlightsTagger> taggers = new WeakKeyDictionary<ITextBuffer, EditHighlightsTagger>();

        public ITagger<T> CreateTagger<T>(ITextView textView, ITextBuffer buffer) where T : ITag
        {
            var tagger = new EditHighlightsTagger(buffer);
            taggers.Add(buffer, tagger);
            return tagger as ITagger<T>;
        }

        // Retain previous highlights keyed on workspace path (path so we don't leak workspace objects)
        // in support of cumulative updates.
        private static List<EditHighlightsInput> previousHighlights;
        private static string previousHighlightsWorkspacePath;

        /* Shows highlights for the given edits, and clears any others. (This means that clearing all
         * edit highlights is achieved by passing in an empty list.) */
        internal static void ApplyEditHighlights(List<EditHighlightsInput> highlightsInput, ICamberWorkspace workspace)
        {
            ApplyEditHighlightsInternal(highlightsInput);

            previousHighlights = highlightsInput;
            previousHighlightsWorkspacePath = workspace.RootPath;
        }

        internal static void ClearEditHighlights()
        {
            ApplyEditHighlightsInternal(new List<EditHighlightsInput>());
        }

        private static void ApplyEditHighlightsInternal(List<EditHighlightsInput> highlightsInput)
        {
            var componentModel = (IComponentModel)CamberAssistantPackage.GetGlobalService(typeof(SComponentModel));
            var diffService = componentModel.GetService<ITextDifferencingSelectorService>().DefaultTextDifferencingService;

            foreach (var entry in taggers.GetLiveEntries())
            {
                // Extract the file path.
                var buffer = entry.Key;
                buffer.Properties.TryGetProperty(typeof(ITextDocument), out ITextDocument textDocument);
                var path = textDocument?.FilePath;
                if (path == null)
                    continue;

                // See if we have highlights for this path.
                var pathHighlights = highlightsInput.FirstOrDefault(hi => hi.Path.Equals(path, StringComparison.OrdinalIgnoreCase));
                if (pathHighlights != null)
                {
                    entry.Value.SetDiff(diffService.DiffStrings(pathHighlights.Before, pathHighlights.After, new StringDifferenceOptions()
                    {
                        DifferenceType = StringDifferenceTypes.Line,
                        IgnoreTrimWhiteSpace = false
                    }));
                }
                else
                {
                    // Should not show a diff for this file.
                    entry.Value.SetDiff(null);
                }
            }
        }

        internal static IEnumerable<EditHighlightsInput> GetPreviousHighlights(ICamberWorkspace workspace)
        {
            return previousHighlights != null && previousHighlightsWorkspacePath == workspace.RootPath
                ? previousHighlights
                : Enumerable.Empty<EditHighlightsInput>();
        }
    }
}
