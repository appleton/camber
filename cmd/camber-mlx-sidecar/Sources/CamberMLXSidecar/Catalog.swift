import Foundation

// The sidecar has no model catalog of its own: the Go helper's catalog
// (pkg/camber-helper/internal/handler/localinference/catalog.go) is the
// single source of truth for what to advertise and download. The sidecar's
// contract is purely "serve what is on disk" — every model the helper
// downloads carries a `.poolside-local-model.json` manifest with its display
// metadata, and anything without one falls back to config.json plus the repo
// id.

struct LocalModel: Sendable {
    let id: String
    let repoID: String
    let name: String
    let provider: String
    let contextWindow: Int
}

let downloadMarkerFilename = ".poolside-download-in-progress"
let installedManifestFilename = ".poolside-local-model.json"

/// Context window advertised for a downloaded model whose manifest and
/// config.json do not declare one.
let fallbackDownloadedContextWindow = 32_768

func candidateModelDirectories(modelsDirectory: URL, repoID: String) -> [URL] {
    let parts = repoID.split(separator: "/").map(String.init)
    if parts.count == 2 {
        return [
            modelsDirectory.appendingPathComponent(parts[0]).appendingPathComponent(parts[1]),
            modelsDirectory.appendingPathComponent(parts[1]),
        ]
    }
    return [modelsDirectory.appendingPathComponent(repoID)]
}

func isDownloadedModel(_ url: URL) -> Bool {
    let fm = FileManager.default
    guard !fm.fileExists(atPath: url.appendingPathComponent(downloadMarkerFilename).path) else {
        return false
    }
    guard fm.fileExists(atPath: url.appendingPathComponent("config.json").path) else {
        return false
    }
    let hasTokenizer = fm.fileExists(atPath: url.appendingPathComponent("tokenizer.json").path)
        || fm.fileExists(atPath: url.appendingPathComponent("tokenizer.model").path)
        || (fm.fileExists(atPath: url.appendingPathComponent("vocab.json").path)
            && fm.fileExists(atPath: url.appendingPathComponent("merges.txt").path))
    guard hasTokenizer else { return false }
    if fm.fileExists(atPath: url.appendingPathComponent("model.safetensors.index.json").path) {
        return true
    }
    guard let entries = try? fm.contentsOfDirectory(atPath: url.path) else {
        return false
    }
    return entries.contains { $0.hasSuffix(".safetensors") }
}

/// Resolve a requested model id against the models directory. Accepts full
/// repo ids (`owner/name`), bare directory names, and — for convenience — the
/// bare last component of a two-level repo id. Returns nil when nothing
/// downloaded matches.
func downloadedModelForRequestID(_ id: String, modelsDirectory: URL) -> LocalModel? {
    let requested = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !requested.isEmpty else { return nil }
    if let path = candidateModelDirectories(modelsDirectory: modelsDirectory, repoID: requested)
        .first(where: isDownloadedModel) {
        return downloadedModel(repoID: requested, at: path)
    }
    // A bare name can refer to a model stored under `owner/name`; resolve it
    // to the canonical repo id so session caching keys stay stable.
    guard !requested.contains("/") else { return nil }
    for repoID in downloadedModelRepoIDs(in: modelsDirectory)
    where repoID.split(separator: "/").last.map(String.init) == requested {
        if let path = candidateModelDirectories(modelsDirectory: modelsDirectory, repoID: repoID)
            .first(where: isDownloadedModel) {
            return downloadedModel(repoID: repoID, at: path)
        }
    }
    return nil
}

/// Repo ids of every downloaded model in the models directory, scanning the
/// one- and two-level layouts the downloader writes (`<owner>/<name>` or
/// `<name>`).
func downloadedModelRepoIDs(in modelsDirectory: URL) -> [String] {
    let fm = FileManager.default
    guard
        let owners = try? fm.contentsOfDirectory(
            at: modelsDirectory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
    else {
        return []
    }
    var repoIDs: [String] = []
    for owner in owners where isDirectory(owner) {
        var foundChild = false
        if let children = try? fm.contentsOfDirectory(
            at: owner,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) {
            for child in children where isDirectory(child) && isDownloadedModel(child) {
                repoIDs.append("\(owner.lastPathComponent)/\(child.lastPathComponent)")
                foundChild = true
            }
        }
        if !foundChild && isDownloadedModel(owner) {
            repoIDs.append(owner.lastPathComponent)
        }
    }
    return repoIDs.sorted()
}

private func downloadedModel(repoID: String, at url: URL) -> LocalModel {
    let manifest = readInstalledManifest(at: url)
    let parts = repoID.split(separator: "/").map(String.init)
    let contextWindow = manifest?.contextWindow.flatMap { $0 > 0 ? $0 : nil }
    return LocalModel(
        id: repoID,
        repoID: repoID,
        name: manifest?.name ?? parts.last ?? repoID,
        provider: manifest?.provider ?? (parts.count == 2 ? parts[0] : "local"),
        contextWindow: contextWindow ?? downloadedModelContextWindow(at: url)
    )
}

/// Display metadata the Go helper writes next to every downloaded model.
private struct InstalledModelManifest: Decodable {
    var name: String?
    var provider: String?
    var contextWindow: Int?
}

private func readInstalledManifest(at url: URL) -> InstalledModelManifest? {
    guard let data = try? Data(contentsOf: url.appendingPathComponent(installedManifestFilename))
    else {
        return nil
    }
    return try? JSONDecoder().decode(InstalledModelManifest.self, from: data)
}

/// Best-effort read of a downloaded model's context window from config.json,
/// falling back to a conservative default.
func downloadedModelContextWindow(at url: URL) -> Int {
    guard
        let data = try? Data(contentsOf: url.appendingPathComponent("config.json")),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return fallbackDownloadedContextWindow
    }
    if let value = json["max_position_embeddings"] as? Int, value > 0 {
        return value
    }
    // Multimodal / nested architectures often carry it under text_config.
    if let textConfig = json["text_config"] as? [String: Any],
        let value = textConfig["max_position_embeddings"] as? Int, value > 0 {
        return value
    }
    return fallbackDownloadedContextWindow
}

private func isDirectory(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
}
