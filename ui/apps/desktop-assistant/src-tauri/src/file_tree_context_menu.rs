use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    file_watcher::{emit_desktop_file_tree_changes, FILE_CHANGE_CREATED, FILE_CHANGE_DELETED},
    settings::{validate_existing_directory_path, validate_existing_open_path, ExistingOpenPath},
};

const CAMBER_PASTEBOARD_OPERATION_TYPE: &str = "io.github.appleton.camber.file-operation";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DesktopFilePasteboardOperation {
    Copy,
    Cut,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFilePasteResult {
    pasted: usize,
}

#[tauri::command]
pub fn file_url_pasteboard_has_files(app_handle: AppHandle) -> Result<bool, String> {
    pasteboard_has_file_urls(&app_handle)
}

#[tauri::command]
pub fn reveal_path_in_finder(app_handle: AppHandle, path: String) -> Result<(), String> {
    let path = existing_open_path(path)?;
    reveal_path_in_finder_impl(&app_handle, path)
}

#[tauri::command]
pub fn write_file_url_to_pasteboard(
    app_handle: AppHandle,
    path: String,
    operation: DesktopFilePasteboardOperation,
) -> Result<(), String> {
    let path = existing_open_path(path)?;
    write_file_url_to_pasteboard_impl(&app_handle, path, operation)
}

#[tauri::command]
pub fn write_text_to_pasteboard(app_handle: AppHandle, text: String) -> Result<(), String> {
    write_text_to_pasteboard_impl(&app_handle, text)
}

#[tauri::command]
pub fn write_image_to_pasteboard(app_handle: AppHandle, path: String) -> Result<(), String> {
    let path = match validate_existing_open_path(&path)? {
        ExistingOpenPath::File(path) => path,
        ExistingOpenPath::Directory(_) => {
            return Err("Only image files can be copied".to_string());
        }
    };
    write_image_to_pasteboard_impl(&app_handle, path)
}

#[tauri::command]
pub fn write_image_data_to_pasteboard(app_handle: AppHandle, data: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let bytes = STANDARD
        .decode(data.trim())
        .map_err(|error| format!("Unable to decode image data: {error}"))?;
    if bytes.is_empty() {
        return Err("Unable to copy an empty image".to_string());
    }
    write_image_data_to_pasteboard_impl(&app_handle, bytes)
}

#[tauri::command]
pub async fn trash_path(app_handle: AppHandle, path: String) -> Result<(), String> {
    let path = existing_open_path(path)?;
    trash_path_impl(app_handle, path).await
}

#[tauri::command]
pub fn paste_files_into_directory(
    app_handle: AppHandle,
    destination: String,
) -> Result<DesktopFilePasteResult, String> {
    let destination = validate_existing_directory_path(&destination)?;
    let pasteboard = read_file_url_pasteboard_impl(&app_handle)?;
    if pasteboard.paths.is_empty() {
        return Err("No files or folders are available to paste".to_string());
    }

    for source in &pasteboard.paths {
        validate_paste_source(source, &destination)?;
    }

    let operation = pasteboard
        .operation
        .unwrap_or(DesktopFilePasteboardOperation::Copy);
    let mut targets = Vec::with_capacity(pasteboard.paths.len());
    for source in &pasteboard.paths {
        let target = unique_destination_path(&destination, source)?;
        match operation {
            DesktopFilePasteboardOperation::Copy => copy_file_system_item(source, &target)?,
            DesktopFilePasteboardOperation::Cut => move_file_system_item(source, &target)?,
        }
        targets.push((source.clone(), target));
    }

    emit_paste_file_tree_changes(&app_handle, operation, &targets);

    if operation == DesktopFilePasteboardOperation::Cut {
        let _ = clear_pasteboard(&app_handle);
    }

    Ok(DesktopFilePasteResult {
        pasted: targets.len(),
    })
}

fn existing_open_path(path: String) -> Result<PathBuf, String> {
    match validate_existing_open_path(&path)? {
        ExistingOpenPath::File(path) | ExistingOpenPath::Directory(path) => Ok(path),
    }
}

fn validate_paste_source(source: &Path, destination: &Path) -> Result<(), String> {
    let source_metadata = fs::symlink_metadata(source).map_err(|err| err.to_string())?;
    if !(source_metadata.is_file()
        || source_metadata.is_dir()
        || source_metadata.file_type().is_symlink())
    {
        return Err("Only files and folders can be pasted".to_string());
    }

    if source == destination {
        return Err("A folder cannot be pasted into itself".to_string());
    }

    if source_metadata.is_dir() {
        if let (Ok(source), Ok(destination)) = (source.canonicalize(), destination.canonicalize()) {
            if destination.starts_with(&source) {
                return Err("A folder cannot be pasted into itself".to_string());
            }
        }
    }

    Ok(())
}

fn emit_paste_file_tree_changes(
    app_handle: &AppHandle,
    operation: DesktopFilePasteboardOperation,
    targets: &[(PathBuf, PathBuf)],
) {
    let mut changes = Vec::with_capacity(targets.len() * 2);
    for (source, target) in targets {
        if operation == DesktopFilePasteboardOperation::Cut {
            changes.push((source.clone(), FILE_CHANGE_DELETED));
        }
        changes.push((target.clone(), FILE_CHANGE_CREATED));
    }
    emit_desktop_file_tree_changes(app_handle, changes);
}

fn unique_destination_path(destination_directory: &Path, source: &Path) -> Result<PathBuf, String> {
    let file_name = source
        .file_name()
        .ok_or_else(|| "Path cannot be pasted".to_string())?;
    let first = destination_directory.join(file_name);
    if !first.exists() {
        return Ok(first);
    }

    let file_name = file_name.to_string_lossy();
    let (stem, extension) = split_copy_name(&file_name);
    for index in 1.. {
        let suffix = if index == 1 {
            " copy".to_string()
        } else {
            format!(" copy {index}")
        };
        let candidate = destination_directory.join(format!("{stem}{suffix}{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    unreachable!("unbounded copy-name search should always return")
}

fn split_copy_name(file_name: &str) -> (&str, String) {
    if file_name.starts_with('.') && file_name[1..].find('.').is_none() {
        return (file_name, String::new());
    }

    match file_name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (file_name, String::new()),
    }
}

fn copy_file_system_item(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|err| err.to_string())?;
    if metadata.file_type().is_symlink() {
        return copy_symlink(source, destination);
    }
    if metadata.is_dir() {
        fs::create_dir(destination).map_err(|err| err.to_string())?;
        for entry in fs::read_dir(source).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            copy_file_system_item(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    fs::copy(source, destination)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

fn move_file_system_item(source: &Path, destination: &Path) -> Result<(), String> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(err) if err.raw_os_error() == Some(18) => {
            copy_file_system_item(source, destination)?;
            remove_file_system_item(source)
        }
        Err(err) => Err(err.to_string()),
    }
}

fn remove_file_system_item(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|err| err.to_string())?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path).map_err(|err| err.to_string())
    } else {
        fs::remove_file(path).map_err(|err| err.to_string())
    }
}

#[cfg(unix)]
fn copy_symlink(source: &Path, destination: &Path) -> Result<(), String> {
    let target = fs::read_link(source).map_err(|err| err.to_string())?;
    std::os::unix::fs::symlink(target, destination).map_err(|err| err.to_string())
}

#[cfg(not(unix))]
fn copy_symlink(_source: &Path, _destination: &Path) -> Result<(), String> {
    Err("Symlinks cannot be copied on this platform".to_string())
}

#[cfg(target_os = "macos")]
fn reveal_path_in_finder_impl(app_handle: &AppHandle, path: PathBuf) -> Result<(), String> {
    run_on_main_thread_sync(app_handle, move || {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::NSArray;

        let url = url_for_path(&path)?;
        let urls = NSArray::from_slice(&[&*url]);
        NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
fn reveal_path_in_finder_impl(_app_handle: &AppHandle, _path: PathBuf) -> Result<(), String> {
    Err("Reveal in Finder is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn write_file_url_to_pasteboard_impl(
    app_handle: &AppHandle,
    path: PathBuf,
    operation: DesktopFilePasteboardOperation,
) -> Result<(), String> {
    run_on_main_thread_sync(app_handle, move || {
        use objc2::runtime::ProtocolObject;
        use objc2_app_kit::{
            NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardWriting,
        };
        use objc2_foundation::{NSArray, NSString};

        let item = NSPasteboardItem::new();
        let url = url_for_path(&path)?;
        let url_string = url
            .absoluteString()
            .ok_or_else(|| "Unable to create file URL".to_string())?;
        if !item.setString_forType(&url_string, unsafe { NSPasteboardTypeFileURL }) {
            return Err("Unable to write file URL to the pasteboard".to_string());
        }
        let marker = serde_json::to_string(&PasteboardOperationMarker { operation })
            .map_err(|err| err.to_string())?;
        let marker_type = NSString::from_str(CAMBER_PASTEBOARD_OPERATION_TYPE);
        if !item.setString_forType(&NSString::from_str(&marker), &marker_type) {
            return Err("Unable to write pasteboard operation metadata".to_string());
        }

        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        let item_ref: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(&*item);
        let items = NSArray::from_slice(&[item_ref]);
        if !pasteboard.writeObjects(&items) {
            return Err("Unable to write file URL to the pasteboard".to_string());
        }
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
fn write_file_url_to_pasteboard_impl(
    _app_handle: &AppHandle,
    _path: PathBuf,
    _operation: DesktopFilePasteboardOperation,
) -> Result<(), String> {
    Err("File pasteboard operations are only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn write_text_to_pasteboard_impl(app_handle: &AppHandle, text: String) -> Result<(), String> {
    run_on_main_thread_sync(app_handle, move || {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;

        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        if !pasteboard.setString_forType(&NSString::from_str(&text), unsafe {
            NSPasteboardTypeString
        }) {
            return Err("Unable to write text to the pasteboard".to_string());
        }
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
fn write_text_to_pasteboard_impl(_app_handle: &AppHandle, _text: String) -> Result<(), String> {
    Err("Native text pasteboard operations are only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn write_image_to_pasteboard_impl(app_handle: &AppHandle, path: PathBuf) -> Result<(), String> {
    run_on_main_thread_sync(app_handle, move || {
        use objc2::{runtime::ProtocolObject, AnyThread};
        use objc2_app_kit::{NSImage, NSPasteboard, NSPasteboardWriting};
        use objc2_foundation::{NSArray, NSString};

        let file_name = NSString::from_str(path.to_string_lossy().as_ref());
        let image = NSImage::initWithContentsOfFile(NSImage::alloc(), &file_name)
            .ok_or_else(|| "Unable to load image for copying".to_string())?;
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        let image_ref: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(&*image);
        let images = NSArray::from_slice(&[image_ref]);
        if !pasteboard.writeObjects(&images) {
            return Err("Unable to copy image to the pasteboard".to_string());
        }
        Ok(())
    })
}

#[cfg(target_os = "macos")]
fn write_image_data_to_pasteboard_impl(
    app_handle: &AppHandle,
    bytes: Vec<u8>,
) -> Result<(), String> {
    run_on_main_thread_sync(app_handle, move || {
        use objc2::{runtime::ProtocolObject, AnyThread};
        use objc2_app_kit::{NSImage, NSPasteboard, NSPasteboardWriting};
        use objc2_foundation::{NSArray, NSData};

        let data = NSData::with_bytes(&bytes);
        let image = NSImage::initWithData(NSImage::alloc(), &data)
            .ok_or_else(|| "Unable to load image data for copying".to_string())?;
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        let image_ref: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(&*image);
        let images = NSArray::from_slice(&[image_ref]);
        if !pasteboard.writeObjects(&images) {
            return Err("Unable to copy image to the pasteboard".to_string());
        }
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
fn write_image_to_pasteboard_impl(_app_handle: &AppHandle, _path: PathBuf) -> Result<(), String> {
    Err("Image pasteboard operations are only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
fn write_image_data_to_pasteboard_impl(
    _app_handle: &AppHandle,
    _bytes: Vec<u8>,
) -> Result<(), String> {
    Err("Image pasteboard operations are only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
async fn trash_path_impl(app_handle: AppHandle, path: PathBuf) -> Result<(), String> {
    use std::{ptr::NonNull, sync::mpsc};

    use block2::RcBlock;
    use objc2_foundation::{NSDictionary, NSError, NSURL};

    let (tx, rx) = mpsc::channel();
    app_handle
        .run_on_main_thread(move || {
            use objc2_app_kit::NSWorkspace;
            use objc2_foundation::NSArray;

            let result = (|| {
                let url = url_for_path(&path)?;
                let urls = NSArray::from_slice(&[&*url]);
                let tx_for_callback = tx.clone();
                let block = RcBlock::new(
                    move |_recycled_urls: NonNull<NSDictionary<NSURL, NSURL>>,
                          error: *mut NSError| {
                        let result = if error.is_null() {
                            Ok(())
                        } else {
                            let description = unsafe { &*error }.localizedDescription().to_string();
                            Err(description)
                        };
                        let _ = tx_for_callback.send(result);
                    },
                );
                NSWorkspace::sharedWorkspace().recycleURLs_completionHandler(&urls, Some(&block));
                Ok(())
            })();

            if let Err(err) = result {
                let _ = tx.send(Err(err));
            }
        })
        .map_err(|err| err.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|err| format!("Trash operation did not complete: {err}"))?
    })
    .await
    .map_err(|err| format!("Trash operation task failed: {err}"))?
}

#[cfg(not(target_os = "macos"))]
async fn trash_path_impl(_app_handle: AppHandle, _path: PathBuf) -> Result<(), String> {
    Err("Move to Trash is only supported on macOS".to_string())
}

#[derive(Debug)]
struct FileUrlPasteboard {
    operation: Option<DesktopFilePasteboardOperation>,
    paths: Vec<PathBuf>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PasteboardOperationMarker {
    operation: DesktopFilePasteboardOperation,
}

#[cfg(target_os = "macos")]
fn read_file_url_pasteboard_impl(app_handle: &AppHandle) -> Result<FileUrlPasteboard, String> {
    run_on_main_thread_sync(app_handle, read_file_url_pasteboard_on_main_thread)
}

#[cfg(not(target_os = "macos"))]
fn read_file_url_pasteboard_impl(_app_handle: &AppHandle) -> Result<FileUrlPasteboard, String> {
    Err("File pasteboard operations are only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn pasteboard_has_file_urls(app_handle: &AppHandle) -> Result<bool, String> {
    run_on_main_thread_sync(app_handle, pasteboard_has_file_url_type_on_main_thread)
}

#[cfg(not(target_os = "macos"))]
fn pasteboard_has_file_urls(_app_handle: &AppHandle) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
fn clear_pasteboard(app_handle: &AppHandle) -> Result<(), String> {
    run_on_main_thread_sync(app_handle, || {
        use objc2_app_kit::NSPasteboard;

        NSPasteboard::generalPasteboard().clearContents();
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
fn clear_pasteboard(_app_handle: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn pasteboard_has_file_url_type_on_main_thread() -> Result<bool, String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::NSArray;

    let types = NSArray::from_slice(&[unsafe { NSPasteboardTypeFileURL }]);
    Ok(NSPasteboard::generalPasteboard().canReadItemWithDataConformingToTypes(&types))
}

#[cfg(target_os = "macos")]
fn read_file_url_pasteboard_on_main_thread() -> Result<FileUrlPasteboard, String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSString, NSURL};

    let marker_type = NSString::from_str(CAMBER_PASTEBOARD_OPERATION_TYPE);
    let pasteboard = NSPasteboard::generalPasteboard();
    let Some(items) = pasteboard.pasteboardItems() else {
        return Ok(FileUrlPasteboard {
            operation: None,
            paths: Vec::new(),
        });
    };

    let mut operation = None;
    let mut paths = Vec::new();
    for index in 0..items.count() {
        let item = items.objectAtIndex(index);
        if operation.is_none() {
            operation = item
                .stringForType(&marker_type)
                .and_then(|value| {
                    serde_json::from_str::<PasteboardOperationMarker>(&value.to_string()).ok()
                })
                .map(|marker| marker.operation);
        }
        let Some(url_string) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) else {
            continue;
        };
        let Some(url) = NSURL::URLWithString(&url_string) else {
            continue;
        };
        let Some(path) = url.to_file_path() else {
            continue;
        };
        paths.push(path);
    }

    Ok(FileUrlPasteboard { operation, paths })
}

#[cfg(target_os = "macos")]
fn url_for_path(path: &Path) -> Result<objc2::rc::Retained<objc2_foundation::NSURL>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|err| err.to_string())?;
    if metadata.is_dir() {
        objc2_foundation::NSURL::from_directory_path(path)
    } else {
        objc2_foundation::NSURL::from_file_path(path)
    }
    .ok_or_else(|| "Unable to create file URL".to_string())
}

#[cfg(target_os = "macos")]
fn run_on_main_thread_sync<T, F>(app_handle: &AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    if objc2::MainThreadMarker::new().is_some() {
        return f();
    }

    let (tx, rx) = std::sync::mpsc::channel();
    app_handle
        .run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|err| err.to_string())?;
    rx.recv()
        .map_err(|err| format!("main-thread operation did not complete: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_unique_copy_names() {
        let root = unique_temp_root("copy-names");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), "").unwrap();
        fs::write(root.join("README copy.md"), "").unwrap();

        let next = unique_destination_path(&root, &PathBuf::from("README.md")).unwrap();

        assert_eq!(next, root.join("README copy 2.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn copies_directories_recursively() {
        let root = unique_temp_root("copy-directory");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested/file.txt"), "hello").unwrap();

        copy_file_system_item(&source, &destination).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("nested/file.txt")).unwrap(),
            "hello"
        );
        let _ = fs::remove_dir_all(root);
    }

    fn unique_temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "camber-file-tree-context-menu-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
}
