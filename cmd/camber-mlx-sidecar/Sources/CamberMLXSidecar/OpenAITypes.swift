import Foundation
import MLXLMCommon

enum AnyJSON: Codable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([AnyJSON])
    case object([String: AnyJSON])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([AnyJSON].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: AnyJSON].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }

    var sendableValue: any Sendable {
        switch self {
        case .null:
            Optional<String>.none as String?
        case .bool(let value):
            value
        case .int(let value):
            value
        case .double(let value):
            value
        case .string(let value):
            value
        case .array(let value):
            value.map(\.sendableValue)
        case .object(let value):
            value.mapValues(\.sendableValue)
        }
    }
}

struct ModelsResponse: Encodable {
    let object = "list"
    let data: [OpenAIModel]
}

struct OpenAIModel: Encodable {
    let id: String
    let object = "model"
    let created: Int
    let owned_by: String
    let root: String
    let name: String
    let context_length: Int
    let details: ModelDetails
}

struct ModelDetails: Encodable {
    let format = "safetensors"
    let family: String
    let context_length: Int
}

struct ErrorResponse: Encodable {
    let error: ErrorBody
}

struct ErrorBody: Encodable {
    let message: String
    let type: String
    let code: String?
}

struct HealthResponse: Encodable {
    let status: String
    let modelsDirectory: String
    let defaultModel: String
    let loadedModel: String?
    /// Seconds since the runtime last started or finished a request.
    let idleSeconds: Int
    /// Idle interval after which the loaded model is unloaded; absent when
    /// idle unloading is disabled.
    let idleUnloadAfterSeconds: Int?
    /// Process physical footprint in bytes (Activity Monitor's "Memory").
    let memoryBytes: Int64?
}

struct UnloadResponse: Encodable {
    let unloaded: Bool
}

struct ChatCompletionRequest: Decodable {
    let model: String
    let messages: [RequestMessage]
    let temperature: Double?
    let top_p: Double?
    let top_k: Int?
    let min_p: Double?
    let max_tokens: Int?
    let max_completion_tokens: Int?
    let stream: Bool?
    let stream_options: StreamOptions?
    let stop: StopValue?
    let seed: Int?
    let tools: [AnyJSON]?
    let tool_choice: AnyJSON?
}

struct StreamOptions: Decodable {
    let include_usage: Bool?
}

enum StopValue: Decodable {
    case string(String)
    case array([String])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        self = .array(try container.decode([String].self))
    }

    var strings: [String] {
        switch self {
        case .string(let value):
            [value]
        case .array(let value):
            value
        }
    }
}

struct RequestMessage: Decodable {
    let role: String
    let content: RequestMessageContent?
    let reasoning_content: String?
    let reasoning: String?
    let tool_calls: [RequestToolCall]?
    let tool_call_id: String?

    func mlxMessage() -> Chat.Message {
        let text = content?.text ?? ""
        switch role {
        case "system":
            return .system(text)
        case "assistant":
            let calls = tool_calls?.compactMap(\.mlxToolCall) ?? []
            if calls.isEmpty {
                return Chat.Message(
                    role: .assistant,
                    content: text,
                    reasoningContent: reasoning_content ?? reasoning
                )
            }
            return Chat.Message(
                role: .assistant,
                content: text,
                reasoningContent: reasoning_content ?? reasoning,
                toolCalls: calls
            )
        case "tool":
            return .tool(text, toolCallId: tool_call_id)
        default:
            return .user(text)
        }
    }
}

enum RequestMessageContent: Decodable {
    case text(String)
    case parts([RequestContentPart])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .text(value)
            return
        }
        self = .parts(try container.decode([RequestContentPart].self))
    }

    var text: String {
        switch self {
        case .text(let value):
            value
        case .parts(let parts):
            parts.compactMap(\.textValue).joined(separator: "\n")
        }
    }
}

struct RequestContentPart: Decodable {
    let type: String
    let text: String?
    let input_text: String?

    var textValue: String? {
        switch type {
        case "text":
            return text
        case "input_text":
            return input_text ?? text
        default:
            return nil
        }
    }
}

struct RequestToolCall: Decodable {
    let id: String?
    let type: String?
    let function: RequestToolFunction

    var mlxToolCall: ToolCall? {
        ToolCall(
            id: id,
            function: ToolCall.Function(
                name: function.name,
                arguments: decodeArguments(function.arguments)
            )
        )
    }
}

struct RequestToolFunction: Decodable {
    let name: String
    let arguments: String?
}

struct ChatCompletionResponse: Encodable {
    let id: String
    let object = "chat.completion"
    let created: Int
    let model: String
    let choices: [ChatCompletionChoice]
    let usage: Usage?
}

struct ChatCompletionChoice: Encodable {
    let index: Int
    let message: ResponseMessage
    let finish_reason: String
}

struct ResponseMessage: Encodable {
    let role = "assistant"
    let content: String?
    let reasoning_content: String?
    let tool_calls: [ResponseToolCall]?
}

struct ChatCompletionChunk: Encodable {
    let id: String
    let object = "chat.completion.chunk"
    let created: Int
    let model: String
    let choices: [ChatCompletionChunkChoice]
    let usage: Usage?
}

struct ChatCompletionChunkChoice: Encodable {
    let index: Int
    let delta: ChunkDelta
    let finish_reason: String?
}

struct ChunkDelta: Encodable {
    let role: String?
    let content: String?
    let reasoning_content: String?
    let tool_calls: [ResponseToolCallDelta]?
}

struct ResponseToolCall: Encodable {
    let id: String
    let type = "function"
    let function: ResponseToolFunction
}

struct ResponseToolCallDelta: Encodable {
    let index: Int
    let id: String
    let type = "function"
    let function: ResponseToolFunction
}

struct ResponseToolFunction: Encodable {
    let name: String
    let arguments: String
}

struct Usage: Encodable {
    let prompt_tokens: Int
    let completion_tokens: Int
    let total_tokens: Int
}

func toolSpecs(from tools: [AnyJSON]?) -> [ToolSpec]? {
    guard let tools, !tools.isEmpty else { return nil }
    return tools.compactMap { value in
        guard case .object(let object) = value else { return nil }
        return object.mapValues(\.sendableValue)
    }
}

func additionalContext(from toolChoice: AnyJSON?) -> [String: any Sendable]? {
    guard let toolChoice else { return nil }
    switch toolChoice {
    case .string(let value):
        if value == "required" {
            return ["tool_choice": "required"]
        }
        return ["tool_choice": value]
    case .object(let object):
        guard case .object(let function)? = object["function"],
              case .string(let name)? = function["name"]
        else {
            return nil
        }
        return [
            "tool_choice": "required",
            "tool_choice_name": name,
        ]
    default:
        return nil
    }
}

func decodeArguments(_ raw: String?) -> [String: any Sendable] {
    guard let raw, let data = raw.data(using: .utf8), !raw.isEmpty else {
        return [:]
    }
    guard let decoded = try? JSONDecoder().decode(AnyJSON.self, from: data),
          case .object(let object) = decoded
    else {
        return ["raw": raw]
    }
    return object.mapValues(\.sendableValue)
}

func encodeArguments(_ arguments: [String: JSONValue]) -> String {
    let object = arguments.mapValues(\.anyValue)
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let string = String(data: data, encoding: .utf8)
    else {
        return "{}"
    }
    return string
}
