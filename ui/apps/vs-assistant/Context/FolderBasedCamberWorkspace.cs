using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Camber.Assistant.Context
{
    internal class FolderBasedCamberWorkspace : ICamberWorkspace
    {
        private readonly string workspacePath;

        public FolderBasedCamberWorkspace(string workspacePath)
        {
            this.workspacePath = Util.TrimTrailingPathSlash(workspacePath);
        }

        public string RootPath
        {
            get { return workspacePath; }
        }

        public string Name
        {
            get { return GetDirectoryName(workspacePath); }
        }

        public IEnumerable<AdditionalWorkspace> AdditionalWorkspaces
        {
            get { return Enumerable.Empty<AdditionalWorkspace>(); }
        }

        public bool IsPathInWorkspace(string path)
        {
            return path.StartsWith(workspacePath, StringComparison.OrdinalIgnoreCase);
        }

        public IEnumerable<WorkspaceItem> EnumerateWorkspaceItems(Dictionary<IgnoredContext.IgnoreTarget, HashSet<Regex>> ignored)
        {
            return EnumerateDirectory(workspacePath, ignored);
        }

        private IEnumerable<WorkspaceItem> EnumerateDirectory(string path, Dictionary<IgnoredContext.IgnoreTarget, HashSet<Regex>> ignored)
        {
            DirectoryInfo info;
            try
            {
                info = new DirectoryInfo(path);
            }
            catch (SecurityException)
            {
                yield break;
            }
            foreach (var file in info.EnumerateFiles())
            {
                yield return new WorkspaceItem(workspacePath, file.FullName, WorkspaceItemKind.File);
            }
            foreach (var directory in info.EnumerateDirectories())
            {
                if (ignored[IgnoredContext.IgnoreTarget.Directory].Any(r => r.IsMatch(directory.Name)))
                    continue;
                yield return new WorkspaceItem(workspacePath, directory.FullName, WorkspaceItemKind.Directory);
                foreach (var item in EnumerateDirectory(directory.FullName, ignored))
                    yield return item;
            }
        }

        private static string GetDirectoryName(string path)
        {
            return string.IsNullOrEmpty(path)
                ? string.Empty
                : Path.GetFileName(Util.TrimTrailingPathSlash(path));
        }

        public void EnsureFileIsRegistered(string filePath)
        {
            // For folders, there's no project file, so nothing needs to be done.
        }

        public void EnsureFileIsNotRegistered(string filePath)
        {
            // For folders, there's no project file, however by default any editor for the file will
            // be left open; make sure to close it.
            Util.CloseEditorsForFile(filePath, false);
        }
    }
}
