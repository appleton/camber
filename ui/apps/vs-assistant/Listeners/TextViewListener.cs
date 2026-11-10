using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Utilities;
using Camber.Assistant.Context;
using Camber.Assistant.HelperLSP;
using Camber.Assistant.Telemetry;
using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Threading;

namespace Camber.Assistant.Listeners
{
    [Export(typeof(IWpfTextViewCreationListener))]
    [ContentType("text")]
    [TextViewRole(PredefinedTextViewRoles.Document)]
    public class TextViewListener : IWpfTextViewCreationListener
    {
        public void TextViewCreated(IWpfTextView textView)
        {
            // So long as there's a file associated with the document, inform the helper.
            textView.TextBuffer.Properties.TryGetProperty(typeof(ITextDocument), out ITextDocument textDocument);
            var path = textDocument?.FilePath;
            if (path != null)
                HelperLSPService.Instance.NotifyFileOpened(path, textView.TextSnapshot.GetText());

            // Set up event handlers.
            textView.Selection.SelectionChanged += OnSelectionChanged;
            textView.TextBuffer.Changed += OnTextBufferChanged;
            textView.Closed += (sender, e) =>
            {
                if (path != null)
                    HelperLSPService.Instance.NotifyFileClosed(path);
            };
        }

        private void OnSelectionChanged(object sender, EventArgs e)
        {
            // Coalesce caret-driven refreshes to idle, as VS Code debounces its
            // equivalent: a full visible-files snapshot per caret step would
            // block the UI thread on large files.
            ScheduleContextResync();
        }

        // Incremented synchronously on a change, and used to cancel the background context sync if there
        // are further changes.
        private int updateContextTicket = 0;

        private void ScheduleContextResync()
        {
            var myUpdateContextTicket = ++this.updateContextTicket;
            _ = ThreadHelper.JoinableTaskFactory.StartOnIdle(() =>
            {
                if (myUpdateContextTicket != this.updateContextTicket)
                    return;
                try
                {
                    ThreadHelper.ThrowIfNotOnUIThread();
                    ContextBuilder.SendLatestContext();
                }
                catch (Exception ex)
                {
                    CamberTelemetryLogger.Instance.reportException(ex);
                }
            });
        }

        private void OnTextBufferChanged(object sender, TextContentChangedEventArgs e)
        {
            // Dispatch the change notification to the LSP immediately, and but do the rest out of
            // this event handler, both to avoid typing lag but also because it changes with a lag.
            // We should do the did change hnadler right away otherwise inline completion can see
            // outdated content.
            if (e.After.TextBuffer.Properties.TryGetProperty(typeof(ITextDocument), out ITextDocument textDocument))
            {
                var path = textDocument.FilePath;
                if (path != null)
                {
                    SendTextDidChangeNotifications(path, e);
                    ScheduleContextResync();
                }
            }
        }

        private void SendTextDidChangeNotifications(string path, TextContentChangedEventArgs e)
        {
            var lspChanges = new List<TextDocumentContentChangePartial>();
            if (e.Changes.Count == 1)
            {
                // The most common case: only a single change. We can easily calculate this, since we
                // can determine the line number from the before snapshot.
                var c = e.Changes[0];
                var start = e.Before.GetLineFromPosition(c.OldSpan.Start);
                var startLine = start.LineNumber;
                var startCharacter = c.OldSpan.Start - start.Start;
                var end = e.Before.GetLineFromPosition(c.OldSpan.End);
                var endLine = end.LineNumber;
                var endCharacter = c.OldSpan.End - end.Start;
                lspChanges.Add(new TextDocumentContentChangePartial
                {
                    Text = c.NewText,
                    Range = new Range
                    {
                        Start = new Position { Line = startLine, Character = startCharacter },
                        End = new Position { Line = endLine, Character = endCharacter }
                    }
                });
            }
            else if (e.Changes.Count > 1)
            {
                // Multiple changes. The LSP protocol needs to send them as a sequence of changes
                // where each one has its line and char numbers based upon the previous change, but
                // we only get the snapshot before the whole batch. Thus we need to simulate the changes.
                // (It's tempting to send a whole file change here instead to nail it, and from the
                // point of view of performance, it would be fine, because this case is rare. Alas,
                // the helper uses these change events to implement completion edit telemetry, and a
                // kind of change that produces this kind of situation is formatting application, and
                // knowing the user reformated what the inline completion suggested is valuable.)
                var textBuilder = new StringBuilder(e.Before.GetText());
                var offsetShift = 0;
                foreach (var change in e.Changes)
                {
                    int oldStart = change.OldSpan.Start + offsetShift;
                    int oldEnd = change.OldSpan.End + offsetShift;

                    var lineStart = GetLineFromPosition(textBuilder, oldStart);
                    var lineEnd = GetLineFromPosition(textBuilder, oldEnd);

                    var startChar = oldStart - lineStart.Item2;
                    var endChar = oldEnd - lineEnd.Item2;

                    lspChanges.Add(new TextDocumentContentChangePartial
                    {
                        Text = change.NewText,
                        Range = new Range
                        {
                            Start = new Position { Line = lineStart.Item1, Character = startChar },
                            End = new Position { Line = lineEnd.Item1, Character = endChar }
                        }
                    });

                    textBuilder.Remove(oldStart, oldEnd - oldStart);
                    textBuilder.Insert(oldStart, change.NewText);

                    offsetShift += change.NewText.Length - (oldEnd - oldStart);
                }
            }
            if (lspChanges.Count > 0)
                HelperLSPService.Instance.NotifyFileChanged(path, e.After.GetText(), lspChanges);
        }

        private static (int LineNumber, int LineStartOffset) GetLineFromPosition(StringBuilder text, int position)
        {
            int line = 0;
            int offset = 0;
            int i = 0;

            while (i < position && i < text.Length)
            {
                char c = text[i];

                if (c == '\r')
                {
                    // Handle \r\n or lone \r
                    if (i + 1 < text.Length && text[i + 1] == '\n')
                        i++; // skip \n

                    line++;
                    offset = i + 1;
                }
                else if (c == '\n')
                {
                    // Handle lone \n
                    line++;
                    offset = i + 1;
                }

                i++;
            }

            return (line, offset);
        }
    }
}
