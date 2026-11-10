using Microsoft.VisualStudio.Shell.TableManager;
using Camber.Assistant.HelperLSP;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.Context
{
    internal class ErrorTableWatcher : IDisposable
    {
        /// <summary>
        /// The error table manager instance.
        /// </summary>
        private readonly ITableManager errorsTable;

        /// <summary>
        /// Tracks our syncs for each data source that populates the errors table.
        /// </summary>
        private readonly ConcurrentDictionary<ITableDataSource, TableSink> sinks = new ConcurrentDictionary<ITableDataSource, TableSink>();

        /// <summary>
        /// Currently awaited changes to the diagnostics.
        /// </summary>
        private readonly List<AwaitedDiagnosticsChange> awaitedDiagnosticsChanges = new List<AwaitedDiagnosticsChange>();

        private class AwaitedDiagnosticsChange
        {
            internal string File { get; set; }
            internal TaskCompletionSource<bool> TCS { get; set; }
        }

        #region Error table sources subscription
        public ErrorTableWatcher(ITableManagerProvider tableManagerProvider)
        {
            // Subscribe to error table data sources, and follow changes to the data sources.
            errorsTable = tableManagerProvider.GetTableManager(StandardTables.ErrorsTable);
            foreach (var src in errorsTable.Sources)
                EnsureSubscribtionToSource(src);
            errorsTable.SourcesChanged += ErrorsTable_SourcesChanged;
        }

        private void ErrorsTable_SourcesChanged(object sender, EventArgs e)
        {
            var current = errorsTable.Sources.ToHashSet();
            foreach (var src in current)
                EnsureSubscribtionToSource(src);
            foreach (var kvp in sinks)
            {
                if (!current.Contains(kvp.Key))
                {
                    if (sinks.TryRemove(kvp.Key, out var sink))
                        sink.Dispose();
                }
            }
        }

        private void EnsureSubscribtionToSource(ITableDataSource src)
        {
            sinks.GetOrAdd(src, s =>
            {
                var sink = new TableSink(this);
                s.Subscribe(sink);
                return sink;
            });
        }

        public void Dispose()
        {
            errorsTable.SourcesChanged -= ErrorsTable_SourcesChanged;
            foreach (var kvp in sinks)
                kvp.Value.Dispose();
            sinks.Clear();
        }
        #endregion

        /// <summary>
        /// Reads the current Errors table rows that belong to the specified file.
        /// </summary>
        public async Task<List<Diagnostic>> GetDiagnosticsForFileAsync(string filePath, int? waitMs, int severity)
        {
            if (waitMs != null)
                await WaitForDiagnosticsChangeForFileOrTimeoutAsync(filePath, waitMs.Value);

            var result = new List<Diagnostic>();
            foreach (var factory in GetAllFactories())
            {
                ITableEntriesSnapshot snap = null;
                try
                {
                    snap = factory.GetCurrentSnapshot();
                    if (snap == null || snap.Count == 0)
                        continue;
                    snap.StartCaching();
                    for (int i = 0; i < snap.Count; i++)
                    {
                        if (!TryGetPath(snap, i, out var entryPath))
                            continue;
                        if (!string.Equals(entryPath, filePath, StringComparison.OrdinalIgnoreCase))
                            continue;

                        var item = BuildDiagnostic(snap, i);
                        if (severity != 0 && item.Severity.HasValue && item.Severity.Value > severity)
                            continue;
                        result.Add(item);
                    }
                }
                finally
                {
                    snap?.StopCaching();
                    snap?.Dispose();
                }
            }
            return result;
        }

        private async Task WaitForDiagnosticsChangeForFileOrTimeoutAsync(string file, int timeout)
        {
            var wait = new AwaitedDiagnosticsChange
            {
                File = file,
                TCS = new TaskCompletionSource<bool>()
            };
            lock (awaitedDiagnosticsChanges)
                awaitedDiagnosticsChanges.Add(wait);
            try
            {
                await Task.WhenAny(wait.TCS.Task, Task.Delay(timeout));
            }
            finally
            {
                lock (awaitedDiagnosticsChanges)
                    awaitedDiagnosticsChanges.Remove(wait);
            }
        }

        private static bool TryGetPath(ITableEntriesSnapshot snap, int index, out string path)
        {
            path = null;
            object obj;

            // Prefer Path (usually full path)
            if (snap.TryGetValue(index, StandardTableKeyNames.Path, out obj))
            {
                var s = obj as string;
                if (!string.IsNullOrWhiteSpace(s)) { path = s; return true; }
            }

            // Then DocumentName
            if (snap.TryGetValue(index, StandardTableKeyNames.DocumentName, out obj))
            {
                var s = obj as string;
                if (!string.IsNullOrWhiteSpace(s)) { path = s; return true; }
            }

            // Finally DisplayPath
            if (snap.TryGetValue(index, StandardTableKeyNames.DisplayPath, out obj))
            {
                var s = obj as string;
                if (!string.IsNullOrWhiteSpace(s)) { path = s; return true; }
            }

            return false;
        }


        /// <summary>
        /// Handler for when a sink changes.
        /// </summary>
        /// <param name="factory"></param>
        private void OnFactorySnapshotChanged(ITableEntriesSnapshotFactory factory)
        {
            ITableEntriesSnapshot snap = null;
            try
            {
                snap = factory.GetCurrentSnapshot();
                if (snap == null)
                    return;
                snap.StartCaching();
                for (int i = 0; i < snap.Count; i++)
                {
                    if (!TryGetPath(snap, i, out var entryPath))
                        continue;
                    // TrySetResult can actually run the continuation of the awaiting task, and
                    // since `lock` is reentrant then it's determined that we already hold it and
                    // so we end up with a concurrent modification exception on the awaitedDiagnosticsChanges
                    // collection. Thus we put the task completion sources into a collection,
                    // release the lock, and loop over them.
                    var completionSources = new List<TaskCompletionSource<bool>>();
                    lock (awaitedDiagnosticsChanges)
                    {
                        foreach (var waiting in awaitedDiagnosticsChanges)
                            if (string.Equals(waiting.File, entryPath, StringComparison.OrdinalIgnoreCase))
                                completionSources.Add(waiting.TCS);
                    }
                    foreach (var completionSource in completionSources)
                        completionSource.TrySetResult(true);
                }
            }
            finally
            {
                snap?.StopCaching();
                snap?.Dispose();
            }
        }

        public static Diagnostic BuildDiagnostic(ITableEntriesSnapshot snap, int index)
        {
            // message
            string message = GetString(snap, index, StandardTableKeyNames.Text);
            if (string.IsNullOrWhiteSpace(message))
                message = GetString(snap, index, StandardTableKeyNames.FullText) ?? "";

            // start position (VS tables are effectively 0-based; LSP is 0-based too)
            int line = GetIntOrDefault(snap, index, StandardTableKeyNames.Line, 0);
            int col = GetIntOrDefault(snap, index, StandardTableKeyNames.Column, 0);

            // no standard EndLine/EndColumn; just use starts.
            int endLine = line;
            int endCol = col;

            // severity -> LSP DiagnosticSeverity (1=Error, 2=Warning, 3=Information, 4=Hint)
            int? severity = MapSeverityToLsp(GetObject(snap, index, StandardTableKeyNames.ErrorSeverity));

            // code + codeDescription
            string code = GetString(snap, index, StandardTableKeyNames.ErrorCode);
            CodeDescription codeDescription = null;
            string helpLink = GetString(snap, index, StandardTableKeyNames.HelpLink);
            if (!string.IsNullOrWhiteSpace(helpLink))
            {
                  codeDescription = new CodeDescription { Href = helpLink };
            }

            // source (who produced it)
            string source = GetString(snap, index, StandardTableKeyNames.ErrorSource);
            if (string.IsNullOrWhiteSpace(source))
                source = GetString(snap, index, StandardTableKeyNames.BuildTool);
            if (string.IsNullOrWhiteSpace(source))
                source = GetString(snap, index, StandardTableKeyNames.ProjectName);

            return new Diagnostic
            {
                Message = message,
                Range = new Range
                {
                    Start = new Position { Line = Math.Max(0, line), Character = Math.Max(0, col) },
                    End = new Position { Line = Math.Max(0, endLine), Character = Math.Max(0, endCol) }
                },
                Severity = severity,
                Source = source,
                Code = string.IsNullOrWhiteSpace(code) ? null : (object)code,
                CodeDescription = codeDescription
            };
        }

        private static object GetObject(ITableEntriesSnapshot snap, int index, string key)
        {
            if (snap.TryGetValue(index, key, out object obj))
                return obj;
            return null;
        }

        private static string GetString(ITableEntriesSnapshot snap, int index, string key)
        {
            if (snap.TryGetValue(index, key, out object obj))
            {
                string s = obj as string;
                if (!string.IsNullOrWhiteSpace(s))
                    return s;
            }
            return null;
        }

        private static int GetIntOrDefault(ITableEntriesSnapshot snap, int index, string key, int @default)
        {
            if (snap.TryGetValue(index, key, out object obj))
            {
                if (obj is int v)
                    return v;
                // Some providers may box as long/short/etc.
                try
                {
                    return Convert.ToInt32(obj);
                }
                catch { }
            }
            return @default;
        }

        private static int? MapSeverityToLsp(object severityObj)
        {
            if (severityObj == null) return null;

            var t = severityObj.GetType();
            if (t.IsEnum)
            {
                var typeName = t.FullName ?? t.Name;
                var name = severityObj.ToString(); // e.g., "EC_ERROR", "EC_WARNING", "EC_MESSAGE"

                // __VSERRORCATEGORY: EC_MESSAGE=0, EC_WARNING=1, EC_ERROR=2
                if (typeName.IndexOf("Microsoft.VisualStudio.Shell.Interop.__VSERRORCATEGORY", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    // prefer mapping by name to be future-proof
                    var n = name.Trim().ToUpperInvariant();
                    if (n == "EC_ERROR") return 1; // LSP Error
                    if (n == "EC_WARNING") return 2; // LSP Warning
                    if (n == "EC_MESSAGE") return 3; // LSP Information

                    // numeric fallback (should match above)
                    try
                    {
                        int v = Convert.ToInt32(severityObj);
                        if (v == 2) return 1;
                        if (v == 1) return 2;
                        if (v == 0) return 3;
                    }
                    catch { }
                    return null;
                }

                // TableManager.Severity: Error=0, Warning=1, Informational=2, Hidden=3
                if (typeName.IndexOf("Microsoft.VisualStudio.Shell.TableManager.Severity", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    try
                    {
                        int v = Convert.ToInt32(severityObj);
                        if (v == 0) return 1;
                        if (v == 1) return 2;
                        if (v == 2) return 3;
                        if (v == 3) return 4;
                    }
                    catch { }
                    return null;
                }

                // Roslyn DiagnosticSeverity: Hidden=0, Info=1, Warning=2, Error=3
                if (typeName.IndexOf("Microsoft.CodeAnalysis.DiagnosticSeverity", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    try
                    {
                        int v = Convert.ToInt32(severityObj);
                        if (v == 3) return 1;
                        if (v == 2) return 2;
                        if (v == 1) return 3;
                        if (v == 0) return 4;
                    }
                    catch { }
                    return null;
                }

                // Generic enum-name fallback
                var lower = name.Trim().ToLowerInvariant();
                if (lower.Contains("error")) return 1;
                if (lower.Contains("warning")) return 2;
                if (lower.Contains("info") || lower.Contains("message") || lower.Contains("informational")) return 3;
                if (lower.Contains("hidden") || lower.Contains("hint") || lower.Contains("suggestion")) return 4;
                return null;
            }

            // String fallback
            var s = severityObj as string;
            if (!string.IsNullOrEmpty(s))
            {
                var n = s.Trim().ToLowerInvariant();
                if (n == "ec_error") return 1;
                if (n == "ec_warning") return 2;
                if (n == "ec_message") return 3;

                if (n == "error") return 1;
                if (n == "warning") return 2;
                if (n == "information" || n == "informational" || n == "message" || n == "info") return 3;
                if (n == "hidden" || n == "hint" || n == "suggestion") return 4;
                return null;
            }

            // Ambiguous numeric without type – better to return null than guess wrong.
            return null;
        }

        private sealed class TableSink : ITableDataSink, IDisposable
        {
            private readonly ErrorTableWatcher owner;
            private readonly object gate = new object();
            private readonly HashSet<ITableEntriesSnapshotFactory> factories = new HashSet<ITableEntriesSnapshotFactory>();

            public TableSink(ErrorTableWatcher owner) => this.owner = owner;

            public bool IsStable { get; set; }

            public void AddFactory(ITableEntriesSnapshotFactory factory, bool removeAllFactories)
            {
                lock (gate)
                {
                    if (removeAllFactories)
                        factories.Clear();
                    factories.Add(factory);
                }
                owner.OnFactorySnapshotChanged(factory);
            }

            public void ReplaceFactory(ITableEntriesSnapshotFactory oldFactory, ITableEntriesSnapshotFactory newFactory)
            {
                lock (gate)
                {
                    factories.Remove(oldFactory);
                    factories.Add(newFactory);
                }
                owner.OnFactorySnapshotChanged(newFactory);
            }

            public void RemoveFactory(ITableEntriesSnapshotFactory oldFactory)
            {
                lock (gate)
                    factories.Remove(oldFactory);
            }

            public void FactorySnapshotChanged(ITableEntriesSnapshotFactory factory)
            {
                owner.OnFactorySnapshotChanged(factory);
            }

            // Most providers use factories; entries/snapshots are included for completeness
            public void AddEntries(IReadOnlyList<ITableEntry> entries, bool removeAllEntries)
            {
                if (entries == null || entries.Count == 0) return;

                var factory = new EntriesFactory(entries);
                lock (gate)
                {
                    if (removeAllEntries)
                        factories.Clear();
                    factories.Add(factory);
                }
                owner.OnFactorySnapshotChanged(factory);
            }

            public void ReplaceEntries(IReadOnlyList<ITableEntry> oldEntries, IReadOnlyList<ITableEntry> newEntries)
            {
                var factory = new EntriesFactory(newEntries ?? Array.Empty<ITableEntry>());
                lock (gate)
                {
                    // nothing reliable to remove by identity here; just add the new view
                    factories.Add(factory);
                }
                owner.OnFactorySnapshotChanged(factory);
            }

            public void RemoveEntries(IReadOnlyList<ITableEntry> entries) { /* no-op */ }

            public void AddSnapshot(ITableEntriesSnapshot snapshot, bool removeAllSnapshots)
            {
                if (snapshot == null) return;

                var factory = new InlineSnapshotFactory(snapshot);
                lock (gate)
                {
                    if (removeAllSnapshots)
                        factories.Clear();
                    factories.Add(factory);
                }
                owner.OnFactorySnapshotChanged(factory);
            }

            public void ReplaceSnapshot(ITableEntriesSnapshot oldSnapshot, ITableEntriesSnapshot newSnapshot)
            {
                if (newSnapshot == null) return;

                var factory = new InlineSnapshotFactory(newSnapshot);
                lock (gate)
                {
                    // try to remove the old one if we can find it
                    var toRemove = factories.OfType<InlineSnapshotFactory>()
                        .Where(f => ReferenceEquals(f.Snapshot, oldSnapshot))
                        .ToList();
                    foreach (var f in toRemove) factories.Remove(f);

                    factories.Add(factory);
                }
                owner.OnFactorySnapshotChanged(factory);
            }

            public void RemoveSnapshot(ITableEntriesSnapshot oldSnapshot) { /* no-op */ }

            public void RemoveAllEntries() { /* no-op */ }

            public void RemoveAllFactories()
            {
                lock (gate) factories.Clear();
            }

            public void RemoveAllSnapshots() { /* no-op */ }

            // Helper to expose our factories to the reader
            public IReadOnlyCollection<ITableEntriesSnapshotFactory> GetFactoriesSnapshot()
            {
                lock (gate)
                    return factories.ToArray();
            }

            private void Notify(IReadOnlyList<ITableEntry> entries)
            {
                if (entries == null || entries.Count == 0)
                    return;
                // Wrap the entries in a one-off snapshot so the owner can scan them
                owner.OnFactorySnapshotChanged(new EntriesFactory(entries));
            }

            public void Dispose()
            {
                lock (gate)
                {
                    foreach (var f in factories.OfType<IDisposable>())
                        f.Dispose();
                    factories.Clear();
                }
            }

            // Minimal wrappers so we can reuse the same reading code path:

            private sealed class EntriesFactory : ITableEntriesSnapshotFactory
            {
                private readonly ITableEntriesSnapshot snap;
                public EntriesFactory(IReadOnlyList<ITableEntry> entries) => snap = new EntriesSnapshot(entries);
                public int CurrentVersionNumber => 0;
                public ITableEntriesSnapshot GetCurrentSnapshot() => snap;
                public ITableEntriesSnapshot GetSnapshot(int versionNumber) => snap;
                public void Dispose() => snap.Dispose();

                private sealed class EntriesSnapshot : ITableEntriesSnapshot
                {
                    private readonly IReadOnlyList<ITableEntry> entries;
                    public EntriesSnapshot(IReadOnlyList<ITableEntry> entries) => this.entries = entries;
                    public int Count => entries.Count;
                    public int VersionNumber => 0;
                    public void Dispose() { }
                    public void StartCaching() { }
                    public void StopCaching() { }
                    public int IndexOf(int currentIndex, ITableEntriesSnapshot newSnapshot) => currentIndex;
                    public bool TryGetValue(int index, string keyName, out object content) =>
                        entries[index].TryGetValue(keyName, out content);
                }
            }

            private sealed class InlineSnapshotFactory : ITableEntriesSnapshotFactory
            {
                public ITableEntriesSnapshot Snapshot { get; }  // expose for ReplaceSnapshot removal
                public InlineSnapshotFactory(ITableEntriesSnapshot snap) => Snapshot = snap;
                public int CurrentVersionNumber => Snapshot?.VersionNumber ?? 0;
                public ITableEntriesSnapshot GetCurrentSnapshot() => Snapshot;
                public ITableEntriesSnapshot GetSnapshot(int versionNumber) => Snapshot;
                public void Dispose() => Snapshot?.Dispose();
            }
        }

        private IEnumerable<ITableEntriesSnapshotFactory> GetAllFactories()
            => sinks.Values.SelectMany(s => s.GetFactoriesSnapshot());
    }
}
