import Foundation
import MLX
import MLXLMCommon
import MLXPress

enum SidecarError: Error, LocalizedError {
    case unknownModel(String)
    case modelNotDownloaded(model: String, searched: [String])
    case emptyPrompt

    var errorDescription: String? {
        switch self {
        case .unknownModel(let model):
            return "Unknown local model: \(model)"
        case .modelNotDownloaded(let model, let searched):
            return "Local model \(model) is not downloaded. Searched: \(searched.joined(separator: ", "))"
        case .emptyPrompt:
            return "The request produced an empty prompt"
        }
    }
}

struct CompletionResult: Sendable {
    let id: String
    let created: Int
    let model: LocalModel
    let content: String
    let reasoning: String
    let toolCalls: [ToolCall]
    let usage: Usage?
    let finishReason: String
}

/// A loaded model: the MLXPress session that owns the weights plus the
/// engine that serves generations from live conversation caches.
struct LoadedModel {
    let session: MLXPressSession
    let engine: CamberEngine
}

actor LocalRuntime {
    private let modelsDirectory: URL
    private let configuredDefaultModel: String
    private let idleUnloadAfter: Duration?
    private var sessions: [String: LoadedModel] = [:]
    // Requests between openGenerationStream and noteRequestFinished; the
    // loaded model is never unloaded while this is non-zero. Loading is
    // counted too, so a memory-pressure event cannot evict the very model
    // that is being brought up.
    private var inFlightRequests = 0
    private var lastActivity = ContinuousClock.now

    init(modelsDirectory: URL, defaultModel: String, idleUnloadAfter: Duration?) {
        self.modelsDirectory = modelsDirectory
        self.configuredDefaultModel = defaultModel
        self.idleUnloadAfter = idleUnloadAfter
    }

    var modelsDirectoryPath: String {
        modelsDirectory.path
    }

    var defaultModel: String {
        configuredDefaultModel
    }

    var loadedModelID: String? {
        sessions.keys.first
    }

    /// Seconds since the last request started or finished. Drives the
    /// "last prompt" display and lets clients anticipate the idle unload.
    var idleSeconds: Int {
        Int((ContinuousClock.now - lastActivity).components.seconds)
    }

    var idleUnloadAfterSeconds: Int? {
        idleUnloadAfter.map { Int($0.components.seconds) }
    }

    /// Marks a request as finished for idle accounting. Every successful
    /// openGenerationStream must be balanced by exactly one call, after its
    /// stream has been fully consumed.
    func noteRequestFinished() {
        inFlightRequests = max(0, inFlightRequests - 1)
        lastActivity = .now
    }

    /// Unloads the resident model unless a request is in flight. Returns
    /// whether a model was unloaded.
    @discardableResult
    func unloadNow(reason: String) -> Bool {
        guard inFlightRequests == 0, !sessions.isEmpty else { return false }
        let unloaded = sessions.keys.joined(separator: ", ")
        sessions.removeAll()
        // Dropping the session releases the weights; the MLX buffer cache
        // holds recycled allocations and must be cleared explicitly for the
        // unified memory to return to the OS.
        Memory.clearCache()
        FileHandle.standardError.write(
            Data("camber-mlx-sidecar: unloaded \(unloaded) (\(reason))\n".utf8))
        return true
    }

    /// Periodically unloads the resident model after the configured idle
    /// interval. Runs for the lifetime of the process; a nil interval
    /// disables idle unloading.
    func runIdleUnloadLoop() async {
        guard let idleUnloadAfter else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(30))
            guard inFlightRequests == 0, !sessions.isEmpty else { continue }
            let idle = ContinuousClock.now - lastActivity
            if idle >= idleUnloadAfter {
                unloadNow(reason: "idle for \(Int(idle.components.seconds))s")
            }
        }
    }

    /// Reacts to macOS memory pressure: critical pressure evicts an idle
    /// model immediately (a model actively being prompted is never evicted —
    /// it is the reason the memory is in use). A warning first gives back
    /// the live conversation KV caches, which cost seconds of prefill to
    /// rebuild; the weights — a ~minute-long reload — are only given up
    /// after a sustained idle period. A large resident model keeps macOS
    /// near the warning level on smaller machines, and evicting on every
    /// warning made each prompt after a minute of idle pay the full reload.
    func handleMemoryPressure(critical: Bool) {
        guard inFlightRequests == 0, !sessions.isEmpty else { return }
        if critical {
            unloadNow(reason: "critical memory pressure")
            return
        }
        if ContinuousClock.now - lastActivity >= .seconds(300) {
            unloadNow(reason: "memory pressure warning while idle")
            return
        }
        let engines = sessions.values.map(\.engine)
        Task {
            for engine in engines {
                await engine.dropConversationCaches()
            }
        }
    }

    func listModels() -> [OpenAIModel] {
        downloadedModelRepoIDs(in: modelsDirectory).compactMap { repoID in
            downloadedModelForRequestID(repoID, modelsDirectory: modelsDirectory)
                .map(openAIModel(from:))
        }
    }

    private func openAIModel(from model: LocalModel) -> OpenAIModel {
        OpenAIModel(
            id: model.id,
            created: Int(Date().timeIntervalSince1970),
            owned_by: model.provider,
            root: model.repoID,
            name: model.name,
            context_length: model.contextWindow,
            details: ModelDetails(family: model.provider, context_length: model.contextWindow)
        )
    }

    func openGenerationStream(for request: ChatCompletionRequest) async throws -> (
        id: String,
        created: Int,
        model: LocalModel,
        stream: AsyncStream<Generation>
    ) {
        inFlightRequests += 1
        lastActivity = .now
        do {
            let model = try resolveModel(request.model)
            let loaded = try await loadedModel(for: model)
            let input = UserInput(
                chat: request.messages.map { $0.mlxMessage() },
                tools: toolSpecs(from: request.tools),
                additionalContext: additionalContext(from: request.tool_choice)
            )
            let stream = try await loaded.engine.openStream(
                input: input,
                parameters: generateParameters(for: request)
            )
            return (
                id: "chatcmpl-\(UUID().uuidString)",
                created: Int(Date().timeIntervalSince1970),
                model: model,
                stream: stream
            )
        } catch {
            noteRequestFinished()
            throw error
        }
    }

    func complete(_ request: ChatCompletionRequest) async throws -> CompletionResult {
        let opened = try await openGenerationStream(for: request)
        var content = ""
        var reasoning = ""
        var toolCalls: [ToolCall] = []
        var usage: Usage?
        var finishReason = "stop"

        for await event in opened.stream {
            switch event {
            case .chunk(let text):
                content += text
            case .reasoning(let text):
                reasoning += text
            case .toolCall(let call):
                toolCalls.append(call)
            case .info(let info):
                usage = Usage(
                    prompt_tokens: info.promptTokenCount,
                    completion_tokens: info.generationTokenCount,
                    total_tokens: info.promptTokenCount + info.generationTokenCount
                )
                finishReason = finishReasonForStop(info.stopReason)
            case .prefillProgress:
                break
            }
        }

        if !toolCalls.isEmpty {
            finishReason = "tool_calls"
        }

        noteRequestFinished()
        return CompletionResult(
            id: opened.id,
            created: opened.created,
            model: opened.model,
            content: content,
            reasoning: reasoning,
            toolCalls: toolCalls,
            usage: usage,
            finishReason: finishReason
        )
    }

    private func resolveModel(_ requested: String) throws -> LocalModel {
        var id = requested.isEmpty ? configuredDefaultModel : requested
        if id.isEmpty {
            // Bare CLI runs may omit --default-model; serve the only (first)
            // downloaded model rather than failing every empty request.
            id = downloadedModelRepoIDs(in: modelsDirectory).first ?? ""
        }
        if let model = downloadedModelForRequestID(id, modelsDirectory: modelsDirectory) {
            return model
        }
        // Report the id actually looked up: when the request omitted a model,
        // `requested` is empty and the failing id is the configured default.
        throw SidecarError.unknownModel(id.isEmpty ? "(no models downloaded)" : id)
    }

    private func loadedModel(for model: LocalModel) async throws -> LoadedModel {
        if let loaded = sessions[model.id] {
            return loaded
        }

        let candidates = candidateModelDirectories(modelsDirectory: modelsDirectory, repoID: model.repoID)
        guard let path = candidates.first(where: isDownloadedModel) else {
            throw SidecarError.modelNotDownloaded(
                model: model.id,
                searched: candidates.map(\.path)
            )
        }

        // Keep one resident session: each holds the model's full weights in
        // unified memory, so evict the previous model before loading the next
        // rather than accumulating every model ever requested. An in-flight
        // generation keeps its evicted session alive until it finishes. The
        // resident session is also dropped after the idle-unload interval and
        // under memory pressure (see unloadNow).
        sessions.removeAll()
        let session = try await MLXPressSession.load(
            from: path, configuration: sidecarLoadConfiguration(forModelAt: path))
        let loaded = LoadedModel(session: session, engine: CamberEngine(session: session))
        sessions[model.id] = loaded
        return loaded
    }
}

/// Load configuration for serving Camber agent traffic.
///
/// Deviations from the MLXPress defaults, both measured on
/// Laguna-XS-2.1 (M3 Pro, 36GB):
///
/// - The multi-tier prompt cache is disabled. Its in-memory paged tier is
///   incompatible with Laguna's sliding-window caches (and with any KV
///   quantization), so every reuse round-trips the full prompt KV through
///   disk — synchronous multi-hundred-MB writes per generation that block
///   the end of the response stream. `CamberEngine`'s live conversation
///   caches replace it with zero-copy in-memory reuse. This also keeps the
///   KV cache in bf16, sidestepping the 8k rotating-KV cap the coordinator
///   applies to long prompts.
/// - The cold-weight tier is disabled when the weights comfortably fit in
///   physical memory. Its decode-time page advice (cold routed experts +
///   Zipfian embed rows) deliberately makes weight pages evictable, which
///   only makes sense on hosts that need the memory back; A/B runs on the
///   fits-in-memory host measured no decode benefit from it in any state.
///   Setting the MLXPRESS env var (e.g. "70" or "off") still forces a
///   policy either way.
func sidecarLoadConfiguration(forModelAt url: URL) -> MLXPressLoadConfiguration {
    var configuration = MLXPressLoadConfiguration()
    configuration.cache = .disabled
    if ProcessInfo.processInfo.environment["MLXPRESS"] == nil,
        ProcessInfo.processInfo.environment["JANGPRESS"] == nil,
        weightsComfortablyFitInMemory(at: url)
    {
        configuration.compression = .disabled
    }
    return configuration
}

/// Whether the bundle's weights fit in physical memory with enough headroom
/// (KV caches, the rest of the app, and the OS) to serve without relying on
/// the cold-weight tier.
func weightsComfortablyFitInMemory(at url: URL) -> Bool {
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(
        at: url, includingPropertiesForKeys: [.fileSizeKey], options: [.skipsHiddenFiles])
    else {
        return false
    }
    let weightBytes = entries
        .filter { $0.pathExtension == "safetensors" }
        .compactMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }
        .reduce(0, +)
    let headroomBytes: UInt64 = 12 << 30
    return UInt64(weightBytes) + headroomBytes <= ProcessInfo.processInfo.physicalMemory
}

/// The process's physical memory footprint in bytes (the same figure
/// Activity Monitor reports as "Memory", including Metal unified-memory
/// buffers, which plain resident-set size misses). Returns nil if the
/// task-info query fails.
func currentMemoryFootprintBytes() -> Int64? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
        MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
        }
    }
    guard result == KERN_SUCCESS else { return nil }
    return Int64(info.phys_footprint)
}

/// Releases the loaded model when macOS reports memory pressure: the model
/// stays warm while memory is plentiful and vacates when the system needs it.
/// Defined outside main.swift on purpose — a closure formed in top-level code
/// inherits @MainActor isolation and traps when libdispatch invokes it on a
/// global queue. The caller must keep the returned source alive.
func startMemoryPressureMonitor(runtime: LocalRuntime) -> DispatchSourceMemoryPressure {
    let source = DispatchSource.makeMemoryPressureSource(
        eventMask: [.warning, .critical],
        queue: .global()
    )
    source.setEventHandler { [weak source] in
        let critical = source?.data.contains(.critical) ?? false
        Task { await runtime.handleMemoryPressure(critical: critical) }
    }
    source.activate()
    return source
}

func generateParameters(for request: ChatCompletionRequest) -> GenerateParameters {
    var parameters = GenerateParameters(
        maxTokens: request.max_completion_tokens ?? request.max_tokens ?? 4096,
        temperature: Float(request.temperature ?? 0.6),
        topP: Float(request.top_p ?? 1.0),
        topK: request.top_k ?? 0,
        minP: Float(request.min_p ?? 0.0),
        randomSeed: request.seed.map(UInt64.init),
        extraStopStrings: request.stop?.strings ?? []
    )
    parameters.prefillStepSize = configuredPrefillStepSize
    return parameters
}

/// Prompt prefill chunk size. The default matches the library default;
/// measured on Laguna-XS-2.1 (M3 Pro 36GB), larger chunks bought nothing —
/// prefill is bound by the MoE forward, not chunk overhead. The env override
/// exists for low-memory hosts, where per-chunk transient buffers scale with
/// this value and vmlx guidance suggests 256 on 16GB machines.
let configuredPrefillStepSize: Int = {
    if let raw = ProcessInfo.processInfo.environment["CAMBER_MLX_PREFILL_STEP"],
        let value = Int(raw.trimmingCharacters(in: .whitespaces)),
        (64...8192).contains(value)
    {
        return value
    }
    return 512
}()

func finishReasonForStop(_ reason: GenerateStopReason) -> String {
    switch reason {
    case .stop:
        return "stop"
    case .length:
        return "length"
    case .cancelled:
        return "stop"
    }
}

func responseToolCalls(from calls: [ToolCall]) -> [ResponseToolCall]? {
    guard !calls.isEmpty else { return nil }
    return calls.enumerated().map { index, call in
        ResponseToolCall(
            id: call.id ?? "call_\(index)",
            function: ResponseToolFunction(
                name: call.function.name,
                arguments: encodeArguments(call.function.arguments)
            )
        )
    }
}

func responseToolCallDeltas(from calls: [ToolCall]) -> [ResponseToolCallDelta]? {
    guard !calls.isEmpty else { return nil }
    return calls.enumerated().map { index, call in
        ResponseToolCallDelta(
            index: index,
            id: call.id ?? "call_\(index)",
            function: ResponseToolFunction(
                name: call.function.name,
                arguments: encodeArguments(call.function.arguments)
            )
        )
    }
}
