import type { VoiceInputState } from "@camber/helperapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const helperApi = vi.hoisted(() => ({
  getState: vi.fn<() => Promise<VoiceInputState>>(),
  downloadModel: vi.fn(),
  cancelDownload: vi.fn(),
  deleteModel: vi.fn(),
  setModel: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock("@camber/helperapi", () => ({
  camberVoiceInputGetState: helperApi.getState,
  camberVoiceInputDownloadModel: helperApi.downloadModel,
  camberVoiceInputCancelDownload: helperApi.cancelDownload,
  camberVoiceInputDeleteModel: helperApi.deleteModel,
  camberVoiceInputSetModel: helperApi.setModel,
  camberVoiceInputTranscribe: helperApi.transcribe,
}));

vi.mock("./wav", () => ({
  pcmToWavBase64: vi.fn(async () => "d2F2LWJhc2U2NA=="),
}));

const rpcMock = vi.hoisted(() => ({
  showInfoMessage: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock("../../../hostRpc", () => ({
  rpc: rpcMock,
}));

const recorder = vi.hoisted(() => ({
  supported: true,
  recording: false,
  sampleCount: 16000,
  durationMs: 2000,
  capture() {
    return {
      samples: new Float32Array(recorder.sampleCount),
      sampleRate: 16000,
      durationMs: recorder.durationMs,
    };
  },
  start: vi.fn(async () => {
    recorder.recording = true;
  }),
  stop: vi.fn(async () => {
    recorder.recording = false;
    return recorder.capture();
  }),
  cancel: vi.fn(() => {
    recorder.recording = false;
  }),
}));

vi.mock("./recorder", () => ({
  SpeechRecorder: class {
    static supported = () => recorder.supported;
    get recording() {
      return recorder.recording;
    }
    start = recorder.start;
    stop = recorder.stop;
    cancel = recorder.cancel;
  },
}));

function voiceState(overrides: Partial<VoiceInputState> = {}): VoiceInputState {
  return {
    supported: true,
    ready: true,
    modelsDirectory: "/tmp/models",
    selectedModelId: "base",
    models: [],
    runtime: "stopped",
    ...overrides,
  };
}

async function freshStore() {
  const { voiceInputStore } = await import("./voiceInputStore.svelte");
  voiceInputStore.cancelDictation();
  voiceInputStore.state = null;
  voiceInputStore.availability = "unknown";
  voiceInputStore.phase = "idle";
  return voiceInputStore;
}

describe("voiceInputStore dictation", () => {
  let disposeSink: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    recorder.supported = true;
    recorder.recording = false;
    recorder.sampleCount = 16000;
    recorder.durationMs = 2000;
    helperApi.getState.mockResolvedValue(voiceState());
  });

  afterEach(() => {
    disposeSink?.();
    disposeSink = null;
    vi.useRealTimers();
  });

  it("transcribes once when the dictation stops", async () => {
    const store = await freshStore();
    const events: string[] = [];
    let final: string | null | undefined;
    disposeSink = store.registerSink({
      onDictationStart: () => events.push("<start>"),
      onDictationEnd: (text) => {
        final = text;
      },
    });

    helperApi.transcribe.mockResolvedValue({ text: " hello there " });
    await store.activate();
    expect(store.phase).toBe("recording");
    expect(events).toEqual(["<start>"]);

    // Nothing is transcribed while speech is still being captured.
    await vi.advanceTimersByTimeAsync(5000);
    expect(helperApi.transcribe).not.toHaveBeenCalled();

    await store.activate();
    expect(store.phase).toBe("idle");
    expect(recorder.stop).toHaveBeenCalled();
    expect(helperApi.transcribe).toHaveBeenCalledTimes(1);
    expect(final).toBe("hello there");
  });

  it("reports null for recordings below the accidental-tap threshold", async () => {
    const store = await freshStore();
    let final: string | null | undefined;
    disposeSink = store.registerSink({
      onDictationStart: () => {},
      onDictationEnd: (text) => {
        final = text;
      },
    });

    await store.activate();
    recorder.durationMs = 100;
    await store.activate();

    expect(final).toBeNull();
    expect(helperApi.transcribe).not.toHaveBeenCalled();
    expect(store.phase).toBe("idle");
  });

  it("cancels an active dictation when its sink unregisters", async () => {
    const store = await freshStore();
    const dispose = store.registerSink({
      onDictationStart: () => {},
      onDictationEnd: () => {},
    });

    await store.activate();
    expect(store.phase).toBe("recording");

    dispose();
    expect(recorder.cancel).toHaveBeenCalled();
    expect(store.phase).toBe("idle");
  });
});

describe("voiceInputStore model setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { appState } = await import("../../../hostAdapter");
    appState.update((state) => ({
      ...state,
      environment: { ...state.environment, assistantHost: "" },
    }));
  });

  async function withHost(assistantHost: string) {
    const { appState } = await import("../../../hostAdapter");
    appState.update((state) => ({
      ...state,
      environment: { ...state.environment, assistantHost },
    }));
  }

  it("opens the Voice Recognition settings from the desktop instead of downloading", async () => {
    await withHost("desktop");
    helperApi.getState.mockResolvedValue(voiceState({ ready: false }));
    const store = await freshStore();

    await store.activate();

    expect(rpcMock.openSettings).toHaveBeenCalledWith("voice");
    expect(helperApi.downloadModel).not.toHaveBeenCalled();
  });

  it("downloads directly on the mobile remote, where no settings page is in reach", async () => {
    await withHost("mobile");
    helperApi.getState.mockResolvedValue(voiceState({ ready: false }));
    helperApi.downloadModel.mockResolvedValue(
      voiceState({
        ready: false,
        download: { modelId: "base", status: "downloading" },
      }),
    );
    const store = await freshStore();

    await store.activate();

    expect(rpcMock.openSettings).not.toHaveBeenCalled();
    expect(helperApi.downloadModel).toHaveBeenCalled();
    expect(store.downloading).toBe(true);
    store.dispose();
  });

  it("applies helper state returned by the settings-page actions", async () => {
    const store = await freshStore();
    helperApi.setModel.mockResolvedValue(voiceState({ selectedModelId: "small" }));
    await store.selectModel("small");
    expect(helperApi.setModel).toHaveBeenCalledWith({ modelId: "small" });
    expect(store.state?.selectedModelId).toBe("small");

    helperApi.deleteModel.mockResolvedValue(voiceState({ ready: false }));
    await store.deleteModel("base");
    expect(store.ready).toBe(false);

    helperApi.cancelDownload.mockResolvedValue(voiceState());
    await store.cancelDownload("base");
    expect(helperApi.cancelDownload).toHaveBeenCalledWith({ modelId: "base" });
  });
});
