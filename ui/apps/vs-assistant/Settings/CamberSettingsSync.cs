using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Utilities.UnifiedSettings;
using System.ComponentModel;
using Camber.Assistant.Telemetry;
using System;

namespace Camber.Assistant.Settings
{
    // Keeps the legacy VSSDK settings (CamberSettings) in sync with the new Unified Settings
    // API (CamberSettingDefinitions), so that both VS 2022 (which uses the legacy dialog) and
    // VS 2026+ (which shows the new settings page) see the same values.
    //
    // Thread safety: all methods run on the VS UI thread (callbacks are dispatched there, and
    // callers switch to it before invoking). The static fields are therefore not accessed
    // concurrently and require no locking.
    internal static class CamberSettingsSync
    {
        // Prefixes all setting monikers; derived from the SettingCategory id in CamberSettingDefinitions.
        private const string CategoryPrefix = "camberAssistant";

        private static IDisposable subscription;
        private static PropertyChangedEventHandler propertyChangedHandler;

        // True while we are applying unified settings values to legacy settings, to suppress the
        // PropertyChanged callbacks those assignments fire (preventing redundant writes back to
        // unified storage).
        private static bool updatingFromUnified = false;

        // Set before a successful RequestCommit so the resulting change callback is skipped.
        // Only set on Success (synchronous commit); PendingApproval fires asynchronously later,
        // by which time the flag would be stale. In that case the callback is a no-op anyway
        // because legacy already holds the value.
        private static bool skipNextUnifiedUpdate = false;

        internal static void Initialize(ISettingsManager settingsManager)
        {
            try
            {
                var legacySettings = CamberAssistantPackage.GetInstance().GetSettings();
                var reader = settingsManager.GetReader();

                // Subscribe to all settings in our category. The handler fires immediately with
                // current values, so this also handles the initial push from new → legacy.
                subscription = reader.SubscribeToChanges(
                    update => OnUnifiedSettingsChanged(reader, legacySettings),
                    CategoryPrefix + ".*");

                // When the legacy dialog (or code) changes a setting, push it to unified storage.
                var writer = settingsManager.GetWriter("Camber Assistant");
                propertyChangedHandler = (sender, e) =>
                    SyncLegacyToUnifiedIfNotSyncing(writer, legacySettings);
                legacySettings.PropertyChanged += propertyChangedHandler;
            }
            catch (Exception ex)
            {
                CamberTelemetryLogger.Instance.reportException(ex);
            }
        }

        internal static void Dispose()
        {
            subscription?.Dispose();
            subscription = null;

            if (propertyChangedHandler != null)
            {
                var settings = CamberAssistantPackage.GetInstance()?.GetSettings();
                if (settings != null)
                    settings.PropertyChanged -= propertyChangedHandler;
                propertyChangedHandler = null;
            }
        }

        private static void OnUnifiedSettingsChanged(ISettingsReader reader, CamberSettings legacySettings)
        {
            if (updatingFromUnified) return;
            // Skip the one callback that our own synchronous RequestCommit fires; we're the source
            // of this change, so syncing it back to legacy would be a redundant no-op at best.
            if (skipNextUnifiedUpdate) { skipNextUnifiedUpdate = false; return; }
            updatingFromUnified = true;
            try
            {
                ThreadHelper.JoinableTaskFactory.Run(async () =>
                {
                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                    ReadInto(reader, legacySettings);
                    legacySettings.SaveSettingsToStorage();
                });
            }
            finally
            {
                updatingFromUnified = false;
            }
        }

        private static void ReadInto(ISettingsReader reader, CamberSettings legacySettings)
        {
            legacySettings.Uri = ReadString(reader, "baseUri", legacySettings.Uri);
            legacySettings.WrapLines = ReadBool(reader, "wrapLines", legacySettings.WrapLines);
            legacySettings.NotifyOnApproval = ReadBool(reader, "notifyOnApproval", legacySettings.NotifyOnApproval);
            legacySettings.ShowMermaidDiagrams = ReadBool(reader, "showMermaidDiagrams", legacySettings.ShowMermaidDiagrams);
            legacySettings.ToolActivity = ReadString(reader, "toolActivity", legacySettings.ToolActivity);
            legacySettings.DefaultWorkingDirectory = ReadString(reader, "defaultWorkingDirectory", legacySettings.DefaultWorkingDirectory);
            legacySettings.AcpAgentServersJson = ReadString(reader, "acpAgentServers", legacySettings.AcpAgentServersJson);
        }

        private static void SyncLegacyToUnifiedIfNotSyncing(ISettingsWriter writer, CamberSettings legacySettings)
        {
            // Suppress writes back to unified while we're applying unified values to legacy,
            // to avoid redundant commits for each PropertyChanged event ReadInto fires.
            if (updatingFromUnified) return;
            writer.EnqueueChange(Moniker("baseUri"), legacySettings.Uri);
            writer.EnqueueChange(Moniker("wrapLines"), legacySettings.WrapLines);
            writer.EnqueueChange(Moniker("notifyOnApproval"), legacySettings.NotifyOnApproval);
            writer.EnqueueChange(Moniker("showMermaidDiagrams"), legacySettings.ShowMermaidDiagrams);
            writer.EnqueueChange(Moniker("toolActivity"), legacySettings.ToolActivity);
            writer.EnqueueChange(Moniker("defaultWorkingDirectory"), legacySettings.DefaultWorkingDirectory);
            writer.EnqueueChange(Moniker("acpAgentServers"), legacySettings.AcpAgentServersJson);
            // Set before RequestCommit in case the callback fires synchronously during the call.
            // Cleared below for any outcome where no callback follows (so the flag doesn't
            // linger and accidentally suppress the next real unified-settings change).
            skipNextUnifiedUpdate = true;
            var result = writer.RequestCommit("Sync settings from legacy storage");
            if (result.Outcome == SettingCommitOutcome.InternalError)
            {
                skipNextUnifiedUpdate = false;
                CamberTelemetryLogger.Instance.reportException(new Exception($"Settings sync commit failed: {result.Message}"));
            }
            else if (result.Outcome != SettingCommitOutcome.Success)
            {
                // PendingApproval or NoChangesQueued: no synchronous callback is coming,
                // so clear the flag to avoid suppressing the next real unified-settings change.
                skipNextUnifiedUpdate = false;
            }
        }

        private static string Moniker(string settingId) => CategoryPrefix + "." + settingId;

        private static string ReadString(ISettingsReader reader, string settingId, string fallback)
        {
            var result = reader.GetValue<string>(Moniker(settingId), SettingReadOptions.NoRequirements);
            return result.Outcome == SettingRetrievalOutcome.Success ? result.Value : fallback;
        }

        private static bool ReadBool(ISettingsReader reader, string settingId, bool fallback)
        {
            var result = reader.GetValue<bool>(Moniker(settingId), SettingReadOptions.NoRequirements);
            return result.Outcome == SettingRetrievalOutcome.Success ? result.Value : fallback;
        }
    }
}
