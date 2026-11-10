using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Camber.Assistant.Context
{
    /// <summary>
    /// An abstraction over the solution/project model and the workspace folder model.
    /// </summary>
    internal interface ICamberWorkspace
    {
        /// <summary>
        /// Get the root path of the workspace. This is the directory that the helper will be started in.
        /// </summary>
        string RootPath { get; }

        /// <summary>
        /// Get a display name for this workspace.
        /// </summary>
        string Name { get; }

        /// <summary>
        /// A possibly empty list of additional workspaces, corresponding to projects whose root directory
        /// lies outside the primary workspace root. These are passed to the helper as additional LSP workspace
        /// folders and to the assistant as additional workspace paths.
        /// </summary>
        IEnumerable<AdditionalWorkspace> AdditionalWorkspaces { get; }

        /// <summary>
        /// Checks if a path falls within the workspace.
        /// </summary>
        /// <param name="path"></param>
        /// <returns></returns>
        bool IsPathInWorkspace(string path);

        /// <summary>
        /// Iterate the files and directories in the workspace, as a flat list of them all.
        /// Skips files and directories with names passed in the `ignored` set.
        /// </summary>
        /// <returns></returns>
        IEnumerable<WorkspaceItem> EnumerateWorkspaceItems(Dictionary<IgnoredContext.IgnoreTarget, HashSet<Regex>> ignored);

        /// <summary>
        /// Takes any actions needed to make sure a file is registered in the workspace. For a Visual
        /// Studio project or solution, we need to make sure it is added to the appropriate project file,
        /// for instance. It is safe to call this on files already included in such.
        /// </summary>
        /// <param name="filePath"></param>
        void EnsureFileIsRegistered(string filePath);

        /// <summary>
        /// Takes any actions needed to make sure a file is not registered in the workspace. For a Visual
        /// Studio project or solution, we need to make sure it is removed from the appropriate project file
        /// if it is present,
        /// </summary>
        void EnsureFileIsNotRegistered(string filePath);
    }

    /// <summary>
    /// A workspace root that is additional to the primary workspace root, typically a project
    /// directory that lives outside the solution directory.
    /// </summary>
    internal class AdditionalWorkspace
    {
        internal AdditionalWorkspace(string name, string path)
        {
            this.Name = name;
            this.Path = path;
        }

        internal string Name { get; private set; }
        internal string Path { get; private set; }
    }

    /// <summary>
    /// A workspace item (file or directory).
    /// </summary>
    internal class WorkspaceItem
    {
        /// <summary>
        /// What kind of item is it?
        /// </summary>
        internal WorkspaceItemKind Kind { get; private set; }

        /// <summary>
        /// The full path to the item.
        /// </summary>
        internal string FullPath { get; private set; }

        /// <summary>
        /// The path of the workspce or sub-workspce that the item belongs to.
        /// </summary>
        internal string WorkspacePath { get; private set; }

        internal WorkspaceItem(string workspacePath, string fullPath, WorkspaceItemKind kind)
        {
            this.WorkspacePath = workspacePath;
            this.FullPath = fullPath;
            this.Kind = kind;
        }
    }

    /// <summary>
    /// The kind of a workspace item.
    /// </summary>
    enum WorkspaceItemKind
    {
        Directory,
        File
    }
}
