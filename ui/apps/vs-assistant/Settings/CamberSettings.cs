using Microsoft.VisualStudio.Shell;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;

namespace Camber.Assistant.Settings
{
    public class CamberSettings : UIElementDialogPage, INotifyPropertyChanged
    {
        private static readonly string DEFAULT_DISABLED_ENRICHMENTS = string.Join(",", new string[]
        {
            "branch",
            "dependencies",
            "diagnostics",
            "local_search"
        });

        private string uri = "";
        private bool wrapLines = true;
        private bool showKeybindings = false;
        private string disabledEnrichments = DEFAULT_DISABLED_ENRICHMENTS;
        private bool displayedLocalSearchDisabledInfo = false;
        private bool notifyOnApproval = true;
        private bool showMermaidDiagrams = false;
        private string toolActivity = DEFAULT_TOOL_ACTIVITY;
        private string defaultWorkingDirectory = "";
        private string acpAgentServersJson = "";

        internal const string DEFAULT_TOOL_ACTIVITY = "grouped";

        private CamberSettingsEditor settingsEditor;

        // Set when OnApply cancels because the ACP agent servers JSON is invalid: ApplyKind.Cancel
        // makes VS re-activate this page, and OnActivate's reload would otherwise overwrite the
        // user's (invalid) text with the last-saved value, forcing them to retype it. We skip that
        // one reload so they can fix the JSON in place.
        private bool suppressNextReload;

        public event PropertyChangedEventHandler PropertyChanged;

        protected void OnPropertyChanged(string propertyName)
        {
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
        }

        [Category("Camber Settings")]
        [DisplayName("Base URI")]
        [Description("The base URI of the Camber API")]
        public string Uri
        {
            get { return uri; }
            set {
                if (uri != value)
                {
                    uri = value;
                    OnPropertyChanged(nameof(Uri));
                }
            }
        }

        [Category("Camber Settings")]
        [DisplayName("Wrap Lines")]
        [Description("Wrap lines in code snippets")]
        public bool WrapLines
        {
            get { return wrapLines; }
            set {
                if (wrapLines != value)
                {
                    wrapLines = value;
                    OnPropertyChanged(nameof(WrapLines));
                }
            }
        }

        [Browsable(false)]
        public bool ShowKeybindings
        {
            get { return showKeybindings; }
            set {
                if (showKeybindings != value)
                {
                    showKeybindings = value;
                    OnPropertyChanged(nameof(ShowKeybindings));
                }
            }
        }

        // Visual Studio's settings mechanism won't serialize a list for us, so we have to have a string property and
        // a convenience front.
        [Browsable(false)]
        public string DisabledEnrichmentsString
        {
            get { return disabledEnrichments; }
            set
            {
                if (disabledEnrichments != value)
                {
                    disabledEnrichments = value;
                    OnPropertyChanged(nameof(DisabledEnrichmentsString));
                }
            }
        }
        [Browsable(false)]
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
        public List<string> DisabledEnrichments
        {
            get { return DisabledEnrichmentsString.Split(',').ToList(); }
            set
            {
                var serializedFrom = string.Join(",", value);
                if (serializedFrom != DisabledEnrichmentsString)
                {
                    DisabledEnrichmentsString = serializedFrom;
                    OnPropertyChanged(nameof(DisabledEnrichments));
                }
            }
        }

        [Browsable(false)]
        public bool DisplayedLocalSearchDisabledInfo
        {
            get { return displayedLocalSearchDisabledInfo; }
            set {
                if (displayedLocalSearchDisabledInfo != value)
                {
                    displayedLocalSearchDisabledInfo = value;
                    OnPropertyChanged(nameof(DisplayedLocalSearchDisabledInfo));
                }
            }
        }

        [Category("Camber Settings")]
        [DisplayName("Notify On Approval")]
        [Description("Show a system notification when approval is needed and the window is not focused")]
        public bool NotifyOnApproval
        {
            get { return notifyOnApproval; }
            set
            {
                if (notifyOnApproval != value)
                {
                    notifyOnApproval = value;
                    OnPropertyChanged(nameof(NotifyOnApproval));
                }
            }
        }

        [Category("Camber Settings")]
        [DisplayName("Show Mermaid Diagrams")]
        [Description("Visualise Mermaid diagrams in code blocks (experimental)")]
        public bool ShowMermaidDiagrams
        {
            get { return showMermaidDiagrams; }
            set
            {
                if (showMermaidDiagrams != value)
                {
                    showMermaidDiagrams = value;
                    OnPropertyChanged(nameof(ShowMermaidDiagrams));
                }
            }
        }

        // How much detail to show while the agent works: "detailed", "grouped", or "compact".
        // Stored as a string so new modes are just new values; the webview treats any
        // unrecognized value as "grouped".
        [Category("Camber Settings")]
        [DisplayName("Tool Activity")]
        [Description("How much detail to show while the agent works: detailed, grouped, or compact")]
        public string ToolActivity
        {
            get { return toolActivity; }
            set
            {
                if (toolActivity != value)
                {
                    toolActivity = value;
                    OnPropertyChanged(nameof(ToolActivity));
                }
            }
        }

        [Category("Camber Settings")]
        [DisplayName("Default Working Directory")]
        [Description("Working directory the assistant uses when no folder or solution is open. Leave empty to use a scratch directory (%LOCALAPPDATA%\\camber\\scratch) so the assistant's file tools start there instead of at your profile directory.")]
        public string DefaultWorkingDirectory
        {
            get { return defaultWorkingDirectory; }
            set
            {
                if (defaultWorkingDirectory != value)
                {
                    defaultWorkingDirectory = value;
                    OnPropertyChanged(nameof(DefaultWorkingDirectory));
                }
            }
        }

        // ACP agent servers as a JSON object (name -> { command, args, env, ... }), mirroring
        // VSCode's camber.agentServers setting. Stored as a string because VS settings can't
        // serialize nested objects; edited via the settings editor and parsed in
        // HelperConfiguration.Build(). Browsable(false): surfaced through the custom editor UI,
        // not the property grid.
        [Browsable(false)]
        public string AcpAgentServersJson
        {
            get { return acpAgentServersJson; }
            set
            {
                if (acpAgentServersJson != value)
                {
                    acpAgentServersJson = value;
                    OnPropertyChanged(nameof(AcpAgentServersJson));
                }
            }
        }

        // Restores every persisted setting to its default value. Mirrors VS Code's
        // camber.resetConfiguration command (which clears all camber.* config keys).
        // Each assignment fires PropertyChanged, so the reset propagates to Unified Settings
        // and the webview exactly like a manual edit; callers persist the legacy
        // store via SaveSettingsToStorage().
        internal void ResetToDefaults()
        {
            Uri = "";
            WrapLines = true;
            ShowKeybindings = false;
            DisabledEnrichmentsString = DEFAULT_DISABLED_ENRICHMENTS;
            DisplayedLocalSearchDisabledInfo = false;
            NotifyOnApproval = true;
            ShowMermaidDiagrams = false;
            ToolActivity = DEFAULT_TOOL_ACTIVITY;
            DefaultWorkingDirectory = "";
            AcpAgentServersJson = "";
        }

        protected override UIElement Child
        {
            get
            {
                if (settingsEditor == null)
                {
                    settingsEditor = new CamberSettingsEditor(this);
                }
                return settingsEditor;
            }
        }

        protected override void OnActivate(System.ComponentModel.CancelEventArgs e)
        {
            // Reload from saved settings when the page is opened so external changes show up, but
            // not right after a cancelled apply (see suppressNextReload), where it would wipe the
            // user's in-progress edits.
            if (suppressNextReload)
            {
                suppressNextReload = false;
            }
            else
            {
                settingsEditor?.LoadSettings();
            }
            base.OnActivate(e);
        }

        protected override void OnApply(PageApplyEventArgs e)
        {
            // Block saving an invalid ACP agent servers JSON. The helper would otherwise
            // silently discard it and fall back to defaults, which looks like the setting was
            // ignored; cancelling the apply keeps the dialog open so the user can fix it.
            if (settingsEditor != null && !settingsEditor.IsAgentServersValid(out var error))
            {
                e.ApplyBehavior = ApplyKind.Cancel;
                // Cancel re-activates this page; keep the user's text so they can fix it in place
                // instead of having it reset to the last-saved value.
                suppressNextReload = true;
                System.Windows.MessageBox.Show(
                    "ACP agent servers JSON is invalid and was not saved:\n\n" + error +
                        "\n\nFix the JSON or clear the field.",
                    "Camber Assistant",
                    System.Windows.MessageBoxButton.OK,
                    System.Windows.MessageBoxImage.Warning);
                base.OnApply(e);
                return;
            }

            settingsEditor?.SaveSettings();
            base.OnApply(e);
        }

        protected override void OnClosed(EventArgs e)
        {
            // Make sure UI is re-sync'd with the settings as they actually are (this is called after
            // OnApply in the event the user uses OK to apply settings, so they will already have been
            // updated; in the event they cancel, this restores the original settings).
            settingsEditor?.LoadSettings();
            base.OnClosed(e);
        }

        internal WebViewConfiguration GetWebViewConfiguration()
        {
            return new WebViewConfiguration
            {
                uri = uri,
                wrapLines = wrapLines,
                notifyOnApproval = notifyOnApproval,
                showMermaidDiagrams = showMermaidDiagrams,
                toolActivity = toolActivity
            };
        }
    }
}
