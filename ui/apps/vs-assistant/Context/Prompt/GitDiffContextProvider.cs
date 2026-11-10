using Camber.Assistant.Context.Prompt;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Camber.Assistant.Context
{
    internal class GitDiffContextProvider : GitBasedContextProvider
    {
        public override PromptContextFacet buildContextFacet(List<ContextItem> items)
        {
            return new PromptContextFacet
            {
                description = "Current uncommitted changes, showing what work is currently in progress",
                items = items,
                kind = "uncommitted_changes",
                mime_type = "text/x-diff",
                source = GetEnrichedContextSource()
            };
        }

        public override List<ContextItem> buildContextItem(string output)
        {
            return new List<ContextItem>()
            {
                new ContextItem {
                    content = output,
                    path = null
                }
            };
        }

        public override Task<string> getCommandArgumentsAsync(string directory)
        {
            return Task.FromResult("diff");
        }

        public override string GetEnrichedContextSource()
        {
            return "uncommitted_changes";
        }
    }
}
