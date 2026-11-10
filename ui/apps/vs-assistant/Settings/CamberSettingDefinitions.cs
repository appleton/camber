#pragma warning disable VSEXTPREVIEW_SETTINGS

using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Settings;

namespace Camber.Assistant.Settings
{
    internal static class CamberSettingDefinitions
    {
        [VisualStudioContribution]
        internal static SettingCategory CamberAssistant { get; } =
            new SettingCategory("camberAssistant", "Camber Assistant");

        [VisualStudioContribution]
        internal static Setting.String BaseUri { get; } =
            new Setting.String("baseUri", "Base URI", CamberAssistant, defaultValue: "")
            {
                Description = "The base URI of the Camber API",
            };

        [VisualStudioContribution]
        internal static Setting.Boolean WrapLines { get; } =
            new Setting.Boolean("wrapLines", "Wrap Lines", CamberAssistant, defaultValue: true)
            {
                Description = "Wrap lines in code snippets",
            };

        [VisualStudioContribution]
        internal static Setting.Boolean NotifyOnApproval { get; } =
            new Setting.Boolean("notifyOnApproval", "Notify On Approval", CamberAssistant, defaultValue: true)
            {
                Description = "Show a system notification when approval is needed and the window is not focused",
            };

        [VisualStudioContribution]
        internal static Setting.Boolean ShowMermaidDiagrams { get; } =
            new Setting.Boolean("showMermaidDiagrams", "Show Mermaid Diagrams", CamberAssistant, defaultValue: false)
            {
                Description = "Visualise Mermaid diagrams in code blocks (experimental)",
            };

        [VisualStudioContribution]
        internal static Setting.Enum ToolActivity { get; } =
            new Setting.Enum(
                "toolActivity",
                "Tool Activity",
                CamberAssistant,
                new[]
                {
                    new EnumSettingEntry("detailed", "Detailed"),
                    new EnumSettingEntry("grouped", "Grouped"),
                    new EnumSettingEntry("compact", "Compact"),
                },
                defaultValue: "grouped")
            {
                Description = "How much detail to show while the agent works. Finished replies always collapse into a summary.",
            };

        [VisualStudioContribution]
        internal static Setting.String DefaultWorkingDirectory { get; } =
            new Setting.String("defaultWorkingDirectory", "Default Working Directory", CamberAssistant, defaultValue: "")
            {
                Description = "Working directory the assistant uses when no folder or solution is open. Leave empty to use a scratch directory (%LOCALAPPDATA%\\camber\\scratch) so the assistant's file tools start there instead of at your profile directory.",
            };

        [VisualStudioContribution]
        internal static Setting.String AcpAgentServers { get; } =
            new Setting.String("acpAgentServers", "ACP Agent Servers", CamberAssistant, defaultValue: "")
            {
                Description = "Named ACP servers available to the Camber ACP client, as a JSON object (name -> { command, args, env, default_config_options }). Use {{SELF}} as the command for the bundled Camber agent. Leave empty to use the default.",
            };
    }
}
