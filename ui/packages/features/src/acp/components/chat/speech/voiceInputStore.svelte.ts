import {
  camberVoiceInputCancelDownload,
  camberVoiceInputDeleteModel,
  camberVoiceInputDownloadModel,
  camberVoiceInputGetState,
  camberVoiceInputSetModel,
  camberVoiceInputTranscribe,
  type VoiceInputState,
} from "@camber/helperapi";
import { InfoMessageType } from "@camber/rpc";
import { currentACPHostState } from "../../../hostAdapter";
import { rpc } from "../../../hostRpc";
import { SpeechRecorder } from "./recorder";
import { pcmToWavBase64 } from "./wav";

const DOWNLOAD_POLL_INTERVAL_MS = 750;
/** Recordings shorter than this are almost certainly accidental taps. */
const MIN_RECORDING_MS = 300;
const MAX_RECORDING_MS = 5 * 60 * 1000;

export type DictationPhase = "idle" | "recording" | "transcribing";

/**
 * Receives dictation output. Registered by the prompt that owns the editor the
 * text should land in; when several prompts are mounted the most recently
 * registered one wins.
 */
export interface DictationSink {
  onDictationStart(): void;
  /** Final transcript, or null when nothing usable was captured. */
  onDictationEnd(text: string | null): void;
}

/**
 * Webview-side view of the helper's camber/voiceInput/* state plus the
 * dictation state machine. Living here (not in the button) lets the prompt box
 * react to recording, the keyboard shortcut toggle it, and the button render
 * it. State refreshes on demand and polls only while a model download is in
 * flight, which works identically on desktop, VS Code, and the mobile remote.
 */
export class VoiceInputStore {
  state = $state<VoiceInputState | null>(null);
  /** unknown until the first getState answers; unsupported hides the button. */
  availability = $state<"unknown" | "available" | "unsupported">("unknown");
  phase = $state<DictationPhase>("idle");
  /** performance.now() when the active recording started; null otherwise. */
  recordingStartedAt = $state<number | null>(null);

  #recorder = new SpeechRecorder();
  #sinks: DictationSink[] = [];
  #loadPromise: Promise<void> | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  get downloading(): boolean {
    return this.state?.download?.status === "downloading";
  }

  get ready(): boolean {
    return this.state?.ready === true;
  }

  ensureLoaded(): Promise<void> {
    if (this.availability !== "unknown") return Promise.resolve();
    this.#loadPromise ??= this.refresh().finally(() => {
      this.#loadPromise = null;
    });
    return this.#loadPromise;
  }

  async refresh(): Promise<void> {
    try {
      this.#apply(await camberVoiceInputGetState());
    } catch {
      // Older helpers (or remote hosts that reject the method) have no voice
      // input; treat as unsupported rather than surfacing an error.
      this.availability = "unsupported";
    }
  }

  registerSink(sink: DictationSink): () => void {
    this.#sinks.push(sink);
    return () => {
      const index = this.#sinks.lastIndexOf(sink);
      if (index >= 0) this.#sinks.splice(index, 1);
      // The prompt that was receiving this dictation is gone; stop capturing.
      if (this.#sinks.length === 0 && this.phase === "recording") {
        this.cancelDictation();
      }
    };
  }

  /**
   * The desktop app manages voice models on the Voice Recognition settings
   * page, so a missing model sends the user there. Other hosts have no such
   * page in reach — the phone especially should be able to set up dictation
   * without walking to the desktop — so the button downloads directly.
   */
  get setupViaSettings(): boolean {
    return currentACPHostState().environment.assistantHost === "desktop";
  }

  /**
   * The mic button click and the keyboard shortcut: set up the model when
   * missing (see setupViaSettings), otherwise start or finish a dictation.
   */
  async activate(): Promise<void> {
    if (this.phase === "transcribing" || this.downloading) return;
    if (this.phase === "recording") {
      await this.#finishDictation();
      return;
    }
    await this.ensureLoaded();
    if (this.availability !== "available" || !SpeechRecorder.supported()) return;
    if (!this.ready) {
      if (this.setupViaSettings) {
        rpc.openSettings("voice");
      } else {
        await this.#startModelDownload();
      }
      return;
    }
    await this.#startDictation();
  }

  /** Settings-page actions; each returns the fresh helper state. */
  async downloadModel(modelId?: string): Promise<void> {
    this.#apply(await camberVoiceInputDownloadModel(modelId ? { modelId } : {}));
  }

  async cancelDownload(modelId?: string): Promise<void> {
    this.#apply(await camberVoiceInputCancelDownload(modelId ? { modelId } : {}));
  }

  async deleteModel(modelId: string): Promise<void> {
    this.#apply(await camberVoiceInputDeleteModel({ modelId }));
  }

  async selectModel(modelId: string): Promise<void> {
    this.#apply(await camberVoiceInputSetModel({ modelId }));
  }

  cancelDictation(): void {
    this.#clearDictationTimers();
    this.#recorder.cancel();
    this.recordingStartedAt = null;
    if (this.phase === "recording") {
      this.phase = "idle";
    }
  }

  /** Instantaneous microphone level in [0, 1] for the live waveform. */
  inputLevel(): number {
    return this.#recorder.level();
  }

  async transcribe(audioBase64: string, mimeType: string): Promise<string> {
    const result = await camberVoiceInputTranscribe({ audio: audioBase64, mimeType });
    return result.text;
  }

  dispose(): void {
    this.#stopPolling();
    this.cancelDictation();
  }

  async #startDictation(): Promise<void> {
    try {
      await this.#recorder.start();
    } catch (error) {
      this.#recorder.cancel();
      console.error("voice input: microphone unavailable", error);
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      this.#toast(
        denied ? "Microphone access was denied" : "Could not start recording",
        InfoMessageType.error,
      );
      return;
    }
    this.phase = "recording";
    this.recordingStartedAt = performance.now();
    this.#sink()?.onDictationStart();
    this.#maxDurationTimer = setTimeout(() => void this.#finishDictation(), MAX_RECORDING_MS);
  }

  async #finishDictation(): Promise<void> {
    this.#clearDictationTimers();
    this.recordingStartedAt = null;
    if (!this.#recorder.recording) {
      this.phase = "idle";
      return;
    }
    this.phase = "transcribing";
    try {
      const capture = await this.#recorder.stop();
      if (capture.durationMs < MIN_RECORDING_MS) {
        this.#sink()?.onDictationEnd(null);
        return;
      }
      const audio = await pcmToWavBase64(capture);
      const text = (await this.transcribe(audio, "audio/wav")).trim();
      this.#sink()?.onDictationEnd(text || null);
    } catch (error) {
      console.error("voice input: transcription failed", error);
      this.#toast("Transcription failed", InfoMessageType.error);
      this.#sink()?.onDictationEnd(null);
    } finally {
      this.phase = "idle";
    }
  }

  async #startModelDownload(): Promise<void> {
    try {
      // Progress renders on the mic button and in the voice settings section,
      // so a started download needs no toast.
      this.#apply(await camberVoiceInputDownloadModel({}));
    } catch (error) {
      console.error("voice input: model download failed", error);
      this.#toast("Could not start the voice model download", InfoMessageType.error);
    }
  }

  #sink(): DictationSink | undefined {
    return this.#sinks[this.#sinks.length - 1];
  }

  #clearDictationTimers(): void {
    if (this.#maxDurationTimer) {
      clearTimeout(this.#maxDurationTimer);
      this.#maxDurationTimer = null;
    }
  }

  #apply(state: VoiceInputState): void {
    const previous = this.state;
    this.state = state;
    this.availability = state.supported ? "available" : "unsupported";
    this.#announceDownloadOutcome(previous, state);
    if (this.downloading) {
      this.#schedulePoll();
    } else {
      this.#stopPolling();
    }
  }

  /** Surfaces the end of a model download the button kicked off earlier. */
  #announceDownloadOutcome(previous: VoiceInputState | null, state: VoiceInputState): void {
    if (previous?.download?.status !== "downloading") return;
    const status = state.download?.status;
    if (status === "downloading") return;
    // Failures render inline in the voice settings section; only success gets
    // a toast, nudging the user back toward the mic.
    if (status !== "failed" && status !== "cancelled") {
      this.#toast("Voice model ready — tap the mic to dictate", InfoMessageType.info);
    }
  }

  #toast(message: string, type: InfoMessageType): void {
    try {
      rpc.showInfoMessage(message, type);
    } catch (error) {
      console.error("voice input: failed to show message", error);
    }
  }

  #schedulePoll(): void {
    if (this.#pollTimer) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.refresh();
    }, DOWNLOAD_POLL_INTERVAL_MS);
  }

  #stopPolling(): void {
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }
}

export const voiceInputStore = new VoiceInputStore();
