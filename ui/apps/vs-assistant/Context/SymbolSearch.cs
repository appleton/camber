using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio.Shell;
using Camber.Assistant.HelperLSP;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Microsoft.VisualStudio.LanguageServices;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis;
using OmniSharp.Extensions.LanguageServer.Protocol;

namespace Camber.Assistant.Context
{
    internal static class SymbolSearch
    {
        internal static async Task<List<SymbolDefinition>> SearchSymbolsAsync(string symbolName, string requiredType)
        {
            await CamberAssistantPackage.GetInstance().JoinableTaskFactory.SwitchToMainThreadAsync();
            var found = new List<SymbolDefinition>();

            // Try to do a Roslyn-based symbol search if available.
            var componentModel = (IComponentModel)Package.GetGlobalService(typeof(SComponentModel));
            var workspace = componentModel?.GetService<VisualStudioWorkspace>();
            var solution = workspace?.CurrentSolution;
            if (solution != null)
            {
                var results = await SymbolFinder.FindSourceDeclarationsAsync(solution, symbolName, ignoreCase: true);
                foreach (var result in results)
                {
                    var type = GetSymbolTypeString(result);
                    if (type != null && (requiredType == null || requiredType == "all" || requiredType == type))
                    {
                        // If it's a partial class it may have multiple locations, so we include it for all of them.
                        foreach (var location in result.Locations)
                        {
                            if (location?.IsInSource == true)
                            {
                                var syntaxTree = location.SourceTree;
                                var sourceText = await syntaxTree.GetTextAsync();
                                var lineSpan = sourceText.Lines.GetLinePositionSpan(location.SourceSpan);
                                var path = location.SourceTree?.FilePath;
                                found.Add(new SymbolDefinition
                                {
                                    Name = result.Name,
                                    Type = type,
                                    Path = DocumentUri.FromFileSystemPath(path).ToString(),
                                    StartLine = lineSpan.Start.Line + 1,
                                    StartCol = lineSpan.Start.Character,
                                    EndLine = lineSpan.End.Line + 1,
                                    EndCol = lineSpan.End.Character,
                                    StartOffset = location.SourceSpan.Start,
                                    EndOffset = location.SourceSpan.End,
                                    Signature = result.Name,
                                    Body = "",
                                    Comment = "",
                                    Receiver = "",
                                    Async = result is IMethodSymbol method && method.IsAsync,
                                    IsTest = false
                                });
                            }
                        }
                    }
                }
            }

            return found;
        }

        private static string GetSymbolTypeString(ISymbol symbol) => symbol.Kind switch
        {
            SymbolKind.Method => "method",
            SymbolKind.NamedType => "type",
            SymbolKind.Namespace => "package",
            _ => null,
        };
    }
}
