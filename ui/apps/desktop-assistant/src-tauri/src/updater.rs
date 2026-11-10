use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::Serialize;
use tauri::{async_runtime, AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::settings::{persist_update_channel, read_settings, DesktopUpdateChannel};

/// A downloaded update waiting for the user to restart.
///
/// The archive lives at a fixed path under the app data directory so it
/// survives quitting without ever installing over the running bundle. That
/// location is user-writable and `Update::install` does not verify what it is
/// given, so the archive is treated as an untrusted cache: its minisign
/// signature is re-checked against the embedded public key both when a later
/// session adopts it and again immediately before install.
struct StagedUpdate {
    update: Update,
    archive_path: PathBuf,
}

#[derive(Default)]
pub struct DesktopUpdaterState {
    pub(crate) operation: async_runtime::Mutex<()>,
    staged: async_runtime::Mutex<Option<StagedUpdate>>,
    pending_update: AtomicBool,
}

impl DesktopUpdaterState {
    pub(crate) fn ensure_no_pending_update(&self) -> Result<(), String> {
        if self.pending_update.load(Ordering::Acquire) {
            Err(
                "An update is ready to install. Restart the app before checking again or changing release channels."
                    .to_string(),
            )
        } else {
            Ok(())
        }
    }

    async fn stage(&self, update: Update, archive_path: PathBuf) {
        *self.staged.lock().await = Some(StagedUpdate {
            update,
            archive_path,
        });
        self.mark_update_pending();
    }

    fn mark_update_pending(&self) {
        self.pending_update.store(true, Ordering::Release);
    }

    /// Lets checks resume after a staged update was lost without being
    /// installed, so the updater recovers instead of staying blocked until the
    /// app quits.
    fn clear_pending_update(&self) {
        self.pending_update.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    version: String,
    /// Release notes from the update feed (the CrabNebula release notes).
    notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStableSwitchResult {
    status: DesktopStableSwitchStatus,
    current_version: String,
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum DesktopStableSwitchStatus {
    AlreadyStable,
    NoUpdate,
    Cancelled,
    /// Downloaded and waiting for the restart that installs it.
    Staged,
}

fn resolve_channel(app: &AppHandle) -> DesktopUpdateChannel {
    read_settings(app)
        .map(|settings| settings.update_channel())
        .unwrap_or_default()
}

fn build_updater(
    app: &AppHandle,
    channel: DesktopUpdateChannel,
    allow_downgrade: bool,
) -> Result<Updater, String> {
    let mut builder = app.updater_builder();
    if channel == DesktopUpdateChannel::Nightly {
        let url = nightly_update_endpoint(app)?;
        builder = builder
            .endpoints(vec![url])
            .map_err(|err| err.to_string())?;
    }
    if allow_downgrade {
        builder = builder.version_comparator(|current, release| release.version != current);
    }
    builder.build().map_err(|err| err.to_string())
}

fn nightly_update_endpoint(app: &AppHandle) -> Result<Url, String> {
    let endpoint = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .and_then(|endpoints| endpoints.first())
        .and_then(|endpoint| endpoint.as_str())
        .ok_or_else(|| "No stable updater endpoint is configured".to_string())?;
    add_nightly_channel(endpoint)
}

fn add_nightly_channel(endpoint: &str) -> Result<Url, String> {
    let mut url = Url::parse(endpoint).map_err(|err| err.to_string())?;
    if url.query_pairs().any(|(key, _)| key == "channel") {
        return Err("The stable updater endpoint must not include a channel query".to_string());
    }
    url.query_pairs_mut().append_pair("channel", "nightly");
    Ok(url)
}

fn parse_numeric_version(version: &str) -> Result<Version, String> {
    let parsed = Version::parse(version).map_err(|err| format!("Invalid update version: {err}"))?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        return Err(format!(
            "Update version {version} must not contain prerelease or build metadata"
        ));
    }
    Ok(parsed)
}

fn is_unstamped_local_build(version: &Version) -> bool {
    version == &Version::new(0, 0, 0)
}

fn validate_channel_version(
    version: &str,
    channel: DesktopUpdateChannel,
) -> Result<Version, String> {
    let parsed = parse_numeric_version(version)?;
    let matches = match channel {
        DesktopUpdateChannel::Stable => parsed.minor % 2 == 0,
        DesktopUpdateChannel::Nightly => parsed.minor % 2 == 1,
    };
    if !matches {
        return Err(format!(
            "Update version {version} does not belong to the {channel:?} channel"
        ));
    }
    Ok(parsed)
}

async fn check_channel_update(
    app: &AppHandle,
    channel: DesktopUpdateChannel,
) -> Result<Option<(Version, Update)>, String> {
    // A personal fork has no update service until one is explicitly configured.
    if app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .is_none_or(|endpoints| endpoints.is_empty())
    {
        return Ok(None);
    }
    let updater = build_updater(app, channel, false)?;
    let Some(update) = updater.check().await.map_err(|err| err.to_string())? else {
        return Ok(None);
    };
    let version = validate_channel_version(&update.version, channel)?;
    Ok(Some((version, update)))
}

fn select_newest_update<T>(
    stable: Option<(Version, T)>,
    nightly: Option<(Version, T)>,
) -> Option<(Version, T)> {
    match (stable, nightly) {
        (Some(stable), Some(nightly)) => {
            if nightly.0 > stable.0 {
                Some(nightly)
            } else {
                Some(stable)
            }
        }
        (Some(stable), None) => Some(stable),
        (None, Some(nightly)) => Some(nightly),
        (None, None) => None,
    }
}

async fn check_selected_update(
    app: &AppHandle,
    selected_channel: DesktopUpdateChannel,
) -> Result<Option<Update>, String> {
    let stable = check_channel_update(app, DesktopUpdateChannel::Stable).await?;
    if selected_channel == DesktopUpdateChannel::Stable {
        return Ok(stable.map(|(_, update)| update));
    }

    let nightly = check_channel_update(app, DesktopUpdateChannel::Nightly).await?;
    Ok(select_newest_update(stable, nightly).map(|(_, update)| update))
}

/// Check the feeds eligible for the selected channel and download the highest
/// signed update. The selected `Update` cannot change between check and
/// download.
///
/// This deliberately stops at the downloaded bytes. Installing replaces the
/// running `.app` in place, which leaves the process running from an unlinked
/// bundle: macOS can no longer resolve its executable, so the out-of-process
/// AppKit services (`NSOpenPanel`, `NSSavePanel`) refuse to launch and take the
/// app down with them. `install_staged_desktop_update` does the swap immediately
/// before relaunching instead.
#[tauri::command]
pub async fn check_and_stage_desktop_update(
    app_handle: AppHandle,
    state: State<'_, DesktopUpdaterState>,
) -> Result<Option<DesktopUpdateInfo>, String> {
    let _operation = state.operation.lock().await;
    state.ensure_no_pending_update()?;
    if is_unstamped_local_build(&app_handle.package_info().version) {
        return Ok(None);
    }
    let channel = resolve_channel(&app_handle);
    let Some(update) = check_selected_update(&app_handle, channel).await? else {
        // Nothing newer than the running version, so any cached archive is
        // stale — including the one this version was just installed from.
        discard_pending_archive(&app_handle);
        return Ok(None);
    };
    if channel == DesktopUpdateChannel::Nightly {
        persist_update_channel(&app_handle, channel)?;
    }
    let version = update.version.clone();
    let notes = update.body.clone();
    stage_update_on_disk(&app_handle, &state, update).await?;
    Ok(Some(DesktopUpdateInfo { version, notes }))
}

/// Downloads and verifies the update archive without touching the installed
/// bundle.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateProgress {
    downloaded: usize,
    content_length: Option<u64>,
}

async fn download_update(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    let app = app.clone();
    let mut downloaded = 0usize;
    update
        .download(
            move |chunk, content_length| {
                downloaded += chunk;
                let _ = app.emit(
                    "camber:desktop-update-progress",
                    DesktopUpdateProgress {
                        downloaded,
                        content_length,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|err| err.to_string())
}

const PENDING_ARCHIVE_FILE: &str = "pending.tar.gz";
const PENDING_PARTIAL_FILE: &str = "pending.tar.gz.part";

fn pending_update_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("pending-update"))
}

/// The minisign public key the updater plugin verifies downloads against,
/// from `plugins.updater.pubkey` in the bundled `tauri.conf.json`.
fn updater_pubkey(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .map(str::to_string)
        .ok_or_else(|| "No updater public key is configured".to_string())
}

/// Verifies an archive against a feed signature, mirroring the updater
/// plugin's own check (both values are base64-wrapped minisign strings).
///
/// This is what makes the on-disk cache safe: whatever is at the pending path
/// only ever reaches `Update::install` after passing this with the public key
/// baked into the app.
fn verify_archive(bytes: &[u8], signature: &str, pubkey: &str) -> Result<(), String> {
    fn base64_to_string(value: &str) -> Result<String, String> {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(|err| err.to_string())?;
        String::from_utf8(decoded).map_err(|err| err.to_string())
    }
    let public_key =
        PublicKey::decode(&base64_to_string(pubkey)?).map_err(|err| err.to_string())?;
    let signature =
        Signature::decode(&base64_to_string(signature)?).map_err(|err| err.to_string())?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|err| err.to_string())
}

fn write_pending_archive(dir: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    // Write-then-rename so a crash mid-write can never leave a torn file at
    // the path a later session will try to adopt.
    let partial = dir.join(PENDING_PARTIAL_FILE);
    std::fs::write(&partial, bytes).map_err(|err| err.to_string())?;
    std::fs::rename(&partial, path).map_err(|err| err.to_string())
}

/// Drops the cached archive. Called when the feed says there is nothing newer
/// than the running version — which is also how the archive from a completed
/// update gets cleaned up on the first check after restarting into it.
fn discard_pending_archive(app: &AppHandle) {
    if let Ok(dir) = pending_update_dir(app) {
        let _ = std::fs::remove_file(dir.join(PENDING_ARCHIVE_FILE));
        let _ = std::fs::remove_file(dir.join(PENDING_PARTIAL_FILE));
    }
}

/// Ensure the selected update's archive is on disk, reusing the cached copy
/// from an earlier session when it is byte-for-byte the release the feed is
/// announcing now (its signature verifies), and mark it staged.
async fn stage_update_on_disk(
    app: &AppHandle,
    state: &DesktopUpdaterState,
    update: Update,
) -> Result<(), String> {
    let pubkey = updater_pubkey(app)?;
    let dir = pending_update_dir(app)?;
    let path = dir.join(PENDING_ARCHIVE_FILE);

    let cached_matches = {
        let path = path.clone();
        let signature = update.signature.clone();
        let pubkey = pubkey.clone();
        async_runtime::spawn_blocking(move || {
            std::fs::read(&path)
                .is_ok_and(|bytes| verify_archive(&bytes, &signature, &pubkey).is_ok())
        })
        .await
        .map_err(|err| err.to_string())?
    };

    if !cached_matches {
        let bytes = download_update(app, &update).await?;
        let dir = dir.clone();
        let path = path.clone();
        async_runtime::spawn_blocking(move || write_pending_archive(&dir, &path, &bytes))
            .await
            .map_err(|err| err.to_string())??;
    }

    state.stage(update, path).await;
    Ok(())
}

/// Swap in the staged update and relaunch into it.
///
/// Installing unlinks the running bundle, so the restart has to follow
/// immediately — nothing may open a native file panel in between. On failure the
/// staged update is put back so the user can retry from the same button.
#[tauri::command]
pub async fn install_staged_desktop_update(
    app_handle: AppHandle,
    state: State<'_, DesktopUpdaterState>,
) -> Result<(), String> {
    let pubkey = updater_pubkey(&app_handle)?;
    let _operation = state.operation.lock().await;
    let mut slot = state.staged.lock().await;
    let Some(staged) = slot.take() else {
        return Err("No update is ready to install.".to_string());
    };

    // Load and re-verify the cached archive: it has sat in a user-writable
    // location since staging. A failed check self-heals by re-downloading the
    // exact selected `Update` (the plugin verifies as it downloads).
    let loaded = {
        let path = staged.archive_path.clone();
        let signature = staged.update.signature.clone();
        let pubkey = pubkey.clone();
        async_runtime::spawn_blocking(move || {
            let bytes = std::fs::read(&path).map_err(|err| err.to_string())?;
            verify_archive(&bytes, &signature, &pubkey)?;
            Ok::<_, String>(bytes)
        })
        .await
    };
    let loaded = match loaded {
        Ok(loaded) => loaded,
        Err(err) => {
            // The read task panicked. `staged` never left this scope, so put
            // it back rather than stranding it.
            *slot = Some(staged);
            return Err(format!("Update install did not complete: {err}"));
        }
    };
    let bytes = match loaded {
        Ok(bytes) => bytes,
        Err(_) => match download_update(&app_handle, &staged.update).await {
            Ok(bytes) => bytes,
            Err(err) => {
                *slot = Some(staged);
                return Err(format!(
                    "The staged update could not be read and downloading it again failed: {err}"
                ));
            }
        },
    };

    // Unpacking the archive over /Applications is blocking filesystem work.
    let installed = async_runtime::spawn_blocking(move || {
        let result = staged.update.install(&bytes).map_err(|err| err.to_string());
        (result, staged)
    })
    .await;

    let (result, staged) = match installed {
        Ok(installed) => installed,
        Err(err) => {
            // The install task panicked and took the staged update with it.
            // Release the pending flag so checks resume and the next one
            // re-stages from the archive still on disk; otherwise the Update
            // button and the release-channel controls stay wedged until quit.
            state.clear_pending_update();
            return Err(format!("Update install did not complete: {err}"));
        }
    };

    if let Err(err) = result {
        *slot = Some(staged);
        return Err(err);
    }

    discard_pending_archive(&app_handle);
    drop(slot);
    app_handle.restart();
}

/// Explicitly leave Preview for Stable, including a lower Stable version.
/// Background checks never use the downgrade comparator. Like the background
/// path this only stages the download; the restart installs it.
#[tauri::command]
pub async fn switch_desktop_to_stable(
    app_handle: AppHandle,
    state: State<'_, DesktopUpdaterState>,
) -> Result<DesktopStableSwitchResult, String> {
    let _operation = state.operation.lock().await;
    state.ensure_no_pending_update()?;
    let current_version = app_handle.package_info().version.to_string();
    let current = parse_numeric_version(&current_version)?;
    if current.minor % 2 == 0 {
        return Ok(DesktopStableSwitchResult {
            status: DesktopStableSwitchStatus::AlreadyStable,
            current_version,
            version: None,
        });
    }

    let updater = build_updater(&app_handle, DesktopUpdateChannel::Stable, true)?;
    let Some(update) = updater.check().await.map_err(|err| err.to_string())? else {
        return Ok(DesktopStableSwitchResult {
            status: DesktopStableSwitchStatus::NoUpdate,
            current_version,
            version: None,
        });
    };
    let stable = validate_channel_version(&update.version, DesktopUpdateChannel::Stable)?;
    let version = update.version.clone();

    if stable < current {
        let (tx, mut rx) = async_runtime::channel(1);
        app_handle
            .dialog()
            .message(format!(
                "Install Stable {version} over Preview {current_version}?\n\nYour settings and local data stay in place, but an older Stable build may not understand data written by Preview."
            ))
            .title("Switch to Stable")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Install Stable".to_string(),
                "Cancel".to_string(),
            ))
            .show(move |confirmed| {
                let _ = tx.blocking_send(confirmed);
            });
        if !rx.recv().await.unwrap_or(false) {
            return Ok(DesktopStableSwitchResult {
                status: DesktopStableSwitchStatus::Cancelled,
                current_version,
                version: Some(version),
            });
        }
    }

    stage_update_on_disk(&app_handle, &state, update).await?;
    Ok(DesktopStableSwitchResult {
        status: DesktopStableSwitchStatus::Staged,
        current_version,
        version: Some(version),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_versions_use_numeric_minor_parity() {
        assert!(validate_channel_version("1.2.3", DesktopUpdateChannel::Stable).is_ok());
        assert!(validate_channel_version("1.3.4", DesktopUpdateChannel::Nightly).is_ok());
        assert!(validate_channel_version("1.3.4", DesktopUpdateChannel::Stable).is_err());
        assert!(validate_channel_version("1.2.3", DesktopUpdateChannel::Nightly).is_err());
    }

    #[test]
    fn channel_versions_reject_semver_suffixes() {
        assert!(
            validate_channel_version("1.3.4-nightly.5", DesktopUpdateChannel::Nightly).is_err()
        );
        assert!(validate_channel_version("1.2.3+build.5", DesktopUpdateChannel::Stable).is_err());
    }

    #[test]
    fn preview_selects_newer_stable_when_nightly_has_no_update() {
        let stable = Some((Version::new(0, 10, 0), "stable"));

        assert_eq!(select_newest_update(stable.clone(), None), stable);
    }

    #[test]
    fn preview_selects_highest_update_across_stable_and_nightly() {
        let stable = Some((Version::new(0, 10, 0), "stable"));
        let nightly = Some((Version::new(0, 11, 0), "nightly"));
        assert_eq!(
            select_newest_update(stable.clone(), nightly.clone()),
            nightly
        );

        let newer_stable = Some((Version::new(0, 12, 0), "stable"));
        assert_eq!(
            select_newest_update(newer_stable.clone(), nightly),
            newer_stable
        );
    }

    #[test]
    fn preview_has_no_update_when_neither_feed_has_a_newer_version() {
        assert_eq!(select_newest_update::<()>(None, None), None);
    }

    #[test]
    fn unstamped_local_builds_do_not_use_the_public_updater() {
        assert!(is_unstamped_local_build(&Version::new(0, 0, 0)));
        assert!(!is_unstamped_local_build(&Version::new(0, 0, 1)));
        assert!(!is_unstamped_local_build(&Version::new(0, 1, 0)));
    }

    #[test]
    fn derives_nightly_from_the_stable_endpoint() {
        let url = add_nightly_channel(
            "https://cdn.crabnebula.app/update/org/app/{{target}}-{{arch}}/{{current_version}}",
        )
        .unwrap();
        assert_eq!(url.query(), Some("channel=nightly"));
        assert!(add_nightly_channel("https://example.com/update?channel=stable").is_err());
    }

    #[test]
    fn unconfigured_fork_has_no_update_feed_or_trusted_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config["plugins"]["updater"]["endpoints"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(config["plugins"]["updater"]["pubkey"].as_str().unwrap(), "");
    }

    // Public verification fixture, independent of the app's release configuration.
    const TEST_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJBRUQ5ODRERjk1MTkxNjkKUldScGtWSDVUWmp0dXY1Z3E2YU9HNjNoV2RmcTFCRS9ZNU1DUWdtMVlvaW9QUjZ2dHZjVnFobXkK";

    /// A well-formed minisign signature (74-byte packet: algorithm, key id,
    /// signature) carrying a bogus Ed25519 signature. `Signature::decode`
    /// accepts it, so verification reaches the actual signature check rather
    /// than bailing out on a length or encoding error.
    fn well_formed_signature_with_bogus_ed25519(key_id: [u8; 8]) -> String {
        let mut packet = Vec::with_capacity(74);
        packet.extend_from_slice(b"ED"); // prehashed Ed25519
        packet.extend_from_slice(&key_id);
        packet.extend_from_slice(&[0u8; 64]);
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let sig_file = format!(
            "untrusted comment: test\n{}\ntrusted comment: test\n{}\n",
            encode(&packet),
            encode(&[0u8; 64])
        );
        encode(sig_file.as_bytes())
    }

    #[test]
    fn tampered_archives_fail_verification() {
        let pubkey = TEST_PUBLIC_KEY;
        // The key id of the shipped public key, so verification gets past the
        // key-id check and actually evaluates the signature.
        let our_key_id = [0x69, 0x91, 0x51, 0xf9, 0x4d, 0x98, 0xed, 0xba];

        // The case that matters: a decodable signature for our own key that
        // does not match the archive bytes.
        assert!(verify_archive(
            b"archive bytes",
            &well_formed_signature_with_bogus_ed25519(our_key_id),
            pubkey
        )
        .is_err());
        // Signed by some other key.
        assert!(verify_archive(
            b"archive bytes",
            &well_formed_signature_with_bogus_ed25519([0u8; 8]),
            pubkey
        )
        .is_err());
        // Malformed inputs.
        assert!(verify_archive(b"archive bytes", "not base64!", pubkey).is_err());
        assert!(verify_archive(b"archive bytes", "", pubkey).is_err());
    }

    #[test]
    fn the_bogus_signature_fixture_survives_decoding() {
        // Guards the test above: if the fixture stopped decoding, those
        // assertions would pass for the wrong reason and no longer prove that
        // a bad signature is rejected on cryptographic grounds.
        let our_key_id = [0x69, 0x91, 0x51, 0xf9, 0x4d, 0x98, 0xed, 0xba];
        let encoded = well_formed_signature_with_bogus_ed25519(our_key_id);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .unwrap();
        let signature = Signature::decode(std::str::from_utf8(&decoded).unwrap()).unwrap();

        let pubkey_decoded = base64::engine::general_purpose::STANDARD
            .decode(TEST_PUBLIC_KEY)
            .unwrap();
        let public_key = PublicKey::decode(std::str::from_utf8(&pubkey_decoded).unwrap()).unwrap();

        // Reaches the signature check and fails there, not on key id.
        assert!(matches!(
            public_key.verify(b"archive bytes", &signature, true),
            Err(minisign_verify::Error::InvalidSignature)
        ));
    }

    #[test]
    fn pending_updates_require_a_restart_before_another_operation() {
        let state = DesktopUpdaterState::default();
        assert!(state.ensure_no_pending_update().is_ok());

        state.mark_update_pending();
        assert_eq!(
            state.ensure_no_pending_update(),
            Err(
                "An update is ready to install. Restart the app before checking again or changing release channels."
                    .to_string()
            )
        );

        // Recovery path for a staged update lost without being installed:
        // checks must resume rather than staying blocked until the app quits.
        state.clear_pending_update();
        assert!(state.ensure_no_pending_update().is_ok());
    }
}
