using Microsoft.VisualStudio.Settings;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Settings;
using System;

namespace Camber.Assistant.Settings
{
    // Persists the currently selected ACP agent id across IDE sessions. The agent itself is
    // chosen in the webview (ACP chat); the host only remembers its id so it can seed the helper
    // configuration and the webview's initial state on startup.
    internal class CurrentAgentStore
    {
        private const string CollectionPath = "CamberAssistant.Models";
        private const string AgentModelIdKey = "AgentModelId";
        private readonly WritableSettingsStore settingsStore;

        private static CurrentAgentStore instance;

        public event Action OnCurrentAgentChange;

        private CurrentAgentStore()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var shellSettingsManager = new ShellSettingsManager(ServiceProvider.GlobalProvider);
            settingsStore = shellSettingsManager.GetWritableSettingsStore(SettingsScope.UserSettings);
            if (!settingsStore.CollectionExists(CollectionPath))
            {
                settingsStore.CreateCollection(CollectionPath);
            }
        }

        internal static CurrentAgentStore Instance
        {
            get { return instance ?? (instance = new CurrentAgentStore()); }
        }

        public string CurrentAgentId
        {
            get
            {
                if (settingsStore.PropertyExists(CollectionPath, AgentModelIdKey))
                    return settingsStore.GetString(CollectionPath, AgentModelIdKey);
                return null;
            }
            set
            {
                if (string.IsNullOrEmpty(value))
                    settingsStore.DeleteProperty(CollectionPath, AgentModelIdKey);
                else
                    settingsStore.SetString(CollectionPath, AgentModelIdKey, value);
                OnCurrentAgentChange?.Invoke();
            }
        }
    }
}
