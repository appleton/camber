using Camber.Assistant.Context.Prompt;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Context
{
    internal static class PromptContextBuilder
    {
        private static readonly List<IPromptContextProvider> providers = new List<IPromptContextProvider>
        {
            new DependenciesContextProvider(),
            new DiagnosticsContextProvider(),
            new ReadmePromptContextProvider(),
            new GitBranchContextProvider(),
            new GitRecentCommitsContextProvider(),
            new GitDiffContextProvider()
        };

        internal static List<string> GetAvailableEnrichments()
        {
            return providers.Select(p => p.GetEnrichedContextSource()).Distinct().ToList();
        }

        internal static async Task<List<PromptContextFacet>> GetContextAsync(List<string> sources, bool isNewConversation)
        {
            var result = new List<PromptContextFacet>();
            foreach (var provider in providers)
            {
                if (sources.Contains(provider.GetEnrichedContextSource()))
                {
                    var facet = await provider.ProvideContextAsync(isNewConversation);
                    if (facet != null)
                        result.Add(facet);
                }
            }
            return result;
        }
    }
}
