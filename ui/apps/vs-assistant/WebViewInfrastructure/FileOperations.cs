using EnvDTE;
using Microsoft.VisualStudio.Shell;
using Camber.Assistant.EditHighlights;
using Camber.Assistant.HelperLSP;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.WebViewInfrastructure
{
    public static class FileOperations
    {
        public static List<Document> GetVisibleFiles()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dte = (DTE)ServiceProvider.GlobalProvider.GetService(typeof(DTE));
            var visible = new List<Document>();
            foreach (EnvDTE.Document doc in dte.Documents)
            {
                string fullName;
                string content;
                try
                {
                    // Documents without a file behind them (folder view, git editors)
                    // throw COM errors (E_INVALIDARG) from FullName; skip them rather
                    // than letting one poison the whole enumeration.
                    fullName = doc.FullName;
                    content = Util.GetDocumentContent(doc);
                }
                catch (Exception)
                {
                    continue;
                }
                if (fullName != null && fullName.Contains("\\") && content != null)
                {
                    visible.Add(new Document
                    {
                        path = fullName,
                        contents = Util.TransformToUnixNewlines(content)
                    });
                }
            }
            return visible;
        }

        public static async Task ApplyTaskWorkspaceEdit(TaskWorkspaceEdit edit)
        {
            var package = CamberAssistantPackage.GetInstance();
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var workspace = package.GetWorkspace();
            var highlightInputByPath = new Dictionary<string, EditHighlightsInput>();
            if (edit.Patch)
            {
                foreach (var previousHighlight in EditHighlightsTaggerProvider.GetPreviousHighlights(workspace))
                {
                    highlightInputByPath.Add(previousHighlight.Path, previousHighlight);
                }
            }
            foreach (var change in edit.Changes)
            {
                if (change is EditFile editFile)
                {
                    var path = UriToPath(editFile.Uri);
                    if (!workspace.IsPathInWorkspace(path))
                        continue;
                    var (before, after) = ApplyEditsToPath(editFile.Edits, path, true);
                    workspace.EnsureFileIsRegistered(path);
                    highlightInputByPath[path] = highlightInputByPath.TryGetValue(path, out var currentHighlights)
                        ? currentHighlights.WithNewAfter(after)
                        : new EditHighlightsInput { Path = path, Before = before, After = after };
                }
                else if (change is CreateFile createFile)
                {
                    var path = UriToPath(createFile.Uri);
                    if (!workspace.IsPathInWorkspace(path))
                        continue;
                    Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path));
                    File.WriteAllText(path, "");
                    workspace.EnsureFileIsRegistered(path);
                }
                else if (change is DeleteFile deleteFile)
                {
                    // First try to remove it from the project file, then remove it on disk.
                    var path = UriToPath(deleteFile.Uri);
                    if (!workspace.IsPathInWorkspace(path))
                        continue;
                    workspace.EnsureFileIsNotRegistered(path);
                    try
                    {
                        File.Delete(path);
                    }
                    catch (IOException)
                    {
                        // Disregard cases where it doesn't exist
                    }
                }
                else if (change is RenameFile renameFile)
                {
                    var oldPath = UriToPath(renameFile.OldUri);
                    if (!workspace.IsPathInWorkspace(oldPath))
                        continue;
                    var newPath = UriToPath(renameFile.NewUri);
                    if (!workspace.IsPathInWorkspace(newPath))
                        continue;
                    var wasOpenInEditor = Util.GetBufferFor(oldPath) != null;
                    Directory.CreateDirectory(System.IO.Path.GetDirectoryName(newPath));
                    File.Move(oldPath, newPath);
                    workspace.EnsureFileIsNotRegistered(oldPath);
                    workspace.EnsureFileIsRegistered(newPath);
                    if (wasOpenInEditor)
                        Util.OpenFileInEditor(newPath);
                }
            }
            if (edit.Highlight)
                EditHighlightsTaggerProvider.ApplyEditHighlights(highlightInputByPath.Values.ToList(), workspace);
        }

        internal static string UriToPath(string uri)
        {
            var fileUri = new Uri(uri);
            return fileUri.LocalPath;
        }

        private static (string, string) ApplyEditsToPath(List<TextEdit> edits, string path, bool save = false)
        {
            // Prefer to apply it to the editor if open, otherwise modity the file.
            ThreadHelper.ThrowIfNotOnUIThread();
            var buffer = Util.GetBufferFor(path);
            if (buffer != null)
            {
                var before = Util.GetBufferContent(buffer);
                var after = ApplyEdits(edits, before);
                Util.ReplaceBufferContent(buffer, after);
                if (save)
                    Util.GetEditorDocumentFor(path)?.Save();
                return (before, after);
            }
            else
            {
                var before = Util.GetFileContentFromDisk(path);
                var after = ApplyEdits(edits, before);
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path));
                File.WriteAllText(path, after);
                return (before, after);
            }
        }

        private static string ApplyEdits(List<TextEdit> edits, string contentWithOriginalLineEndings)
        {
            // Determine if the original content has Windows newline endings, so we can transform
            // what we apply to have them or not have them as needed. If it's an empty file, we
            // assume we want them, given it's the standard thing on Windows.
            var wantCR = contentWithOriginalLineEndings == "" || contentWithOriginalLineEndings.IndexOf('\r') >= 0;

            // Transform to Unix newlines so that the character offsets will make sense.
            var original = wantCR ? Util.TransformToUnixNewlines(contentWithOriginalLineEndings) : contentWithOriginalLineEndings;

            // Compute line start offsets
            var lineOffsets = new List<int> { 0 };
            for (int i = 0; i < original.Length; i++)
            {
                if (original[i] == '\n')
                {
                    lineOffsets.Add(i + 1);
                }
            }

            // Map (line, character) to absolute offset
            int ToOffset(int line, int character)
            {
                var lineStart = line < lineOffsets.Count ? lineOffsets[line] : original.Length;
                return Math.Min(lineStart + character, original.Length);
            }

            // Sort edits descending by start offset
            var sortedEdits = edits.OrderByDescending(
                edit => ToOffset(edit.Range.Start.Line, edit.Range.Start.Character)
            ).ToList();

            // Apply the changes.
            var result = new StringBuilder(original);
            foreach (var edit in sortedEdits)
            {
                var startOffset = ToOffset(edit.Range.Start.Line, edit.Range.Start.Character);
                var endOffset = ToOffset(edit.Range.End.Line, edit.Range.End.Character);
                result.Remove(startOffset, endOffset - startOffset);
                result.Insert(startOffset, edit.NewText);
            }

            // Transform back to Windows newlines if needed.
            return wantCR ? Util.TransformToWindowsNewlines(result.ToString()) : result.ToString();
        }
    }

    public class DocumentPath
    {
        public string path { get; set; }
    }

    public class Document : DocumentPath
    {
        public string contents { get; set; }
    }
}
