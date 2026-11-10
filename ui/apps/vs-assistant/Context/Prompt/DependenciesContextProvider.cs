using Microsoft.VisualStudio.Shell;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Xml.Linq;

namespace Camber.Assistant.Context.Prompt
{
    internal class DependenciesContextProvider : IPromptContextProvider
    {
        public string GetEnrichedContextSource()
        {
            return "dependencies";
        }

        public async Task<PromptContextFacet> ProvideContextAsync(bool isNewConversation)
        {
            // We'll find the dependencies of the project of the active document; if there's no active
            // document, don't continue.
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var dte = (EnvDTE.DTE)await CamberAssistantPackage.GetInstance().GetServiceAsync(typeof(EnvDTE.DTE));
            var activeDocument = dte.ActiveDocument;
            if (activeDocument == null)
                return null;

            // Find the project, and try to load it as an XML file.
            var project = activeDocument.ProjectItem?.ContainingProject;
            if (project == null)
                return null;
            XDocument projectFile;
            try
            {
                projectFile = XDocument.Load(project.FullName);
            }
            catch
            {
                // Either doesn't exist or is invalid XML; we can't do much about either.
                return null;
            }

            // Extract the elements of interest.
            var itemGroups = projectFile.Root.Elements().Where(e => e.Name.LocalName == "ItemGroup").ToList();
            var packageReferences = itemGroups.Elements()
                .Where(e => e.Name.LocalName == "PackageReference")
                .Select(pr => new
                {
                    PackageId = pr.Attribute("Include")?.Value,
                    Version = pr.Attribute("Version")?.Value
                })
                .Where(pr => !string.IsNullOrEmpty(pr.PackageId) && !string.IsNullOrEmpty(pr.Version))
                .ToList();
            var assemblyReferences = itemGroups.Elements()
                .Where(e => e.Name.LocalName == "Reference")
                .Select(r => r.Attribute("Include")?.Value)
                .Where(r => !string.IsNullOrEmpty(r))
                .ToList();
            if (packageReferences.Count == 0 && assemblyReferences.Count == 0)
                return null;

            // Turn it back into XML for feeding to the model.
            var packageReferenceXml = string.Join("\n", packageReferences.Select(pr =>
                $"<PackageReference Include=\"{pr.PackageId}\" Version=\"{pr.Version}\" />"));
            var assemblyReferenceXml = string.Join("\n", assemblyReferences.Select(r =>
                $"<Reference Include=\"{r}\" />"));
            return new PromptContextFacet
            {
                kind = "dependencies",
                mime_type = "text/xml",
                source = GetEnrichedContextSource(),
                description = "This is an extract of the dependencies from the project file.",
                items = new List<ContextItem>
                {
                    new ContextItem
                    {
                        content = $"<Project>\n{packageReferenceXml}\n{assemblyReferenceXml}\n</Project>",
                        path = project.FullName
                    }
                }
            };
        }
    }
}
