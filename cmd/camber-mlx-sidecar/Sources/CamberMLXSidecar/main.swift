import Foundation
import Darwin

let exitOnStdinCloseEnv = "CAMBER_MLX_EXIT_ON_STDIN_CLOSE"
let idleUnloadSecondsEnv = "CAMBER_MLX_IDLE_UNLOAD_SECONDS"

/// How long the loaded model may sit idle before its unified memory is
/// released. Overridable via CAMBER_MLX_IDLE_UNLOAD_SECONDS; zero or
/// negative disables idle unloading.
let defaultIdleUnloadSeconds = 15 * 60

func configuredIdleUnloadInterval() -> Duration? {
    var seconds = defaultIdleUnloadSeconds
    if let raw = ProcessInfo.processInfo.environment[idleUnloadSecondsEnv],
        let parsed = Int(raw.trimmingCharacters(in: .whitespaces)) {
        seconds = parsed
    }
    return seconds > 0 ? .seconds(seconds) : nil
}

struct Options {
    var host = "127.0.0.1"
    var port = 0
    var modelsDirectory = ""
    // Empty means "serve the first downloaded model" for requests that omit a
    // model id; the Camber helper always passes --default-model explicitly.
    var defaultModel = ""
    var apiKey = ""

    static func parse(_ arguments: [String]) throws -> Options {
        var options = Options()
        var index = 1
        while index < arguments.count {
            let arg = arguments[index]
            switch arg {
            case "--host":
                options.host = try value(after: arg, in: arguments, index: &index)
            case "--port":
                let raw = try value(after: arg, in: arguments, index: &index)
                guard let port = Int(raw), port > 0 else {
                    throw CLIError.invalidValue("--port must be a positive integer")
                }
                options.port = port
            case "--models-dir":
                options.modelsDirectory = try value(after: arg, in: arguments, index: &index)
            case "--default-model":
                options.defaultModel = try value(after: arg, in: arguments, index: &index)
            case "--api-key":
                options.apiKey = try value(after: arg, in: arguments, index: &index)
            case "--help", "-h":
                throw CLIError.help
            default:
                throw CLIError.invalidValue("unknown argument: \(arg)")
            }
            index += 1
        }

        if options.modelsDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if let env = ProcessInfo.processInfo.environment["CAMBER_LOCAL_INFERENCE_MODELS_DIR"], !env.isEmpty {
                options.modelsDirectory = env
            } else if let env = ProcessInfo.processInfo.environment["OSU_MODELS_DIR"], !env.isEmpty {
                options.modelsDirectory = env
            } else {
                throw CLIError.invalidValue("--models-dir is required")
            }
        }
        if options.port == 0 {
            throw CLIError.invalidValue("--port is required")
        }
        return options
    }

    private static func value(after flag: String, in arguments: [String], index: inout Int) throws -> String {
        let valueIndex = index + 1
        guard valueIndex < arguments.count else {
            throw CLIError.invalidValue("\(flag) requires a value")
        }
        index = valueIndex
        return arguments[valueIndex]
    }
}

enum CLIError: Error, LocalizedError {
    case help
    case invalidValue(String)

    var errorDescription: String? {
        switch self {
        case .help:
            return UsageText.text
        case .invalidValue(let message):
            return "\(message)\n\n\(UsageText.text)"
        }
    }
}

enum UsageText {
    static let text = """
    Usage: camber-mlx-sidecar --host 127.0.0.1 --port 12345 --models-dir ~/MLXModels [--default-model <owner>/<name>] --api-key TOKEN

    Serves a local OpenAI-compatible MLX/vMLX endpoint for Camber ACP standalone mode.
    """
}

func startStdinLifetimeMonitorIfRequested() {
    guard ProcessInfo.processInfo.environment[exitOnStdinCloseEnv] == "1" else {
        return
    }
    Thread.detachNewThread {
        _ = FileHandle.standardInput.readDataToEndOfFile()
        fputs("camber-mlx-sidecar: stdin closed; exiting\n", stderr)
        fflush(stderr)
        exit(0)
    }
}

do {
    let options = try Options.parse(CommandLine.arguments)
    startStdinLifetimeMonitorIfRequested()
    let modelsDirectory = URL(
        fileURLWithPath: NSString(string: options.modelsDirectory).expandingTildeInPath,
        isDirectory: true
    )
    let runtime = LocalRuntime(
        modelsDirectory: modelsDirectory,
        defaultModel: options.defaultModel,
        idleUnloadAfter: configuredIdleUnloadInterval()
    )
    Task { await runtime.runIdleUnloadLoop() }
    // Kept alive for the process lifetime; see startMemoryPressureMonitor.
    let memoryPressureSource = startMemoryPressureMonitor(runtime: runtime)
    defer { memoryPressureSource.cancel() }
    let server = SidecarHTTPServer(
        host: options.host,
        port: options.port,
        apiKey: options.apiKey,
        runtime: runtime
    )
    try await server.run()
} catch CLIError.help {
    print(UsageText.text)
    exit(0)
} catch {
    fputs("camber-mlx-sidecar: \(error.localizedDescription)\n", stderr)
    exit(1)
}
