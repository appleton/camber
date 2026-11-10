using EnvDTE;
using Microsoft.VisualStudio.Shell;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Context
{
    public class CodeSymbol
    {
        public const string TypeKind = "type";
        public const string CodeKind = "code";
        public const string ValueKind = "value";

        public string name { get; set; }
        public string kind { get; set; }
    }

    public class CodeSymbolResponse
    {
        public List<CodeSymbol> symbols { get; set; }
    }

    internal class CodeSymbolBuilder
    {
        internal static bool HasCodeSymbols(Document document)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                var projectItem = document?.ProjectItem;
                if (projectItem == null || !Marshal.IsComObject(projectItem))
                    return false;
                return projectItem.FileCodeModel != null;
            }
            catch (COMException)
            {
                return false; // Likely due to disposed COM object
            }
            catch (ObjectDisposedException)
            {
                return false; // Defensive catch for .NET wrapper disposal
            }
            catch (NotImplementedException)
            {
                return false; // Some project systems don't implement FileCodeModel
            }
        }

        internal static CodeSymbolResponse BuildCodeSymbolsForActiveFile()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dte = (DTE)ServiceProvider.GlobalProvider.GetService(typeof(DTE));
            var activeDocument = dte?.ActiveDocument;
            return activeDocument != null
                ? BuildCodeSymbols(activeDocument)
                : EmptySymbolResponse();
        }

        internal static CodeSymbolResponse BuildCodeSymbolsForPath(string path)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var document = Util.GetEditorDocumentFor(path);
            return document != null
                ? BuildCodeSymbols(document)
                : EmptySymbolResponse();
        }

        internal static CodeSymbolResponse BuildCodeSymbols(Document document)
        {
            try
            {
                // Make sure we have some symbols to explore.
                ThreadHelper.ThrowIfNotOnUIThread();
                var projectItem = document?.ProjectItem;
                if (projectItem == null || !Marshal.IsComObject(projectItem))
                    return null;
                var codeModel = projectItem.FileCodeModel;
                if (codeModel == null)
                    return EmptySymbolResponse();

                // Get the current location, for local variable filtering.
                var textDocument = document.Object("TextDocument") as TextDocument;
                var currentPosition = textDocument?.Selection?.ActivePoint?.AbsoluteCharOffset ?? -1;

                // Collect the symbols.
                var symbols = new List<CodeSymbol>();
                var seenNames = new HashSet<string>();
                CollectSymbols(codeModel.CodeElements, symbols, seenNames, true, currentPosition);
                return new CodeSymbolResponse { symbols = symbols };
            }
            catch (COMException)
            {
                return null;
            }
            catch (ObjectDisposedException)
            {
                return null;
            }
            catch (NotImplementedException)
            {
                return null;
            }
        }

        private static void CollectSymbols(CodeElements elements, List<CodeSymbol> into, HashSet<string> seenNames, bool inScope, int currentPosition)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            foreach (CodeElement element in elements)
            {
                try
                {
                    var name = GetName(element);
                    switch (element.Kind)
                    {
                        case vsCMElement.vsCMElementNamespace:
                        case vsCMElement.vsCMElementModule:
                            CollectSymbols(element.Children, into, seenNames, ScopeFrom(element, currentPosition), currentPosition);
                            break;
                        case vsCMElement.vsCMElementClass:
                        case vsCMElement.vsCMElementDelegate:
                        case vsCMElement.vsCMElementEnum:
                        case vsCMElement.vsCMElementInterface:
                        case vsCMElement.vsCMElementStruct:
                        case vsCMElement.vsCMElementTypeDef:
                        case vsCMElement.vsCMElementUDTDecl:
                        case vsCMElement.vsCMElementUnion:
                            if (name != null && !seenNames.Contains(name))
                                into.Add(new CodeSymbol { name = name, kind = CodeSymbol.TypeKind });
                            CollectSymbols(element.Children, into, seenNames, ScopeFrom(element, currentPosition), currentPosition);
                            break;
                        case vsCMElement.vsCMElementEvent:
                        case vsCMElement.vsCMElementFunction:
                            if (name != null && !seenNames.Contains(name))
                                into.Add(new CodeSymbol { name = name, kind = CodeSymbol.CodeKind });
                            CollectSymbols(element.Children, into, seenNames, ScopeFrom(element, currentPosition), currentPosition);
                            break;
                        case vsCMElement.vsCMElementProperty:
                        case vsCMElement.vsCMElementVariable: // Used for fields
                            if (name != null && !seenNames.Contains(name))
                                into.Add(new CodeSymbol { name = name, kind = CodeSymbol.ValueKind });
                            CollectSymbols(element.Children, into, seenNames, ScopeFrom(element, currentPosition), currentPosition);
                            break;
                        case vsCMElement.vsCMElementParameter:
                        case vsCMElement.vsCMElementLocalDeclStmt:
                            if (inScope && name != null && !seenNames.Contains(name))
                                into.Add(new CodeSymbol { name = name, kind = CodeSymbol.ValueKind });
                            break;
                        default:
                            break;
                    }
                }
                catch (COMException) { }
                catch (NotImplementedException) { }
            }
        }

        private static string GetName(CodeElement element)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                return element.Name;
            }
            catch
            {
                return null;
            }
        }

        private static bool ScopeFrom(CodeElement element, int currentPosition)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            return (element.StartPoint?.AbsoluteCharOffset ?? int.MaxValue) <= currentPosition &&
                (element.EndPoint?.AbsoluteCharOffset ?? int.MinValue) >= currentPosition;
        }

        private static CodeSymbolResponse EmptySymbolResponse()
        {
            return new CodeSymbolResponse { symbols = new List<CodeSymbol>() };
        }
    }
}
