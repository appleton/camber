using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace Camber.Assistant.Telemetry
{
    // Diagnostics are written to the "Camber Assistant Diagnostics" output window pane and
    // are never sent to a reporting service.
    internal class CamberTelemetryLogger
    {
        public static readonly CamberTelemetryLogger Instance = new CamberTelemetryLogger();

        private const string paneName = "Camber Assistant Diagnostics";
        private static Guid paneGuid = new Guid("E0360EA9-B75B-4748-A1E9-688FCA900626");

        private IVsOutputWindowPane outputPane;

        private CamberTelemetryLogger() { }

        public void reportError(Exception ex, Dictionary<string, object> data)
        {
            Write(ex.ToString());
            if (data != null)
                Write(JsonConvert.SerializeObject(data));
        }

        public void reportError(IDictionary<string, object> error, Dictionary<string, object> data)
        {
            if (error != null)
                Write(JsonConvert.SerializeObject(error));
            if (data != null)
                Write(JsonConvert.SerializeObject(data));
        }

        public void reportException(Exception ex) => reportError(ex, null);

        // Writes a diagnostic line to the output window pane. Debug.WriteLine is compiled out of
        // Release builds (the shipped VSIX), so the pane is the only sink that survives there.
        private void Write(string message)
        {
            var line = $"[{DateTime.Now:HH:mm:ss.fff}] {message}";
            Debug.WriteLine(line);
            _ = ThreadHelper.JoinableTaskFactory.StartOnIdle(() =>
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                var pane = GetOutputPane();
                if (pane == null)
                    return;
                pane.OutputStringThreadSafe($"{line}\n");
            });
        }

        // Lazily creates the output pane on first use. Must be called on the UI thread. Returns
        // null if the output window service isn't available (for example, during shutdown), in
        // which case the caller should just skip writing.
        private IVsOutputWindowPane GetOutputPane()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (outputPane != null)
                return outputPane;
            var outputWindow = Package.GetGlobalService(typeof(SVsOutputWindow)) as IVsOutputWindow;
            if (outputWindow == null)
                return null;
            outputWindow.CreatePane(ref paneGuid, paneName, 1, 1); // visible and clearWithSolution = true
            outputWindow.GetPane(ref paneGuid, out outputPane);
            return outputPane;
        }
    }
}
