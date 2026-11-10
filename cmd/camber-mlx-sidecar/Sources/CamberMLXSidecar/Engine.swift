import Foundation
import MLX
import MLXLMCommon
import MLXPress

/// Serves generations for one loaded model while keeping each recent
/// conversation's KV cache alive in unified memory between requests.
///
/// The stock MLXPress path rebuilds the KV cache for every HTTP request and
/// round-trips prompt prefixes through a disk cache — for agent conversations
/// that means re-prefilling (or re-reading from disk) the entire transcript
/// on every turn, plus synchronously writing the full prompt KV back to disk
/// before the response stream can finish. This engine instead keeps the live
/// cache from the previous turn and prefills only the tokens that follow the
/// longest common token prefix, the same way llama.cpp server slots work.
///
/// Generations are strictly serialized: the desktop assistant issues one
/// generation at a time per model, MLX decode throughput collapses when two
/// generations share the GPU, and serial generations keep slot bookkeeping
/// trivially correct. The serialization lock is held from slot selection
/// until the generation loop has fully stopped.
actor CamberEngine {
    /// A conversation slot: the tokens whose KV state is materialized in
    /// `cache`, in order. Reconciled after every generation from the cache
    /// offset, which is authoritative for how many positions were fed.
    private final class Slot {
        var tokens: [Int] = []
        var cache: [KVCache] = []
        var lastUsed = ContinuousClock.now

        func reset() {
            tokens = []
            cache = []
        }
    }

    /// Two slots cover the desktop reality: the active conversation plus one
    /// side request (e.g. title generation) without evicting the main
    /// conversation's cache.
    private static let slotCount = 2

    /// Reusing a cached prefix shorter than this recycles the least recently
    /// used slot instead: a match of just the shared template header is not
    /// worth evicting a real conversation's cache for.
    private static let minimumUsefulPrefix = 64

    private let session: MLXPressSession

    private var slots: [Slot] = (0..<CamberEngine.slotCount).map { _ in Slot() }

    // FIFO generation lock. `acquireGenerationLock` has no suspension between
    // reading and writing `generationInFlight`, so actor reentrancy cannot
    // admit two generations; a continuation resume transfers ownership.
    private var generationInFlight = false
    private var lockWaiters: [CheckedContinuation<Void, Never>] = []

    init(session: MLXPressSession) {
        self.session = session
    }

    /// Drops all live conversation caches, keeping the model weights. Called
    /// under memory pressure: the KV for a long conversation is the cheap
    /// thing to give back first — re-prefilling it costs seconds, reloading
    /// the weights costs the better part of a minute.
    func dropConversationCaches() async {
        await acquireGenerationLock()
        defer { releaseGenerationLock() }
        for slot in slots {
            slot.reset()
        }
        Memory.clearCache()
    }

    /// Opens a generation stream for the request. The returned stream ends
    /// with a `.info` event exactly like the MLXPress path; the serialization
    /// lock is released internally once the generation loop stops.
    func openStream(
        input: consuming sending UserInput,
        parameters: GenerateParameters
    ) async throws -> AsyncStream<Generation> {
        await acquireGenerationLock()
        do {
            let stream = try await openStreamLocked(input: input, parameters: parameters)
            return stream
        } catch {
            releaseGenerationLock()
            throw error
        }
    }

    private func openStreamLocked(
        input: consuming sending UserInput,
        parameters: GenerateParameters
    ) async throws -> AsyncStream<Generation> {
        let prepared = try await session.container.prepare(input: input)
        let promptTokens = prepared.text.tokens.reshaped(-1).asArray(Int.self)
        guard !promptTokens.isEmpty else {
            throw SidecarError.emptyPrompt
        }
        let toolSchemas = prepared.toolSchemas

        let slotIndex = bestSlot(for: promptTokens)
        let slot = slots[slotIndex]
        slot.lastUsed = .now

        // Reuse at most promptTokens.count - 1 cached positions: the
        // iterator needs at least one prompt token as input to produce the
        // first logits (an identical re-sent prompt is the regenerate case).
        let reusable = min(
            commonPrefixLength(slot.tokens, promptTokens),
            promptTokens.count - 1)
        let sink = GeneratedTokenSink()
        let slotBox = UnsafeSendableBox(slot)

        let started: StartedGeneration = try await session.container.perform { context in
            let slot = slotBox.value
            let excess = slot.tokens.count - reusable
            if excess > 0 {
                // The cache holds tokens the new prompt does not share (an
                // edited turn, a stripped reasoning block, or an identical
                // re-send). Trim when every layer still can; Laguna's
                // sliding-window layers stop being trimmable once their ring
                // rotates, in which case the slot starts over.
                if reusable > 0, canTrimPromptCache(slot.cache),
                    trimPromptCache(slot.cache, numTokens: excess) == excess
                {
                    slot.tokens.removeLast(excess)
                } else {
                    slot.reset()
                }
            }
            if slot.cache.isEmpty {
                slot.cache = context.model.newCache(parameters: parameters)
                slot.tokens = []
            }

            let suffix = Array(promptTokens[slot.tokens.count...])
            FileHandle.standardError.write(Data(
                "camber-mlx-sidecar: engine slot reused=\(slot.tokens.count) prefill=\(suffix.count) prompt=\(promptTokens.count)\n"
                    .utf8))
            let suffixTokens = MLXArray(suffix.map(Int32.init)).expandedDimensions(axis: 0)
            let suffixInput = LMInput(text: .init(tokens: suffixTokens))

            // Prefill of the suffix runs here, inside the container's serial
            // context, exactly like the stock ModelContainer.generate path.
            let iterator = try TokenIterator(
                input: suffixInput,
                model: context.model,
                cache: slot.cache,
                parameters: parameters,
                cacheCoordinator: nil)
            let (stream, task) = generateTask(
                promptTokenCount: promptTokens.count,
                modelConfiguration: context.configuration,
                tokenizer: context.tokenizer,
                iterator: GeneratedTokenRecordingIterator(base: iterator, sink: sink),
                extraStopStrings: parameters.extraStopStrings,
                toolSchemas: toolSchemas)
            return StartedGeneration(stream: stream, task: task)
        }

        // Reconcile the slot and release the lock only once the loop task has
        // fully stopped — normal stop, tool call, or client cancellation.
        Task { [weak self] in
            await started.task.value
            await self?.finishGeneration(
                slotIndex: slotIndex, promptTokens: promptTokens, sink: sink)
        }
        return started.stream
    }

    /// Reconciles slot bookkeeping after a generation loop has stopped and
    /// releases the generation lock. The cache offset says how many positions
    /// were actually fed through the model; sampled-token order fills in the
    /// identities past the prompt.
    private func finishGeneration(
        slotIndex: Int,
        promptTokens: [Int],
        sink: GeneratedTokenSink
    ) {
        defer { releaseGenerationLock() }
        let slot = slots[slotIndex]
        var offset = slot.cache.first?.offset ?? 0
        let fed = promptTokens + sink.tokens
        guard offset > 0, offset <= fed.count else {
            // An aborted prefill or unexpected cache shape: the slot's
            // contents can no longer be trusted for prefix reuse.
            slot.reset()
            return
        }

        // A generation that ends on a stop token feeds that token into the
        // cache in the same step that samples it, but the chat template does
        // not re-render it verbatim on the next turn (Laguna renders a
        // newline before `</assistant>`). One mismatched trailing token
        // would force a full slot reset — sliding-window rings cannot trim
        // once rotated — so roll the single just-written position back out.
        // That trim is pure write-pointer bookkeeping: the next fed token
        // overwrites the same ring slot the stop token occupied.
        if let emitted = sink.emittedCount, offset - promptTokens.count - emitted == 1 {
            for layer in slot.cache {
                _ = layer.trim(1)
            }
            offset -= 1
        }

        slot.tokens = Array(fed[..<offset])
        slot.lastUsed = .now
    }

    private func acquireGenerationLock() async {
        if !generationInFlight {
            generationInFlight = true
            return
        }
        await withCheckedContinuation { continuation in
            lockWaiters.append(continuation)
        }
    }

    private func releaseGenerationLock() {
        if lockWaiters.isEmpty {
            generationInFlight = false
        } else {
            // Ownership transfers to the resumed waiter; generationInFlight
            // stays true.
            lockWaiters.removeFirst().resume()
        }
    }

    private func bestSlot(for promptTokens: [Int]) -> Int {
        var bestIndex = 0
        var bestPrefix = -1
        var oldestIndex = 0
        var oldestUsed = ContinuousClock.now
        for (index, slot) in slots.enumerated() {
            let prefix = commonPrefixLength(slot.tokens, promptTokens)
            if prefix > bestPrefix {
                bestPrefix = prefix
                bestIndex = index
            }
            if slot.lastUsed < oldestUsed {
                oldestUsed = slot.lastUsed
                oldestIndex = index
            }
        }
        return bestPrefix >= Self.minimumUsefulPrefix ? bestIndex : oldestIndex
    }

    private func commonPrefixLength(_ a: [Int], _ b: [Int]) -> Int {
        var i = 0
        let limit = min(a.count, b.count)
        while i < limit && a[i] == b[i] {
            i += 1
        }
        return i
    }
}

/// Carries non-Sendable generation state across the container boundary. Safe
/// here because the engine's generation lock guarantees a single generation
/// (and therefore a single reader/writer) at a time.
private final class UnsafeSendableBox<T>: @unchecked Sendable {
    let value: T

    init(_ value: T) {
        self.value = value
    }
}

private struct StartedGeneration: @unchecked Sendable {
    let stream: AsyncStream<Generation>
    let task: Task<Void, Never>
}

/// Collects sampled token ids from the generation loop. Appended from the
/// loop task only; read by the engine only after the loop task completes.
final class GeneratedTokenSink: @unchecked Sendable {
    private(set) var tokens: [Int] = []

    /// The generation loop's emitted-token count, from
    /// `storeCacheAfterGeneration`. Excludes a terminating stop token, so
    /// `tokens.count - emittedCount` says whether one was sampled (and fed).
    private(set) var emittedCount: Int?

    func append(_ token: Int) {
        tokens.append(token)
    }

    func recordEmittedCount(_ count: Int) {
        emittedCount = count
    }
}

/// Forwards a `TokenIterator` while recording every sampled token, so the
/// engine can reconstruct exactly which token ids the cache holds after the
/// generation ends — including early stops and cancellations.
struct GeneratedTokenRecordingIterator: TokenIteratorProtocol {
    var base: TokenIterator
    let sink: GeneratedTokenSink

    var maxTokens: Int? { base.maxTokens }
    var tokenCount: Int { base.tokenCount }
    var promptPrefillTime: TimeInterval { base.promptPrefillTime }
    var promptTokenIds: [Int] { base.promptTokenIds }
    var turboQuantCompressionCount: Int { base.turboQuantCompressionCount }

    mutating func next() -> Int? {
        guard let token = base.next() else { return nil }
        sink.append(token)
        return token
    }

    mutating func storeCacheAfterGeneration(
        generatedTokenIds: [Int], includeGeneratedBoundary: Bool
    ) {
        // No cache coordinator: there is nothing to persist — the live slot
        // cache itself is the reuse mechanism. The emitted count feeds the
        // engine's stop-token rollback.
        sink.recordEmittedCount(generatedTokenIds.count)
    }
}
