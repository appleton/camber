using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using Newtonsoft.Json;

namespace Camber.Assistant.HelperLSP
{
    public class TaskWorkspaceEdit
    {
        public TaskWorkspaceEdit(dynamic editJson)
        {
            this.TaskId = editJson.taskId;
            this.Highlight = editJson.highlight ?? false;
            this.Patch = editJson.patch ?? false;
            this.Changes = new List<DocumentChange>();
            foreach (dynamic change in editJson.changes)
            {
                var kind = change.kind;
                if (kind == null)
                {
                    var uri = change.textDocument.uri;
                    var edits = new List<TextEdit>();
                    foreach (dynamic edit in change.edits)
                    {
                        var range = new Range
                        {
                            Start = ExtractPosition(edit.range.start),
                            End = ExtractPosition(edit.range.end)
                        };
                        var newText = edit.newText;
                        edits.Add(new TextEdit
                        {
                            Range = range,
                            NewText = newText
                        });
                    }
                    this.Changes.Add(new EditFile { Uri = uri, Edits = edits });
                }
                else if (kind == "create")
                {
                    this.Changes.Add(new CreateFile
                    {
                        Uri = change.uri
                    });
                }
                else if (kind == "rename")
                {
                    this.Changes.Add(new RenameFile
                    {
                        NewUri = change.newUri,
                        OldUri = change.oldUri
                    });
                }
                else if (kind == "delete")
                {
                    this.Changes.Add(new DeleteFile
                    {
                        Uri = change.uri
                    });
                }
            }
        }

        private static Position ExtractPosition(dynamic positionJson)
        {
            long line = positionJson.line;
            long character = positionJson.character;
            return new Position
            {
                Line = (int)Math.Min(line, int.MaxValue),
                Character = (int)Math.Min(character, int.MaxValue)
            };
        }

        public List<DocumentChange> Changes { get; set; }
        public string TaskId { get; set; }
        public bool Highlight { get; set; }
        public bool Patch { get; set; }
    }

    public abstract class DocumentChange { }

    public class EditFile : DocumentChange
    {
        public string Uri { get; set; }
        public List<TextEdit> Edits { get; set; }
    }

    // The helper's OpenAPI schema stopped emitting TextEdit, so it is no longer
    // generated into Messages.cs. Range and Position still are.
    public class TextEdit
    {
        [JsonProperty("newText")]
        public string NewText { get; set; }
        [JsonProperty("range")]
        public Range Range { get; set; } = new Range();
    }

    public class CreateFile : DocumentChange
    {
        public string Uri { get; set; }
    }

    public class RenameFile : DocumentChange
    {
        public string NewUri { get; set; }
        public string OldUri { get; set; }
    }

    public class DeleteFile : DocumentChange
    {
        public string Uri { get; set; }
    }

    public class TaskWorkspaceEditResult
    {
        [JsonProperty("applied")]
        public bool Applied { get; set; }
        [JsonProperty("failureReason")]
        public string FailureReason { get; set; }
    }
}
