using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Camber.Assistant.Context
{
    internal class SolutionBasedCamberWorkspace : ICamberWorkspace
    {
        /// <summary>
        /// The path to the workspace root (the solution directory), provided to the helper.
        /// </summary>
        private readonly string workspacePath;

        /// <summary>
        /// A name for the workspace.
        /// </summary>
        private readonly string name;

        /// <summary>
        /// Projects whose root directory lies outside the solution directory, treated as additional
        /// workspace roots for the helper and assistant.
        /// </summary>
        private readonly AdditionalWorkspace[] additionalWorkspaces;

        /// <summary>
        /// A mapping from project file path to the root path calculated for that project. If it's a project
        /// that includes files from a directory from outside of its path, the root path will account for it.
        /// </summary>
        private Dictionary<string, string> projectRootPaths = new Dictionary<string, string>();

        internal SolutionBasedCamberWorkspace(IVsSolution solution)
        {
            // The solution directory is always the primary workspace root. Projects outside that directory
            // become additional workspace roots rather than pulling the root up to a common ancestor.
            ThreadHelper.ThrowIfNotOnUIThread();
            solution.GetSolutionInfo(out var directory, out var solutionFile, out _);
            this.workspacePath = Util.TrimTrailingPathSlash(directory);

            // Store name of the solution in properties, since we might still end up trying to form
            // context while closing, and the solution will return nulls then.
            if (solutionFile != null)
            {
                this.name = Path.GetFileNameWithoutExtension(solutionFile);
            }
            else
            {
                this.name = Path.GetFileName(directory);
            }

            // Identify projects whose root lies outside the solution directory. These become additional
            // workspace roots passed to both the helper and the assistant.
            var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var external = new List<AdditionalWorkspace>();
            foreach (var p in GetAllProjectsInSolution())
            {
                try
                {
                    var fullName = p.Project.FullName;
                    if (!string.IsNullOrEmpty(fullName) &&
                        !string.IsNullOrEmpty(p.RootPath) &&
                        !p.RootPath.StartsWith(this.workspacePath, StringComparison.OrdinalIgnoreCase) &&
                        seenPaths.Add(p.RootPath))
                    {
                        external.Add(new AdditionalWorkspace(Path.GetFileNameWithoutExtension(fullName), p.RootPath));
                    }
                }
                catch (NotImplementedException) { /* Skip projects that don't support FullName */ }
                catch (COMException) { /* Skip inaccessible projects */ }
            }
            this.additionalWorkspaces = external.ToArray();
        }

        public string RootPath { get { return workspacePath; } }

        public string Name { get { return name; } }

        public IEnumerable<AdditionalWorkspace> AdditionalWorkspaces => additionalWorkspaces;

        public bool IsPathInWorkspace(string path)
        {
            if (path.StartsWith(workspacePath, StringComparison.OrdinalIgnoreCase))
                return true;
            foreach (var additional in additionalWorkspaces)
            {
                if (path.StartsWith(additional.Path, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        public IEnumerable<WorkspaceItem> EnumerateWorkspaceItems(Dictionary<IgnoredContext.IgnoreTarget, HashSet<Regex>> ignored)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            foreach (var project in GetAllProjectsInSolution())
            {
                foreach (var workspaceItem in EnumerateProjectItems(project.Project, project.RootPath, ignored))
                {
                    yield return workspaceItem;
                }
            }
        }

        /// <summary>
        /// Holds information about a project, including the DTE project reference.
        /// </summary>
        private class ProjectInfo
        {
            /// <summary>
            /// The DTE Project object for the project.
            /// </summary>
            public Project Project { get; set; }
            /// <summary>
            /// The root path for files contained in the project.
            /// </summary>
            public string RootPath { get; set; }
        }

        /// <summary>
        /// Gets all projects in the current solution. Traverses solution folders to ensure that we reliably find
        /// them all. If a project is not loaded, it is handled gracefully.
        /// </summary>
        /// <returns></returns>
        private IEnumerable<ProjectInfo> GetAllProjectsInSolution()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dte = (DTE2)ServiceProvider.GlobalProvider.GetService(typeof(DTE));
            var projects = dte.Solution?.Projects;
            if (projects != null)
            {
                foreach (Project project in projects)
                {
                    if (project != null)
                    {
                        foreach (var p in GetAllProjectsFromItem(project))
                            yield return p;
                    }
                }
            }
        }

        private IEnumerable<ProjectInfo> GetAllProjectsFromItem(Project project)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (project.Kind == ProjectKinds.vsProjectKindSolutionFolder)
            {
                foreach (ProjectItem item in project.ProjectItems)
                {
                    var subProject = item.SubProject;
                    if (subProject != null)
                    {
                        foreach (var nested in GetAllProjectsFromItem(subProject))
                            yield return nested;
                    }
                }
            }
            else
            {
                string path = null;
                try
                {
                    if (!string.IsNullOrEmpty(project.FullName) && project.FullName.Contains(":"))
                    {
                        path = GetProjectRootPath(project);
                    }
                }
                catch (NotImplementedException) { /* Skip projects that aren't real */ }
                catch (COMException) { /* Some projects might not be accessible */ }
                if (!string.IsNullOrEmpty(path))
                {
                    yield return new ProjectInfo
                    {
                        Project = project,
                        RootPath = path
                    };
                }
            }
        }

        private static bool IsExternalCachePath(string fullPath)
        {
            return !string.IsNullOrEmpty(fullPath)
                && fullPath.IndexOf(@"\.nuget\packages\", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private string GetProjectRootPath(Project project)
        {
            // See if we already calculated and cached it.
            ThreadHelper.ThrowIfNotOnUIThread();
            if (projectRootPaths.TryGetValue(project.FullName, out var path))
                return path;

            // No, so we need to calculate the base path by looking at all files. (We reuse the code used for file
            // searching, but put an empty string into the sub-workspace path argument, as that's what we're using
            // the code to determine in this context). NuGet content references resolved from the global package
            // cache (~\.nuget\packages\...) are excluded — otherwise a project that consumes such a package drags
            // the common-prefix workspace root up to the user home directory.
            path = GetCommonPathPrefix(EnumerateProjectItems(project, string.Empty, IgnoredContext.IGNORE_PATTERNS)
                .Where(i => i.Kind == WorkspaceItemKind.File && !IsExternalCachePath(i.FullPath))
                .Select(i => Path.GetDirectoryName(i.FullPath))
                .Where(d => !string.IsNullOrEmpty(d))
                .ToList());

            // Cache it for next time.
            projectRootPaths.Add(project.FullName, path);

            return path;
        }

        private IEnumerable<WorkspaceItem> EnumerateProjectItems(Project project, string rootPath, Dictionary<IgnoredContext.IgnoreTarget, HashSet<Regex>> ignored)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var projectItems = project.ProjectItems;
            if (projectItems != null)
            {
                foreach (ProjectItem projectItem in projectItems)
                {
                    foreach (var workspaceItem in Util.EnumerateWithErrorsHandled(EnumerateProjectItems(projectItem, rootPath, ignored)))
                    {
                        yield return workspaceItem;
                    }
                }
            }
        }

        private IEnumerable<WorkspaceItem> EnumerateProjectItems(ProjectItem item, string subWorkspacePath, Dictionary<IgnoredContext.IgnoreTarget, HashSet<Regex>> ignored)
        {
            // Produce the workspace item.
            ThreadHelper.ThrowIfNotOnUIThread();
            if (item.Kind == EnvDTE.Constants.vsProjectItemKindPhysicalFile)
            {
                for (short i = 0; i < item.FileCount; i++)
                {
                    var fullName = item.FileNames[i];
                    if (!ignored[IgnoredContext.IgnoreTarget.File].Any(r => r.IsMatch(item.Name)))
                        yield return new WorkspaceItem(subWorkspacePath, fullName, WorkspaceItemKind.File);
                }
            }
            else if (item.Kind == EnvDTE.Constants.vsProjectItemKindPhysicalFolder)
            {
                if (ignored[IgnoredContext.IgnoreTarget.Directory].Any(r => r.IsMatch(item.Name)))
                    yield break;
                var fullName = item.FileNames[0];
                yield return new WorkspaceItem(subWorkspacePath, fullName, WorkspaceItemKind.Directory);
            }

            // Visit sub-items whether directory or file, as sometimes files have sub-items
            // (such as the code-behind for forms).
            var projectItems = item.ProjectItems;
            if (projectItems != null)
            {
                foreach (ProjectItem subItem in projectItems)
                {
                    foreach (var worksapceItem in EnumerateProjectItems(subItem, subWorkspacePath, ignored))
                    {
                        yield return worksapceItem;
                    }
                }
            }
        }

        private static string GetCommonPathPrefix(List<string> paths)
        {
            if (paths == null || paths.Count == 0)
                return string.Empty;

            // Split each path into parts
            var separatedPaths = paths
                .Select(path => Path.GetFullPath(path)
                                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                                    .Split(Path.DirectorySeparatorChar))
                .ToList();

            // Find the minimum length to avoid index out of range
            int minLength = separatedPaths.Min(parts => parts.Length);

            var commonParts = new List<string>();
            for (int i = 0; i < minLength; i++)
            {
                var currentPart = separatedPaths[0][i];
                if (separatedPaths.All(parts => string.Equals(parts[i], currentPart, StringComparison.OrdinalIgnoreCase)))
                {
                    commonParts.Add(currentPart);
                }
                else
                {
                    break;
                }
            }

            if (commonParts.Count == 0)
                return string.Empty;

            return string.Join(Path.DirectorySeparatorChar.ToString(), commonParts);
        }

        public void EnsureFileIsRegistered(string filePath)
        {
            if (IsSolutionOrProjectFile(filePath))
                return;
            ThreadHelper.ThrowIfNotOnUIThread();
            var existingItem = FindProjectItem(filePath);
            if (existingItem == null)
            {
                AddFileToClosestProject(filePath);
            }
        }

        public void EnsureFileIsNotRegistered(string filePath)
        {
            if (IsSolutionOrProjectFile(filePath))
                return;
            ThreadHelper.ThrowIfNotOnUIThread();
            FindProjectItem(filePath)?.Delete();
        }

        private static readonly string[] ProjectFileExtensions = new[]
        {
            ".sln",     // Solution
            ".csproj",  // C#
            ".vbproj",  // Visual Basic
            ".fsproj",  // F#
            ".vcxproj", // C++ (new)
            ".vcproj",  // C++ (legacy)
            ".vcxitems",// Shared C++ items
            ".shproj",  // Shared project
            ".sqlproj", // SQL Server Database
            ".dbproj",  // Legacy SQL project
            ".wixproj", // WiX Installer
            ".dtproj",  // SSIS
            ".rptproj", // SSRS
            ".smproj",  // SQL Server Management Studio
            ".synproj", // Synapse Analytics
            ".pyproj",  // Python
            ".njsproj"  // Node.js
        };

        private static bool IsSolutionOrProjectFile(string filePath)
        {
            if (string.IsNullOrWhiteSpace(filePath))
                return false;

            string ext = Path.GetExtension(filePath);
            return Array.Exists(ProjectFileExtensions, e =>
                string.Equals(e, ext, StringComparison.OrdinalIgnoreCase));
        }

        private static ProjectItem FindProjectItem(string filePath)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dte = (DTE)ServiceProvider.GlobalProvider.GetService(typeof(DTE));
            foreach (Project project in dte.Solution.Projects)
            {
                var item = FindInProject(project, filePath);
                if (item != null)
                    return item;
            }
            return null;
        }

        private static ProjectItem FindInProject(Project project, string filePath)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            foreach (ProjectItem item in project.ProjectItems)
            {
                var itemPath = item.FileNames[1]; // 1-based index
                if (string.Equals(itemPath, filePath, StringComparison.OrdinalIgnoreCase))
                    return item;

                if (item.ProjectItems != null)
                {
                    var found = FindInProjectItems(item.ProjectItems, filePath);
                    if (found != null)
                        return found;
                }
            }
            return null;
        }

        private static ProjectItem FindInProjectItems(ProjectItems items, string filePath)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            foreach (ProjectItem item in items)
            {
                var itemPath = item.FileNames[1];
                if (string.Equals(itemPath, filePath, StringComparison.OrdinalIgnoreCase))
                    return item;

                if (item.ProjectItems != null)
                {
                    var found = FindInProjectItems(item.ProjectItems, filePath);
                    if (found != null)
                        return found;
                }
            }
            return null;
        }

        private void AddFileToClosestProject(string filePath)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var project = FindContainingProject(filePath);
            project?.ProjectItems?.AddFromFile(filePath);
        }

        // A cache of which directories a project has files in. This is used to help us handle
        // cases where the project file references files in directories outside of the project
        // directory itself. There's only so much we can do in that case, but this gives us a
        // chance of doing something useful.
        private Dictionary<string, HashSet<string>> projectDirectories = new Dictionary<string, HashSet<string>>();

        private Project FindContainingProject(string filePath)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            Project bestMatch = null;
            var longestMatchLength = 0;
            foreach (var project in this.GetAllProjectsInSolution())
            {
                var key = project.Project.FullName;
                if (string.IsNullOrEmpty(key))
                    continue;
                var directories = projectDirectories.ContainsKey(key)
                    ? projectDirectories[key]
                    : CalculateAndCacheProjectDirectories(key, project.Project);
                foreach (var projectDir in directories)
                {
                    if (filePath.StartsWith(projectDir, StringComparison.OrdinalIgnoreCase))
                    {
                        var matchLength = projectDir.Length;
                        if (matchLength > longestMatchLength)
                        {
                            bestMatch = project.Project;
                            longestMatchLength = matchLength;
                        }
                    }
                }
            }

            return bestMatch;
        }

        private HashSet<string> CalculateAndCacheProjectDirectories(string key, Project project)
        {
            var directories = new HashSet<string>();
            foreach (var item in EnumerateProjectItems(project, "", IgnoredContext.IGNORE_PATTERNS))
            {
                if (item.Kind == WorkspaceItemKind.Directory)
                {
                    directories.Add(item.FullPath);
                }
                else if (item.Kind == WorkspaceItemKind.File)
                {
                    // While you might hope the above would suffice, projects that
                    // explicitly reference a set of files only (e.g. a CMake generated
                    // project) don't have the directory items.
                    var directory = Path.GetDirectoryName(item.FullPath);
                    if (!string.IsNullOrEmpty(directory))
                        directories.Add(directory);
                }
            }
            projectDirectories.Add(key, directories);
            return directories;
        }
    }
}
