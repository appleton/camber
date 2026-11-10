using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;
using Camber.Assistant.Context.Prompt;

namespace Camber.Assistant.Context
{
    internal abstract class GitBasedContextProvider : IPromptContextProvider
    {
        public abstract string GetEnrichedContextSource();
        public abstract Task<string> getCommandArgumentsAsync(string directory);
        public abstract List<ContextItem> buildContextItem(string output);
        public abstract PromptContextFacet buildContextFacet(List<ContextItem> items);

        public async Task<List<string>> GetRepoDirectoriesAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var dte = (EnvDTE.DTE)await CamberAssistantPackage.GetInstance().GetServiceAsync(typeof(EnvDTE.DTE));
            var fileName = Path.GetDirectoryName(dte.Solution.FileName);
            return new List<string> { fileName };
        }

        public async Task<PromptContextFacet> ProvideContextAsync(bool isNewConversation)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var directories = await GetRepoDirectoriesAsync();
            var contextItems = new List<ContextItem>();

            foreach (var repo in directories)
            {
                var result = await executeProcessAsync(repo);
                if (string.IsNullOrEmpty(result.Item2))
                {
                    contextItems.AddRange(buildContextItem(result.Item1));
                }
            }
            if (contextItems.Count == 0)
                return null;
            return buildContextFacet(contextItems);
        }

        public async Task<(string, string)> executeProcessAsync(string directory)
        {
            var arguments = await getCommandArgumentsAsync(directory);
            if (arguments == null)
                return (null, "No arguments");
            ProcessStartInfo processStartInfo = new ProcessStartInfo
            {
                FileName = "git",
                Arguments = arguments,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = directory
            };
            try
            {
                using (Process process = Process.Start(processStartInfo))
                {
                    string output = await process.StandardOutput.ReadToEndAsync();
                    string error = await process.StandardError.ReadToEndAsync();
                    process.WaitForExit();
                    return (output.TrimEnd('\n', '\r'), error);
                }
            }
            catch (System.Exception ex) when (ex is InvalidOperationException || ex is ArgumentNullException ||
                                              ex is ObjectDisposedException || ex is FileNotFoundException ||
                                              ex is Win32Exception || ex is ArgumentOutOfRangeException ||
                                              ex is InvalidOperationException || ex is SystemException)
            {
                return (null, ex.Message);
            }
        }
    }
}
