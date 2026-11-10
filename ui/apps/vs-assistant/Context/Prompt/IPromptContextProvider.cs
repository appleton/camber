using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Documents;

namespace Camber.Assistant.Context.Prompt
{
    internal interface IPromptContextProvider
    {
        string GetEnrichedContextSource();
        Task<PromptContextFacet> ProvideContextAsync(bool isNewConversation);
    }
}
