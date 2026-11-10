using Microsoft.VisualStudio.Shell;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Context.Prompt
{
    internal class ReadmePromptContextProvider : IPromptContextProvider
    {
        private static readonly string[] readmeFileNames = new string[] { "README.md", "README.markdown", "README.txt" };

        public string GetEnrichedContextSource()
        {
            return "readmes";
        }

        public async Task<PromptContextFacet> ProvideContextAsync(bool isNewConversation)
        {
            // Use current open documents as the basis for finding relevant READMEs.
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var dte = (EnvDTE.DTE)await CamberAssistantPackage.GetInstance().GetServiceAsync(typeof(EnvDTE.DTE));
            var root = Path.GetDirectoryName(dte.Solution.FullName);
            var possibleReadmes = new List<string>();
            foreach (EnvDTE.Document doc in dte.Documents)
            {
                if (string.IsNullOrEmpty(doc.FullName))
                    continue;
                var path = Path.GetDirectoryName(doc.FullName);
                while (path != null && path != root)
                {
                    foreach (var name in readmeFileNames)
                    {
                        var possibleReadme = Path.Combine(path, name);
                        if (File.Exists(possibleReadme))
                            possibleReadmes.Add(possibleReadme);
                    }
                    path = Path.GetDirectoryName(path);
                }
            }

            // If we didn't find any, try in the solutino root.
            if (possibleReadmes.Count == 0)
            {
                foreach (var name in readmeFileNames)
                {
                    var possibleReadme = Path.Combine(root, name);
                    if (File.Exists(possibleReadme))
                        possibleReadmes.Add(possibleReadme);
                }
            }

            // Read in all distinct found readmes.
            var contextItems = new List<ContextItem>();
            foreach (var readmePath in possibleReadmes.Distinct())
            {
                try
                {
                    contextItems.Add(new ContextItem
                    {
                        path = readmePath,
                        content = File.ReadAllText(readmePath)
                    });
                }
                catch (IOException)
                {
                    // Disregard, maybe file got deleted in the meantime or some such.
                }
            }

            // Produce context, so long as we have some context items.
            return contextItems.Count > 0
                ? new PromptContextFacet
                {
                    source = GetEnrichedContextSource(),
                    description = "README file containing general information about the system",
                    kind = "readmes",
                    mime_type = "text/markdown",
                    items = contextItems
                }
                : null;
        }
    }
}
