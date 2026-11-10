using EnvDTE;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.TextManager.Interop;
using Camber.Assistant.ChatWindow;
using Camber.Assistant.Telemetry;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Camber.Assistant
{
    internal static class Util
    {
        internal static void OpenUrlInBrowser(String url)
        {
            try
            {
                System.Diagnostics.Process.Start(new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true  // This ensures the URL opens in the default browser
                });
            }
            catch (Exception ex)
            {
                System.Windows.MessageBox.Show($"Failed to open the URL: {ex.Message}");
            }
        }

        internal static async Task ShowInfoMessageAsync(string message, string type = null)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var infoBarFactory = (IVsInfoBarUIFactory)Package.GetGlobalService(typeof(SVsInfoBarUIFactory));
            var infoBarModel = new InfoBarModel(
                new[] { new InfoBarTextSpan(message) },
                type == "error" ? KnownMonikers.StatusError : KnownMonikers.StatusInformation,
                isCloseButtonVisible: true
            );
            var camberToolWindow = await ChatToolWindow.GetAndShowAsync(CamberAssistantPackage.GetInstance());
            camberToolWindow.AddInfoBar(infoBarFactory.CreateInfoBar(infoBarModel));
        }

        public static System.Windows.Media.Color ToWindowsMediaColor(this System.Drawing.Color color)
        {
            return System.Windows.Media.Color.FromArgb(color.A, color.R, color.G, color.B);
        }

        public static System.Windows.Media.Brush ToBrush(this System.Drawing.Color color)
        {
            return new System.Windows.Media.SolidColorBrush(ToWindowsMediaColor(color));
        }

        public static IEnumerable<IVsWindowFrame> GetAllWindowFrames()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (CamberAssistantPackage.GetGlobalService(typeof(SVsUIShell)) is not IVsUIShell uiShell)
                yield break;
            // Tool windows (Solution Explorer, Output, etc.) and document windows are enumerated
            // separately via different IVsUIShell methods; we want both.
            foreach (var frame in EnumerateFrames(uiShell.GetDocumentWindowEnum))
                yield return frame;
            foreach (var frame in EnumerateFrames(uiShell.GetToolWindowEnum))
                yield return frame;
        }

        private delegate int GetWindowEnum(out IEnumWindowFrames windowEnumerator);

        private static IEnumerable<IVsWindowFrame> EnumerateFrames(GetWindowEnum getWindowEnum)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (getWindowEnum(out IEnumWindowFrames windowEnumerator) != VSConstants.S_OK || windowEnumerator == null)
                yield break;
            var frames = new IVsWindowFrame[1];
            while (windowEnumerator.Next(1, frames, out uint fetched) == VSConstants.S_OK && fetched == 1)
            {
                var frame = frames[0];
                if (frame != null)
                    yield return frame;
            }
        }

        public static void OpenFileInEditor(string path, int? line = null, int? column = null)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var openDocumentService = (IVsUIShellOpenDocument)Package.GetGlobalService(typeof(SVsUIShellOpenDocument));
            var logicalView = VSConstants.LOGVIEWID_Code;
            var hr = openDocumentService.OpenDocumentViaProject(path, ref logicalView, out var serviceProvider, out var hierarchy, out var itemId, out var windowFrame);
            if (ErrorHandler.Succeeded(hr) && windowFrame != null)
            {
                windowFrame.Show();

                if (line.HasValue)
                {
                    // Line/column in the RPC contract are 1-indexed; VS text APIs are 0-indexed.
                    var zeroBasedLine = Math.Max(0, line.Value - 1);
                    var zeroBasedColumn = Math.Max(0, (column ?? 1) - 1);
                    NavigateToLine(windowFrame, zeroBasedLine, zeroBasedColumn);
                }
            }
        }

        private static void NavigateToLine(IVsWindowFrame windowFrame, int line, int column)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (windowFrame.GetProperty((int)__VSFPROPID.VSFPROPID_DocView, out object docView) != VSConstants.S_OK)
                return;
            if (!(docView is IVsCodeWindow codeWindow))
                return;
            if (codeWindow.GetPrimaryView(out IVsTextView textView) != VSConstants.S_OK || textView == null)
                return;
            textView.SetCaretPos(line, column);
            textView.CenterLines(line, 1);
        }

        /// <summary>
        /// Open the editor with a file that does not exist, and with placeholder content, such that the file will be
        /// created upon save.
        /// </summary>
        /// <param name="fullPath"></param>
        /// <param name="placeholderContent"></param>
        public static void OpenEphemeralFile(string fullPath, string placeholderContent)
        {
            ThreadHelper.ThrowIfNotOnUIThread();

            // All attempts to actually create an editor for a file that doesn't exist failed, so instead we create
            // it empty, open it, then delete it from disk.
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
            File.WriteAllText(fullPath, string.Empty);
            OpenFileInEditor(fullPath);
            File.Delete(fullPath);

            // We then inject the placeholder content so the file looks unsaved with the placeholder.
            var rdt = (IVsRunningDocumentTable)Package.GetGlobalService(typeof(SVsRunningDocumentTable));
            rdt.FindAndLockDocument((uint)_VSRDTFLAGS.RDT_NoLock, fullPath,
                out _, out _, out _, out uint docCookie);
            rdt.GetDocumentInfo(docCookie, out _, out _, out _, out _, out _, out _, out IntPtr docData);
            try
            {
                if (docData != IntPtr.Zero && Marshal.GetObjectForIUnknown(docData) is IVsTextBuffer vsBuffer)
                {
                    // Convert IVsTextBuffer to ITextBuffer
                    var componentModel = (IComponentModel)Package.GetGlobalService(typeof(SComponentModel));
                    var editorAdapters = componentModel.GetService<IVsEditorAdaptersFactoryService>();
                    ITextBuffer textBuffer = editorAdapters.GetDocumentBuffer(vsBuffer);

                    // Replace content with placeholder text
                    string init = placeholderContent ?? " ";
                    textBuffer.Replace(new Span(0, textBuffer.CurrentSnapshot.Length), init);
                }
            }
            finally
            {
                if (docData != IntPtr.Zero)
                    Marshal.Release(docData);
            }
        }

        public static ITextBuffer GetBufferFor(string path)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var rdt = (IVsRunningDocumentTable)Package.GetGlobalService(typeof(SVsRunningDocumentTable));
            if (rdt == null)
                return null;
            var docData = IntPtr.Zero;
            try
            {
                int hr = rdt.FindAndLockDocument(
                    (uint)_VSRDTFLAGS.RDT_NoLock,
                    path,
                    out IVsHierarchy hierarchy,
                    out uint itemId,
                    out docData,
                    out uint cookie);
                if (ErrorHandler.Failed(hr) || docData == IntPtr.Zero)
                    return null;
                if (Marshal.GetObjectForIUnknown(docData) is not IVsTextBuffer vsTextBuffer)
                    return null;
                var componentModel = (IComponentModel)Package.GetGlobalService(typeof(SComponentModel));
                var adapter = componentModel.GetService<IVsEditorAdaptersFactoryService>();
                return adapter.GetDocumentBuffer(vsTextBuffer);
            }
            finally
            {
                if (docData != IntPtr.Zero)
                    Marshal.Release(docData);
            }
        }

        public static string GetBufferContent(ITextBuffer textBuffer)
        {
            return textBuffer.CurrentSnapshot.GetText();
        }

        public static void ReplaceBufferContent(ITextBuffer textBuffer, string newContent)
        {
            var oldText = textBuffer.CurrentSnapshot.GetText();
            if (oldText == newContent)
                return; // No changes needed

            // Find common prefix
            var prefixLength = 0;
            var minLen = Math.Min(oldText.Length, newContent.Length);
            while (prefixLength < minLen && oldText[prefixLength] == newContent[prefixLength])
            {
                prefixLength++;
            }

            // Find common suffix
            var suffixLength = 0;
            while (
                suffixLength < (oldText.Length - prefixLength) &&
                suffixLength < (newContent.Length - prefixLength) &&
                oldText[oldText.Length - 1 - suffixLength] == newContent[newContent.Length - 1 - suffixLength])
            {
                suffixLength++;
            }

            var oldMiddleStart = prefixLength;
            var oldMiddleLength = oldText.Length - prefixLength - suffixLength;
            var newMiddleLength = newContent.Length - prefixLength - suffixLength;
            var edit = textBuffer.CreateEdit();
            edit.Replace(oldMiddleStart, oldMiddleLength, newContent.Substring(prefixLength, newMiddleLength));
            edit.Apply();
        }

        public static Document GetEditorDocumentFor(string filePath)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dte = (DTE)ServiceProvider.GlobalProvider.GetService(typeof(DTE));
            var documents = dte.Documents;
            foreach (Document doc in documents)
                if (doc.FullName.Equals(TransformPathFromWebView(filePath), StringComparison.OrdinalIgnoreCase))
                    return doc;
            return null;
        }

        public static string GetDocumentContent(Document doc)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                if (doc.Object("TextDocument") is not TextDocument textDocument)
                    return null;
                var startPoint = textDocument.StartPoint.CreateEditPoint();
                return startPoint.GetText(textDocument.EndPoint);
            }
            catch (Exception)
            {
                // Broad catch needed here: doc.Object("TextDocument") can throw COMException
                // (designers, binary files, images) or Microsoft.Assumes.InternalErrorException
                // (documents that failed to load). The latter is internal and extends Exception
                // directly, so we can't catch it specifically. Return null to skip the document.
                return null;
            }
        }

        /// <summary>
        /// Closes all open editor frames showing the given file.
        /// </summary>
        /// <param name="fullPath">Absolute path to the file.</param>
        /// <param name="promptToSave">If true, prompt to save; otherwise close without saving.</param>
        /// <returns>Number of frames that were closed.</returns>
        public static int CloseEditorsForFile(string fullPath, bool promptToSave = false)
        {
            ThreadHelper.ThrowIfNotOnUIThread();

            if (string.IsNullOrWhiteSpace(fullPath))
                return 0;

            // Normalize for comparison (VS stores monikers as full paths)
            fullPath = Path.GetFullPath(fullPath);

            if (Package.GetGlobalService(typeof(SVsUIShell)) is not IVsUIShell uiShell)
                return 0;

            // Enumerate ONLY document windows (editors), not tool windows
            if (uiShell.GetDocumentWindowEnum(out IEnumWindowFrames enumFrames) != VSConstants.S_OK || enumFrames == null)
                return 0;

            int closed = 0;
            var frames = new IVsWindowFrame[1];

            while (enumFrames.Next(1, frames, out uint fetched) == VSConstants.S_OK && fetched == 1)
            {
                var frame = frames[0];
                if (frame == null)
                    continue;

                // Get the moniker (path) for the frame’s document
                if (frame.GetProperty((int)__VSFPROPID.VSFPROPID_pszMkDocument, out object monikerObj) == VSConstants.S_OK &&
                    monikerObj is string moniker &&
                    string.Equals(Path.GetFullPath(moniker), fullPath, StringComparison.OrdinalIgnoreCase))
                {
                    uint closeOpt = promptToSave
                        ? (uint)__FRAMECLOSE.FRAMECLOSE_PromptSave
                        : (uint)__FRAMECLOSE.FRAMECLOSE_NoSave;

                    frame.CloseFrame(closeOpt);
                    closed++;
                }
            }

            return closed;
        }

        public static string GetFileContentFromDisk(string filePath)
        {
            return File.Exists(filePath) ? File.ReadAllText(filePath) : "";
        }

        public static string TransformPathFromWebView(string path)
        {
            return path.Replace('/', '\\');
        }

        public static string TrimTrailingPathSlash(string path)
        {
            return path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        public static string TransformToUnixNewlines(string input)
        {
            return input.Replace("\r", "");
        }

        public static string TransformToWindowsNewlines(string input)
        {
            return Regex.Replace(input, @"(?<!\r)\n", "\r\n");
        }

        internal static bool IsExperimentalInstance()
        {
            return Environment.CommandLine.Contains("/rootsuffix Exp");
        }

        internal static void FocusMainWindow()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dte = (DTE)CamberAssistantPackage.GetGlobalService(typeof(DTE));
            dte.MainWindow.Activate();
        }

        /// <summary>
        /// Displays an info bar message with actions and returns the selected action via a TaskCompletionSource.
        /// </summary>
        /// <typeparam name="T">The type representing the action result</typeparam>
        /// <param name="message">The message to display</param>
        /// <param name="actions">Dictionary mapping action button text to result values</param>
        /// <param name="moniker">The icon to show</param>
        /// <param name="toolWindow">The tool window to display the info bar in (defaults to ChatToolWindow)</param>
        /// <returns>Task that completes when an action is selected, or null if closed without action</returns>
        internal static async Task<T> ShowInfoBarWithActionsAsync<T>(
            string message,
            Dictionary<string, T> actions,
            Microsoft.VisualStudio.Imaging.Interop.ImageMoniker moniker,
            ChatToolWindow toolWindow = null)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

            var actionItems = actions.Keys.Select(text => new InfoBarButton(text)).ToList<InfoBarActionItem>();
            var infoBarFactory = (IVsInfoBarUIFactory)Package.GetGlobalService(typeof(SVsInfoBarUIFactory));
            var infoBarModel = new InfoBarModel(
                message,
                actionItems,
                moniker,
                isCloseButtonVisible: true
            );

            if (toolWindow == null)
            {
                toolWindow = await ChatToolWindow.GetInstanceAsync(CamberAssistantPackage.GetInstance());
            }

            var infoBar = infoBarFactory.CreateInfoBar(infoBarModel);
            var tcs = new TaskCompletionSource<T>();
            var eventsSink = new InfoBarActionEventsSink<T>(actions, tcs);
            infoBar.Advise(eventsSink, out uint cookie);
            eventsSink.cookie = cookie;
            toolWindow.AddInfoBar(infoBar);

            return await tcs.Task;
        }

        private class InfoBarActionEventsSink<T> : IVsInfoBarUIEvents
        {
            private readonly Dictionary<string, T> actions;
            private readonly TaskCompletionSource<T> tcs;
            public uint cookie { get; set; }

            public InfoBarActionEventsSink(Dictionary<string, T> actions, TaskCompletionSource<T> tcs)
            {
                this.actions = actions;
                this.tcs = tcs;
            }

            public void OnClosed(IVsInfoBarUIElement infoBarUIElement)
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                infoBarUIElement?.Unadvise(cookie);
                if (!tcs.Task.IsCompleted)
                {
                    tcs.TrySetResult(default(T));
                }
            }

            [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD100:Avoid async void methods", Justification = "API compatibility; has try/catch")]
            public async void OnActionItemClicked(IVsInfoBarUIElement infoBarUIElement, IVsInfoBarActionItem actionItem)
            {
                try
                {
                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                    infoBarUIElement.Unadvise(cookie);

                    if (actions.TryGetValue(actionItem.Text, out T result))
                    {
                        tcs.TrySetResult(result);
                    }
                    else
                    {
                        tcs.TrySetResult(default(T));
                    }

                    infoBarUIElement.Close();
                }
                catch (Exception ex)
                {
                    CamberTelemetryLogger.Instance.reportException(ex);
                    tcs.TrySetException(ex);
                }
            }
        }

        internal static void HandleTaskErrors(Task toObserve)
        {
            if (toObserve != null)
                _ = toObserve.ContinueWith(result =>
                {
                    if (result.IsFaulted)
                        CamberTelemetryLogger.Instance.reportException(result.Exception);
                }, TaskScheduler.Default);
        }

        internal static IEnumerable<T> EnumerateWithErrorsHandled<T>(IEnumerable<T> source)
        {
            using (var e = source.GetEnumerator())
            {
                while (true)
                {
                    bool moved;
                    try
                    {
                        moved = e.MoveNext();
                    }
                    catch (Exception ex)
                    {
                        CamberTelemetryLogger.Instance.reportException(ex);
                        yield break;
                    }
                    if (!moved)
                        yield break;
                    yield return e.Current;
                }
            }
        }
    }
}
