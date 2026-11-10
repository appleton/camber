import type { VoiceInputState } from "@camber/helperapi";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const helperApi = vi.hoisted(() => ({
  getState: vi.fn<() => Promise<VoiceInputState>>(),
  downloadModel: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock("@camber/helperapi", () => ({
  camberVoiceInputGetState: helperApi.getState,
  camberVoiceInputDownloadModel: helperApi.downloadModel,
  camberVoiceInputTranscribe: helperApi.transcribe,
}));

vi.mock("./wav", () => ({
  pcmToWavBase64: vi.fn(async () => "d2F2LWJhc2U2NA=="),
}));

vi.mock("../../../hostRpc", () => ({
  rpc: { showInfoMessage: vi.fn() },
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

// Imported statically so the component graph compiles during collection
// (vi.mock calls are hoisted above these imports, so the mocks still apply);
// importing inside the first test counted the compile time against its 20s
// timeout, which flaked under full-workspace parallel load.
import SpeechButtonHarness from "./SpeechButtonHarness.test.svelte";
import { voiceInputStore } from "./voiceInputStore.svelte";

async function resetStore() {
  voiceInputStore.cancelDictation();
  voiceInputStore.state = null;
  voiceInputStore.availability = "unknown";
  voiceInputStore.phase = "idle";
  return voiceInputStore;
}

async function renderButton() {
  return render(SpeechButtonHarness, { props: {} });
}

describe("SpeechButton", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    recorder.supported = true;
    recorder.recording = false;
    recorder.sampleCount = 16000;
    recorder.durationMs = 2000;
    await resetStore();
  });

  it("stays hidden when the helper reports voice input as unsupported", async () => {
    helperApi.getState.mockResolvedValue(voiceState({ supported: false, ready: false }));

    await renderButton();

    await waitFor(() => expect(helperApi.getState).toHaveBeenCalled());
    expect(screen.queryByTestId("prompt-speech-button")).toBeNull();
  });

  it("matches the muted sizing of the other prompt controls", async () => {
    helperApi.getState.mockResolvedValue(voiceState());

    await renderButton();
    const button = await screen.findByTestId("prompt-speech-button");
    const icon = button.querySelector('[data-type="product"]');

    expect(button).toHaveClass("text-psx-icon");
    expect(icon).not.toBeNull();
  });

  it("starts and stops a dictation from clicks", async () => {
    helperApi.getState.mockResolvedValue(voiceState());
    helperApi.transcribe.mockResolvedValue({ text: "hello world" });

    await renderButton();
    const button = await screen.findByTestId("prompt-speech-button");
    expect(button.getAttribute("aria-label")).toContain("Dictate");

    await fireEvent.click(button);
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());
    expect(button.getAttribute("aria-pressed")).toBe("true");

    await fireEvent.click(button);
    await waitFor(() => expect(recorder.stop).toHaveBeenCalled());
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("false"));
  });

  it("starts a model download instead of recording when no model is ready", async () => {
    helperApi.getState.mockResolvedValue(voiceState({ ready: false }));
    helperApi.downloadModel.mockResolvedValue(
      voiceState({
        ready: false,
        download: { modelId: "base", status: "downloading", bytesTotal: 100, bytesDownloaded: 10 },
      }),
    );

    await renderButton();
    const button = await screen.findByTestId("prompt-speech-button");
    expect(button.getAttribute("aria-label")).toBe("Download voice model for dictation");

    await fireEvent.click(button);
    await waitFor(() => expect(helperApi.downloadModel).toHaveBeenCalled());
    expect(recorder.start).not.toHaveBeenCalled();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  });
});
