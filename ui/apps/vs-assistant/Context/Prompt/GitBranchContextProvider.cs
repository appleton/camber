using System.Collections.Generic;
using System.Threading.Tasks;
using Camber.Assistant.Context.Prompt;

namespace Camber.Assistant.Context
{
    internal class GitBranchContextProvider : GitBasedContextProvider
    {
        public override string GetEnrichedContextSource()
        {
            return "branch";
        }

        public override Task<string> getCommandArgumentsAsync(string directory)
        {
            return Task.FromResult("rev-parse --abbrev-ref HEAD");
        }
        public override List<ContextItem> buildContextItem(string output)
        {
            return new List<ContextItem>
            {
                new ContextItem
                {
                    path = null,
                    content = output
                }
            };
        }

        public override PromptContextFacet buildContextFacet(List<ContextItem> items)
        {
            return new PromptContextFacet
            {
                description = "Git branch name",
                items = items,
                kind = "branch_name",
                mime_type = "text/plain",
                source = GetEnrichedContextSource()
            };
        }
    }
}
