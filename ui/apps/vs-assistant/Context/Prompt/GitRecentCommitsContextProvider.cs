using Camber.Assistant.Context.Prompt;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;

namespace Camber.Assistant.Context
{
    internal class GitRecentCommitsContextProvider : GitBasedContextProvider
    {
        private readonly string PREFIX = "COMMIT-";

        public override PromptContextFacet buildContextFacet(List<ContextItem> items)
        {
            return new PromptContextFacet
            {
                description = "Commits on branch diverging from main branch",
                items = items,
                kind = "branch_commits",
                mime_type = "text/plain",
                source = GetEnrichedContextSource()
            };
        }

        public override List<ContextItem> buildContextItem(string output)
        {
            string[] lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            List<ContextItem> result = new List<ContextItem>();
            foreach (var commit in lines)
            {
                result.Add(
                    new ContextItem
                    {
                        content = commit.Substring(PREFIX.Length), path = null
                    });
            }
            return result;
        }

        public override async Task<string> getCommandArgumentsAsync(string directory)
        {
            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = "git",
                Arguments = "rev-parse --abbrev-ref origin/HEAD",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = directory
            };
            try
            {
                using (Process process = Process.Start(info))
                {
                    string output = await process.StandardOutput.ReadToEndAsync();
                    string error = await process.StandardError.ReadToEndAsync();
                    process.WaitForExit();
                    if (!string.IsNullOrEmpty(error))
                    {
                        return null;
                    }
                    else
                    {
                        return "log " + output.Substring("origin/".Length).TrimEnd('\n', '\r') + "..HEAD --pretty=format:" + PREFIX + "%s -10";
                    }
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        public override string GetEnrichedContextSource()
        {
            return "branch";
        }
    }
}
