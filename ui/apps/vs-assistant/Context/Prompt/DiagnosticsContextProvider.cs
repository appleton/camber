using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Adornments;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Text.Tagging;
using Microsoft.VisualStudio.TextManager.Interop;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Context.Prompt
{
    internal class DiagnosticsContextProvider : IPromptContextProvider
    {
        public string GetEnrichedContextSource()
        {
            return "diagnostics";
        }

        public async Task<PromptContextFacet> ProvideContextAsync(bool isNewConversation)
        {
            // Ensure we have an active text view to get diagnostics from.
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var activeTextView = GetCurrentTextView();
            if (activeTextView == null)
                return null;

            // Create a tag aggregator, to obtain tags.
            var componentModel = CamberAssistantPackage.GetGlobalService(typeof(SComponentModel)) as IComponentModel;
            var tagAggregatorFactoryService = componentModel?.GetService<IViewTagAggregatorFactoryService>();
            if (tagAggregatorFactoryService == null)
                return null;
            var aggregator = tagAggregatorFactoryService.CreateTagAggregator<IErrorTag>(activeTextView);

            // Collect tags of interest, extracting their messages. We filter out short messages as these tend
            // to be compiler error numbers and then are repeated in a more explanatory textual form; having
            // them twice tends to result in output where the model suggests fixing them twice.
            var diagnostics = new List<string>();
            var snapshot = activeTextView.TextBuffer.CurrentSnapshot;
            var entireBufferSpan = new SnapshotSpan(snapshot, 0, snapshot.Length);
            foreach (var tagSpan in aggregator.GetTags(new NormalizedSnapshotSpanCollection(entireBufferSpan)))
            {
                foreach (var span in tagSpan.Span.GetSpans(activeTextView.TextBuffer))
                {
                    var tag = tagSpan.Tag;
                    if (tag == null)
                        continue;
                    if (tag.ToolTipContent is ContainerElement contentContainer)
                        foreach (var element in contentContainer.Elements)
                            if (element is ClassifiedTextElement classifiedElement)
                                foreach (var run in classifiedElement.Runs)
                                    if (run.ClassificationTypeName == "text" && !string.IsNullOrWhiteSpace(run.Text) && run.Text.Length >= 10)
                                        diagnostics.Add($"{tag.ErrorType} at line {span.Start.GetContainingLine().LineNumber + 1}: {run.Text}");
                }
            }

            // If we found anything, build context facet.
            return diagnostics.Count > 0
                ? new PromptContextFacet
                {
                    source = GetEnrichedContextSource(),
                    description = "## Diagnostics\nThis is a list of diagnostics from my editor, indicating errors or warnings about the code",
                    kind = "diagnostics",
                    mime_type = "text/plain",
                    items = diagnostics.Select(diagnostic => new ContextItem { content = diagnostic }).ToList()
                }
                : null;
        }

        public IWpfTextView GetCurrentTextView()
        {
            if (!(CamberAssistantPackage.GetGlobalService(typeof(SVsTextManager)) is IVsTextManager textManager))
                return null;
            textManager.GetActiveView(1, null, out IVsTextView currentTextView);
            if (currentTextView == null)
                return null;
            var componentModel = CamberAssistantPackage.GetGlobalService(typeof(SComponentModel)) as IComponentModel;
            var editorAdaptersFactoryService = componentModel?.GetService<IVsEditorAdaptersFactoryService>();
            return editorAdaptersFactoryService?.GetWpfTextView(currentTextView);
        }
    }
}
