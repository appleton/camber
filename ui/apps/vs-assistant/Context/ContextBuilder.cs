using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.TextManager.Interop;
using Camber.Assistant.ChatWindow;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Camber.Assistant.Telemetry;

namespace Camber.Assistant.Context
{
    internal static class ContextBuilder
    {
        internal static void SendLatestContext()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            ChatWindowRPCClient.setContext(BuildContext());
        }

        internal static ActiveFileContext BuildContext()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var recentFile = BuildActiveFile();
            var activeFiles = BuildVisibleFiles(recentFile);

            // The focused view is not always among the enumerated frames, and the
            // webview expects the recent file to be one of the active ones.
            if (recentFile != null &&
                !activeFiles.Any(f => string.Equals(f.path, recentFile.path, StringComparison.OrdinalIgnoreCase)))
            {
                activeFiles.Insert(0, recentFile);
            }

            return new ActiveFileContext
            {
                workspaces = BuildProjectsList(),
                homeDirectory = BuildHomeDirectory(),
                defaultCwd = BuildDefaultCwd(),
                recentFile = recentFile,
                activeFiles = activeFiles.ToArray()
            };
        }

        // Every on-screen document, mirroring what VS Code sends from
        // window.visibleTextEditors. This runs on every caret move, so the focused
        // file's already-built snapshot is reused rather than materialized twice.
        private static List<AttachedFile> BuildVisibleFiles(AttachedFile recentFile)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var files = new List<AttachedFile>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var frame in Util.GetAllWindowFrames())
            {
                frame.GetProperty((int)__VSFPROPID.VSFPROPID_pszMkDocument, out object monikerObj);
                // Tool windows and designer surfaces are enumerated too; File.Exists
                // keeps us to real files, as VS Code keeps to text tabs.
                if (monikerObj is not string path || !File.Exists(path))
                    continue;
                frame.IsOnScreen(out int isVisible);
                if (isVisible == 0 || !seen.Add(path))
                    continue;
                var file = recentFile != null && string.Equals(path, recentFile.path, StringComparison.OrdinalIgnoreCase)
                    ? recentFile
                    : BuildOpenTextFileContext(path);
                if (file != null)
                    files.Add(file);
            }
            return files;
        }

        internal static string BuildHomeDirectory()
        {
            return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }

        // Returns the fallback working directory supplied to the helper when no
        // workspace folder is open. Honors the DefaultWorkingDirectory user
        // setting when set, otherwise uses a dedicated scratch directory: rooting
        // the agent at the user's profile puts .ssh, .aws and AppData within reach
        // of its file tools.
        internal static string BuildDefaultCwd()
        {
            var configured = CamberAssistantPackage.GetInstance()?.GetSettings()?.DefaultWorkingDirectory;
            if (!string.IsNullOrWhiteSpace(configured))
            {
                return configured.Trim();
            }

            return EnsureScratchDirectory();
        }

        // BuildDefaultCwd runs on every context refresh, so the directory is created once
        // per session rather than on every call.
        private static string ensuredScratchDirectory;

        private static string EnsureScratchDirectory()
        {
            if (ensuredScratchDirectory != null)
            {
                return ensuredScratchDirectory;
            }

            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(localAppData))
            {
                // GetFolderPath returns an empty string when the folder is not physically
                // present. Combining onto it would yield the relative path "camber\scratch",
                // which CreateDirectory would happily make under the IDE's own working
                // directory - leaving the helper with a relative cwd pointing who knows where.
                ensuredScratchDirectory = Path.GetTempPath();
                return ensuredScratchDirectory;
            }

            var scratch = Path.Combine(localAppData, "poolside", "scratch");
            try
            {
                Directory.CreateDirectory(scratch);
                ensuredScratchDirectory = scratch;
            }
            catch (Exception)
            {
                // The shell tool still needs somewhere writable to start; the temp
                // directory keeps it out of the profile when scratch cannot be made.
                ensuredScratchDirectory = Path.GetTempPath();
            }
            return ensuredScratchDirectory;
        }

        internal static Workspace[] BuildProjectsList()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var result = new List<Workspace>();
            try
            {
                var workspace = CamberAssistantPackage.GetInstance()?.GetWorkspace();
                if (workspace != null)
                {
                    result.Add(new Workspace { path = workspace.RootPath, name = workspace.Name, index = 0 });
                    foreach (var additional in workspace.AdditionalWorkspaces)
                    {
                        result.Add(new Workspace { path = additional.Path, name = additional.Name, index = result.Count });
                    }
                }
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
            return result.ToArray();
        }

        // Only documents backed by a text view join the visible-files context,
        // matching VS Code's visibleTextEditors: designer and image frames also
        // carry real file paths, and reading those from disk would push binary
        // content into the prompt.
        private static AttachedFile BuildOpenTextFileContext(string path)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var wpfTextView = GetWpfTextViewForFilePath(path);
            return wpfTextView == null ? null : BuildFileFromTextView(wpfTextView);
        }

        internal static AttachedFile BuildSingleFileContext(string path)
        {
            // See if the file is open in an editor; if so, we'll build the context from the editor.
            ThreadHelper.ThrowIfNotOnUIThread();
            var wpfTextView = GetWpfTextViewForFilePath(path);
            if (wpfTextView != null)
                return BuildFileFromTextView(wpfTextView);

            // Not found, so just form it from the file.
            try
            {
                return new AttachedFile
                {
                    path = path,
                    content = Util.TransformToUnixNewlines(File.ReadAllText(path))
                };
            }
            catch (IOException)
            {
                // Couldn't read the file, maybe it was deleted.
                return null;
            }
        }

        private static IWpfTextView GetWpfTextViewForFilePath(string filePath)
        {
            // See if the document is open and get the window frame if so.
            ThreadHelper.ThrowIfNotOnUIThread();
            var openDoc = (IVsUIShellOpenDocument)Package.GetGlobalService(typeof(SVsUIShellOpenDocument));
            if (openDoc == null)
                return null;
            var itemID = new uint[1];
            int hr = openDoc.IsDocumentOpen(null, 0, filePath, Guid.Empty, 0, out IVsUIHierarchy _, itemID, out IVsWindowFrame windowFrame, out int isOpen);
            if (hr != VSConstants.S_OK || windowFrame == null || isOpen == 0)
            {
                return null;
            }

            // Get the text view and then WPF text view.
            hr = windowFrame.GetProperty((int)__VSFPROPID.VSFPROPID_DocView, out object docView);
            if (hr != VSConstants.S_OK || docView == null)
                return null;
            if (!(docView is IVsCodeWindow codeWindow))
                return null;
            hr = codeWindow.GetPrimaryView(out IVsTextView vsTextView);
            if (hr != VSConstants.S_OK || vsTextView == null)
                return null;
            var componentModel = (IComponentModel)Package.GetGlobalService(typeof(SComponentModel));
            var editorAdapter = componentModel?.GetService<IVsEditorAdaptersFactoryService>();
            if (editorAdapter == null)
                return null;
            return editorAdapter.GetWpfTextView(vsTextView);
        }

        private static AttachedFile BuildActiveFile()
        {
            // Get the current text view, if any.
            ThreadHelper.ThrowIfNotOnUIThread();
            var textManager = (IVsTextManager)ServiceProvider.GlobalProvider.GetService(typeof(SVsTextManager));
            textManager.GetActiveView(1, null, out var activeView);
            if (!(activeView is IVsUserData userData))
                return null;
            var guidViewHost = Microsoft.VisualStudio.Editor.DefGuidList.guidIWpfTextViewHost;
            userData.GetData(ref guidViewHost, out object holder);
            var textView = (holder as IWpfTextViewHost)?.TextView;
            return textView == null ? null : BuildFileFromTextView(textView);
        }

        private static AttachedFile BuildFileFromTextView(IWpfTextView textView)
        {
            // Get its text document.
            textView.TextDataModel.DocumentBuffer.Properties.TryGetProperty(typeof(ITextDocument), out ITextDocument textDocument);
            if (textDocument == null)
                return null;

            // Ensure it's a real, eixsting, file.
            if (textDocument.FilePath == null || !File.Exists(textDocument.FilePath))
                return null;

            // Get the visible range.
            var textViewLines = textView.TextViewLines;
            int startLine = textViewLines.FirstVisibleLine.Start.GetContainingLine().LineNumber + 1;
            int endLine = textViewLines.LastVisibleLine.End.GetContainingLine().LineNumber + 1;

            // Get the selection, if any.
            var selectedCode = "";
            int[] selectionStartEnd = null;
            if (!textView.Selection.IsEmpty)
            {
                selectedCode = textView.Selection.StreamSelectionSpan.GetText();
                selectionStartEnd = new int[]
                {
                    textView.Selection.Start.Position.GetContainingLine().LineNumber + 1,
                    textView.Selection.End.Position.GetContainingLine().LineNumber + 1
                };
            }

            // Produce object with name, content, and ranges.
            var content = textView.TextSnapshot.GetText();
            return new AttachedFile
            {
                path = textDocument.FilePath,
                content = Util.TransformToUnixNewlines(content),
                // Don't send selected code if its equal to the entire document.
                selectedCode = Util.TransformToUnixNewlines(selectedCode != content ? selectedCode : ""),
                selection = selectionStartEnd,
                visibleRange = new TextRange
                {
                    start = startLine,
                    end = endLine
                },
                codeSymbolsAvailable = CodeSymbolBuilder.HasCodeSymbols(Util.GetEditorDocumentFor(textDocument.FilePath))
            };
        }
    }
}
