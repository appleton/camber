import Foundation
import MLXLMCommon
import NIOCore
import NIOHTTP1
import NIOPosix

final class SidecarHTTPServer {
    private let host: String
    private let port: Int
    private let apiKey: String
    private let runtime: LocalRuntime

    init(host: String, port: Int, apiKey: String, runtime: LocalRuntime) {
        self.host = host
        self.port = port
        self.apiKey = apiKey
        self.runtime = runtime
    }

    func run() async throws {
        let group = MultiThreadedEventLoopGroup(numberOfThreads: System.coreCount)
        let apiKey = apiKey
        let runtime = runtime
        let bootstrap = ServerBootstrap(group: group)
            .serverChannelOption(ChannelOptions.backlog, value: 128)
            .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .childChannelInitializer { channel in
                channel.pipeline.configureHTTPServerPipeline().flatMap {
                    channel.pipeline.addHandler(SidecarHTTPHandler(apiKey: apiKey, runtime: runtime))
                }
            }
            .childChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .childChannelOption(ChannelOptions.socketOption(.tcp_nodelay), value: 1)

        let channel = try await bootstrap.bind(host: host, port: port).get()
        fputs("camber-mlx-sidecar listening on http://\(host):\(port)\n", stderr)
        try await channel.closeFuture.get()
        try await group.shutdownGracefully()
    }
}

final class ResponseContext: @unchecked Sendable {
    let context: ChannelHandlerContext

    init(_ context: ChannelHandlerContext) {
        self.context = context
    }
}

final class SidecarHTTPHandler: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart

    private let apiKey: String
    private let runtime: LocalRuntime
    private var requestHead: HTTPRequestHead?
    private var requestBody = ByteBufferAllocator().buffer(capacity: 0)
    // Per-connection response tasks and their tail; only touched on the event
    // loop. See channelRead for why responses must be serialized.
    private var nextResponseID = 0
    private var responseTasks: [Int: Task<Void, Never>] = [:]
    private var pendingResponse: (id: Int, task: Task<Void, Never>)?

    init(apiKey: String, runtime: LocalRuntime) {
        self.apiKey = apiKey
        self.runtime = runtime
    }

    func channelInactive(context: ChannelHandlerContext) {
        // A disconnected client can no longer receive the response; cancel the
        // in-flight work so an abandoned generation (e.g. the user stopped the
        // turn) stops burning compute, releases its in-flight accounting, and
        // no longer blocks model unloads.
        for task in responseTasks.values {
            task.cancel()
        }
        responseTasks.removeAll()
        pendingResponse = nil
        context.fireChannelInactive()
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        switch unwrapInboundIn(data) {
        case .head(let head):
            requestHead = head
            requestBody = context.channel.allocator.buffer(capacity: 0)
        case .body(var buffer):
            requestBody.writeBuffer(&buffer)
        case .end:
            guard let head = requestHead else {
                writeError(responseContext: ResponseContext(context), status: .badRequest, message: "missing HTTP request head")
                return
            }
            let body = requestBody.readData(length: requestBody.readableBytes) ?? Data()
            requestHead = nil
            requestBody.clear()
            let responseContext = ResponseContext(context)
            // Serialize requests per connection: handle() enqueues all of a
            // response's frames onto the event loop before returning, so a
            // pipelined request must wait for the previous handle() to finish
            // or its frames would interleave with an in-flight response
            // (e.g. a JSON body spliced into an SSE stream).
            let responseID = nextResponseID
            nextResponseID += 1
            let previous = pendingResponse?.task
            let task = Task { [weak self] in
                await previous?.value
                if !Task.isCancelled, let self {
                    await self.handle(head: head, body: body, responseContext: responseContext)
                }
                responseContext.context.eventLoop.execute { [weak self] in
                    guard let self else { return }
                    self.responseTasks.removeValue(forKey: responseID)
                    if self.pendingResponse?.id == responseID {
                        self.pendingResponse = nil
                    }
                }
            }
            responseTasks[responseID] = task
            pendingResponse = (responseID, task)
        }
    }

    private func handle(head: HTTPRequestHead, body: Data, responseContext: ResponseContext) async {
        guard isAuthorized(head.headers) else {
            writeError(responseContext: responseContext, requestHead: head, status: .unauthorized, message: "missing or invalid bearer token")
            return
        }

        let path = head.uri.split(separator: "?", maxSplits: 1).first.map(String.init) ?? head.uri
        do {
            switch (head.method, path) {
            case (.GET, "/health"):
                await writeJSON(
                    responseContext: responseContext,
                    requestHead: head,
                    value: HealthResponse(
                        status: "ok",
                        modelsDirectory: await runtime.modelsDirectoryPath,
                        defaultModel: await runtime.defaultModel,
                        loadedModel: await runtime.loadedModelID,
                        idleSeconds: await runtime.idleSeconds,
                        idleUnloadAfterSeconds: await runtime.idleUnloadAfterSeconds,
                        memoryBytes: currentMemoryFootprintBytes()
                    )
                )
            case (.POST, "/admin/unload"):
                let unloaded = await runtime.unloadNow(reason: "requested via /admin/unload")
                await writeJSON(
                    responseContext: responseContext,
                    requestHead: head,
                    value: UnloadResponse(unloaded: unloaded)
                )
            case (.GET, "/v1/models"), (.GET, "/models"):
                await writeJSON(
                    responseContext: responseContext,
                    requestHead: head,
                    value: ModelsResponse(data: await runtime.listModels())
                )
            case (.POST, "/v1/chat/completions"), (.POST, "/chat/completions"):
                let request = try JSONDecoder().decode(ChatCompletionRequest.self, from: body)
                if request.stream == true {
                    try await writeStreamingChat(request: request, responseContext: responseContext, requestHead: head)
                } else {
                    try await writeBufferedChat(request: request, responseContext: responseContext, requestHead: head)
                }
            default:
                writeError(responseContext: responseContext, requestHead: head, status: .notFound, message: "unknown route \(path)")
            }
        } catch let error as DecodingError {
            writeError(responseContext: responseContext, requestHead: head, status: .badRequest, message: "\(error)")
        } catch {
            writeError(responseContext: responseContext, requestHead: head, status: status(for: error), message: error.localizedDescription)
        }
    }

    private func isAuthorized(_ headers: HTTPHeaders) -> Bool {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if key.isEmpty {
            return true
        }
        let expected = Array("Bearer \(key)".utf8)
        return headers["Authorization"].contains { header in
            constantTimeEquals(Array(header.utf8), expected)
        }
    }

    // Constant-time so response timing cannot be used to recover the bearer
    // token byte-by-byte.
    private func constantTimeEquals(_ lhs: [UInt8], _ rhs: [UInt8]) -> Bool {
        guard lhs.count == rhs.count else { return false }
        var difference: UInt8 = 0
        for index in lhs.indices {
            difference |= lhs[index] ^ rhs[index]
        }
        return difference == 0
    }

    private func writeBufferedChat(
        request: ChatCompletionRequest,
        responseContext: ResponseContext,
        requestHead: HTTPRequestHead
    ) async throws {
        let result = try await runtime.complete(request)
        let toolCalls = responseToolCalls(from: result.toolCalls)
        let response = ChatCompletionResponse(
            id: result.id,
            created: result.created,
            model: result.model.id,
            choices: [
                ChatCompletionChoice(
                    index: 0,
                    message: ResponseMessage(
                        content: result.content.isEmpty && toolCalls != nil ? nil : result.content,
                        reasoning_content: result.reasoning.isEmpty ? nil : result.reasoning,
                        tool_calls: toolCalls
                    ),
                    finish_reason: result.finishReason
                )
            ],
            usage: result.usage
        )
        await writeJSON(responseContext: responseContext, requestHead: requestHead, value: response)
    }

    private func writeStreamingChat(
        request: ChatCompletionRequest,
        responseContext: ResponseContext,
        requestHead: HTTPRequestHead
    ) async throws {
        // Errors up to here surface through handle()'s catch as a regular
        // JSON error response; nothing has been written yet.
        let opened = try await runtime.openGenerationStream(for: request)
        writeSSEHead(responseContext: responseContext, requestHead: requestHead)
        await streamGeneration(opened: opened, request: request, responseContext: responseContext)
    }

    // Deliberately non-throwing: once the SSE response head is on the wire,
    // an error escaping to handle()'s writeError would emit a second
    // response head onto the stream — an HTTP/1 protocol violation that can
    // wedge the connection. Any future fallible work in here must report
    // failures as SSE frames and terminate the stream instead of throwing.
    private func streamGeneration(
        opened: (id: String, created: Int, model: LocalModel, stream: AsyncStream<Generation>),
        request: ChatCompletionRequest,
        responseContext: ResponseContext
    ) async {
        writeSSE(
            responseContext: responseContext,
            value: ChatCompletionChunk(
                id: opened.id,
                created: opened.created,
                model: opened.model.id,
                choices: [ChatCompletionChunkChoice(
                    index: 0,
                    delta: ChunkDelta(role: "assistant", content: nil, reasoning_content: nil, tool_calls: nil),
                    finish_reason: nil,
                )],
                usage: nil
            )
        )

        var usage: Usage?
        var finishReason = "stop"
        var emittedToolCalls = false
        for await event in opened.stream {
            switch event {
            case .chunk(let text):
                guard !text.isEmpty else { continue }
                writeSSE(
                    responseContext: responseContext,
                    value: ChatCompletionChunk(
                        id: opened.id,
                        created: opened.created,
                        model: opened.model.id,
                        choices: [ChatCompletionChunkChoice(
                            index: 0,
                            delta: ChunkDelta(role: nil, content: text, reasoning_content: nil, tool_calls: nil),
                            finish_reason: nil,
                        )],
                        usage: nil
                    )
                )
            case .reasoning(let text):
                guard !text.isEmpty else { continue }
                writeSSE(
                    responseContext: responseContext,
                    value: ChatCompletionChunk(
                        id: opened.id,
                        created: opened.created,
                        model: opened.model.id,
                        choices: [ChatCompletionChunkChoice(
                            index: 0,
                            delta: ChunkDelta(role: nil, content: nil, reasoning_content: text, tool_calls: nil),
                            finish_reason: nil,
                        )],
                        usage: nil
                    )
                )
            case .toolCall(let call):
                emittedToolCalls = true
                writeSSE(
                    responseContext: responseContext,
                    value: ChatCompletionChunk(
                        id: opened.id,
                        created: opened.created,
                        model: opened.model.id,
                        choices: [ChatCompletionChunkChoice(
                            index: 0,
                            delta: ChunkDelta(role: nil, content: nil, reasoning_content: nil, tool_calls: responseToolCallDeltas(from: [call])),
                            finish_reason: nil,
                        )],
                        usage: nil
                    )
                )
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

        if emittedToolCalls {
            finishReason = "tool_calls"
        }
        writeSSE(
            responseContext: responseContext,
            value: ChatCompletionChunk(
                id: opened.id,
                created: opened.created,
                model: opened.model.id,
                choices: [ChatCompletionChunkChoice(
                    index: 0,
                    delta: ChunkDelta(role: nil, content: nil, reasoning_content: nil, tool_calls: nil),
                    finish_reason: finishReason,
                )],
                usage: nil
            )
        )
        await runtime.noteRequestFinished()
        if request.stream_options?.include_usage == true, let usage {
            writeSSE(
                responseContext: responseContext,
                value: ChatCompletionChunk(
                    id: opened.id,
                    created: opened.created,
                    model: opened.model.id,
                    choices: [],
                    usage: usage
                )
            )
        }
        writeSSEDone(responseContext: responseContext)
    }

    private func writeJSON<T: Encodable>(
        responseContext: ResponseContext,
        requestHead: HTTPRequestHead,
        status: HTTPResponseStatus = .ok,
        value: T
    ) async {
        do {
            let data = try JSONEncoder().encode(value)
            writeResponse(
                responseContext: responseContext,
                requestHead: requestHead,
                status: status,
                contentType: "application/json",
                body: data
            )
        } catch {
            writeError(responseContext: responseContext, requestHead: requestHead, status: .internalServerError, message: error.localizedDescription)
        }
    }

    private func writeError(
        responseContext: ResponseContext,
        requestHead: HTTPRequestHead? = nil,
        status: HTTPResponseStatus,
        message: String
    ) {
        let response = ErrorResponse(error: ErrorBody(message: message, type: "invalid_request_error", code: "\(status.code)"))
        let data = (try? JSONEncoder().encode(response)) ?? Data()
        writeResponse(
            responseContext: responseContext,
            requestHead: requestHead,
            status: status,
            contentType: "application/json",
            body: data
        )
    }

    private func writeResponse(
        responseContext: ResponseContext,
        requestHead: HTTPRequestHead?,
        status: HTTPResponseStatus,
        contentType: String,
        body: Data
    ) {
        responseContext.context.eventLoop.execute { [responseContext] in
            let context = responseContext.context
            var headers = self.baseHeaders(contentType: contentType)
            headers.add(name: "Content-Length", value: "\(body.count)")
            let responseHead = HTTPResponseHead(
                version: requestHead?.version ?? .http1_1,
                status: status,
                headers: headers
            )
            context.write(self.wrapOutboundOut(.head(responseHead)), promise: nil)
            var buffer = context.channel.allocator.buffer(capacity: body.count)
            buffer.writeBytes(body)
            context.write(self.wrapOutboundOut(.body(.byteBuffer(buffer))), promise: nil)
            context.writeAndFlush(self.wrapOutboundOut(.end(nil)), promise: nil)
        }
    }

    private func writeSSEHead(responseContext: ResponseContext, requestHead: HTTPRequestHead) {
        responseContext.context.eventLoop.execute { [responseContext] in
            let context = responseContext.context
            var headers = self.baseHeaders(contentType: "text/event-stream")
            headers.add(name: "Cache-Control", value: "no-cache")
            headers.add(name: "Connection", value: "keep-alive")
            let responseHead = HTTPResponseHead(version: requestHead.version, status: .ok, headers: headers)
            context.writeAndFlush(self.wrapOutboundOut(.head(responseHead)), promise: nil)
        }
    }

    private func writeSSE<T: Encodable>(responseContext: ResponseContext, value: T) {
        do {
            let data = try JSONEncoder().encode(value)
            let json = String(data: data, encoding: .utf8) ?? "{}"
            writeSSELine(responseContext: responseContext, "data: \(json)\n\n")
        } catch {
            writeSSELine(responseContext: responseContext, "data: {\"error\":\"\(error.localizedDescription)\"}\n\n")
        }
    }

    private func writeSSEDone(responseContext: ResponseContext) {
        writeSSELine(responseContext: responseContext, "data: [DONE]\n\n", end: true)
    }

    private func writeSSELine(responseContext: ResponseContext, _ line: String, end: Bool = false) {
        responseContext.context.eventLoop.execute { [responseContext] in
            let context = responseContext.context
            var buffer = context.channel.allocator.buffer(capacity: line.utf8.count)
            buffer.writeString(line)
            context.write(self.wrapOutboundOut(.body(.byteBuffer(buffer))), promise: nil)
            if end {
                context.writeAndFlush(self.wrapOutboundOut(.end(nil)), promise: nil)
            } else {
                context.flush()
            }
        }
    }

    // No CORS headers on purpose: the only clients are local processes, and
    // advertising cross-origin access would invite drive-by probing from web
    // pages against the local port.
    private func baseHeaders(contentType: String) -> HTTPHeaders {
        var headers = HTTPHeaders()
        headers.add(name: "Content-Type", value: contentType)
        return headers
    }
}

func status(for error: Error) -> HTTPResponseStatus {
    switch error {
    case SidecarError.unknownModel:
        // The client asked for a model this server does not have — a request
        // error, not a missing route; clients treat 404 as "endpoint absent".
        return .badRequest
    case SidecarError.modelNotDownloaded:
        // The model exists but its weights are not on disk yet; the request
        // may succeed later once the download completes.
        return .conflict
    default:
        return .internalServerError
    }
}
