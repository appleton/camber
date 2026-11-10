using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Navigation;
using System.Windows.Shapes;

namespace Camber.Assistant.Settings
{
    /// <summary>
    /// Interaction logic for CamberSettingsEditor.xaml
    /// </summary>
    public partial class CamberSettingsEditor : UserControl
    {
        private readonly CamberSettings settings;

        public CamberSettingsEditor(CamberSettings settings)
        {
            InitializeComponent();
            this.settings = settings;
            LoadSettings();
        }

        public void LoadSettings()
        {
            UriTextBox.Text = settings.Uri;
            DefaultWorkingDirectoryTextBox.Text = settings.DefaultWorkingDirectory;
            WrapLinesCheckBox.IsChecked = settings.WrapLines;
            NotifyOnApprovalCheckBox.IsChecked = settings.NotifyOnApproval;
            ShowMermaidDiagramsCheckBox.IsChecked = settings.ShowMermaidDiagrams;
            SelectToolActivity(settings.ToolActivity);
            AcpAgentServersTextBox.Text = settings.AcpAgentServersJson;
            UpdateAgentServersValidation();
        }

        public void SaveSettings()
        {
            settings.Uri = UriTextBox.Text;
            settings.DefaultWorkingDirectory = DefaultWorkingDirectoryTextBox.Text;
            settings.WrapLines = WrapLinesCheckBox.IsChecked ?? false;
            settings.NotifyOnApproval = NotifyOnApprovalCheckBox.IsChecked ?? false;
            settings.ShowMermaidDiagrams = ShowMermaidDiagramsCheckBox.IsChecked ?? false;
            settings.ToolActivity = SelectedToolActivity();
            settings.AcpAgentServersJson = AcpAgentServersTextBox.Text;
        }

        // Selects the combo item whose Tag matches the stored mode, falling back to the
        // default when the value is empty or unrecognized (e.g. a mode added later).
        private void SelectToolActivity(string mode)
        {
            var target = string.IsNullOrEmpty(mode) ? CamberSettings.DEFAULT_TOOL_ACTIVITY : mode;
            foreach (ComboBoxItem item in ToolActivityComboBox.Items)
            {
                if (string.Equals(item.Tag as string, target, StringComparison.OrdinalIgnoreCase))
                {
                    ToolActivityComboBox.SelectedItem = item;
                    return;
                }
            }
            // Unknown stored value: show the default rather than leaving the box blank.
            foreach (ComboBoxItem item in ToolActivityComboBox.Items)
            {
                if (string.Equals(item.Tag as string, CamberSettings.DEFAULT_TOOL_ACTIVITY, StringComparison.OrdinalIgnoreCase))
                {
                    ToolActivityComboBox.SelectedItem = item;
                    return;
                }
            }
        }

        private string SelectedToolActivity()
        {
            return (ToolActivityComboBox.SelectedItem as ComboBoxItem)?.Tag as string
                ?? CamberSettings.DEFAULT_TOOL_ACTIVITY;
        }

        // True when the ACP agent servers JSON is empty or a well-formed value matching the
        // expected schema. The dialog page calls this from OnApply to block saving an invalid
        // value (which the helper would otherwise silently drop, falling back to defaults).
        public bool IsAgentServersValid(out string error)
        {
            return ValidateAgentServersJson(AcpAgentServersTextBox.Text, out error);
        }

        private void AcpAgentServersTextBox_TextChanged(object sender, TextChangedEventArgs e)
        {
            UpdateAgentServersValidation();
        }

        // Re-validates the textbox and shows/hides the inline error message accordingly.
        private bool UpdateAgentServersValidation()
        {
            // Guard against a TextChanged firing mid-initialization, before the named elements
            // are assigned.
            if (AcpAgentServersTextBox == null || AcpAgentServersError == null)
                return true;
            var valid = ValidateAgentServersJson(AcpAgentServersTextBox.Text, out var error);
            AcpAgentServersError.Text = valid ? string.Empty : error;
            AcpAgentServersError.Visibility = valid ? Visibility.Collapsed : Visibility.Visible;
            return valid;
        }

        // Validates the user's ACP agent servers JSON against the same schema VSCode enforces
        // for camber.agentServers: an object mapping a server name to { command (required
        // string), args (string[]), env (string map), default_config_options (string map) }.
        // Unknown fields are allowed so newer server options pass through. Empty input is valid
        // (the helper then uses its registry defaults).
        private static bool ValidateAgentServersJson(string json, out string error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(json))
                return true;

            JToken root;
            try
            {
                root = JToken.Parse(json);
            }
            catch (JsonException ex)
            {
                error = "Invalid JSON: " + ex.Message;
                return false;
            }

            if (root.Type != JTokenType.Object)
            {
                error = "Expected a JSON object mapping server names to their configuration.";
                return false;
            }

            foreach (var entry in ((JObject)root).Properties())
            {
                var name = entry.Name;
                if (entry.Value.Type != JTokenType.Object)
                {
                    error = $"Server \"{name}\" must be an object.";
                    return false;
                }
                var server = (JObject)entry.Value;

                var command = server["command"];
                if (command == null || command.Type != JTokenType.String ||
                    string.IsNullOrEmpty(command.Value<string>()))
                {
                    error = $"Server \"{name}\" requires a non-empty string \"command\".";
                    return false;
                }

                var args = server["args"];
                if (args != null && args.Type != JTokenType.Null)
                {
                    if (args.Type != JTokenType.Array ||
                        ((JArray)args).Any(a => a.Type != JTokenType.String))
                    {
                        error = $"Server \"{name}\": \"args\" must be an array of strings.";
                        return false;
                    }
                }

                foreach (var mapField in new[] { "env", "default_config_options" })
                {
                    var map = server[mapField];
                    if (map != null && map.Type != JTokenType.Null)
                    {
                        if (map.Type != JTokenType.Object ||
                            ((JObject)map).Properties().Any(p => p.Value.Type != JTokenType.String))
                        {
                            error = $"Server \"{name}\": \"{mapField}\" must be an object of string values.";
                            return false;
                        }
                    }
                }
            }

            return true;
        }
    }
}